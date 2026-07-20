import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { renderMemoryGuidance, type GraduationRecord, type LearnedMemory } from "./core.ts";

export type GraduationTarget = "agents" | "skill";

export interface GraduationCheck {
  eligible: boolean;
  reasons: string[];
}

export function checkGraduation(memory: LearnedMemory, now: string): GraduationCheck {
  const ageDays = (Date.parse(now) - Date.parse(memory.createdAt)) / 86_400_000;
  const reasons: string[] = [];
  if (memory.status !== "active") reasons.push("memory is not active");
  if (memory.confidence < 0.75) reasons.push("confidence is below 0.75");
  if (memory.evidence.helpful < 3) reasons.push("fewer than three verified helpful outcomes");
  if (memory.evidence.harmful > 1) reasons.push("more than one harmful outcome");
  if (ageDays < 7) reasons.push("memory is younger than seven days");
  return { eligible: reasons.length === 0, reasons };
}

export function graduationPreview(memory: LearnedMemory, target: GraduationTarget, destination: string): string {
  return [
    `Target: ${target}`,
    `Destination: ${destination}`,
    `Memory: ${memory.title}`,
    `Rule: ${memory.rule}`,
    `Evidence: ${memory.evidence.helpful} helpful / ${memory.evidence.harmful} harmful`,
  ].join("\n");
}

async function atomicWrite(filePath: string, content: string, expected?: string | null): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.senpi-lock`;
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lock = await fs.stat(lockPath);
    if (Date.now() - lock.mtimeMs <= 60_000) throw new Error(`Artifact write already in progress: ${filePath}`);
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath);
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (expected !== undefined) {
      let current: string | null = null;
      try {
        current = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== expected) throw new Error(`Concurrent modification detected: ${filePath}`);
    }
    await fs.writeFile(temporary, content, "utf8");
    if (expected !== undefined) {
      let current: string | null = null;
      try {
        current = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== expected) throw new Error(`Concurrent modification detected: ${filePath}`);
    }
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function agentsBlock(memory: LearnedMemory): string {
  return `<!-- senpi-learned:${memory.id} -->\n## Learned project guidance\n\nModel scope: ${memory.model}\n\n${renderMemoryGuidance(memory)}\n<!-- /senpi-learned:${memory.id} -->\n`;
}

export async function cleanupOrphanedAgentBlocks(
  cwd: string,
  activeMemoryIds: Set<string>,
): Promise<number> {
  const destination = path.join(cwd, "AGENTS.md");
  let existing: string;
  try {
    existing = await fs.readFile(destination, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  const next = existing.replace(
    /<!-- senpi-learned:([^\s]+) -->[\s\S]*?<!-- \/senpi-learned:\1 -->\n?/g,
    (block, memoryId: string) => {
      if (activeMemoryIds.has(memoryId)) return block;
      removed += 1;
      return "";
    },
  ).trimEnd();
  if (/senpi-learned:/.test(next)) {
    const quarantine = path.join(path.dirname(destination), ".senpi-learning-quarantine");
    await atomicWrite(path.join(quarantine, `AGENTS-malformed-${Date.now()}.md`), existing, null);
    await atomicWrite(destination, "", existing);
    return removed + 1;
  }
  if (removed > 0) await atomicWrite(destination, next ? `${next}\n` : "", existing);
  return removed;
}

export async function cleanupOrphanedSkills(agentDir: string, activeMemoryIds: Set<string>): Promise<number> {
  const skillsDirectory = path.join(agentDir, "skills");
  const entries = await fs.readdir(skillsDirectory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("learned-")) continue;
    const skillDirectory = path.join(skillsDirectory, entry.name);
    const content = await fs.readFile(path.join(skillDirectory, "SKILL.md"), "utf8").catch(() => "");
    const memoryId = content.match(/^memory_id:\s*([^\s]+)$/m)?.[1];
    if (!memoryId || activeMemoryIds.has(memoryId)) continue;
    const quarantine = path.join(agentDir, "learning-quarantine");
    await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
    await fs.rename(skillDirectory, path.join(quarantine, `${entry.name}-${Date.now()}`));
    removed += 1;
  }
  return removed;
}

function skillContent(memory: LearnedMemory): string {
  if (memory.kind !== "procedure" || !memory.procedure) {
    throw new Error(`Refusing to create a skill from non-procedural memory: ${memory.id}`);
  }
  return [
    "---",
    `name: learned-${memory.id}`,
    `description: ${JSON.stringify(memory.title.replace(/[\r\n]/g, " "))}`,
    `memory_id: ${memory.id}`,
    "---",
    "",
    `# ${memory.title}`,
    "",
    memory.procedure.goal,
    "",
    "## Procedure",
    "",
    ...memory.procedure.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Verification",
    "",
    ...memory.procedure.verification.map((step) => `- ${step}`),
    "",
    "## Recovery",
    "",
    ...(memory.procedure.recovery.length > 0 ? memory.procedure.recovery.map((step) => `- ${step}`) : ["- Stop and preserve the last verified state."]),
    "",
    "## Decomposition",
    "",
    memory.procedure.decomposition,
    "",
    "## Model scope",
    "",
    memory.model,
    "",
    "## Evidence",
    "",
    `Promoted after ${memory.evidence.helpful} helpful outcomes and ${memory.evidence.harmful} harmful outcomes.`,
    "",
  ].join("\n");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function graduationContentHash(memory: LearnedMemory, target: GraduationTarget): string {
  return digest(target === "agents" ? agentsBlock(memory) : skillContent(memory));
}

export function graduationDestination(
  memory: LearnedMemory,
  target: GraduationTarget,
  cwd: string,
  agentDir: string,
): string {
  return target === "agents"
    ? path.join(cwd, "AGENTS.md")
    : path.join(agentDir, "skills", `learned-${memory.id}`, "SKILL.md");
}

export async function graduateMemory(
  memory: LearnedMemory,
  target: GraduationTarget,
  cwd: string,
  agentDir: string,
): Promise<string> {
  const destination = graduationDestination(memory, target, cwd, agentDir);
  if (target === "skill" && (memory.kind !== "procedure" || !memory.procedure)) {
    throw new Error(`Refusing to create a skill from non-procedural memory: ${memory.id}`);
  }
  if (target === "agents") {
    let existing = "";
    let exists = true;
    try {
      existing = await fs.readFile(destination, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    const marker = `<!-- senpi-learned:${memory.id} -->`;
    if (existing.includes(marker)) return destination;
    const block = agentsBlock(memory);
    await atomicWrite(destination, `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}`, exists ? existing : null);
    return destination;
  }

  try {
    await fs.access(destination);
    throw new Error(`Refusing to overwrite existing skill: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(destination, skillContent(memory), null);
  return destination;
}

export async function rollbackGraduation(
  record: GraduationRecord,
  memory: LearnedMemory,
  now: string,
  reason: string,
): Promise<GraduationRecord> {
  try {
    const existing = await fs.readFile(record.destination, "utf8");
    if (record.target === "agents") {
      const block = agentsBlock(memory);
      const escapedId = memory.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = existing.match(new RegExp(`<!-- senpi-learned:${escapedId} -->[\\s\\S]*?<!-- \\/senpi-learned:${escapedId} -->\\n?`));
      if (!match) {
        const quarantine = path.join(path.dirname(record.destination), ".senpi-learning-quarantine");
        await atomicWrite(path.join(quarantine, `AGENTS-${memory.id}-${Date.now()}.md`), existing, null);
        await atomicWrite(record.destination, "", existing);
        reason = `${reason}; marker-damaged AGENTS file quarantined`;
      } else {
        const modified = digest(block) !== record.contentHash || match[0].trimEnd() !== block.trimEnd();
        if (modified) {
          const quarantine = path.join(path.dirname(record.destination), ".senpi-learning-quarantine");
          await atomicWrite(path.join(quarantine, `${memory.id}-${Date.now()}.md`), match[0], null);
        }
        const next = existing.replace(match[0], "").trimEnd();
        await atomicWrite(record.destination, next ? `${next}\n` : "", existing);
        if (modified) reason = `${reason}; modified managed block quarantined`;
      }
    } else {
      if (digest(existing) !== record.contentHash) {
        const skillDirectory = path.dirname(record.destination);
        const quarantine = path.join(path.dirname(skillDirectory), "..", "learning-quarantine");
        await fs.mkdir(quarantine, { recursive: true, mode: 0o700 });
        await fs.rename(skillDirectory, path.join(quarantine, `${path.basename(skillDirectory)}-${Date.now()}`));
        reason = `${reason}; modified managed skill quarantined`;
      } else {
        await fs.rm(record.destination);
        await fs.rmdir(path.dirname(record.destination)).catch(() => undefined);
      }
    }
    return { ...record, status: "rolled_back", rolledBackAt: now, reason };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...record, status: "rolled_back", rolledBackAt: now, reason: `${reason}; artifact already absent` };
    }
    throw error;
  }
}
