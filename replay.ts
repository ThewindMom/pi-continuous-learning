import { createHash } from "node:crypto";
import { z } from "zod";

import {
  containsUnsafeGeneratedInstruction,
  memoryArtifactHash,
  normalizeKeywords,
  scrubSecrets,
  renderMemoryGuidance,
  tokenize,
  type LearnedMemory,
  type LearningEpisode,
  type LearningStore,
  type ProcedureSpec,
  type ReplayEvidence,
} from "./core.ts";
import { evaluateExperimentDecision } from "./autonomy.ts";

export interface ReplayCase {
  episodeId: string;
  prompt: string;
  response: string;
  expectedRelevant: boolean;
  verified: boolean;
  corrected: boolean;
  taskStratum: string;
  split: "train" | "validation" | "test";
}

export interface ReplayOptimizerInput {
  version: 1;
  model: string;
  generatedAt: string;
  previousMetaMemory?: string;
  candidates: Array<{
    id: string;
    title: string;
    rule: string;
    kind: LearnedMemory["kind"];
    keywords: string[];
    procedure?: ProcedureSpec;
    sourceHash: string;
    cases: ReplayCase[];
  }>;
}

const ProcedureSchema = z.object({
  goal: z.string().min(10).max(240),
  steps: z.array(z.string().min(3).max(240)).min(2).max(12),
  verification: z.array(z.string().min(3).max(240)).min(1).max(6),
  recovery: z.array(z.string().min(3).max(240)).max(6),
  decomposition: z.string().min(3).max(80),
});

const CandidateResultSchema = z.object({
  id: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  score: z.number().min(0).max(1),
  baselineScore: z.number().min(0).max(1),
  cases: z.number().int().min(1),
  falsePositiveRate: z.number().min(0).max(1),
  equivalenceClass: z.string().min(3).max(120),
  semanticScore: z.number().min(0).max(1),
  heldOutDomains: z.number().int().min(0),
  longContextScore: z.number().min(0).max(1),
  optimizedRule: z.string().min(20).max(360),
  optimizedKeywords: z.array(z.string()).min(2).max(12),
  procedure: ProcedureSchema.optional(),
});

const ReplayArtifactSchema = z.object({
  version: z.literal(1),
  model: z.string().min(3),
  generatedAt: z.string().datetime(),
  optimizer: z.literal("rlm-gepa"),
  metaMemory: z.string().max(2_000),
  candidates: z.array(CandidateResultSchema).max(32),
});

export type ReplayArtifact = z.infer<typeof ReplayArtifactSchema>;
const MAX_RULE_EDIT_RATIO = 0.65;
const MAX_KEYWORD_EDITS = 4;

export function replaySourceHash(memory: LearnedMemory, episodes: LearningEpisode[], caseIds?: string[]): string {
  const selectedIds = caseIds ? new Set(caseIds) : undefined;
  const evidence = episodes
    .filter((episode) => episode.projectId === memory.projectId && episode.model === memory.model && (!selectedIds || selectedIds.has(episode.id)))
    .map((episode) => ({
      id: episode.id,
      prompt: episode.prompt,
      response: episode.response,
      verified: episode.verified,
      corrected: episode.corrected,
      taskStratum: episode.taskStratum,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify({
    id: memory.id,
    model: memory.model,
    rule: memory.rule,
    keywords: normalizeKeywords(memory.keywords).sort(),
    procedure: memory.procedure,
    sourceEpisodeIds: [...memory.sourceEpisodeIds].sort(),
    evidence,
  })).digest("hex");
}

export function buildReplayCases(store: LearningStore, memory: LearnedMemory): ReplayCase[] {
  const sourceIds = new Set(memory.sourceEpisodeIds);
  const createdAt = Date.parse(memory.createdAt);
  const sourceStrata = new Set(store.episodes
    .filter((episode) => sourceIds.has(episode.id))
    .map((episode) => episode.taskStratum.split("/")[0]));
  const eligible: ReplayCase[] = store.episodes
    .filter((episode) => episode.projectId === memory.projectId && episode.model === memory.model)
    .filter((episode) => {
      if (sourceIds.has(episode.id)) return true;
      const assigned = episode.memoryAssignments.some((assignment) => assignment.memoryId === memory.id);
      const crossDomain = !sourceStrata.has(episode.taskStratum.split("/")[0]);
      return crossDomain || Date.parse(episode.timestamp) > createdAt && assigned && (episode.verified || episode.corrected);
    })
    .map((episode) => ({
      episodeId: episode.id,
      prompt: episode.prompt,
      response: episode.response,
      expectedRelevant: sourceIds.has(episode.id) || (
        episode.memoryAssignments.some((assignment) => assignment.memoryId === memory.id) &&
        episode.verified && !episode.corrected
      ),
      verified: episode.verified,
      corrected: episode.corrected,
      taskStratum: episode.taskStratum,
      split: (sourceIds.has(episode.id) || Date.parse(episode.timestamp) <= createdAt ? "train" : "validation") as ReplayCase["split"],
    }))
    .sort((left, right) => left.episodeId.localeCompare(right.episodeId));
  const sourceCases = eligible.filter((item) => sourceIds.has(item.episodeId));
  const otherCases = eligible.filter((item) => !sourceIds.has(item.episodeId));
  const cases = [...sourceCases, ...otherCases.slice(-Math.max(0, 40 - sourceCases.length))]
    .sort((left, right) => left.episodeId.localeCompare(right.episodeId));
  const splits = ["validation", "test"] as const;
  for (const expectedRelevant of [true, false]) {
    cases.filter((item) => item.split !== "train" && item.expectedRelevant === expectedRelevant)
      .forEach((item, index) => { item.split = splits[index % splits.length]!; });
  }
  return cases;
}

function matches(memory: Pick<LearnedMemory, "keywords">, prompt: string): boolean {
  const promptTokens = new Set(tokenize(prompt));
  return normalizeKeywords(memory.keywords).filter((keyword) => promptTokens.has(keyword)).length >= 2;
}

function localTransferMetrics(cases: ReplayCase[], memory: Pick<LearnedMemory, "keywords">): {
  heldOutDomains: number;
  longContextScore: number;
  domainScores: Record<string, number>;
} {
  const testCases = cases.filter((item) => item.split === "test");
  const domains = [...new Set(testCases.map((item) => item.taskStratum.split("/")[0]!))];
  const domainScores = Object.fromEntries(domains.map((domain) => {
    const domainCases = testCases.filter((item) => item.taskStratum.startsWith(`${domain}/`));
    const correct = domainCases.filter((item) => matches(memory, item.prompt) === item.expectedRelevant).length;
    return [domain, correct / Math.max(1, domainCases.length)];
  }));
  const longCases = testCases.filter((item) => item.taskStratum.endsWith("/long"));
  const longCorrect = longCases.filter((item) => matches(memory, item.prompt) === item.expectedRelevant).length;
  return {
    heldOutDomains: domains.length,
    longContextScore: longCases.length > 0 ? longCorrect / longCases.length : 0,
    domainScores,
  };
}

export function evaluateNativeReplay(store: LearningStore, memory: LearnedMemory, now: string): ReplayEvidence {
  const cases = buildReplayCases(store, memory);
  const caseIds = cases.map((item) => item.episodeId);
  const evaluated = evaluateCases(cases, memory, 3, 4);
  const transfer = localTransferMetrics(cases, memory);
  return {
    status: evaluated.status,
    model: memory.model,
    score: evaluated.score,
    cases: cases.length,
    falsePositiveRate: evaluated.falsePositiveRate,
    sourceHash: replaySourceHash(memory, store.episodes, caseIds),
    artifactHash: memoryArtifactHash(memory),
    evaluatedAt: now,
    optimizer: "native",
    attempts: memory.replay?.attempts ?? 0,
    lastAttemptAt: memory.replay?.lastAttemptAt,
    ...transfer,
    caseIds,
    fresh: true,
  };
}

function evaluateCases(
  cases: ReplayCase[],
  memory: Pick<LearnedMemory, "keywords">,
  minimumPositives: number,
  minimumNegatives: number,
): Pick<ReplayEvidence, "status" | "score" | "falsePositiveRate"> {
  const positives = cases.filter((item) => item.expectedRelevant);
  const negatives = cases.filter((item) => !item.expectedRelevant);
  const truePositives = positives.filter((item) => matches(memory, item.prompt)).length;
  const falsePositives = negatives.filter((item) => matches(memory, item.prompt)).length;
  const recall = positives.length > 0 ? truePositives / positives.length : 0;
  const falsePositiveRate = negatives.length > 0 ? falsePositives / negatives.length : 1;
  const score = Math.max(0, Math.min(1, recall * (1 - falsePositiveRate)));
  const enoughCases = positives.length >= minimumPositives && negatives.length >= minimumNegatives;
  return {
    status: enoughCases && score >= 0.75 && falsePositiveRate <= 0.15 ? "passed" : enoughCases ? "failed" : "pending",
    score,
    falsePositiveRate,
  };
}

export function applyNativeReplay(store: LearningStore, now: string): LearningStore {
  return {
    ...store,
    memories: store.memories.map((memory) => memory.status === "candidate" && memory.replay?.optimizer !== "rlm-gepa"
      ? { ...memory, replay: evaluateNativeReplay(store, memory, now), updatedAt: now }
      : memory),
  };
}

export function refreshReplayFreshness(store: LearningStore): LearningStore {
  return {
    ...store,
    memories: store.memories.map((memory) => {
      if (!memory.replay) return memory;
      const caseIds = memory.replay.caseIds ?? [];
      const sourcesCovered = memory.sourceEpisodeIds.every((id) => caseIds.includes(id));
      const currentHash = replaySourceHash(memory, store.episodes, caseIds);
      const fresh = caseIds.length > 0 && sourcesCovered && currentHash === memory.replay.sourceHash &&
        memory.replay.artifactHash === memoryArtifactHash(memory);
      return fresh === memory.replay.fresh
        ? memory
        : { ...memory, replay: { ...memory.replay, fresh, status: fresh ? memory.replay.status : "stale" } };
    }),
  };
}

export function buildReplayOptimizerInput(
  store: LearningStore,
  model: string,
  now: string,
): ReplayOptimizerInput {
  return {
    version: 1,
    model,
    generatedAt: now,
    ...(store.optimizerMemory?.model === model ? { previousMetaMemory: store.optimizerMemory.summary } : {}),
    candidates: store.memories
      .filter((memory) => memory.status === "candidate" && memory.model === model)
      .map((memory) => ({
        id: memory.id,
        title: memory.title,
        rule: memory.rule,
        kind: memory.kind,
        keywords: normalizeKeywords(memory.keywords),
        ...(memory.procedure ? { procedure: memory.procedure } : {}),
        sourceHash: replaySourceHash(memory, store.episodes),
        cases: buildReplayCases(store, memory),
      })),
  };
}

function sanitizeProcedure(procedure: z.infer<typeof ProcedureSchema>): ProcedureSpec {
  return {
    goal: scrubSecrets(procedure.goal),
    steps: procedure.steps.map(scrubSecrets),
    verification: procedure.verification.map(scrubSecrets),
    recovery: procedure.recovery.map(scrubSecrets),
    decomposition: scrubSecrets(procedure.decomposition),
  };
}

export function parseReplayArtifact(value: unknown): ReplayArtifact {
  return ReplayArtifactSchema.parse(value);
}

export function applyReplayArtifact(store: LearningStore, value: unknown, now: string): LearningStore {
  const artifact = parseReplayArtifact(value);
  const results = new Map(artifact.candidates.map((candidate) => [candidate.id, candidate]));
  const memories = store.memories.map((memory) => {
      const result = results.get(memory.id);
      if (!result || memory.status !== "candidate" || memory.model !== artifact.model) return memory;
      if (replaySourceHash(memory, store.episodes) !== result.sourceHash) return memory;
      const keywords = normalizeKeywords(result.optimizedKeywords);
      const procedure = result.procedure ? sanitizeProcedure(result.procedure) : undefined;
      if (keywords.length < 2 || memory.kind === "procedure" && !procedure) return memory;
      if (
        containsUnsafeGeneratedInstruction(result.optimizedRule) ||
        procedure && containsUnsafeGeneratedInstruction(JSON.stringify(procedure))
      ) return memory;
      const prospective: LearnedMemory = {
        ...memory,
        rule: scrubSecrets(result.optimizedRule),
        keywords,
        ...(procedure ? { procedure } : {}),
      };
      const rendered = renderMemoryGuidance(prospective);
      if (rendered.length > 520) return memory;
      const originalTokens = new Set(tokenize(renderMemoryGuidance(memory)));
      const optimizedTokens = new Set(tokenize(rendered));
      const union = new Set([...originalTokens, ...optimizedTokens]);
      const intersection = [...originalTokens].filter((token) => optimizedTokens.has(token)).length;
      const editRatio = union.size > 0 ? 1 - intersection / union.size : 1;
      const keywordEdits = new Set([...memory.keywords, ...keywords]).size -
        [...new Set(memory.keywords)].filter((keyword) => keywords.includes(keyword)).length;
      const localCases = buildReplayCases(store, memory);
      if (result.cases !== localCases.length) return memory;
      const localCaseIds = localCases.map((item) => item.episodeId);
      if (!memory.sourceEpisodeIds.every((id) => localCaseIds.includes(id))) return memory;
      const testCases = localCases.filter((item) => item.split === "test");
      const baseline = evaluateCases(testCases, memory, 1, 1);
      const evaluated = evaluateCases(testCases, prospective, 1, 1);
      const transfer = localTransferMetrics(localCases, prospective);
      const noRegression = evaluated.score + 0.01 >= baseline.score;
      if (editRatio > MAX_RULE_EDIT_RATIO || keywordEdits > MAX_KEYWORD_EDITS || !noRegression) return memory;
      const optimized: LearnedMemory = {
        ...prospective,
        revisions: [...(memory.revisions ?? []), {
          capturedAt: now,
          rule: memory.rule,
          keywords: memory.keywords,
          ...(memory.procedure ? { procedure: memory.procedure } : {}),
          ...(memory.replay ? { replay: memory.replay } : {}),
          reason: "RLM/GEPA validation-gated update",
        }].slice(-8),
        updatedAt: now,
      };
      const passed = evaluated.status === "passed";
      const changed = memoryArtifactHash(optimized) !== memoryArtifactHash(memory);
      return evaluateExperimentDecision({
        ...optimized,
        ...(changed ? {
          status: "candidate" as const,
          confidence: Math.min(memory.confidence, 0.65),
          experiment: undefined,
          evidence: { ...memory.evidence, helpful: 0, harmful: 0, neutral: 0 },
        } : {}),
        replay: {
          status: passed ? "passed" : "failed",
          model: memory.model,
          score: evaluated.score,
          cases: localCases.length,
          falsePositiveRate: evaluated.falsePositiveRate,
          sourceHash: replaySourceHash(optimized, store.episodes, localCaseIds),
          artifactHash: memoryArtifactHash(optimized),
          evaluatedAt: now,
          optimizer: "rlm-gepa",
          equivalenceClass: scrubSecrets(result.equivalenceClass),
          semanticScore: 1 - editRatio,
          heldOutDomains: transfer.heldOutDomains,
          longContextScore: transfer.longContextScore,
          domainScores: transfer.domainScores,
          attempts: memory.replay?.attempts ?? 1,
          lastAttemptAt: memory.replay?.lastAttemptAt ?? now,
          caseIds: localCaseIds,
          fresh: true,
        },
      }, now);
    });
  return {
    ...store,
    memories,
    optimizerMemory: {
      model: artifact.model,
      summary: scrubSecrets(artifact.metaMemory).slice(0, 2_000),
      epochs: (store.optimizerMemory?.model === artifact.model ? store.optimizerMemory.epochs : 0) + 1,
      updatedAt: now,
    },
  };
}
