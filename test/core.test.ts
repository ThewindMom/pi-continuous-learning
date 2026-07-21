import { describe, expect, test } from "bun:test";

import {
  ConfigSchema,
  newStore,
  parseStore,
  recordAttribution,
  type Candidate,
} from "../core.ts";
import { applyInteractionEvidence } from "../index.ts";

const config = ConfigSchema.parse({
  idleMs: 1,
  historyBatchSize: 10,
  maxApprovedMemories: 10,
  maxCandidates: 10,
  maxAttributions: 10,
  maxInjectedMemories: 2,
  maxInjectionChars: 200,
  repeatThreshold: 3,
  replayMinimumMatches: 2,
  replayMinimumSuccessRate: 0.5,
  canaryRate: 1,
  promotionMinimumTrials: 2,
  promotionMinimumHelpful: 2,
  rollbackMinimumTrials: 2,
  rollbackHarmfulRate: 0.5,
  graduationMinimumHelpful: 3,
  graduationMinimumAgeDays: 14,
  notifications: { promotions: true, rollbacks: true, failures: true },
});

function candidate(state: Candidate["state"] = "canary"): Candidate {
  return {
    id: "candidate-1",
    title: "Verify parser",
    rule: "Verify parser output before claiming completion.",
    keywords: ["parser", "output"],
    projectId: "project-1",
    state,
    evidenceInteractionIds: ["old-1", "old-2", "old-3"],
    replay: { matches: 3, helpful: 3, harmful: 0 },
    canary: { trials: 0, helpful: 0, harmful: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("compact state and candidate lifecycle", () => {
  test("migrates active legacy memories without copying episodes", async () => {
    const migrated = parseStore({
      version: 3,
      memories: [{
        id: "legacy-rule",
        title: "Keep checks",
        rule: "Run the check before completion.",
        keywords: ["checks"],
        status: "active",
        scope: "project",
        kind: "guidance",
        projectId: "project-1",
        confidence: 0.9,
        evidence: { observations: 4, helpful: 3, harmful: 0, neutral: 1 },
      }],
      episodes: [{ prompt: "secret transcript must not persist" }],
    });
    expect(migrated.approvedMemories).toHaveLength(1);
    expect("episodes" in migrated).toBe(false);
    expect(migrated.historyCursor.attributions).toHaveLength(0);
  });

  test("bounds local selection and promotes or disables from attribution evidence", () => {
    const base = newStore();
    const withCandidate = { ...base, candidates: [candidate()] };
    const interaction = {
      id: "interaction-1",
      entryId: "a1",
      userPrompt: "fix parser output",
      assistantText: "Verified: tests passed.",
      completed: true,
      helpful: true,
      harmful: false,
      keywords: ["parser", "output"],
      sourceEntryIds: ["u1", "a1"],
    };
    const attributed = recordAttribution(withCandidate, {
      interactionId: "interaction-1",
      memoryIds: [],
      candidateIds: ["candidate-1"],
      injectedAt: new Date().toISOString(),
    }, 10);
    const promotedOnce = applyInteractionEvidence(attributed, interaction, attributed.historyCursor.attributions, config, new Date().toISOString());
    const secondAttribution = recordAttribution(promotedOnce.store, {
      interactionId: "interaction-2",
      memoryIds: [],
      candidateIds: ["candidate-1"],
      injectedAt: new Date().toISOString(),
    }, 10);
    const promotedTwice = applyInteractionEvidence(secondAttribution, { ...interaction, id: "interaction-2" }, secondAttribution.historyCursor.attributions, config, new Date().toISOString());
    expect(promotedTwice.store.approvedMemories).toHaveLength(1);
    expect(promotedTwice.promoted).toBe(1);
    const memory = promotedTwice.store.approvedMemories[0]!;
    const harmful = {
      ...promotedTwice.store,
      historyCursor: {
        ...promotedOnce.store.historyCursor,
        attributions: [{
          interactionId: "interaction-2",
          memoryIds: [memory.id],
          candidateIds: [],
          injectedAt: new Date().toISOString(),
        }],
      },
    };
    const harmfulInteraction = { ...interaction, id: "interaction-2", helpful: false, harmful: true };
    const rolled = applyInteractionEvidence(harmful, harmfulInteraction, harmful.historyCursor.attributions, config, new Date().toISOString());
    expect(rolled.store.approvedMemories[0]?.disabled).toBe(false);
    const rolledAgain = applyInteractionEvidence(rolled.store, { ...harmfulInteraction, id: "interaction-3" }, [{
      ...harmful.historyCursor.attributions[0]!,
      interactionId: "interaction-3",
    }], config, new Date().toISOString());
    expect(rolledAgain.store.approvedMemories[0]?.disabled).toBe(true);
  });
});
