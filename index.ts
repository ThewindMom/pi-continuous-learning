import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  ConfigSchema,
  approvedMemoryId,
  candidateId,
  loadStore,
  memoryPrompt,
  normalizeKeywords,
  projectIdForPath,
  recordAttribution,
  saveStore,
  selectApprovedMemories,
  selectCanaryCandidate,
  type ApprovedMemory,
  type Attribution,
  type Candidate,
  type LearningConfig,
  type LearningStore,
} from "./core.ts";
import { attributionOutcome, parseInteractions, type Interaction } from "./history.ts";
import {
  checkGraduation,
  cleanupOrphanedAgentBlocks,
  cleanupOrphanedSkills,
  graduateMemory,
  graduationContentHash,
} from "./graduation.ts";
import type { GraduationTarget } from "./graduation.ts";
import { appendDiagnostic, sanitizeLegacyCorpus } from "./security.ts";

const AGENT_DIR = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "/tmp", ".pi", "agent"));
function stateRoot(): string {
  return process.env.PI_CONTINUOUS_LEARNING_ROOT ??
    path.join(path.dirname(AGENT_DIR), "continuous-learning-hybrid", "v3");
}

function hashPrompt(sessionId: string, prompt: string): string {
  return `prompt:${createHash("sha256").update(`${sessionId}\0${prompt}`).digest("hex").slice(0, 16)}`;
}

function sessionPath(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionFile?.();
  } catch {
    return undefined;
  }
}

function sessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager?.getSessionId?.() ?? "memory";
  } catch {
    return "memory";
  }
}

function notify(ctx: ExtensionContext, enabled: boolean, message: string): void {
  if (enabled && ctx.hasUI) ctx.ui.notify(message, "info");
}

function memoryFromCandidate(candidate: Candidate, projectId: string, now: string): ApprovedMemory {
  return {
    id: approvedMemoryId(candidate.rule),
    title: candidate.title,
    rule: candidate.rule,
    keywords: candidate.keywords,
    scope: "project",
    kind: "rule",
    projectId,
    origin: "candidate",
    confidence: 0.72,
    evidence: {
      observations: candidate.canary.trials,
      helpful: candidate.canary.helpful,
      harmful: candidate.canary.harmful,
      neutral: Math.max(0, candidate.canary.trials - candidate.canary.helpful - candidate.canary.harmful),
    },
    sourceInteractionIds: candidate.evidenceInteractionIds,
    createdAt: candidate.createdAt,
    updatedAt: now,
  };
}

function deriveCandidate(interactions: Interaction[], projectId: string, config: LearningConfig, now: string): Candidate | undefined {
  const repeated = new Map<string, Interaction[]>();
  for (const interaction of interactions.filter((item) => item.harmful || item.helpful)) {
    const keywords = normalizeKeywords(interaction.keywords).slice(0, 6);
    if (keywords.length < 2) continue;
    const signature = keywords.slice(0, 4).join("|");
    repeated.set(signature, [...(repeated.get(signature) ?? []), interaction]);
  }
  const group = [...repeated.values()].sort((left, right) => right.length - left.length)[0];
  if (!group || group.length < config.repeatThreshold) return undefined;
  const keywords = normalizeKeywords(group.flatMap((item) => item.keywords)).slice(0, 6);
  const rule = `For ${keywords.slice(0, 4).join(", ")}, verify the result before claiming completion and address any failed check.`;
  const id = candidateId(rule);
  return {
    id,
    title: `Verify ${keywords.slice(0, 3).join(" ")}`,
    rule,
    keywords,
    projectId,
    state: "observed",
    evidenceInteractionIds: [...new Set(group.map((item) => item.id))].slice(0, 32),
    replay: {
      matches: group.length,
      helpful: group.filter((item) => item.helpful).length,
      harmful: group.filter((item) => item.harmful).length,
    },
    canary: { trials: 0, helpful: 0, harmful: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

export function applyInteractionEvidence(
  store: LearningStore,
  interaction: Interaction,
  attributions: Attribution[],
  config: LearningConfig,
  now: string,
): { store: LearningStore; promoted: number; rolledBack: number } {
  const attributed = attributions.filter((item) =>
    item.interactionId === interaction.id ||
    item.interactionId === hashPrompt(store.historyCursor.sessionId ?? "memory", interaction.userPrompt),
  );
  if (attributed.length === 0) return { store, promoted: 0, rolledBack: 0 };
  if (attributed.some((item) => item.outcome)) return { store, promoted: 0, rolledBack: 0 };
  const completed = attributionOutcome(attributed[0]!, interaction);
  const outcome = completed.outcome!;
  let promoted = 0;
  let rolledBack = 0;
  let candidates = store.candidates;
  let approvedMemories = store.approvedMemories.map((memory) => {
    if (!completed.memoryIds.includes(memory.id) || memory.disabled) return memory;
    const evidence = {
      ...memory.evidence,
      observations: memory.evidence.observations + 1,
      helpful: memory.evidence.helpful + (outcome === "helpful" ? 1 : 0),
      harmful: memory.evidence.harmful + (outcome === "harmful" ? 1 : 0),
      neutral: memory.evidence.neutral + (outcome === "neutral" ? 1 : 0),
    };
    const harmfulRate = evidence.harmful / Math.max(1, evidence.observations);
    const disabled = evidence.observations >= config.rollbackMinimumTrials &&
      harmfulRate >= config.rollbackHarmfulRate;
    if (disabled) rolledBack += 1;
    return { ...memory, evidence, confidence: disabled ? 0.2 : memory.confidence, disabled, updatedAt: now };
  });
  for (const candidateIdValue of completed.candidateIds) {
    candidates = candidates.map((candidate) => {
      if (candidate.id !== candidateIdValue || candidate.state !== "canary") return candidate;
      const canary = {
        ...candidate.canary,
        trials: candidate.canary.trials + 1,
        helpful: candidate.canary.helpful + (outcome === "helpful" ? 1 : 0),
        harmful: candidate.canary.harmful + (outcome === "harmful" ? 1 : 0),
      };
      const ready = canary.trials >= config.promotionMinimumTrials &&
        canary.helpful >= config.promotionMinimumHelpful &&
        canary.harmful === 0;
      if (ready && !approvedMemories.some((memory) => memory.id === approvedMemoryId(candidate.rule))) {
        approvedMemories = [...approvedMemories, memoryFromCandidate({ ...candidate, canary }, candidate.projectId, now)];
        promoted += 1;
        return { ...candidate, canary, state: "rejected" as const, rejectedReason: "promoted", updatedAt: now };
      }
      if (canary.trials >= config.rollbackMinimumTrials &&
        canary.harmful / canary.trials >= config.rollbackHarmfulRate) {
        return { ...candidate, canary, state: "rejected" as const, rejectedReason: "harmful canary", updatedAt: now };
      }
      return { ...candidate, canary, updatedAt: now };
    });
  }
  return {
    store: { ...store, approvedMemories, candidates },
    promoted,
    rolledBack,
  };
}

export default function selectiveLearning(pi: ExtensionAPI): void {
  let config: LearningConfig | undefined;
  let store: LearningStore | undefined;
  let projectId = "";
  let statePath = "";
  let ownsLock = false;
  let closed = false;
  let workerTimer: ReturnType<typeof setTimeout> | undefined;
  let workerPromise: Promise<void> | undefined;
  let activityGeneration = 0;
  let lockPath = "";
  let lockOwner = "";
  let persistQueue: Promise<void> = Promise.resolve();

  const persist = async (): Promise<void> => {
    if (!store || !statePath || !ownsLock || closed) return;
    const snapshot = store;
    persistQueue = persistQueue.then(() => saveStore(statePath, snapshot)).catch(() => undefined);
    await persistQueue;
  };

  const releaseLock = async (): Promise<void> => {
    if (!ownsLock || !lockPath || !lockOwner) return;
    const owner = await fs.readFile(path.join(lockPath, "owner"), "utf8").catch(() => "");
    if (owner === lockOwner) await fs.rm(lockPath, { recursive: true, force: true });
    ownsLock = false;
  };

  const acquireLock = async (): Promise<boolean> => {
    lockPath = path.join(path.dirname(statePath), "worker.lock");
    await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    try {
      await fs.mkdir(lockPath);
      lockOwner = randomUUID();
      await fs.writeFile(path.join(lockPath, "owner"), lockOwner, { mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(lockPath).catch(() => undefined);
      if (stats && Date.now() - stats.mtimeMs > 30 * 60_000) {
        await fs.rm(lockPath, { recursive: true, force: true });
        return acquireLock();
      }
      return false;
    }
  };

  const cancelWorker = (): void => {
    activityGeneration += 1;
    if (workerTimer) clearTimeout(workerTimer);
    workerTimer = undefined;
  };

  const runWorker = async (ctx: ExtensionContext, generation: number): Promise<void> => {
    if (!store || !config || !ownsLock || closed || generation !== activityGeneration) return;
    const sessionFile = sessionPath(ctx);
    if (!sessionFile) return;
    const currentSessionId = sessionId(ctx);
    const cursor = store.historyCursor.sessionId === currentSessionId
      ? store.historyCursor
      : { ...store.historyCursor, sessionId: currentSessionId, sessionFile, entryId: undefined };
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const batch = parseInteractions(entries as any, cursor, ctx.sessionManager?.getLeafId?.(), config.historyBatchSize);
    let nextStore: LearningStore = { ...store, historyCursor: { ...batch.cursor, sessionId: currentSessionId, sessionFile } };
    const pendingAttributions = nextStore.historyCursor.attributions;
    let promoted = 0;
    let rolledBack = 0;
    for (const interaction of batch.interactions) {
      const applied = applyInteractionEvidence(nextStore, interaction, pendingAttributions, config, new Date().toISOString());
      nextStore = applied.store;
      promoted += applied.promoted;
      rolledBack += applied.rolledBack;
      nextStore = {
        ...nextStore,
        historyCursor: {
          ...nextStore.historyCursor,
          attributions: nextStore.historyCursor.attributions
            .map((item) => item.interactionId === interaction.id ? { ...item, outcome: interaction.harmful ? "harmful" : interaction.helpful ? "helpful" : "neutral" } : item),
        },
      };
    }
    const derived = deriveCandidate(batch.interactions, projectId, config, new Date().toISOString());
    if (derived) {
      const existing = nextStore.candidates.find((candidate) => candidate.id === derived.id);
      const merged = existing ? {
        ...existing,
        evidenceInteractionIds: [...new Set([...existing.evidenceInteractionIds, ...derived.evidenceInteractionIds])].slice(-32),
        replay: {
          matches: existing.replay.matches + derived.replay.matches,
          helpful: existing.replay.helpful + derived.replay.helpful,
          harmful: existing.replay.harmful + derived.replay.harmful,
        },
        updatedAt: derived.updatedAt,
      } : derived;
      const state: Candidate["state"] = merged.state === "rejected" ? "rejected" :
        merged.replay.matches >= config.replayMinimumMatches &&
        merged.replay.helpful / merged.replay.matches >= config.replayMinimumSuccessRate ? "canary" : "observed";
      nextStore = {
        ...nextStore,
        candidates: existing
          ? nextStore.candidates.map((candidate) => candidate.id === merged.id ? { ...merged, state } : candidate)
          : [...nextStore.candidates, { ...merged, state }].slice(-config.maxCandidates),
      };
    }
    if (generation !== activityGeneration || closed || !ownsLock) return;
    store = {
      ...nextStore,
      historyCursor: {
        ...nextStore.historyCursor,
        attributions: nextStore.historyCursor.attributions.slice(-config.maxAttributions),
      },
      approvedMemories: nextStore.approvedMemories.slice(-config.maxApprovedMemories),
    };
    await persist();
    if (promoted > 0) notify(ctx, config.notifications.promotions, "Learned one project rule.");
    if (rolledBack > 0) notify(ctx, config.notifications.rollbacks, "Rolled back one harmful candidate.");
    if (batch.hasMore && generation === activityGeneration) scheduleWorker(ctx);
  };

  function scheduleWorker(ctx: ExtensionContext): void {
    if (!config || !store || !ownsLock || closed || workerTimer || workerPromise) return;
    const generation = activityGeneration;
    workerTimer = setTimeout(() => {
      workerTimer = undefined;
      workerPromise = runWorker(ctx, generation)
        .catch(async (error) => {
          await appendDiagnostic(path.join(stateRoot(), "diagnostics.jsonl"), "idle-worker", error);
          if (config?.notifications.failures) notify(ctx, true, "Continuous learning worker failed.");
        })
        .finally(() => { workerPromise = undefined; });
    }, config.idleMs);
    workerTimer.unref?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    closed = false;
    config = ConfigSchema.parse(JSON.parse(await fs.readFile(path.join(import.meta.dirname, "config.json"), "utf8")));
    projectId = projectIdForPath(ctx.cwd);
    statePath = path.join(stateRoot(), "projects", projectId, "state.json");
    ownsLock = await acquireLock();
    store = await loadStore(statePath);
    if (ownsLock) {
      await cleanupOrphanedAgentBlocks(ctx.cwd, new Set(store.approvedMemories.filter((memory) => memory.deployment?.status === "active").map((memory) => memory.id)));
      await cleanupOrphanedSkills(AGENT_DIR, new Set(store.approvedMemories.filter((memory) => memory.deployment?.status === "active").map((memory) => memory.id)));
      await persist();
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    cancelWorker();
    if (!store || !config) return;
    const now = new Date().toISOString();
    const currentSessionId = sessionId(ctx);
    const interactionId = hashPrompt(currentSessionId, event.prompt);
    const selected = selectApprovedMemories(store, event.prompt, config.maxInjectedMemories, config.maxInjectionChars);
    const candidate = selectCanaryCandidate(store, event.prompt, interactionId, config.canaryRate);
    const attribution: Attribution = {
      interactionId,
      memoryIds: selected.map((memory) => memory.id),
      candidateIds: candidate ? [candidate.id] : [],
      injectedAt: now,
    };
    store = recordAttribution({
      ...store,
      historyCursor: { ...store.historyCursor, sessionId: currentSessionId, sessionFile: sessionPath(ctx) },
      approvedMemories: store.approvedMemories.map((memory) =>
        selected.some((item) => item.id === memory.id) ? { ...memory, lastUsedAt: now } : memory),
    }, attribution, config.maxAttributions);
    await persist();
    const injection = memoryPrompt(selected, candidate);
    return injection ? { systemPrompt: `${event.systemPrompt}\n\n${injection}` } : undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (store && config && ownsLock) scheduleWorker(ctx);
  });

  pi.on("session_shutdown", async () => {
    cancelWorker();
    if (workerPromise) await workerPromise;
    await persist();
    closed = true;
    await releaseLock();
  });

  pi.registerCommand("learn", {
    description: "Inspect or control continuous learning",
    handler: async (args, ctx) => {
      if (!store) {
        ctx.ui.notify("Continuous learning state is not loaded", "error");
        return;
      }
      const [command = "status", id] = args.trim().split(/\s+/);
      if (command === "status") {
        ctx.ui.notify(`Continuous learning: ${JSON.stringify({
          approved: store.approvedMemories.filter((memory) => !memory.disabled).length,
          candidates: store.candidates.filter((candidate) => candidate.state !== "rejected").length,
          cursor: store.historyCursor.entryId ?? null,
        })}`, "info");
        return;
      }
      if (!ownsLock) {
        ctx.ui.notify("Continuous learning is read-only because another session owns the project worker", "error");
        return;
      }
      if (command === "run") {
        cancelWorker();
        await runWorker(ctx, activityGeneration);
        return;
      }
      if (command === "rollback" && id) {
        const now = new Date().toISOString();
        const memory = store.approvedMemories.find((item) => item.id === id);
        if (!memory) {
          ctx.ui.notify("Approved memory not found", "error");
          return;
        }
        const updated = { ...memory, disabled: true, confidence: 0.2, updatedAt: now };
        store = { ...store, approvedMemories: store.approvedMemories.map((item) => item.id === id ? updated : item) };
        await persist();
        ctx.ui.notify(`Rolled back ${id}`, "info");
        return;
      }
      if (command === "graduate" && id) {
        const memory = store.approvedMemories.find((item) => item.id === id);
        if (!memory) {
          ctx.ui.notify("Approved memory not found", "error");
          return;
        }
        const targetValue = args.trim().split(/\s+/)[2] as GraduationTarget;
        if (!["agents", "skill"].includes(targetValue)) {
          ctx.ui.notify("Usage: /learn graduate <id> agents|skill", "error");
          return;
        }
        const check = checkGraduation(memory as any, new Date().toISOString());
        if (!check.eligible) {
          ctx.ui.notify(`Not eligible: ${check.reasons.join("; ")}`, "error");
          return;
        }
        const destination = await graduateMemory(memory as any, targetValue, ctx.cwd, AGENT_DIR);
        store = {
          ...store,
          approvedMemories: store.approvedMemories.map((item) => item.id === id ? {
            ...item,
            deployment: {
              target: targetValue,
              destination,
              contentHash: graduationContentHash(memory as any, targetValue),
              graduatedAt: new Date().toISOString(),
              status: "active" as const,
            },
          } : item),
        };
        await persist();
        ctx.ui.notify(`Graduated ${id}`, "info");
        return;
      }
      if (command === "migrate") {
        const roots = [...new Set([path.dirname(AGENT_DIR), process.env.HOME ?? "/tmp"])];
        const count = (await Promise.all(roots.map((root) => sanitizeLegacyCorpus(path.join(root, "continuous-learning")))))
          .reduce((sum, item) => sum + item, 0);
        ctx.ui.notify(`Migration complete; sanitized ${count} value(s)`, "info");
        return;
      }
      ctx.ui.notify("Usage: /learn status|run|rollback <id>|graduate <id> agents|skill|migrate", "error");
    },
  });
}
