import { createHash } from "node:crypto";

import { type LearnedMemory, type LearningStore, scrubSecrets } from "./core.ts";

function revalidationId(memory: LearnedMemory, model: string): string {
  const suffix = createHash("sha256").update(`${memory.id}\0${model}`).digest("hex").slice(0, 10);
  return `${memory.id}-model-${suffix}`;
}

function sourceHash(memory: LearnedMemory, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ rule: memory.rule, keywords: memory.keywords, procedure: memory.procedure, model }))
    .digest("hex");
}

export function attributeRevalidationEpisode(memory: LearnedMemory, episodeId: string): LearnedMemory {
  if (!memory.revalidationOf) return memory;
  return {
    ...memory,
    sourceEpisodeIds: [...new Set([...memory.sourceEpisodeIds, episodeId])],
    replay: memory.replay ? { ...memory.replay, status: "stale", fresh: false } : memory.replay,
  };
}

export function prepareModelRevalidation(
  store: LearningStore,
  projectId: string,
  currentModel: string,
  now: string,
): LearningStore {
  const additions: LearnedMemory[] = [];
  for (const memory of store.memories) {
    if (memory.projectId !== projectId || memory.model === currentModel || memory.status !== "active") continue;
    const id = revalidationId(memory, currentModel);
    if (store.memories.some((candidate) => candidate.id === id || candidate.revalidationOf === memory.id && candidate.model === currentModel)) {
      continue;
    }
    additions.push({
      ...memory,
      id,
      title: scrubSecrets(`${memory.title} (${currentModel} revalidation)`).slice(0, 100),
      model: currentModel,
      status: "candidate",
      origin: "revalidated",
      confidence: Math.min(memory.confidence, 0.65),
      evidence: {
        observations: 0,
        helpful: 0,
        harmful: 0,
        neutral: 0,
      },
      sourceEpisodeIds: [],
      experiment: undefined,
      revisions: [],
      replay: {
        status: "pending",
        model: currentModel,
        score: 0,
        cases: 0,
        falsePositiveRate: 0,
        sourceHash: sourceHash(memory, currentModel),
      },
      revalidationOf: memory.id,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined,
    });
  }
  return additions.length > 0 ? { ...store, memories: [...store.memories, ...additions] } : store;
}
