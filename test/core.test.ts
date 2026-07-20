import { describe, expect, test } from "bun:test";
import {
  applyCorrection,
  applyOutcome,
  buildHybridInjection,
  buildInjection,
  isCorrectionPrompt,
  maintainStore,
  mergeSynthesizedCandidates,
  migrateStore,
  newStore,
  normalizeKeywords,
  sanitizeRemoteUrl,
  scrubSecrets,
  selectFacts,
  selectMemories,
  tokenize,
  type LearnedFact,
  type LearnedMemory,
} from "../core.ts";

const NOW = "2026-07-20T18:00:00.000Z";

function memory(overrides: Partial<LearnedMemory> = {}): LearnedMemory {
  return {
    id: "unicode-normalization",
    title: "Canonicalize Unicode before deduplication",
    rule: "Normalize user-facing text to NFC before comparing or deduplicating values.",
  keywords: ["unicode", "normalize", "nfc", "deduplicate", "username"],
  scope: "project",
  kind: "guidance",
  origin: "synthesized",
  projectId: "project-a",
    model: "openai-codex/gpt-5.6-sol",
    status: "active",
    confidence: 0.72,
    evidence: { observations: 3, helpful: 1, harmful: 0, neutral: 0 },
    sourceEpisodeIds: ["episode-1", "episode-2"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("selective memory retrieval", () => {
  test("injects only relevant model-matched memories", () => {
    const selected = selectMemories(
      [
        memory(),
        memory({ id: "postgres", keywords: ["postgres", "index", "query"], rule: "Use EXPLAIN ANALYZE." }),
        memory({ id: "wrong-model", model: "anthropic/claude", confidence: 0.9 }),
      ],
      {
        prompt: "Fix Unicode NFC normalization when deduplicating usernames",
        projectId: "project-a",
        model: "openai-codex/gpt-5.6-sol",
      },
    );

    expect(selected.map((item) => item.memory.id)).toEqual(["unicode-normalization"]);
    expect(selected[0]!.overlap).toBeGreaterThanOrEqual(2);
  });

  test("rejects broad or weakly related memories", () => {
    expect(
      selectMemories([memory()], {
        prompt: "Implement a topological sort for dependency edges",
        projectId: "project-a",
        model: "openai-codex/gpt-5.6-sol",
      }),
    ).toEqual([]);
  });

  test("removes generic keywords before retrieval", () => {
    const broad = memory({ keywords: ["input", "negative", "value", "parser"] });
    expect(normalizeKeywords(broad.keywords)).toEqual(["parser"]);
    expect(selectMemories([broad], {
      prompt: "Handle a negative input value",
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
    })).toEqual([]);
  });

  test("retrieves model-scoped facts through the same gate", () => {
    const fact: LearnedFact = {
      id: "fact-1",
      title: "Unicode database",
      content: "The username database stores Unicode NFC values.",
      keywords: ["unicode", "nfc", "username"],
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
      confidence: 0.8,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const selected = selectFacts([fact], {
      prompt: "Normalize a Unicode username to NFC",
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
    });
    expect(buildHybridInjection([], selected)).toContain("Project fact");
    expect(selectFacts([fact], {
      prompt: "Sort graph nodes",
      projectId: "project-a",
      model: "openai-codex/gpt-5.6-sol",
    })).toEqual([]);
  });

  test("bounds injected guidance", () => {
    const selected = selectMemories(
      Array.from({ length: 4 }, (_, index) =>
        memory({
          id: `memory-${index}`,
          rule: `${"Canonicalize text before comparison. ".repeat(10)}${index}`,
        }),
      ),
      {
        prompt: "Normalize Unicode NFC text before username deduplication",
        projectId: "project-a",
        model: "openai-codex/gpt-5.6-sol",
      },
    );
    const injection = buildInjection(selected);
    expect(selected).toHaveLength(2);
    expect(injection.length).toBeLessThanOrEqual(600);
  });
});

describe("outcome scoring", () => {
  test("requires explicit attributable correction language", () => {
    expect(isCorrectionPrompt("Correction: your previous change broke parsing.")).toBe(true);
    expect(isCorrectionPrompt("Actually, add a second parser instead.")).toBe(false);
    expect(isCorrectionPrompt("Do not change the generated filename.")).toBe(false);
  });

  test("rewards verified success conservatively", () => {
    const updated = applyOutcome(memory(), { verified: true, harmful: false }, NOW);
    expect(updated.confidence).toBeCloseTo(0.74);
    expect(updated.evidence.helpful).toBe(2);
  });

  test("retires repeatedly harmful memories", () => {
    const initiallyWeak = memory({
      confidence: 0.68,
      evidence: { observations: 4, helpful: 0, harmful: 1, neutral: 2 },
    });
    const failed = applyOutcome(initiallyWeak, { verified: false, harmful: true }, NOW);
    expect(failed.status).toBe("retired");
    expect(failed.confidence).toBeCloseTo(0.56);
  });

  test("applies explicit next-turn corrections more strongly", () => {
    const corrected = applyCorrection(memory(), NOW);
    expect(corrected.confidence).toBeCloseTo(0.52);
    expect(corrected.evidence.harmful).toBe(1);
  });
});

describe("candidate synthesis", () => {
  test("keeps synthesized guidance experimental despite repeated source evidence", () => {
    const store = newStore();
    const merged = mergeSynthesizedCandidates(
      store,
      [
        {
          title: "Canonical Unicode usernames",
          rule: "Normalize usernames to NFC before deduplication.",
          keywords: ["unicode", "username", "normalize", "nfc"],
          evidenceEpisodeIds: ["a", "b", "c"],
          confidence: 0.7,
        },
        {
          title: "Speculative preference",
          rule: "Always use arrays for collection values.",
          keywords: ["array", "collection"],
          evidenceEpisodeIds: ["c"],
          confidence: 0.9,
        },
      ],
      { projectId: "project-a", model: "openai-codex/gpt-5.6-sol", now: NOW },
    );
    expect(merged.memories.map((item) => item.status)).toEqual(["candidate"]);
  });

  test("quarantines contradictory candidates", () => {
    const store = { ...newStore(), memories: [memory({ rule: "Always use interfaces for public APIs.", keywords: ["public", "api", "interfaces"] })] };
    const merged = mergeSynthesizedCandidates(store, [{
      title: "Avoid interfaces",
      rule: "Never use interfaces for public APIs.",
      keywords: ["public", "api", "interfaces"],
      evidenceEpisodeIds: ["x", "y", "z"],
      confidence: 0.8,
    }], { projectId: "project-a", model: "openai-codex/gpt-5.6-sol", now: NOW });
    expect(merged.memories.at(-1)?.status).toBe("conflicted");
  });
});

describe("privacy helpers", () => {
  test("normalizes tokens and scrubs common secrets", () => {
    expect(tokenize("NFC-normalize usernames, usernames!")).toEqual(["nfc", "normalize", "usernames"]);
    const scrubbed = scrubSecrets("api_key=secret-value Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(scrubbed).not.toContain("secret-value");
    expect(scrubbed).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubSecrets("https://user:secret@example.com/repo.git")).toBe("https://[REDACTED]@example.com/repo.git");
    expect(sanitizeRemoteUrl("https://user:token@example.com/org/repo.git?x=1#y")).toBe("https://example.com/org/repo.git");
  });

  test("migrates v1 stores and retires stale candidates", () => {
    const migrated = migrateStore({
      version: 1,
      memories: [{
        ...memory(),
        kind: undefined,
        origin: undefined,
        experiment: {
          treatment: { trials: 1, verified: 1, corrected: 0, tokens: 100 },
          control: { trials: 1, verified: 0, corrected: 0, tokens: 100 },
          decision: "exploring",
        },
      }],
      episodes: [{
        id: "legacy",
        projectId: "project-a",
        model: "openai-codex/gpt-5.6-sol",
        injectedMemoryIds: ["unicode-normalization"],
        toolErrors: 1,
      }],
      analyzedEpisodeIds: [],
    });
    expect(migrated.version).toBe(3);
    expect(migrated.facts).toEqual([]);
    expect(migrated.memories[0]?.kind).toBe("guidance");
    expect(migrated.memories[0]?.experiment?.treatment.cost).toBe(0);
    expect(migrated.memories[0]?.experiment?.treatment.strata).toEqual({});
    expect(migrated.episodes[0]?.memoryAssignments).toEqual([{ memoryId: "unicode-normalization", arm: "treatment" }]);
    expect(migrated.episodes[0]?.failedAttempts).toBe(1);
    const stale = memory({ status: "candidate", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const maintained = maintainStore({ ...newStore(), memories: [stale] }, "2026-03-01T00:00:00.000Z");
    expect(maintained.memories[0]?.status).toBe("retired");
  });
});
