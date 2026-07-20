import { describe, expect, test } from "bun:test";

import { newStore, type LearnedMemory } from "../core.ts";
import { attributeRevalidationEpisode, prepareModelRevalidation } from "../revalidation.ts";

const memory: LearnedMemory = {
  id: "parser-boundaries",
  title: "Validate parser boundaries",
  rule: "Validate parser boundaries before accepting input.",
  keywords: ["parser", "boundaries", "validation"],
  scope: "project",
  kind: "guidance",
  origin: "synthesized",
  projectId: "project-a",
  model: "openai-codex/gpt-5.5",
  status: "active",
  confidence: 0.82,
  evidence: { observations: 30, helpful: 20, harmful: 0, neutral: 3 },
  sourceEpisodeIds: ["a", "b"],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

describe("model upgrade revalidation", () => {
  test("creates one isolated candidate for the new model", () => {
    const initial = { ...newStore(), memories: [memory] };
    const migrated = prepareModelRevalidation(
      initial,
      "project-a",
      "openai-codex/gpt-5.6-sol",
      "2026-07-21T00:00:00.000Z",
    );
    expect(migrated.memories).toHaveLength(2);
    const candidate = migrated.memories[1]!;
    expect(candidate.status).toBe("candidate");
    expect(candidate.model).toBe("openai-codex/gpt-5.6-sol");
    expect(candidate.revalidationOf).toBe(memory.id);
    expect(candidate.replay?.status).toBe("pending");
    expect(candidate.experiment).toBeUndefined();
    expect(candidate.sourceEpisodeIds).toEqual([]);
    const attributed = attributeRevalidationEpisode({
      ...candidate,
      replay: { ...candidate.replay!, status: "passed", fresh: true },
    }, "new-model-episode");
    expect(attributed.replay?.status).toBe("stale");
    expect(attributed.replay?.fresh).toBe(false);
    expect(attributed.sourceEpisodeIds).toEqual(["new-model-episode"]);

    const repeated = prepareModelRevalidation(
      migrated,
      "project-a",
      "openai-codex/gpt-5.6-sol",
      "2026-07-22T00:00:00.000Z",
    );
    expect(repeated.memories).toHaveLength(2);
  });
});
