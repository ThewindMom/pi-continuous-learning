import type { UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildHybridInjection,
  isCorrectionPrompt,
  loadStore,
  maintainStore,
  mergeSynthesizedCandidates,
  normalizeKeywords,
  projectIdForPath,
  renderMemoryGuidance,
  saveStore,
  scrubSecrets,
  selectFacts,
  selectMemories,
  type GraduationRecord,
  type LearnedFact,
  type LearnedMemory,
  type LearningEpisode,
  type LearningStore,
  type MemorySelection,
} from "./core.ts";
import {
  assignMemories,
  autonomousGraduationEligible,
  classifyTaskStratum,
  recordExperimentCorrection,
  recordExperimentOutcome,
  type MemoryAssignment,
} from "./autonomy.ts";
import {
  checkGraduation,
  cleanupOrphanedAgentBlocks,
  cleanupOrphanedSkills,
  graduateMemory,
  graduationContentHash,
  rollbackGraduation,
  type GraduationTarget,
} from "./graduation.ts";
import { appendDiagnostic, fileExists, sanitizeLegacyCorpus } from "./security.ts";
import { activeGlobalMemoryIds, disableGlobalSkills, nominateGlobalSkill, reconcileGlobalSkills, withdrawGlobalNomination } from "./global-skills.ts";
import { buildSynthesisInput, parseCandidateResponse, SYNTHESIS_SYSTEM_PROMPT } from "./synthesis.ts";
import { attributeRevalidationEpisode, prepareModelRevalidation } from "./revalidation.ts";
import { applyNativeReplay, applyReplayArtifact, buildReplayOptimizerInput, refreshReplayFreshness } from "./replay.ts";
import { isObjectiveValidationStart, objectiveValidationSucceeded } from "./validation.ts";
import { ensureOptimizerSigningKey, verifyOptimizerArtifact } from "./optimizer-provenance.ts";

interface Config {
  analysisProvider: string;
  analysisModel: string;
  analysisMinEpisodes: number;
  maxEpisodes: number;
  autoAnalyze: boolean;
  autonomous: boolean;
  candidateControlRate: number;
  activeControlRate: number;
  globalSkillMinProjects: number;
  globalSkillMinTreatmentTrials: number;
  autoOptimize: boolean;
  optimizerPython: string;
  optimizerMaxMetricCalls: number;
  optimizerBatchSize: number;
}

interface ActiveRun {
  episodeId: string;
  taskStratum: string;
  prompt: string;
  model: string;
  autonomous: boolean;
  assignments: MemoryAssignment[];
  injected: MemorySelection[];
  toolCalls: number;
  toolErrors: number;
  validationChecks: number;
  pendingValidationIds: Map<string, { toolName: string; args: unknown }>;
  response: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  startedAt: number;
}

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  const installedAgentDir = path.resolve(import.meta.dirname, "../..");
  if (path.basename(installedAgentDir) === "agent") return installedAgentDir;
  return path.join(os.homedir(), ".pi", "agent");
}

const AGENT_DIR = resolveAgentDir();
const PI_ROOT = path.dirname(AGENT_DIR);
const STATE_ROOT = process.env.PI_CONTINUOUS_LEARNING_ROOT ?? process.env.SENPI_CONTINUOUS_LEARNING_ROOT ?? path.join(PI_ROOT, "continuous-learning-hybrid", "v3");
const V2_STATE_ROOT = path.join(PI_ROOT, "continuous-learning-hybrid", "v2");
const LEGACY_STATE_ROOT = path.join(PI_ROOT, "selective-learning", "v1");
const DIAGNOSTICS_PATH = path.join(STATE_ROOT, "diagnostics.jsonl");
const OPTIMIZER_KEY_PATH = path.join(STATE_ROOT, "optimizer-signing.key");
const MIGRATION_MARKER = path.join(STATE_ROOT, "legacy-migration-v3.json");

async function ensureLegacyMigration(): Promise<number> {
  if (await fileExists(MIGRATION_MARKER)) return 0;
  const roots = [...new Set([PI_ROOT, path.join(os.homedir(), ".pi"), path.join(os.homedir(), ".senpi")])];
  const counts = await Promise.all(roots.map((root) => sanitizeLegacyCorpus(path.join(root, "continuous-learning"))));
  await fs.mkdir(path.dirname(MIGRATION_MARKER), { recursive: true, mode: 0o700 });
  await fs.writeFile(MIGRATION_MARKER, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  return counts.reduce((sum, count) => sum + count, 0);
}

function modelName(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
}

function assistantSummary(messages: unknown[]): Pick<ActiveRun, "response" | "inputTokens" | "outputTokens" | "cost"> {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const content = Array.isArray(record.content) ? record.content : [];
    const response = content
      .flatMap((part): string[] => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n");
    const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
    const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
    return {
      response,
      inputTokens: typeof usage.input === "number" ? usage.input : 0,
      outputTokens: typeof usage.output === "number" ? usage.output : 0,
      cost: typeof cost.total === "number" ? cost.total : 0,
    };
  }
  return { response: "", inputTokens: 0, outputTokens: 0, cost: 0 };
}

function responseText(response: { content: unknown[] }): string {
  return response.content
    .flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

export default function selectiveLearning(pi: ExtensionAPI): void {
  let config: Config | undefined;
  let projectId = "";
  let statePath = "";
  let store: LearningStore | undefined;
  let activeRun: ActiveRun | undefined;
  let previousEpisodeId: string | undefined;
  let analysisPromise: Promise<number> | undefined;
  let optimizerPromise: Promise<number> | undefined;
  let sessionGeneration = 0;
  let sessionClosed = false;
  let sessionLockPath: string | undefined;
  let sessionLockOwner: string | undefined;
  let lockHeartbeat: ReturnType<typeof setInterval> | undefined;
  let ownsSessionLock = false;
  const activeChildren = new Set<ReturnType<typeof spawn>>();
  let persistQueue: Promise<void> = Promise.resolve();

  const persist = async (): Promise<void> => {
    if (!store || !statePath || !ownsSessionLock || sessionClosed) return;
    const snapshot = store;
    const destination = statePath;
    const operation = persistQueue.then(async () => {
      if (!ownsSessionLock || sessionClosed || destination !== statePath) return;
      await saveStore(destination, snapshot);
    });
    persistQueue = operation.catch(() => undefined);
    await operation;
  };

  const acquireSessionLock = async (): Promise<boolean> => {
    if (!statePath) return false;
    sessionLockPath = path.join(path.dirname(statePath), "session.lock");
    await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fs.mkdir(sessionLockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = await fs.stat(sessionLockPath).catch(() => undefined);
        if (!lock) continue;
        if (Date.now() - lock.mtimeMs <= 30 * 60 * 1_000) return false;
        const stalePath = `${sessionLockPath}.stale-${crypto.randomUUID()}`;
        try {
          await fs.rename(sessionLockPath, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameError;
        }
        try {
          await fs.mkdir(sessionLockPath);
        } catch (mkdirError) {
          await fs.rm(stalePath, { recursive: true, force: true });
          if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw mkdirError;
        }
        await fs.rm(stalePath, { recursive: true, force: true });
      }
      sessionLockOwner = crypto.randomUUID();
      const ownerPath = path.join(sessionLockPath, "owner");
      await fs.writeFile(ownerPath, sessionLockOwner, { mode: 0o600, flag: "wx" });
      if (await fs.readFile(ownerPath, "utf8") === sessionLockOwner) return true;
      await fs.rm(sessionLockPath, { recursive: true, force: true });
    }
    return false;
  };

  const releaseSessionLock = async (): Promise<void> => {
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    lockHeartbeat = undefined;
    if (ownsSessionLock && sessionLockPath && sessionLockOwner) {
      const owner = await fs.readFile(path.join(sessionLockPath, "owner"), "utf8").catch(() => "");
      if (owner === sessionLockOwner) await fs.rm(sessionLockPath, { recursive: true, force: true });
    }
    ownsSessionLock = false;
    sessionLockPath = undefined;
    sessionLockOwner = undefined;
  };

  const signalChild = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child when the process group already exited.
      }
    }
    child.kill(signal);
  };

  const runProcess = async (command: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: import.meta.dirname,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-20_000); });
    const timeout = setTimeout(() => {
      timedOut = true;
      signalChild(child, "SIGTERM");
      hardKill = setTimeout(() => signalChild(child, "SIGKILL"), 5_000);
    }, 20 * 60 * 1_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      activeChildren.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      activeChildren.delete(child);
      if (timedOut) reject(new Error("Optimizer exceeded the 20 minute execution limit and was terminated"));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`Optimizer exited ${code}: ${scrubSecrets(stderr || stdout)}`));
    });
  });

  const optimizeReplay = async (ctx: ExtensionContext): Promise<number> => {
    if (!store || !config || !store.automation.enabled || !config.autonomous) return 0;
    const generation = sessionGeneration;
    const model = modelName(ctx);
    const input = buildReplayOptimizerInput(store, model, new Date().toISOString());
    input.candidates = input.candidates.filter((candidate) => {
      const memory = store!.memories.find((item) => item.id === candidate.id);
      return (memory?.replay?.optimizer !== "rlm-gepa" || memory.replay.status !== "passed") &&
        (memory?.replay?.attempts ?? 0) < 3;
    }).slice(0, config.optimizerBatchSize);
    if (input.candidates.length === 0) return 0;
    const optimizerDir = path.join(STATE_ROOT, "projects", projectId, "optimizer");
    const inputPath = path.join(optimizerDir, "latest-input.json");
    const outputPath = path.join(optimizerDir, "latest-output.json");
    await fs.mkdir(optimizerDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(optimizerDir, "running.lock");
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const lock = await fs.stat(lockPath);
        if (Date.now() - lock.mtimeMs <= 25 * 60 * 1_000) return 0;
        await fs.rm(lockPath, { recursive: true, force: true });
        await fs.mkdir(lockPath);
      } else {
        throw error;
      }
    }
    try {
      const attemptedIds = new Set(input.candidates.map((candidate) => candidate.id));
      const attemptAt = new Date().toISOString();
      store = {
        ...store,
        memories: store.memories.map((memory) => attemptedIds.has(memory.id)
          ? {
            ...memory,
            replay: memory.replay
              ? { ...memory.replay, attempts: (memory.replay.attempts ?? 0) + 1, lastAttemptAt: attemptAt }
              : memory.replay,
          }
          : memory),
      };
      await persist();
      await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
      const python = path.resolve(import.meta.dirname, config.optimizerPython);
      const signingKey = await ensureOptimizerSigningKey(OPTIMIZER_KEY_PATH);
      const [provider, ...modelParts] = model.split("/");
      await runProcess(python, [
        path.join(import.meta.dirname, "scripts", "optimize.py"),
        inputPath,
        outputPath,
        "--provider",
        provider!,
        "--model",
        modelParts.join("/"),
        "--max-metric-calls",
        String(config.optimizerMaxMetricCalls),
        "--signing-key-file",
        OPTIMIZER_KEY_PATH,
      ]);
      const artifact = JSON.parse(await fs.readFile(outputPath, "utf8"));
      const verifiedArtifact = verifyOptimizerArtifact(artifact, signingKey);
      if (
        sessionClosed || generation !== sessionGeneration || !ownsSessionLock ||
        !store.automation.enabled || !config.autonomous
      ) return 0;
      store = applyReplayArtifact(store, verifiedArtifact, new Date().toISOString());
      await reconcileGraduations(ctx, new Date().toISOString());
      await persist();
      return input.candidates.length;
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  };

  const reconcileGraduations = async (ctx: ExtensionContext, now: string): Promise<void> => {
    if (!store || !config || !ownsSessionLock) return;
    const generation = sessionGeneration;
    const canGraduate = (): boolean => Boolean(
      store?.automation.enabled && config?.autonomous && ownsSessionLock &&
      !sessionClosed && generation === sessionGeneration,
    );
    const allowGraduation = canGraduate();
    const currentModel = modelName(ctx);
    const memories = new Map(store.memories.map((memory) => [memory.id, memory]));
    const graduations: LearningStore["graduations"] = [];
    const artifactRollbackIds = new Set<string>();
    const retireIds = new Set<string>();
    for (const record of store.graduations) {
      const memory = memories.get(record.memoryId);
      const harmfulAfterGraduation = Boolean(memory?.evidence.lastHarmfulAt && memory.evidence.lastHarmfulAt > record.graduatedAt);
      const modelStale = Boolean(memory && memory.model !== currentModel);
      if (record.status === "active" && memory && (!allowGraduation || memory.status === "retired" || harmfulAfterGraduation || modelStale)) {
        artifactRollbackIds.add(memory.id);
        if (memory.status === "retired" || harmfulAfterGraduation) retireIds.add(memory.id);
        graduations.push(await rollbackGraduation(
          record,
          memory,
          now,
          harmfulAfterGraduation
            ? "explicit correction after graduation"
            : !allowGraduation
              ? "autonomous learning disabled"
              : modelStale
              ? `model changed from ${memory.model} to ${currentModel}`
              : "memory failed ongoing evaluation",
        ));
      } else {
        graduations.push(record);
      }
    }

    const recorded = new Set(graduations.filter((record) => record.status === "active").map((record) => record.memoryId));
    for (const memory of allowGraduation ? store.memories : []) {
      if (!canGraduate()) break;
      if (recorded.has(memory.id) || !autonomousGraduationEligible(memory, now)) continue;
      const target: GraduationTarget = memory.scope === "project" ? "agents" : "skill";
      const destination = await graduateMemory(memory, target, ctx.cwd, AGENT_DIR);
      let record: GraduationRecord = {
        memoryId: memory.id,
        target,
        destination,
        contentHash: graduationContentHash(memory, target),
        graduatedAt: now,
        status: "active",
      };
      if (!canGraduate()) record = await rollbackGraduation(record, memory, now, "autonomy disabled during graduation");
      graduations.push(record);
    }
    store = {
      ...store,
      memories: store.memories.map((memory) => retireIds.has(memory.id)
        ? { ...memory, status: "retired", updatedAt: now }
        : memory),
      graduations,
    };
    await persist();
    for (const record of graduations) {
      const memory = memories.get(record.memoryId);
      if (canGraduate() && record.status === "active" && record.target === "agents" && memory?.model === currentModel) {
        await nominateGlobalSkill(STATE_ROOT, projectId, memory);
      }
    }
    for (const memoryId of artifactRollbackIds) {
      await withdrawGlobalNomination(STATE_ROOT, projectId, memoryId);
    }
    if (canGraduate()) {
      await reconcileGlobalSkills(
        STATE_ROOT,
        AGENT_DIR,
        config.globalSkillMinProjects,
        config.globalSkillMinTreatmentTrials,
        now,
      );
    } else {
      await disableGlobalSkills(STATE_ROOT, now);
    }
  };

  const analyze = async (ctx: ExtensionContext, force: boolean): Promise<number> => {
    if (!store || !config || !store.automation.enabled || !config.autonomous) return 0;
    const generation = sessionGeneration;
    const analyzed = new Set(store.analyzedEpisodeIds);
    const pending = store.episodes.filter((episode) =>
      !analyzed.has(episode.id) && (episode.verified || episode.corrected || episode.toolErrors > 0),
    ).slice(-12);
    if (pending.length === 0 || (!force && pending.length < config.analysisMinEpisodes)) return 0;

    const configured = ctx.modelRegistry.find(config.analysisProvider, config.analysisModel);
    const model = configured ?? ctx.model;
    if (!model) return 0;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return 0;

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: buildSynthesisInput(pending) }],
      timestamp: Date.now(),
    };
    const { complete } = await import("@earendil-works/pi-ai/compat");
    const response = await complete(
      model,
      { systemPrompt: SYNTHESIS_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
    );
    if (
      sessionClosed || generation !== sessionGeneration || !ownsSessionLock ||
      !store.automation.enabled || !config.autonomous
    ) return 0;
    const allowedIds = new Set(pending.map((episode) => episode.id));
    const candidates = parseCandidateResponse(responseText(response)).map((candidate) => ({
      ...candidate,
      evidenceEpisodeIds: candidate.evidenceEpisodeIds.filter((id) => allowedIds.has(id)),
    }));
    store = mergeSynthesizedCandidates(store, candidates, {
      projectId,
      model: modelName(ctx),
      now: new Date().toISOString(),
    });
    store = applyNativeReplay(store, new Date().toISOString());
    store = refreshReplayFreshness(store);
    store = {
      ...store,
      analyzedEpisodeIds: [...new Set([...store.analyzedEpisodeIds, ...pending.map((episode) => episode.id)])],
    };
    await persist();
    if (config.autoOptimize && !optimizerPromise) {
      optimizerPromise = optimizeReplay(ctx)
        .catch(async (error) => {
          await appendDiagnostic(DIAGNOSTICS_PATH, "automatic-optimizer", error);
          return 0;
        })
        .finally(() => {
          optimizerPromise = undefined;
        });
    }
    return candidates.length;
  };

  const recoverInterruptedRuns = (value: LearningStore, now: string): LearningStore => {
    let memories = value.memories;
    const episodes = value.episodes.map((episode) => {
      if (episode.status !== "pending") return episode;
      if (episode.autonomous) {
        const assignments = new Map(episode.memoryAssignments.map((assignment) => [assignment.memoryId, assignment.arm]));
        memories = memories.map((memory) => {
          const arm = assignments.get(memory.id);
          return arm ? recordExperimentOutcome(memory, arm, {
            verified: false,
            corrected: false,
            tokens: episode.inputTokens + episode.outputTokens,
            cost: episode.cost,
            latencyMs: episode.latencyMs,
            failedAttempts: Math.max(1, episode.failedAttempts),
            taskStratum: episode.taskStratum,
          }, now) : memory;
        });
      }
      return {
        ...episode,
        status: "settled" as const,
        response: "[interrupted before agent_settled]",
        failedAttempts: Math.max(1, episode.failedAttempts),
      };
    });
    return { ...value, memories, episodes };
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    sessionClosed = false;
    config = JSON.parse(await fs.readFile(path.join(import.meta.dirname, "config.json"), "utf8")) as Config;
    projectId = projectIdForPath(ctx.cwd);
    statePath = path.join(STATE_ROOT, "projects", projectId, "state.json");
    ownsSessionLock = await acquireSessionLock();
    if (ownsSessionLock && sessionLockPath && sessionLockOwner) {
      const ownerPath = path.join(sessionLockPath, "owner");
      const owner = sessionLockOwner;
      lockHeartbeat = setInterval(() => {
        void fs.readFile(ownerPath, "utf8").then((currentOwner) => {
          if (currentOwner === owner && sessionLockPath) return fs.utimes(sessionLockPath, new Date(), new Date());
          ownsSessionLock = false;
        }).catch(() => { ownsSessionLock = false; });
      }, 60_000);
      lockHeartbeat.unref?.();
    }
    const pathScopedId = createHash("sha256").update(path.resolve(ctx.cwd)).digest("hex").slice(0, 16);
    const pathScopedStatePath = path.join(STATE_ROOT, "projects", pathScopedId, "state.json");
    const v2StatePath = path.join(V2_STATE_ROOT, "projects", projectId, "state.json");
    const legacyStatePath = path.join(LEGACY_STATE_ROOT, "projects", projectId, "state.json");
    store = await fileExists(statePath)
      ? await loadStore(statePath)
      : pathScopedId !== projectId && await fileExists(pathScopedStatePath)
        ? await loadStore(pathScopedStatePath)
      : await fileExists(v2StatePath)
        ? await loadStore(v2StatePath)
      : await fileExists(legacyStatePath)
        ? await loadStore(legacyStatePath)
        : await loadStore(statePath);
    if (pathScopedId !== projectId && await fileExists(pathScopedStatePath) && !await fileExists(statePath)) {
      store = {
        ...store,
        memories: store.memories.map((memory) => ({ ...memory, projectId })),
        facts: store.facts.map((fact) => ({ ...fact, projectId })),
        episodes: store.episodes.map((episode) => ({ ...episode, projectId })),
      };
    }
    if (ownsSessionLock) store = recoverInterruptedRuns(store, new Date().toISOString());
    store = refreshReplayFreshness(store);
    if (ownsSessionLock) {
      await cleanupOrphanedAgentBlocks(
        ctx.cwd,
        new Set(store.graduations.filter((record) => record.status === "active").map((record) => record.memoryId)),
      );
      await cleanupOrphanedSkills(
        AGENT_DIR,
        new Set([
          ...store.graduations.filter((record) => record.status === "active").map((record) => record.memoryId),
          ...await activeGlobalMemoryIds(STATE_ROOT),
        ]),
      );
    }
    if (!config.autonomous || !ownsSessionLock) store = { ...store, automation: { enabled: false } };
    store = maintainStore(store, new Date().toISOString());
    store = prepareModelRevalidation(store, projectId, modelName(ctx), new Date().toISOString());
    await ensureLegacyMigration();
    await reconcileGraduations(ctx, new Date().toISOString()).catch(async (error) => {
      await appendDiagnostic(DIAGNOSTICS_PATH, "automatic-graduation", error);
    });
    if (!config.autonomous && ownsSessionLock) await disableGlobalSkills(STATE_ROOT, new Date().toISOString());
    await persist();
    previousEpisodeId = store.episodes.at(-1)?.id;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!store || !config) return;
    const now = new Date().toISOString();
    if (previousEpisodeId && isCorrectionPrompt(event.prompt)) {
      const episodeIndex = store.episodes.findIndex((episode) => episode.id === previousEpisodeId);
      const previous = store.episodes[episodeIndex];
      if (previous && !previous.corrected) {
        const assignments = previous.autonomous
          ? new Map(previous.memoryAssignments.map((assignment) => [assignment.memoryId, assignment.arm]))
          : new Map();
        store = {
          ...store,
          episodes: store.episodes.map((episode, index) => index === episodeIndex ? { ...episode, corrected: true } : episode),
          memories: store.memories.map((memory) => {
            const arm = assignments.get(memory.id);
            return arm ? recordExperimentCorrection(memory, arm, previous.taskStratum, now) : memory;
          }),
        };
        await reconcileGraduations(ctx, now).catch(async (error) => {
          await appendDiagnostic(DIAGNOSTICS_PATH, "automatic-rollback", error);
        });
      }
    }

    const model = modelName(ctx);
    const selectionContext = { prompt: event.prompt, projectId, model };
    const selected = selectMemories(store.memories, selectionContext);
    const graduatedIds = new Set(store.graduations.filter((record) => record.status === "active").map((record) => record.memoryId));
    const autonomous = store.automation.enabled && config.autonomous;
    const eligibleSelections = autonomous
      ? selected
      : selected.filter(({ memory }) => memory.status === "active" && memory.origin === "user");
    const assignments = autonomous
      ? assignMemories(eligibleSelections, selectionContext, graduatedIds, {
        candidateControlRate: config.candidateControlRate,
        activeControlRate: config.activeControlRate,
      })
      : eligibleSelections.map((selection): MemoryAssignment => ({ selection, arm: "treatment", graduated: graduatedIds.has(selection.memory.id) }));
    const injected = assignments
      .filter((assignment) => assignment.arm === "treatment" && !assignment.graduated)
      .map((assignment) => assignment.selection);
    const selectedFacts = selectFacts(store.facts, { prompt: event.prompt, projectId, model });
    if (selected.length > 0) {
      const selectedIds = new Set(selected.map(({ memory }) => memory.id));
      store = {
        ...store,
        memories: store.memories.map((memory) => selectedIds.has(memory.id) ? { ...memory, lastUsedAt: now } : memory),
      };
    }
    const episodeId = crypto.randomUUID();
    const taskStratum = classifyTaskStratum(event.prompt);
    activeRun = {
      episodeId,
      taskStratum,
      prompt: scrubSecrets(event.prompt).slice(0, 2_400),
      model,
      autonomous,
      assignments,
      injected,
      toolCalls: 0,
      toolErrors: 0,
      validationChecks: 0,
      pendingValidationIds: new Map(),
      response: "",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      startedAt: Date.now(),
    };
    store = {
      ...store,
      episodes: [...store.episodes, {
        id: episodeId,
        status: "pending" as const,
        timestamp: now,
        projectId,
        model,
        prompt: scrubSecrets(event.prompt).slice(0, 2_400),
        response: "",
        autonomous,
        memoryAssignments: assignments.map((assignment) => ({ memoryId: assignment.selection.memory.id, arm: assignment.arm })),
        injectedMemoryIds: injected.map(({ memory }) => memory.id),
        toolCalls: 0,
        toolErrors: 0,
        verified: false,
        corrected: false,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        latencyMs: 0,
        failedAttempts: 0,
        taskStratum,
      }].slice(-config.maxEpisodes),
    };
    await persist();
    const injection = buildHybridInjection(injected, selectedFacts);
    if (!injection) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });

  pi.on("tool_execution_start", (event) => {
    if (!activeRun) return;
    activeRun.toolCalls += 1;
    if (isObjectiveValidationStart(event.toolName, event.args)) {
      activeRun.pendingValidationIds.set(
        String(event.toolCallId ?? `${event.toolName}:${activeRun.toolCalls}`),
        { toolName: event.toolName, args: event.args },
      );
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!activeRun) return;
    if (event.isError) activeRun.toolErrors += 1;
    const id = String(event.toolCallId ?? "");
    const pending = activeRun.pendingValidationIds.get(id);
    if (id && pending) {
      if (!event.isError && objectiveValidationSucceeded(pending.toolName, pending.args, event.result)) {
        activeRun.validationChecks += 1;
      }
      activeRun.pendingValidationIds.delete(id);
    }
  });

  pi.on("agent_end", (event) => {
    if (!activeRun) return;
    const summary = assistantSummary(event.messages);
    activeRun.response = summary.response;
    activeRun.inputTokens += summary.inputTokens;
    activeRun.outputTokens += summary.outputTokens;
    activeRun.cost += summary.cost;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!activeRun || !store || !config) return;
    const now = new Date().toISOString();
    const response = scrubSecrets(activeRun.response).slice(0, 2_400);
    const verified = activeRun.toolErrors === 0 && activeRun.validationChecks > 0;
    const assignments = new Map(activeRun.assignments.map((assignment) => [assignment.selection.memory.id, assignment.arm]));
    const injectedIds = new Set(activeRun.injected.map(({ memory }) => memory.id));
    const tokens = activeRun.inputTokens + activeRun.outputTokens;
    const latencyMs = Math.max(0, Date.now() - activeRun.startedAt);
    const taskStratum = activeRun.taskStratum;
    store = {
      ...store,
      memories: store.memories.map((memory) => {
        if (!activeRun!.autonomous) return memory;
        const arm = assignments.get(memory.id);
        const attributed = arm && memory.revalidationOf
          ? attributeRevalidationEpisode(memory, activeRun!.episodeId)
          : memory;
        return arm ? recordExperimentOutcome(attributed, arm, {
          verified,
          corrected: false,
          tokens,
          cost: activeRun!.cost,
          latencyMs,
          failedAttempts: activeRun!.toolErrors,
          taskStratum,
        }, now) : memory;
      }),
    };
    const episode: LearningEpisode = {
      id: activeRun.episodeId,
      status: "settled",
      timestamp: now,
      projectId,
      model: activeRun.model,
      prompt: activeRun.prompt,
      response,
      autonomous: activeRun.autonomous,
      memoryAssignments: [...assignments].map(([memoryId, arm]) => ({ memoryId, arm })),
      injectedMemoryIds: [...injectedIds],
      toolCalls: activeRun.toolCalls,
      toolErrors: activeRun.toolErrors,
      verified,
      corrected: false,
      inputTokens: activeRun.inputTokens,
      outputTokens: activeRun.outputTokens,
      cost: activeRun.cost,
      latencyMs,
      failedAttempts: activeRun.toolErrors,
      taskStratum,
    };
    store = {
      ...store,
      episodes: [...store.episodes.filter((item) => item.id !== episode.id), episode].slice(-config.maxEpisodes),
    };
    store = applyNativeReplay(store, now);
    store = refreshReplayFreshness(store);
    previousEpisodeId = episode.id;
    activeRun = undefined;
    await reconcileGraduations(ctx, now).catch(async (error) => {
      await appendDiagnostic(DIAGNOSTICS_PATH, "automatic-graduation", error);
    });
    await persist();

    if (config.autoAnalyze && !analysisPromise) {
      analysisPromise = analyze(ctx, false)
        .catch(async (error) => {
          await appendDiagnostic(DIAGNOSTICS_PATH, "automatic-analysis", error);
          return 0;
        })
        .finally(() => {
          analysisPromise = undefined;
        });
    }
  });

  pi.on("session_shutdown", async () => {
    await persist();
    sessionClosed = true;
    for (const child of activeChildren) signalChild(child, "SIGKILL");
    activeChildren.clear();
    await releaseSessionLock();
  });

  pi.registerCommand("learn", {
    description: "Inspect and control selective learned memories",
    handler: async (args, ctx) => {
      if (!store) {
        ctx.ui.notify("Selective learning state is not loaded", "error");
        return;
      }
      const [command = "status", ...rest] = args.trim().split(/\s+/);
      if (!ownsSessionLock && !["status", "inspect", "conflicts"].includes(command)) {
        ctx.ui.notify("Learning state is read-only because another session owns the project learner lock", "error");
        return;
      }
      if (command === "status") {
        const counts = {
          active: store.memories.filter((memory) => memory.status === "active").length,
          candidate: store.memories.filter((memory) => memory.status === "candidate").length,
          conflicted: store.memories.filter((memory) => memory.status === "conflicted").length,
          retired: store.memories.filter((memory) => memory.status === "retired").length,
          facts: store.facts.filter((fact) => fact.status === "active").length,
          episodes: store.episodes.length,
          experimenting: store.memories.filter((memory) => memory.experiment?.decision === "exploring").length,
          graduated: store.graduations.filter((record) => record.status === "active").length,
          rolledBack: store.graduations.filter((record) => record.status === "rolled_back").length,
          autonomous: config?.autonomous === true && store.automation.enabled,
          pending: store.episodes.filter((episode) => !store!.analyzedEpisodeIds.includes(episode.id)).length,
        };
        ctx.ui.notify(`Selective learning: ${JSON.stringify(counts)}`, "info");
        return;
      }
      if (command === "autonomy") {
        const value = rest[0];
        if (!value || !["on", "off"].includes(value)) {
          ctx.ui.notify("Usage: /learn autonomy on|off", "error");
          return;
        }
        store = { ...store, automation: { enabled: value === "on" } };
        if (value === "off") {
          for (const child of activeChildren) signalChild(child, "SIGKILL");
          activeChildren.clear();
        }
        await reconcileGraduations(ctx, new Date().toISOString());
        if (value === "off") await disableGlobalSkills(STATE_ROOT, new Date().toISOString());
        await persist();
        ctx.ui.notify(`Autonomous learning ${value === "on" ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (command === "analyze") {
        const count = await analyze(ctx, true);
        ctx.ui.notify(`Selective learning synthesized ${count} candidate(s)`, "info");
        return;
      }
      if (command === "replay") {
        if (!store.automation.enabled) {
          ctx.ui.notify("Autonomous learning is disabled", "error");
          return;
        }
        const artifactPath = rest.join(" ").trim();
        if (artifactPath) {
          const artifact = JSON.parse(await fs.readFile(path.resolve(ctx.cwd, artifactPath), "utf8"));
          const verifiedArtifact = verifyOptimizerArtifact(artifact, await ensureOptimizerSigningKey(OPTIMIZER_KEY_PATH));
          store = applyReplayArtifact(store, verifiedArtifact, new Date().toISOString());
        } else {
          store = applyNativeReplay(store, new Date().toISOString());
        }
        await persist();
        const counts = {
          passed: store.memories.filter((memory) => memory.replay?.status === "passed").length,
          failed: store.memories.filter((memory) => memory.replay?.status === "failed").length,
          pending: store.memories.filter((memory) => memory.status === "candidate" && memory.replay?.status === "pending").length,
        };
        ctx.ui.notify(`Replay complete: ${JSON.stringify(counts)}`, "info");
        return;
      }
      if (command === "optimize") {
        const count = await optimizeReplay(ctx);
        ctx.ui.notify(`RLM/GEPA optimized ${count} candidate(s)`, "info");
        return;
      }
      if (command === "add") {
        const body = rest.join(" ");
        const separator = body.indexOf("::");
        if (separator < 0) {
          ctx.ui.notify("Usage: /learn add keyword1,keyword2 :: actionable rule", "error");
          return;
        }
        const keywords = normalizeKeywords(body.slice(0, separator).split(/[\s,]+/));
        const rule = scrubSecrets(body.slice(separator + 2).trim()).slice(0, 360);
        if (keywords.length < 2 || rule.length < 20) {
          ctx.ui.notify("Provide at least two keywords and a concrete rule", "error");
          return;
        }
        const now = new Date().toISOString();
        const memory: LearnedMemory = {
          id: `explicit-${crypto.randomUUID().slice(0, 8)}`,
          title: rule.slice(0, 80),
          rule,
          keywords,
          scope: "project",
          kind: "guidance",
          origin: "user",
          projectId,
          model: modelName(ctx),
          status: "active",
          confidence: 0.75,
          evidence: { observations: 1, helpful: 0, harmful: 0, neutral: 0 },
          sourceEpisodeIds: [],
          createdAt: now,
          updatedAt: now,
        };
        store = { ...store, memories: [...store.memories, memory] };
        await persist();
        ctx.ui.notify(`Added selective memory ${memory.id}`, "info");
        return;
      }
      if (command === "remember") {
        const body = rest.join(" ");
        const separator = body.indexOf("::");
        if (separator < 0) {
          ctx.ui.notify("Usage: /learn remember keyword1,keyword2 :: project fact", "error");
          return;
        }
        const keywords = normalizeKeywords(body.slice(0, separator).split(/[\s,]+/));
        const content = scrubSecrets(body.slice(separator + 2).trim()).slice(0, 300);
        if (keywords.length < 2 || content.length < 5) {
          ctx.ui.notify("Provide at least two technical keywords and a fact", "error");
          return;
        }
        const now = new Date().toISOString();
        const fact: LearnedFact = {
          id: `fact-${crypto.randomUUID().slice(0, 8)}`,
          title: content.slice(0, 80),
          content,
          keywords,
          projectId,
          model: modelName(ctx),
          confidence: 0.8,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        store = { ...store, facts: [...store.facts, fact] };
        await persist();
        ctx.ui.notify(`Stored project fact ${fact.id}`, "info");
        return;
      }
      if (command === "procedure") {
        const body = rest.join(" ");
        const separator = body.indexOf("::");
        if (separator < 0) {
          ctx.ui.notify("Usage: /learn procedure keyword1,keyword2 :: goal | step one; step two | verification | recovery | decomposition", "error");
          return;
        }
        const keywords = normalizeKeywords(body.slice(0, separator).split(/[\s,]+/));
        const [goal = "", stepsValue = "", verificationValue = "", recoveryValue = "", decomposition = "direct"] = body
          .slice(separator + 2)
          .split("|")
          .map((value) => scrubSecrets(value.trim()));
        const steps = stepsValue.split(";").map((value) => value.trim()).filter(Boolean).slice(0, 12);
        const verification = verificationValue.split(";").map((value) => value.trim()).filter(Boolean).slice(0, 6);
        const recovery = recoveryValue.split(";").map((value) => value.trim()).filter(Boolean).slice(0, 6);
        if (keywords.length < 2 || goal.length < 10 || steps.length < 2 || verification.length < 1) {
          ctx.ui.notify("Provide two technical keywords, a goal, two steps, and one verification action", "error");
          return;
        }
        const now = new Date().toISOString();
        const memory: LearnedMemory = {
          id: `procedure-${crypto.randomUUID().slice(0, 8)}`,
          title: goal.slice(0, 80),
          rule: goal.slice(0, 360),
          keywords,
          scope: "project",
          kind: "procedure",
          origin: "user",
          procedure: {
            goal: goal.slice(0, 240),
            steps,
            verification,
            recovery,
            decomposition: decomposition.slice(0, 80),
          },
          projectId,
          model: modelName(ctx),
          status: "active",
          confidence: 0.75,
          evidence: { observations: 1, helpful: 0, harmful: 0, neutral: 0 },
          sourceEpisodeIds: [],
          createdAt: now,
          updatedAt: now,
        };
        if (renderMemoryGuidance(memory).length > 520) {
          ctx.ui.notify("Procedure is too large for the exact treatment/deployment budget", "error");
          return;
        }
        store = { ...store, memories: [...store.memories, memory] };
        await persist();
        ctx.ui.notify(`Added executable procedure ${memory.id}`, "info");
        return;
      }
      if (command === "conflicts") {
        const conflicts = store.memories.filter((memory) => memory.status === "conflicted");
        ctx.ui.notify(conflicts.length > 0 ? conflicts.map((memory) => `${memory.id}: ${memory.rule}`).join("\n") : "No conflicts", "info");
        return;
      }
      if (command === "maintain") {
        store = maintainStore(store, new Date().toISOString());
        await persist();
        ctx.ui.notify("Applied confidence decay and candidate TTL maintenance", "info");
        return;
      }
      if (command === "migrate") {
        const roots = [...new Set([PI_ROOT, path.join(os.homedir(), ".pi"), path.join(os.homedir(), ".senpi")])];
        const redactions = await Promise.all(roots.map((root) => sanitizeLegacyCorpus(path.join(root, "continuous-learning"))));
        await persist();
        ctx.ui.notify(`Migration complete; sanitized ${redactions.reduce((sum, count) => sum + count, 0)} sensitive value(s)`, "info");
        return;
      }
      if (command === "graduate") {
        const [id, targetValue] = rest;
        const target = targetValue as GraduationTarget;
        const memory = store.memories.find((item) => item.id === id);
        if (!memory || !["agents", "skill"].includes(target)) {
          ctx.ui.notify("Usage: /learn graduate <id> agents|skill", "error");
          return;
        }
        const check = checkGraduation(memory, new Date().toISOString());
        if (!check.eligible) {
          ctx.ui.notify(`Not eligible: ${check.reasons.join("; ")}`, "error");
          return;
        }
        if (store.graduations.some((record) => record.memoryId === memory.id && record.status === "active")) {
          ctx.ui.notify(`Memory ${memory.id} is already graduated`, "info");
          return;
        }
        const written = await graduateMemory(memory, target, ctx.cwd, AGENT_DIR);
        store = {
          ...store,
          graduations: [...store.graduations, {
            memoryId: memory.id,
            target,
            destination: written,
            contentHash: graduationContentHash(memory, target),
            graduatedAt: new Date().toISOString(),
            status: "active",
          }],
        };
        await persist();
        ctx.ui.notify(`Graduated ${memory.id} to ${written}`, "info");
        return;
      }
      if (command === "retire") {
        const id = rest[0];
        const foundMemory = Boolean(id && store.memories.some((memory) => memory.id === id));
        const foundFact = Boolean(id && store.facts.some((fact) => fact.id === id));
        if (!foundMemory && !foundFact) {
          ctx.ui.notify("Memory or fact not found", "error");
          return;
        }
        const now = new Date().toISOString();
        store = {
          ...store,
          memories: store.memories.map((memory) => memory.id === id ? { ...memory, status: "retired", updatedAt: now } : memory),
          facts: store.facts.map((fact) => fact.id === id ? { ...fact, status: "retired", updatedAt: now } : fact),
        };
        await reconcileGraduations(ctx, now);
        await persist();
        ctx.ui.notify(`Retired ${id}`, "info");
        return;
      }
      if (command === "inspect") {
        const memory = store.memories.find((item) => item.id === rest[0]);
        const fact = store.facts.find((item) => item.id === rest[0]);
        ctx.ui.notify(memory || fact ? JSON.stringify(memory ?? fact) : "Memory or fact not found", memory || fact ? "info" : "error");
        return;
      }
      ctx.ui.notify("Usage: /learn status|autonomy|analyze|replay|optimize|add|remember|procedure|conflicts|maintain|migrate|graduate|retire|inspect", "error");
    },
  });
}
