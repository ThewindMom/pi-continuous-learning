import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadStore, memoryArtifactHash, memoriesContradict, normalizeKeywords, type GraduationRecord, type LearnedMemory } from "./core.ts";
import { autonomousGraduationEligible } from "./autonomy.ts";
import { graduateMemory, graduationContentHash, rollbackGraduation } from "./graduation.ts";

interface GlobalNomination {
  key: string;
  memoryId: string;
  projectId: string;
  model: string;
  title: string;
  rule: string;
  keywords: string[];
  helpful: number;
  createdAt: string;
  procedure: NonNullable<LearnedMemory["procedure"]>;
  equivalenceClass: string;
  semanticScore: number;
  treatmentTrials: number;
  heldOutDomains: number;
  longContextScore: number;
  artifactHash: string;
  domainScores: Record<string, number>;
}

interface GlobalSkillRecord extends GraduationRecord {
  key: string;
  projectIds: string[];
  memory: LearnedMemory;
}

interface GlobalSkillLedger {
  version: 1;
  skills: GlobalSkillRecord[];
}

function semanticTokens(nomination: GlobalNomination): string[] {
  return normalizeKeywords([
    nomination.rule,
    nomination.procedure.goal,
    ...nomination.procedure.steps,
    ...nomination.keywords,
  ]);
}

function semanticallyCompatible(left: GlobalNomination, right: GlobalNomination): boolean {
  if (left.model !== right.model || left.procedure.decomposition !== right.procedure.decomposition) return false;
  if (left.equivalenceClass !== right.equivalenceClass || memoriesContradict(left, right)) return false;
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const keywordIntersection = normalizeKeywords(left.keywords).filter((token) => normalizeKeywords(right.keywords).includes(token)).length;
  return intersection / Math.max(1, union) >= 0.55 && keywordIntersection >= 2;
}

function nominationKey(memory: LearnedMemory): string {
  const signature = `${memory.model}\0${memory.procedure?.decomposition}\0${memory.replay?.equivalenceClass}`;
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

function nominationPath(stateRoot: string, projectId: string, memoryId: string): string {
  return path.join(stateRoot, "global", "nominations", `${projectId}-${memoryId}.json`);
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function nominateGlobalSkill(
  stateRoot: string,
  projectId: string,
  memory: LearnedMemory,
): Promise<boolean> {
  if (
    memory.kind !== "procedure" || !memory.procedure ||
    memory.replay?.status !== "passed" || memory.replay.optimizer !== "rlm-gepa" ||
    memory.replay.fresh !== true ||
    !memory.replay.equivalenceClass || (memory.replay.semanticScore ?? 0) < 0.8
    || Object.values(memory.replay.domainScores ?? {}).filter((score) => score >= 0.75).length < 2
    || (memory.replay.longContextScore ?? 0) < 0.75
    || memory.replay.artifactHash !== memoryArtifactHash(memory)
  ) return false;
  const nomination: GlobalNomination = {
    key: nominationKey(memory),
    memoryId: memory.id,
    projectId,
    model: memory.model,
    title: memory.title,
    rule: memory.rule,
    keywords: normalizeKeywords(memory.keywords),
    helpful: memory.evidence.helpful,
    createdAt: memory.createdAt,
    procedure: memory.procedure,
    equivalenceClass: memory.replay.equivalenceClass,
    semanticScore: memory.replay.semanticScore ?? 0,
    treatmentTrials: memory.experiment?.treatment.trials ?? 0,
    heldOutDomains: memory.replay.heldOutDomains ?? 0,
    longContextScore: memory.replay.longContextScore ?? 0,
    artifactHash: memoryArtifactHash(memory),
    domainScores: memory.replay.domainScores ?? {},
  };
  await atomicJson(nominationPath(stateRoot, projectId, memory.id), nomination);
  return true;
}

export async function withdrawGlobalNomination(
  stateRoot: string,
  projectId: string,
  memoryId: string,
): Promise<void> {
  await fs.rm(nominationPath(stateRoot, projectId, memoryId), { force: true });
}

async function readNominations(stateRoot: string): Promise<GlobalNomination[]> {
  const directory = path.join(stateRoot, "global", "nominations");
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
    JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as GlobalNomination,
  ));
  const verified: GlobalNomination[] = [];
  for (const value of values) {
    if (!value?.key || !value.projectId || !value.memoryId || !value.procedure || !value.artifactHash) continue;
    const projectStore = await loadStore(path.join(stateRoot, "projects", value.projectId, "state.json"));
    const memory = projectStore.memories.find((item) => item.id === value.memoryId);
    const graduated = projectStore.graduations.some((record) => record.memoryId === value.memoryId && record.status === "active");
    if (
      !memory || !graduated || memory.projectId !== value.projectId || memory.status !== "active" ||
      !autonomousGraduationEligible(memory, new Date().toISOString()) ||
      memory.kind !== "procedure" || !memory.procedure || memory.replay?.status !== "passed" ||
      memory.replay.optimizer !== "rlm-gepa" || memory.replay.fresh !== true || memoryArtifactHash(memory) !== value.artifactHash ||
      nominationKey(memory) !== value.key || memory.rule !== value.rule ||
      memory.title !== value.title || memory.model !== value.model || memory.createdAt !== value.createdAt ||
      JSON.stringify(normalizeKeywords(memory.keywords)) !== JSON.stringify(value.keywords) ||
      JSON.stringify(memory.procedure) !== JSON.stringify(value.procedure) ||
      (memory.experiment?.treatment.trials ?? 0) !== value.treatmentTrials ||
      memory.evidence.helpful !== value.helpful || memory.replay.semanticScore !== value.semanticScore ||
      memory.replay.heldOutDomains !== value.heldOutDomains || memory.replay.longContextScore !== value.longContextScore ||
      value.equivalenceClass !== memory.replay.equivalenceClass
      || JSON.stringify(value.domainScores) !== JSON.stringify(memory.replay.domainScores ?? {})
    ) continue;
    verified.push(value);
  }
  return verified;
}

async function readLedger(stateRoot: string): Promise<GlobalSkillLedger> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(stateRoot, "global", "skills.json"), "utf8")) as GlobalSkillLedger;
    return value?.version === 1 && Array.isArray(value.skills) ? value : { version: 1, skills: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, skills: [] };
    throw error;
  }
}

export async function activeGlobalMemoryIds(stateRoot: string): Promise<Set<string>> {
  const ledger = await readLedger(stateRoot);
  return new Set(ledger.skills.filter((record) => record.status === "active").map((record) => record.memoryId));
}

interface GlobalLock {
  path: string;
  owner: string;
  heartbeat: ReturnType<typeof setInterval>;
}

async function acquireGlobalLock(stateRoot: string): Promise<GlobalLock | undefined> {
  const globalDirectory = path.join(stateRoot, "global");
  const lockPath = path.join(globalDirectory, "reconcile.lock");
  await fs.mkdir(globalDirectory, { recursive: true, mode: 0o700 });
  const owner = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = await fs.stat(lockPath).catch(() => undefined);
      if (!lock) continue;
      if (Date.now() - lock.mtimeMs <= 30 * 60 * 1_000) return undefined;
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      try {
        await fs.mkdir(lockPath);
        acquired = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      } finally {
        await fs.rm(stalePath, { recursive: true, force: true });
      }
    }
  }
  if (!acquired) return undefined;
  const ownerPath = path.join(lockPath, "owner");
  await fs.writeFile(ownerPath, owner, { mode: 0o600, flag: "wx" });
  if (await fs.readFile(ownerPath, "utf8") !== owner) return undefined;
  const heartbeat = setInterval(() => {
    void fs.readFile(ownerPath, "utf8").then((currentOwner) => {
      if (currentOwner === owner) return fs.utimes(lockPath, new Date(), new Date());
    }).catch(() => undefined);
  }, 60_000);
  heartbeat.unref?.();
  return { path: lockPath, owner, heartbeat };
}

async function releaseGlobalLock(lock: GlobalLock): Promise<void> {
  clearInterval(lock.heartbeat);
  const owner = await fs.readFile(path.join(lock.path, "owner"), "utf8").catch(() => "");
  if (owner === lock.owner) await fs.rm(lock.path, { recursive: true, force: true });
}

function globalMemory(nomination: GlobalNomination, projectIds: string[], now: string): LearnedMemory {
  return {
    id: `global-${nomination.key}`,
    title: nomination.title,
    rule: nomination.rule,
    keywords: nomination.keywords,
    scope: "global",
    kind: "procedure",
    origin: "federated",
    procedure: nomination.procedure,
    projectId: "*",
    model: nomination.model,
    status: "active",
    confidence: 0.9,
    evidence: {
      observations: projectIds.length,
      helpful: nomination.helpful * projectIds.length,
      harmful: 0,
      neutral: 0,
    },
    sourceEpisodeIds: [],
    createdAt: nomination.createdAt,
    updatedAt: now,
  };
}

export async function reconcileGlobalSkills(
  stateRoot: string,
  agentDir: string,
  minimumProjects: number,
  minimumTreatmentTrials: number,
  now: string,
): Promise<GlobalSkillLedger> {
  const lock = await acquireGlobalLock(stateRoot);
  if (!lock) return readLedger(stateRoot);
  try {
  const nominations = await readNominations(stateRoot);
  const ledger = await readLedger(stateRoot);
  const groups = new Map<string, GlobalNomination[]>();
  for (const nomination of nominations) {
    groups.set(nomination.key, [...(groups.get(nomination.key) ?? []), nomination]);
  }
  const skills = [...ledger.skills];
  const keys = new Set([...groups.keys(), ...skills.filter((record) => record.status === "active").map((record) => record.key)]);

  for (const key of keys) {
    const group = groups.get(key) ?? [];
    const compatibleAll: GlobalNomination[] = [];
    for (const nomination of [...group].sort((left, right) => left.projectId.localeCompare(right.projectId))) {
      if (compatibleAll.every((existing) => semanticallyCompatible(existing, nomination))) compatibleAll.push(nomination);
    }
    const representative = compatibleAll[0];
    const byProject = new Map<string, GlobalNomination>();
    for (const nomination of compatibleAll) {
      const existing = byProject.get(nomination.projectId);
      if (!existing || nomination.treatmentTrials > existing.treatmentTrials) byProject.set(nomination.projectId, nomination);
    }
    const compatible = [...byProject.values()];
    const projectIds = [...new Set(compatible.map((nomination) => nomination.projectId))].sort();
    const treatmentTrials = compatible.reduce((sum, nomination) => sum + nomination.treatmentTrials, 0);
    let activeIndex = skills.findIndex((record) => record.key === key && record.status === "active");
    if (activeIndex >= 0 && representative) {
      const desired = globalMemory(representative, projectIds, now);
      if (skills[activeIndex]!.contentHash !== graduationContentHash(desired, "skill")) {
        skills[activeIndex] = {
          ...await rollbackGraduation(skills[activeIndex]!, skills[activeIndex]!.memory, now, "global representative changed"),
          key,
          projectIds,
          memory: skills[activeIndex]!.memory,
        };
        activeIndex = -1;
      }
    }
    if (projectIds.length >= minimumProjects && treatmentTrials >= minimumTreatmentTrials && representative && activeIndex < 0) {
      const memory = globalMemory(representative, projectIds, now);
      const destination = await graduateMemory(memory, "skill", "", agentDir);
      skills.push({
        key,
        projectIds,
        memory,
        memoryId: memory.id,
        target: "skill",
        destination,
        contentHash: graduationContentHash(memory, "skill"),
        graduatedAt: now,
        status: "active",
      });
    } else if ((projectIds.length < minimumProjects || treatmentTrials < minimumTreatmentTrials) && activeIndex >= 0) {
      skills[activeIndex] = {
        ...await rollbackGraduation(skills[activeIndex]!, skills[activeIndex]!.memory, now, "cross-project support fell below threshold"),
        key,
        projectIds,
        memory: skills[activeIndex]!.memory,
      };
    } else if (activeIndex >= 0) {
      skills[activeIndex] = { ...skills[activeIndex]!, projectIds };
    }
  }

  const result = { version: 1 as const, skills };
  await atomicJson(path.join(stateRoot, "global", "skills.json"), result);
  return result;
  } finally {
    await releaseGlobalLock(lock);
  }
}

export async function disableGlobalSkills(stateRoot: string, now: string): Promise<number> {
  const lock = await acquireGlobalLock(stateRoot);
  if (!lock) return 0;
  try {
  const ledger = await readLedger(stateRoot);
  let disabled = 0;
  const skills: GlobalSkillRecord[] = [];
  for (const record of ledger.skills) {
    if (record.status !== "active") {
      skills.push(record);
      continue;
    }
    skills.push({
      ...await rollbackGraduation(record, record.memory, now, "global autonomous learning disabled"),
      key: record.key,
      projectIds: record.projectIds,
      memory: record.memory,
    });
    disabled += 1;
  }
  await atomicJson(path.join(stateRoot, "global", "skills.json"), { version: 1, skills });
  return disabled;
  } finally {
    await releaseGlobalLock(lock);
  }
}
