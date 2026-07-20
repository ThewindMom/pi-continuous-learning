import { describe, expect, test } from "bun:test";

import {
  assignMemories,
  autonomousGraduationEligible,
  evaluateExperimentDecision,
  experimentScore,
  posteriorProbability,
  recordExperimentCorrection,
  recordExperimentOutcome,
} from "../autonomy.ts";
import { memoryArtifactHash, type ArmEvidence, type LearnedMemory, type MemorySelection, type StratumEvidence } from "../core.ts";

const NOW = "2026-07-20T00:00:00.000Z";

function memory(overrides: Partial<LearnedMemory> = {}): LearnedMemory {
  return {
    id: "unicode-normalization",
    title: "Normalize Unicode usernames",
    rule: "Normalize usernames to Unicode NFC before deduplication.",
    keywords: ["unicode", "nfc", "username"],
    scope: "project",
    kind: "guidance",
    origin: "synthesized",
    projectId: "project-a",
    model: "openai-codex/gpt-5.6-sol",
    status: "candidate",
    confidence: 0.7,
    evidence: { observations: 2, helpful: 0, harmful: 0, neutral: 0 },
    sourceEpisodeIds: ["a", "b"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

function outcome(verified: boolean) {
  return {
    verified,
    corrected: false,
    tokens: 100,
    cost: 0.01,
    latencyMs: 1_000,
    failedAttempts: 0,
    taskStratum: "parse-transform/short",
  };
}

function arm(trials: number, verified: number): ArmEvidence {
  return {
    trials,
    verified,
    corrected: 0,
    tokens: trials * 100,
    cost: trials * 0.01,
    latencyMs: trials * 1_000,
    failedAttempts: 0,
    strata: {
      "parse-transform/short": {
        trials,
        verified,
        corrected: 0,
        tokens: trials * 100,
        cost: trials * 0.01,
        latencyMs: trials * 1_000,
        failedAttempts: 0,
      },
    },
  };
}

function stratum(trials: number, verified: number): StratumEvidence {
  const { strata: _strata, ...evidence } = arm(trials, verified);
  return evidence;
}

describe("autonomous causal learning", () => {
  test("assigns one experimental candidate deterministically", () => {
    const selections: MemorySelection[] = [
      { memory: memory(), relevance: 1, overlap: 3 },
      { memory: memory({ id: "other-candidate" }), relevance: 0.8, overlap: 2 },
    ];
    const context = {
      prompt: "Normalize a Unicode username to NFC",
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
    };
    const first = assignMemories(selections, context, new Set(), { candidateControlRate: 0.5, activeControlRate: 0.15 });
    const second = assignMemories(selections, context, new Set(), { candidateControlRate: 0.5, activeControlRate: 0.15 });
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  test("isolates one active memory per treatment turn", () => {
    const selections: MemorySelection[] = [
      { memory: memory({ id: "first", status: "active" }), relevance: 1, overlap: 3 },
      { memory: memory({ id: "second", status: "active" }), relevance: 0.9, overlap: 2 },
    ];
    const assignments = assignMemories(selections, {
      prompt: "Normalize a Unicode username to NFC",
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
    }, new Set(), { candidateControlRate: 0.5, activeControlRate: 0.15 });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.selection.memory.id).toBe("first");
  });

  test("promotes candidates only after treatment beats matched control", () => {
    let learned = memory();
    learned = { ...learned, replay: {
      status: "passed",
      model: "openai-codex/gpt-5.6-sol",
      score: 0.9,
      cases: 12,
      falsePositiveRate: 0,
      sourceHash: "source",
      artifactHash: memoryArtifactHash(learned),
      optimizer: "rlm-gepa",
      caseIds: ["a", "b"],
      fresh: true,
    } };
    for (let index = 0; index < 10; index++) {
      learned = recordExperimentOutcome(learned, "treatment", outcome(true), NOW);
      learned = recordExperimentOutcome(learned, "control", outcome(index < 5), NOW);
    }
    expect(learned.status).toBe("active");
    expect(learned.experiment?.decision).toBe("promoted");
    expect(experimentScore(learned.experiment!)).toBeCloseTo(0.4167, 3);
    expect(posteriorProbability(learned.experiment!, 0.03)).toBeGreaterThan(0.95);
  });

  test("blocks statistically strong candidates until replay passes", () => {
    let learned = memory();
    for (let index = 0; index < 10; index++) {
      learned = recordExperimentOutcome(learned, "treatment", outcome(true), NOW);
      learned = recordExperimentOutcome(learned, "control", outcome(index < 5), NOW);
    }
    expect(learned.status).toBe("candidate");
    const replayMemory = { ...learned };
    const released = evaluateExperimentDecision({
      ...learned,
      replay: {
        status: "passed",
        model: learned.model,
        score: 0.9,
        cases: 12,
        falsePositiveRate: 0,
        sourceHash: "source",
        artifactHash: memoryArtifactHash(replayMemory),
        optimizer: "rlm-gepa",
        caseIds: ["a", "b"],
        fresh: true,
      },
    }, NOW);
    expect(released.status).toBe("active");
    const stale = evaluateExperimentDecision({ ...learned, rule: "A materially changed untested parser rule.", replay: released.replay }, NOW);
    expect(stale.status).toBe("candidate");
  });

  test("rejects candidates that underperform control", () => {
    let learned = memory();
    for (let index = 0; index < 10; index++) {
      learned = recordExperimentOutcome(learned, "treatment", outcome(false), NOW);
      learned = recordExperimentOutcome(learned, "control", outcome(true), NOW);
    }
    expect(learned.status).toBe("retired");
    expect(learned.experiment?.decision).toBe("rejected");
  });

  test("scores matched strata instead of trusting aggregate outcomes", () => {
    const treatment = arm(100, 80);
    const control = arm(100, 20);
    treatment.strata = {
      "search-filter/short": stratum(90, 80),
      "search-filter/long": stratum(10, 0),
    };
    control.strata = {
      "search-filter/short": stratum(10, 10),
      "search-filter/long": stratum(90, 10),
    };
    const score = experimentScore({ treatment, control, decision: "exploring" });
    expect(score).toBeLessThan(0);
  });

  test("penalizes treatment cost when objective outcomes are equal", () => {
    const treatment = arm(10, 8);
    const control = arm(10, 8);
    treatment.cost = 2;
    treatment.strata["parse-transform/short"]!.cost = 2;
    control.cost = 1;
    control.strata["parse-transform/short"]!.cost = 1;
    expect(experimentScore({ treatment, control, decision: "exploring" })).toBeLessThan(0);
  });

  test("treats explicit corrections as strong posterior failures", () => {
    let learned = memory({ status: "active" });
    for (let index = 0; index < 10; index++) {
      learned = recordExperimentOutcome(learned, "treatment", outcome(true), NOW);
      learned = recordExperimentOutcome(learned, "control", outcome(index < 7), NOW);
    }
    const before = posteriorProbability(learned.experiment!, 0)!;
    learned = recordExperimentCorrection(learned, "treatment", "parse-transform/short", NOW);
    const after = posteriorProbability(learned.experiment!, 0)!;
    expect(after).toBeLessThan(before);
    expect(learned.experiment?.treatment.corrected).toBe(1);
    expect(learned.experiment?.treatment.strata["parse-transform/short"]?.corrected).toBe(1);
  });

  test("requires strong causal evidence for autonomous graduation", () => {
    let proven = memory({
      status: "active",
      confidence: 0.86,
      evidence: { observations: 35, helpful: 25, harmful: 0, neutral: 0 },
      experiment: {
        treatment: arm(25, 25),
        control: arm(10, 5),
        decision: "promoted",
      },
      replay: {
        status: "passed",
        model: "openai-codex/gpt-5.6-sol",
        score: 0.9,
        cases: 12,
        falsePositiveRate: 0,
        sourceHash: "source",
        optimizer: "rlm-gepa",
        caseIds: ["a", "b"],
        fresh: true,
      },
    });
    proven = { ...proven, replay: { ...proven.replay!, artifactHash: memoryArtifactHash(proven) } };
    expect(autonomousGraduationEligible(proven, NOW)).toBe(true);
    expect(autonomousGraduationEligible({ ...proven, evidence: { ...proven.evidence, harmful: 1 } }, NOW)).toBe(false);
  });
});
