import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export type MemoryStatus = "candidate" | "active" | "conflicted" | "retired";
export type MemoryScope = "project" | "global";
export type MemoryKind = "guidance" | "procedure";
export type MemoryOrigin = "user" | "synthesized" | "revalidated" | "federated";

export interface ProcedureSpec {
  goal: string;
  steps: string[];
  verification: string[];
  recovery: string[];
  decomposition: string;
}

export interface MemoryEvidence {
  observations: number;
  helpful: number;
  harmful: number;
  neutral: number;
  lastHelpfulAt?: string;
  lastHarmfulAt?: string;
}

export type ExperimentArm = "treatment" | "control";

export interface ArmEvidence {
  trials: number;
  verified: number;
  corrected: number;
  tokens: number;
  cost: number;
  latencyMs: number;
  failedAttempts: number;
  strata: Record<string, StratumEvidence>;
}

export interface StratumEvidence {
  trials: number;
  verified: number;
  corrected: number;
  tokens: number;
  cost: number;
  latencyMs: number;
  failedAttempts: number;
}

export interface MemoryExperiment {
  treatment: ArmEvidence;
  control: ArmEvidence;
  decision: "exploring" | "promoted" | "rejected";
  score?: number;
  probabilityPositive?: number;
  probabilityLift?: number;
  updatedAt?: string;
}

export interface ReplayEvidence {
  status: "pending" | "passed" | "failed" | "stale";
  model: string;
  score: number;
  cases: number;
  falsePositiveRate: number;
  sourceHash: string;
  artifactHash?: string;
  evaluatedAt?: string;
  optimizer?: "native" | "rlm-gepa";
  equivalenceClass?: string;
  semanticScore?: number;
  heldOutDomains?: number;
  longContextScore?: number;
  domainScores?: Record<string, number>;
  attempts?: number;
  lastAttemptAt?: string;
  caseIds?: string[];
  fresh?: boolean;
}

export interface LearnedMemory {
  id: string;
  title: string;
  rule: string;
  keywords: string[];
  scope: MemoryScope;
  kind: MemoryKind;
  origin: MemoryOrigin;
  procedure?: ProcedureSpec;
  projectId: string;
  model: string;
  status: MemoryStatus;
  confidence: number;
  evidence: MemoryEvidence;
  sourceEpisodeIds: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  experiment?: MemoryExperiment;
  replay?: ReplayEvidence;
  revalidationOf?: string;
  revisions?: MemoryRevision[];
}

export interface MemoryRevision {
  capturedAt: string;
  rule: string;
  keywords: string[];
  procedure?: ProcedureSpec;
  replay?: ReplayEvidence;
  reason: string;
}

export interface LearningEpisode {
  id: string;
  status: "pending" | "settled";
  timestamp: string;
  projectId: string;
  model: string;
  prompt: string;
  response: string;
  autonomous: boolean;
  memoryAssignments: Array<{ memoryId: string; arm: ExperimentArm }>;
  injectedMemoryIds: string[];
  toolCalls: number;
  toolErrors: number;
  verified: boolean;
  corrected: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  failedAttempts: number;
  taskStratum: string;
}

export interface LearningStore {
  version: 3;
  memories: LearnedMemory[];
  facts: LearnedFact[];
  episodes: LearningEpisode[];
  analyzedEpisodeIds: string[];
  graduations: GraduationRecord[];
  automation: { enabled: boolean };
  optimizerMemory?: { model: string; summary: string; epochs: number; updatedAt: string };
  maintenanceAt?: string;
}

export interface GraduationRecord {
  memoryId: string;
  target: "agents" | "skill";
  destination: string;
  contentHash: string;
  graduatedAt: string;
  status: "active" | "rolled_back" | "modified";
  rolledBackAt?: string;
  reason?: string;
}

export interface LearnedFact {
  id: string;
  title: string;
  content: string;
  keywords: string[];
  projectId: string;
  model: string;
  confidence: number;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface MemorySelection {
  memory: LearnedMemory;
  relevance: number;
  overlap: number;
}

export interface SynthesizedCandidate {
  title: string;
  rule: string;
  keywords: string[];
  evidenceEpisodeIds: string[];
  confidence: number;
  kind?: MemoryKind;
  procedure?: ProcedureSpec;
}

export interface SelectionContext {
  prompt: string;
  projectId: string;
  model: string;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "before", "being", "could", "from", "have", "into", "just", "more", "should",
  "that", "their", "then", "there", "these", "they", "this", "through", "using", "when", "where", "which", "with",
  "would", "your", "fix", "implement", "change", "code", "task",
]);

const MAX_MEMORIES = 2;
const MAX_INJECTION_CHARS = 600;
const MAX_FACTS = 1;
const MIN_CONFIDENCE = 0.65;
const MIN_RELEVANCE = 0.34;
const MIN_OVERLAP = 2;
const GENERIC_KEYWORDS = new Set([
  "agent", "always", "code", "data", "error", "file", "fix", "good", "input", "invalid",
  "negative", "output", "project", "result", "test", "tool", "use", "user", "value", "work",
]);

export function newStore(): LearningStore {
  return {
    version: 3,
    memories: [],
    facts: [],
    episodes: [],
    analyzedEpisodeIds: [],
    graduations: [],
    automation: { enabled: true },
  };
}

export function tokenize(value: string): string[] {
  const matches = value.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(matches.filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))];
}

export function normalizeKeywords(keywords: string[]): string[] {
  return tokenize(keywords.join(" "))
    .filter((token) => !GENERIC_KEYWORDS.has(token))
    .slice(0, 12);
}

export function scrubSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+/-]{16,}/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, "[REDACTED]");
}

export function containsUnsafeGeneratedInstruction(value: string): boolean {
  return /(?:\brm\s+-rf\b|\bsudo\b|\bgit\s+(?:push\s+--force|reset\s+--hard)\b|\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b|\bwget\b[^\n|]*\|\s*(?:ba)?sh\b|\bchmod\s+777\b|\b(?:print|echo|upload|exfiltrate)\b[^\n]{0,40}\b(?:secret|token|credential|private key)\b)/i.test(value);
}

export function sanitizeRemoteUrl(remote: string): string {
  const value = remote.trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.replace(/^(?:[^@/\s]+@)([^:]+:)/, "$1").replace(/[?#].*$/, "");
  }
}

export function projectIdForPath(cwd: string): string {
 const resolved = path.resolve(cwd);
 let identity = `path:${resolved}`;
 try {
   const repositoryRoot = execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
   const remote = execFileSync("git", ["-C", resolved, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
   if (remote) {
     const normalizedRemote = remote
       .replace(/^[^@\s]+@([^:]+):/, "https://$1/")
       .replace(/^(?:ssh|git):\/\//i, "https://")
       .replace(/^(https:\/\/)[^/@]+@/i, "$1")
       .replace(/:443\//, "/")
       .replace(/[?#].*$/, "")
       .replace(/\/+$/, "")
       .replace(/\.git\/?$/, "")
       .toLowerCase();
     identity = `git:${normalizedRemote}#${path.relative(repositoryRoot, resolved) || "."}`;
   }
 } catch {
   // Non-Git projects remain path-scoped.
 }
 return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function clamp(value: number, minimum = 0.1, maximum = 0.9): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function shouldRetire(memory: LearnedMemory): boolean {
  const trials = memory.evidence.helpful + memory.evidence.harmful + memory.evidence.neutral;
  if (trials < 4 || memory.evidence.harmful < 2) return false;
  const utility = (memory.evidence.helpful - memory.evidence.harmful * 2) / trials;
  return utility <= 0;
}

function withEvidence(memory: LearnedMemory, evidence: MemoryEvidence, confidence: number, now: string): LearnedMemory {
  const updated = { ...memory, evidence, confidence: clamp(confidence), updatedAt: now };
  return shouldRetire(updated) ? { ...updated, status: "retired" } : updated;
}

export function applyOutcome(
  memory: LearnedMemory,
  outcome: { verified: boolean; harmful: boolean },
  now: string,
): LearnedMemory {
  if (memory.status === "retired") return memory;
  if (outcome.harmful) {
    return withEvidence(
      memory,
      { ...memory.evidence, harmful: memory.evidence.harmful + 1, lastHarmfulAt: now },
      memory.confidence - 0.12,
      now,
    );
  }
  if (outcome.verified) {
    return withEvidence(
      memory,
      { ...memory.evidence, helpful: memory.evidence.helpful + 1, lastHelpfulAt: now },
      memory.confidence + 0.02,
      now,
    );
  }
  return withEvidence(
    memory,
    { ...memory.evidence, neutral: memory.evidence.neutral + 1 },
    memory.confidence,
    now,
  );
}

export function applyCorrection(memory: LearnedMemory, now: string): LearnedMemory {
  if (memory.status === "retired") return memory;
  return withEvidence(
    memory,
    { ...memory.evidence, harmful: memory.evidence.harmful + 1, lastHarmfulAt: now },
    memory.confidence - 0.2,
    now,
  );
}

export function selectMemories(memories: LearnedMemory[], context: SelectionContext): MemorySelection[] {
  const promptTokens = new Set(tokenize(context.prompt));
  return memories
    .flatMap((memory): MemorySelection[] => {
      const minimumConfidence = memory.status === "candidate" ? 0.55 : MIN_CONFIDENCE;
      if (!["active", "candidate"].includes(memory.status) || memory.confidence < minimumConfidence) return [];
      if (memory.model !== "*" && memory.model !== context.model) return [];
      if (memory.scope === "project" && memory.projectId !== context.projectId) return [];
      const keywordTokens = new Set(normalizeKeywords(memory.keywords));
      if (keywordTokens.size < MIN_OVERLAP) return [];
      const overlap = [...keywordTokens].filter((token) => promptTokens.has(token)).length;
      if (overlap < MIN_OVERLAP) return [];
      const relevance = overlap / Math.min(5, Math.max(1, keywordTokens.size));
      if (relevance < MIN_RELEVANCE) return [];
      return [{ memory, relevance, overlap }];
    })
    .sort((left, right) =>
      right.relevance * right.memory.confidence - left.relevance * left.memory.confidence ||
      right.memory.confidence - left.memory.confidence ||
      left.memory.id.localeCompare(right.memory.id),
    )
    .slice(0, MAX_MEMORIES);
}

export function selectFacts(facts: LearnedFact[], context: SelectionContext): LearnedFact[] {
  const promptTokens = new Set(tokenize(context.prompt));
  return facts
    .filter((fact) => fact.status === "active" && fact.confidence >= MIN_CONFIDENCE)
    .filter((fact) => fact.projectId === context.projectId && fact.model === context.model)
    .filter((fact) => normalizeKeywords(fact.keywords).filter((token) => promptTokens.has(token)).length >= MIN_OVERLAP)
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
    .slice(0, MAX_FACTS);
}

export function renderMemoryGuidance(memory: Pick<LearnedMemory, "kind" | "rule" | "procedure">): string {
  if (memory.kind !== "procedure" || !memory.procedure) return memory.rule;
  return [
    `Goal: ${memory.procedure.goal}`,
    ...memory.procedure.steps.map((step, index) => `${index + 1}. ${step}`),
    ...memory.procedure.verification.map((step) => `Verify: ${step}`),
    ...memory.procedure.recovery.map((step) => `Recover: ${step}`),
    `Decomposition: ${memory.procedure.decomposition}`,
  ].join("\n");
}

export function memoryArtifactHash(memory: Pick<LearnedMemory, "model" | "kind" | "rule" | "keywords" | "procedure">): string {
  return createHash("sha256").update(JSON.stringify({
    model: memory.model,
    guidance: renderMemoryGuidance(memory),
    keywords: normalizeKeywords(memory.keywords).sort(),
  })).digest("hex");
}

export function buildInjection(selected: MemorySelection[]): string {
  if (selected.length === 0) return "";
  let output = "Relevant learned guidance (apply only if it fits the task):";
  for (const { memory } of selected) {
    const prefix = "\n- ";
    const remaining = MAX_INJECTION_CHARS - output.length - prefix.length;
    if (remaining <= 0) break;
    const guidance = renderMemoryGuidance(memory);
    if (guidance.length > remaining) continue;
    output += `${prefix}${guidance}`;
  }
  return output.slice(0, MAX_INJECTION_CHARS);
}

export function buildHybridInjection(selected: MemorySelection[], facts: LearnedFact[]): string {
  if (selected.length === 0 && facts.length === 0) return "";
  const lines = ["## Evidence-gated learned guidance"];
  for (const { memory } of selected) {
    const line = `- ${renderMemoryGuidance(memory)}`;
    if ([...lines, line].join("\n").length <= MAX_INJECTION_CHARS) lines.push(line);
  }
  for (const fact of facts) {
    const line = `- Project fact: ${fact.content}`;
    if ([...lines, line].join("\n").length <= MAX_INJECTION_CHARS) lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function slug(value: string): string {
  return tokenize(value).slice(0, 6).join("-") || "memory";
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left.flatMap(tokenize));
  const b = new Set(right.flatMap(tokenize));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return [...a].filter((token) => b.has(token)).length / union.size;
}

const OPPOSING_TERMS: Array<[string, string]> = [
  ["always", "never"], ["avoid", "prefer"], ["disable", "enable"], ["skip", "ensure"], ["throw", "return"],
];

export function memoriesContradict(
  left: Pick<LearnedMemory, "rule" | "keywords">,
  right: Pick<LearnedMemory, "rule" | "keywords">,
): boolean {
  if (jaccard(normalizeKeywords(left.keywords), normalizeKeywords(right.keywords)) < 0.5) return false;
  const leftRule = left.rule.toLowerCase();
  const rightRule = right.rule.toLowerCase();
  return OPPOSING_TERMS.some(([a, b]) =>
    (leftRule.includes(a) && rightRule.includes(b)) || (leftRule.includes(b) && rightRule.includes(a)),
  );
}

export function mergeSynthesizedCandidates(
  store: LearningStore,
  candidates: SynthesizedCandidate[],
  context: { projectId: string; model: string; now: string },
): LearningStore {
  const memories = [...store.memories];
  for (const candidate of candidates.slice(0, 3)) {
const keywords = normalizeKeywords(candidate.keywords);
const rule = scrubSecrets(candidate.rule.trim()).slice(0, 360);
if (keywords.length < 2 || rule.length < 20 || containsUnsafeGeneratedInstruction(rule)) continue;
    const sourceEpisodeIds = [...new Set(candidate.evidenceEpisodeIds)].slice(0, 8);
    if (sourceEpisodeIds.length < 3) continue;
    const baseId = slug(candidate.title);
    let id = baseId;
    let suffix = 2;
    while (memories.some((memory) => memory.id === id)) id = `${baseId}-${suffix++}`;
    const confidence = clamp(candidate.confidence, 0.35, 0.85);
    const procedure = candidate.kind === "procedure" && candidate.procedure &&
      candidate.procedure.steps.length >= 2 && candidate.procedure.verification.length >= 1
      ? {
        goal: scrubSecrets(candidate.procedure.goal).slice(0, 240),
        steps: candidate.procedure.steps.map((step) => scrubSecrets(step).slice(0, 240)).slice(0, 12),
        verification: candidate.procedure.verification.map((step) => scrubSecrets(step).slice(0, 240)).slice(0, 6),
        recovery: candidate.procedure.recovery.map((step) => scrubSecrets(step).slice(0, 240)).slice(0, 6),
        decomposition: scrubSecrets(candidate.procedure.decomposition).slice(0, 80),
      }
      : undefined;
    if (candidate.kind === "procedure" && !procedure) continue;
    if (procedure && containsUnsafeGeneratedInstruction(JSON.stringify(procedure))) continue;
    if (procedure && renderMemoryGuidance({ kind: "procedure", rule, procedure }).length > 520) continue;
    const proposed: LearnedMemory = {
      id,
      title: scrubSecrets(candidate.title.trim()).slice(0, 100),
      rule,
      keywords,
      scope: "project",
      kind: procedure ? "procedure" : "guidance",
      origin: "synthesized",
      ...(procedure ? { procedure } : {}),
      projectId: context.projectId,
      model: context.model,
      status: "candidate",
      confidence,
      evidence: { observations: sourceEpisodeIds.length, helpful: 0, harmful: 0, neutral: 0 },
      sourceEpisodeIds,
      createdAt: context.now,
      updatedAt: context.now,
    };
    const duplicate = memories.find((memory) =>
      memory.projectId === context.projectId && memory.model === context.model && jaccard(memory.keywords, keywords) >= 0.65,
    );
    if (duplicate && memoriesContradict(duplicate, proposed)) {
      proposed.status = "conflicted";
      memories.push(proposed);
      continue;
    }
    if (duplicate) {
      if (memoryArtifactHash(duplicate) === memoryArtifactHash(proposed)) {
        const index = memories.indexOf(duplicate);
        const mergedSources = [...new Set([...duplicate.sourceEpisodeIds, ...sourceEpisodeIds])];
        memories[index] = {
          ...duplicate,
          sourceEpisodeIds: mergedSources,
          evidence: { ...duplicate.evidence, observations: mergedSources.length },
          updatedAt: context.now,
        };
      } else {
        memories.push(proposed);
      }
      continue;
    }
    const conflicting = memories.some((memory) => memory.status === "active" && memoriesContradict(memory, proposed));
    proposed.status = conflicting ? "conflicted" : "candidate";
    memories.push(proposed);
  }
  return { ...store, memories };
}

export function isCorrectionPrompt(prompt: string): boolean {
 return /^(?:correction\s*:|that (?:was|is) wrong\b|your previous (?:answer|change|guidance) (?:was|is|caused)\b|revert (?:your|the) previous\b|undo (?:your|the|that) (?:previous )?(?:change|guidance)\b|the previous .{0,40}\b(?:broke|failed|was wrong)\b)/i.test(prompt.trim());
}

export function hasVerificationEvidence(response: string): boolean {
  return /\b(?:tests?|typecheck|build|lint|verification)\b[^\n]{0,80}\b(?:pass(?:ed)?|clean|successful|0 fail)/i.test(response);
}

export function maintainStore(store: LearningStore, now: string): LearningStore {
  const nowMs = Date.parse(now);
 let memories = store.memories.map((memory) => {
    if (memory.status === "retired" || memory.status === "conflicted") return memory;
    const ageDays = (nowMs - Date.parse(memory.updatedAt)) / 86_400_000;
    if (memory.status === "candidate" && ageDays >= 28) return { ...memory, status: "retired" as const, updatedAt: now };
    if (ageDays < 14) return memory;
    const confidence = clamp(memory.confidence - Math.min(0.15, Math.floor(ageDays / 14) * 0.03));
    return {
      ...memory,
      confidence,
      status: confidence < MIN_CONFIDENCE && ageDays >= 30 ? "retired" as const : memory.status,
      updatedAt: now,
    };
 });
 const candidates = memories.filter((memory) => memory.status === "candidate")
   .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
 const overflow = new Set(candidates.slice(64).map((memory) => memory.id));
 memories = memories.map((memory) => overflow.has(memory.id) ? { ...memory, status: "retired" as const, updatedAt: now } : memory);
 const protectedIds = new Set(store.graduations.map((record) => record.memoryId));
 const retainedRetired = new Set(memories.filter((memory) => memory.status === "retired")
   .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
   .slice(0, 128)
   .map((memory) => memory.id));
 memories = memories.filter((memory) => memory.status !== "retired" || protectedIds.has(memory.id) || retainedRetired.has(memory.id));
  return { ...store, memories, maintenanceAt: now };
}

function migrateArm(value: Partial<ArmEvidence> | undefined): ArmEvidence {
  return {
    trials: value?.trials ?? 0,
    verified: value?.verified ?? 0,
    corrected: value?.corrected ?? 0,
    tokens: value?.tokens ?? 0,
    cost: value?.cost ?? 0,
    latencyMs: value?.latencyMs ?? 0,
    failedAttempts: value?.failedAttempts ?? 0,
    strata: value?.strata ?? {},
  };
}

function migrateMemory(memory: LearnedMemory): LearnedMemory {
 const kind = memory.kind === "procedure" && memory.procedure ? "procedure" : "guidance";
 const origin = memory.origin ?? (memory.revalidationOf ? "revalidated" : memory.sourceEpisodeIds.length > 0 ? "synthesized" : "user");
 if (!memory.experiment) return { ...memory, kind, origin, revisions: Array.isArray(memory.revisions) ? memory.revisions.slice(-8) : [] };
  return {
    ...memory,
 kind,
 origin,
    revisions: Array.isArray(memory.revisions) ? memory.revisions.slice(-8) : [],
    experiment: {
      ...memory.experiment,
      treatment: migrateArm(memory.experiment.treatment),
      control: migrateArm(memory.experiment.control),
    },
  };
}

export function migrateStore(value: unknown): LearningStore {
  if (!value || typeof value !== "object") return newStore();
  const source = value as Partial<LearningStore>;
  const episodes = Array.isArray(source.episodes)
    ? source.episodes.map((episode) => ({
      ...episode,
      status: episode.status === "pending" ? "pending" as const : "settled" as const,
      autonomous: typeof episode.autonomous === "boolean" ? episode.autonomous : true,
      cost: typeof episode.cost === "number" ? episode.cost : 0,
      latencyMs: typeof episode.latencyMs === "number" ? episode.latencyMs : 0,
      failedAttempts: typeof episode.failedAttempts === "number" ? episode.failedAttempts : episode.toolErrors,
      taskStratum: typeof episode.taskStratum === "string" ? episode.taskStratum : "legacy/unknown/unknown",
      memoryAssignments: Array.isArray(episode.memoryAssignments)
        ? episode.memoryAssignments
        : (episode.injectedMemoryIds ?? []).map((memoryId) => ({ memoryId, arm: "treatment" as const })),
    }))
    : [];
  return {
    version: 3,
    memories: Array.isArray(source.memories) ? source.memories.map(migrateMemory) : [],
    facts: Array.isArray(source.facts) ? source.facts : [],
    episodes,
    analyzedEpisodeIds: Array.isArray(source.analyzedEpisodeIds) ? source.analyzedEpisodeIds : [],
    graduations: Array.isArray(source.graduations) ? source.graduations : [],
    automation: source.automation && typeof source.automation.enabled === "boolean"
      ? source.automation
      : { enabled: true },
    ...(source.optimizerMemory ? { optimizerMemory: source.optimizerMemory } : {}),
    ...(typeof source.maintenanceAt === "string" ? { maintenanceAt: source.maintenanceAt } : {}),
  };
}

export async function loadStore(filePath: string): Promise<LearningStore> {
  try {
    return migrateStore(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return newStore();
    throw error;
  }
}

export async function saveStore(filePath: string, store: LearningStore): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
 const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}
