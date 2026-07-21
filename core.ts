import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

export const STORE_VERSION = 4 as const;

export interface MemoryEvidence {
  observations: number;
  helpful: number;
  harmful: number;
  neutral: number;
}

export interface Procedure {
  goal: string;
  steps: string[];
  verification: string[];
  recovery: string[];
  decomposition?: string;
}

export interface DeploymentRecord {
  target: "agents" | "skill";
  destination: string;
  contentHash: string;
  graduatedAt: string;
  status: "active" | "rolled_back" | "quarantined";
  rolledBackAt?: string;
  reason?: string;
}

export interface ApprovedMemory {
  id: string;
  title: string;
  rule: string;
  keywords: string[];
  scope: "project" | "global";
  kind: "rule" | "guidance" | "procedure";
  procedure?: Procedure;
  projectId: string;
  model?: string;
  origin: "candidate" | "legacy" | "manual" | "synthesized" | "revalidated" | "federated" | "user";
  confidence: number;
  evidence: MemoryEvidence;
  sourceInteractionIds?: string[];
  sourceEpisodeIds?: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  disabled?: boolean;
  disabledReason?: string;
  status?: "active" | "candidate" | "retired" | "conflicted";
  deployment?: DeploymentRecord;
}

export interface CandidateReplay {
  matches: number;
  helpful: number;
  harmful: number;
}

export interface CandidateCanary {
  trials: number;
  helpful: number;
  harmful: number;
}

export interface Candidate {
  id: string;
  title: string;
  rule: string;
  keywords: string[];
  projectId: string;
  state: "observed" | "canary" | "rejected";
  evidenceInteractionIds: string[];
  replay: CandidateReplay;
  canary: CandidateCanary;
  createdAt: string;
  updatedAt: string;
  rejectedReason?: string;
}

export interface GraduationRecord extends DeploymentRecord {
  memoryId: string;
}

export type LearnedMemory = ApprovedMemory;

export interface Attribution {
  interactionId: string;
  memoryIds: string[];
  candidateIds: string[];
  injectedAt: string;
  outcome?: "helpful" | "harmful" | "neutral";
}

export interface HistoryCursor {
  sessionId?: string;
  sessionFile?: string;
  entryId?: string;
  previousInteractionId?: string;
  processedAt?: string;
  attributions: Attribution[];
}

export interface LearningStore {
  version: typeof STORE_VERSION;
  approvedMemories: ApprovedMemory[];
  candidates: Candidate[];
  historyCursor: HistoryCursor;
}

const EvidenceSchema = z.object({
  observations: z.number().int().nonnegative(),
  helpful: z.number().int().nonnegative(),
  harmful: z.number().int().nonnegative(),
  neutral: z.number().int().nonnegative(),
});

const ProcedureSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(z.string().min(1)),
  verification: z.array(z.string().min(1)),
  recovery: z.array(z.string().min(1)),
});

const DeploymentSchema = z.object({
  target: z.enum(["agents", "skill"]),
  destination: z.string().min(1),
  contentHash: z.string().min(1),
  graduatedAt: z.string().min(1),
  status: z.enum(["active", "rolled_back", "quarantined"]),
  rolledBackAt: z.string().optional(),
  reason: z.string().optional(),
});

const ApprovedMemorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rule: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  scope: z.enum(["project", "global"]),
  kind: z.enum(["rule", "procedure"]),
  procedure: ProcedureSchema.optional(),
  projectId: z.string().min(1),
  model: z.string().optional(),
  origin: z.enum(["candidate", "legacy", "manual"]),
  confidence: z.number().min(0).max(1),
  evidence: EvidenceSchema,
  sourceInteractionIds: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastUsedAt: z.string().optional(),
  disabled: z.boolean().optional(),
  disabledReason: z.string().optional(),
  status: z.enum(["active", "candidate", "retired", "conflicted"]).optional(),
  deployment: DeploymentSchema.optional(),
});

const CandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rule: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  projectId: z.string().min(1),
  state: z.enum(["observed", "canary", "rejected"]),
  evidenceInteractionIds: z.array(z.string().min(1)),
  replay: z.object({
    matches: z.number().int().nonnegative(),
    helpful: z.number().int().nonnegative(),
    harmful: z.number().int().nonnegative(),
  }),
  canary: z.object({
    trials: z.number().int().nonnegative(),
    helpful: z.number().int().nonnegative(),
    harmful: z.number().int().nonnegative(),
  }),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  rejectedReason: z.string().optional(),
});

const AttributionSchema = z.object({
  interactionId: z.string().min(1),
  memoryIds: z.array(z.string().min(1)),
  candidateIds: z.array(z.string().min(1)),
  injectedAt: z.string().min(1),
  outcome: z.enum(["helpful", "harmful", "neutral"]).optional(),
});

const StoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  approvedMemories: z.array(ApprovedMemorySchema),
  candidates: z.array(CandidateSchema),
  historyCursor: z.object({
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    entryId: z.string().optional(),
    previousInteractionId: z.string().optional(),
    processedAt: z.string().optional(),
    attributions: z.array(AttributionSchema),
  }),
});

export interface LearningConfig {
  idleMs: number;
  historyBatchSize: number;
  maxApprovedMemories: number;
  maxCandidates: number;
  maxAttributions: number;
  maxInjectedMemories: number;
  maxInjectionChars: number;
  repeatThreshold: number;
  replayMinimumMatches: number;
  replayMinimumSuccessRate: number;
  canaryRate: number;
  promotionMinimumTrials: number;
  promotionMinimumHelpful: number;
  rollbackMinimumTrials: number;
  rollbackHarmfulRate: number;
  graduationMinimumHelpful: number;
  graduationMinimumAgeDays: number;
  notifications: {
    promotions: boolean;
    rollbacks: boolean;
    failures: boolean;
  };
}

export const ConfigSchema = z.object({
  idleMs: z.number().int().nonnegative(),
  historyBatchSize: z.number().int().positive().max(500),
  maxApprovedMemories: z.number().int().positive().max(500),
  maxCandidates: z.number().int().positive().max(500),
  maxAttributions: z.number().int().positive().max(500),
  maxInjectedMemories: z.number().int().positive().max(10),
  maxInjectionChars: z.number().int().positive().max(10_000),
  repeatThreshold: z.number().int().min(2).max(20),
  replayMinimumMatches: z.number().int().min(2).max(100),
  replayMinimumSuccessRate: z.number().min(0).max(1),
  canaryRate: z.number().min(0).max(1),
  promotionMinimumTrials: z.number().int().min(1).max(100),
  promotionMinimumHelpful: z.number().int().min(1).max(100),
  rollbackMinimumTrials: z.number().int().min(1).max(100),
  rollbackHarmfulRate: z.number().min(0).max(1),
  graduationMinimumHelpful: z.number().int().min(1).max(1_000),
  graduationMinimumAgeDays: z.number().int().nonnegative().max(3_650),
  notifications: z.object({
    promotions: z.boolean(),
    rollbacks: z.boolean(),
    failures: z.boolean(),
  }),
});

const STOPWORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "does", "doing",
  "from", "have", "into", "more", "must", "only", "should", "than", "that", "their", "then",
  "there", "these", "they", "this", "those", "through", "using", "very", "what", "when", "where",
  "which", "while", "with", "would", "your",
]);

export function normalizeKeywords(values: string[]): string[] {
  const tokens = values
    .join(" ")
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return [...new Set(tokens.filter((token) => !STOPWORDS.has(token)))];
}

export function scrubSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat|xoxb|xoxp)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/(["']?(?:token|api[_-]?key|password|secret)["']?\s*[:=]\s*)(["']?)[^"',\s]+(["']?)/gi, "$1$2[redacted]$3");
}

export function sanitizeRemoteUrl(remote: string): string {
  const value = remote.trim();
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

export function renderMemoryGuidance(memory: Pick<ApprovedMemory, "kind" | "rule" | "procedure">): string {
  if (memory.kind !== "procedure" || !memory.procedure) return memory.rule;
  return [
    memory.procedure.goal,
    ...memory.procedure.steps.map((step, index) => `${index + 1}. ${step}`),
    ...memory.procedure.verification.map((step) => `Verify: ${step}`),
  ].join("\n");
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function candidateId(rule: string): string {
  return stableId("candidate", normalizeKeywords([rule]).join("\0"));
}

export function approvedMemoryId(rule: string): string {
  return stableId("memory", normalizeKeywords([rule]).join("\0"));
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.replace(/^\/+|\/+$/g, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export function projectIdForPath(cwd: string): string {
  try {
    const rootResult = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = rootResult.exitCode === 0 ? rootResult.stdout.toString().trim() : path.resolve(cwd);
    const remoteResult = Bun.spawnSync(["git", "-C", root, "config", "--get", "remote.origin.url"]);
    const identity = remoteResult.exitCode === 0 && remoteResult.stdout.toString().trim()
      ? normalizeRemote(remoteResult.stdout.toString())
      : path.resolve(root);
    return stableId("project", identity);
  } catch {
    return stableId("project", path.resolve(cwd));
  }
}

export function newStore(): LearningStore {
  return {
    version: STORE_VERSION,
    approvedMemories: [],
    candidates: [],
    historyCursor: { attributions: [] },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function legacyEvidence(value: unknown): MemoryEvidence {
  const evidence = asRecord(value);
  return {
    observations: Math.max(0, Math.floor(asNumber(evidence?.observations, 0))),
    helpful: Math.max(0, Math.floor(asNumber(evidence?.helpful, 0))),
    harmful: Math.max(0, Math.floor(asNumber(evidence?.harmful, 0))),
    neutral: Math.max(0, Math.floor(asNumber(evidence?.neutral, 0))),
  };
}

function legacyProcedure(value: unknown): Procedure | undefined {
  const procedure = asRecord(value);
  if (!procedure) return undefined;
  const goal = asString(procedure.goal, "");
  const steps = asStringArray(procedure.steps);
  if (!goal || steps.length === 0) return undefined;
  return {
    goal,
    steps,
    verification: asStringArray(procedure.verification),
    recovery: asStringArray(procedure.recovery),
  };
}

function migrateLegacyStore(value: unknown): LearningStore {
  const source = asRecord(value);
  if (!source) return newStore();
  const graduations = Array.isArray(source.graduations)
    ? source.graduations.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const activeDeployments = new Map<string, DeploymentRecord>();
  for (const item of graduations) {
    const memoryId = asString(item.memoryId, "");
    const target = item.target === "skill" ? "skill" : item.target === "agents" ? "agents" : undefined;
    const status = item.status === "rolled_back" || item.status === "quarantined" ? item.status : "active";
    if (!memoryId || !target || status !== "active") continue;
    activeDeployments.set(memoryId, {
      target,
      destination: asString(item.destination, ""),
      contentHash: asString(item.contentHash, ""),
      graduatedAt: asString(item.graduatedAt, new Date(0).toISOString()),
      status,
    });
  }

  const approvedMemories: ApprovedMemory[] = [];
  const seen = new Set<string>();
  for (const collection of [source.memories, source.facts]) {
    if (!Array.isArray(collection)) continue;
    for (const raw of collection) {
      const item = asRecord(raw);
      if (!item || item.status !== "active") continue;
      const rule = asString(item.rule, asString(item.value, ""));
      if (!rule) continue;
      const id = asString(item.id, approvedMemoryId(rule));
      if (seen.has(id)) continue;
      const procedure = legacyProcedure(item.procedure);
      const now = new Date().toISOString();
      approvedMemories.push({
        id,
        title: asString(item.title, rule.slice(0, 72)),
        rule,
        keywords: normalizeKeywords([...asStringArray(item.keywords), rule]).slice(0, 16),
        scope: item.scope === "global" ? "global" : "project",
        kind: procedure ? "procedure" : "rule",
        ...(procedure ? { procedure } : {}),
        projectId: asString(item.projectId, "legacy"),
        origin: "legacy",
        confidence: Math.min(1, Math.max(0, asNumber(item.confidence, 0.75))),
        evidence: legacyEvidence(item.evidence),
        sourceInteractionIds: asStringArray(item.sourceEpisodeIds),
        createdAt: asString(item.createdAt, now),
        updatedAt: asString(item.updatedAt, now),
        ...(activeDeployments.has(id) ? { deployment: activeDeployments.get(id) } : {}),
      });
      seen.add(id);
    }
  }

  return {
    ...newStore(),
    approvedMemories,
  };
}

export function parseStore(value: unknown): LearningStore {
  const record = asRecord(value);
  if (record?.version === STORE_VERSION) return StoreSchema.parse(value);
  return migrateLegacyStore(value);
}

export async function loadStore(filePath: string): Promise<LearningStore> {
  try {
    return parseStore(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return newStore();
    throw error;
  }
}

export async function saveStore(filePath: string, store: LearningStore): Promise<void> {
  const validated = StoreSchema.parse(store);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function overlapScore(promptTokens: Set<string>, memory: Pick<ApprovedMemory, "keywords" | "confidence" | "evidence">): number {
  const overlap = memory.keywords.filter((keyword) => promptTokens.has(keyword)).length;
  if (overlap === 0) return 0;
  const observations = Math.max(1, memory.evidence.observations);
  const helpfulRate = memory.evidence.helpful / observations;
  const harmfulRate = memory.evidence.harmful / observations;
  return overlap * 3 + memory.confidence * 2 + helpfulRate - harmfulRate * 3;
}

export function selectApprovedMemories(
  store: LearningStore,
  prompt: string,
  maxItems: number,
  maxChars: number,
): ApprovedMemory[] {
  const promptTokens = new Set(normalizeKeywords([prompt]));
  const ranked = store.approvedMemories
    .map((memory) => ({ memory, score: overlapScore(promptTokens, memory) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id));
  const selected: ApprovedMemory[] = [];
  let used = 0;
  for (const { memory } of ranked) {
    const size = memory.rule.length + 4;
    if (selected.length >= maxItems || used + size > maxChars) continue;
    selected.push(memory);
    used += size;
  }
  return selected;
}

function deterministicFraction(value: string): number {
  const prefix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return Number.parseInt(prefix, 16) / 0xffffffff;
}

export function selectCanaryCandidate(
  store: LearningStore,
  prompt: string,
  interactionId: string,
  rate: number,
): Candidate | undefined {
  if (deterministicFraction(interactionId) >= rate) return undefined;
  const promptTokens = new Set(normalizeKeywords([prompt]));
  return store.candidates
    .filter((candidate) =>
      candidate.state === "canary" &&
      candidate.keywords.some((keyword) => promptTokens.has(keyword))
    )
    .sort((left, right) => right.evidenceInteractionIds.length - left.evidenceInteractionIds.length || left.id.localeCompare(right.id))
    .at(0);
}

export function recordAttribution(
  store: LearningStore,
  attribution: Attribution,
  maxAttributions: number,
): LearningStore {
  const withoutDuplicate = store.historyCursor.attributions.filter(
    (item) => item.interactionId !== attribution.interactionId,
  );
  return {
    ...store,
    historyCursor: {
      ...store.historyCursor,
      attributions: [...withoutDuplicate, attribution].slice(-maxAttributions),
    },
  };
}

export function memoryPrompt(memories: ApprovedMemory[], candidate?: Candidate): string | undefined {
  if (memories.length === 0 && !candidate) return undefined;
  const lines = [
    "<continuous-learning>",
    "Apply only when relevant; current user and repository instructions still win.",
    ...memories.map((memory) => `- ${memory.rule}`),
    ...(candidate ? [`- [canary] ${candidate.rule}`] : []),
    "</continuous-learning>",
  ];
  return lines.join("\n");
}
