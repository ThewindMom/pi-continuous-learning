import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { LearnedMemory } from "../core.ts";
import { checkGraduation, cleanupOrphanedAgentBlocks, cleanupOrphanedSkills, graduateMemory, graduationContentHash, rollbackGraduation } from "../graduation.ts";

const roots: string[] = [];
const memory: LearnedMemory = {
  id: "unicode-usernames",
  title: "Normalize Unicode usernames",
  rule: "Normalize usernames to Unicode NFC before deduplication.",
  keywords: ["unicode", "nfc", "username"],
  scope: "project",
  kind: "guidance",
  origin: "synthesized",
  projectId: "project-a",
  model: "openai-codex/gpt-5.6-sol",
  status: "active",
  confidence: 0.8,
  evidence: { observations: 6, helpful: 3, harmful: 0, neutral: 2 },
  sourceEpisodeIds: ["a", "b"],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
};
const procedureMemory: LearnedMemory = {
  ...memory,
  id: "unicode-usernames-procedure",
  kind: "procedure",
  procedure: {
    goal: "Normalize and deduplicate usernames consistently.",
    steps: ["Normalize each username to NFC.", "Deduplicate normalized usernames."],
    verification: ["Run the username normalization tests."],
    recovery: ["Restore the prior implementation when verification fails."],
    decomposition: "parse-transform",
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("graduation artifacts", () => {
  test("rejects immature memories", () => {
    const check = checkGraduation({ ...memory, confidence: 0.6 }, "2026-07-20T00:00:00.000Z");
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain("confidence is below 0.75");
  });

  test("writes idempotent AGENTS guidance only after eligibility", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-graduate-"));
    roots.push(root);
    expect(checkGraduation(memory, "2026-07-20T00:00:00.000Z").eligible).toBe(true);
    await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/<!-- pi-learned:unicode-usernames -->/g)).toHaveLength(1);
  });

  test("writes a standalone skill and refuses overwrite", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-skill-"));
    roots.push(root);
    const agentDir = path.join(root, ".pi", "agent");
    const destination = await graduateMemory(procedureMemory, "skill", root, agentDir);
    expect(await fs.readFile(destination, "utf8")).toContain("Normalize each username to NFC");
    expect(graduateMemory(procedureMemory, "skill", root, agentDir)).rejects.toThrow("Refusing to overwrite");
  });

  test("rolls back only an unchanged autonomous artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-rollback-"));
    roots.push(root);
    const destination = await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    const record = {
      memoryId: memory.id,
      target: "agents" as const,
      destination,
      contentHash: graduationContentHash(memory, "agents"),
      graduatedAt: "2026-07-20T00:00:00.000Z",
      status: "active" as const,
    };
    const rolledBack = await rollbackGraduation(record, memory, "2026-07-21T00:00:00.000Z", "explicit correction");
    expect(rolledBack.status).toBe("rolled_back");
    expect(await fs.readFile(destination, "utf8")).not.toContain("pi-learned:unicode-usernames");
  });

  test("quarantines a modified managed block instead of leaving it active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-quarantine-"));
    roots.push(root);
    const destination = await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    const existing = await fs.readFile(destination, "utf8");
    await fs.writeFile(destination, existing.replace(memory.rule, `${memory.rule} User-modified note.`));
    const record = {
      memoryId: memory.id,
      target: "agents" as const,
      destination,
      contentHash: graduationContentHash(memory, "agents"),
      graduatedAt: "2026-07-20T00:00:00.000Z",
      status: "active" as const,
    };
    const rolledBack = await rollbackGraduation(record, memory, "2026-07-21T00:00:00.000Z", "autonomy disabled");
    expect(rolledBack.status).toBe("rolled_back");
    expect(await fs.readFile(destination, "utf8")).not.toContain("pi-learned:unicode-usernames");
    expect((await fs.readdir(path.join(root, ".pi-learning-quarantine"))).length).toBe(1);
  });

  test("concurrent AGENTS writes never silently lose a fulfilled update", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-cas-"));
    roots.push(root);
    const second = { ...memory, id: "unicode-usernames-second", title: "Second Unicode rule" };
    const results = await Promise.allSettled([
      graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent")),
      graduateMemory(second, "agents", root, path.join(root, ".pi", "agent")),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    const content = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(content.match(/<!-- pi-learned:/g)?.length ?? 0).toBe(fulfilled);
  });

  test("quarantines the whole AGENTS file when managed markers are damaged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-marker-damage-"));
    roots.push(root);
    const destination = await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    const existing = await fs.readFile(destination, "utf8");
    await fs.writeFile(destination, existing.replace("<!-- pi-learned:", "<!-- damaged-pi-learned:"));
    const record = {
      memoryId: memory.id,
      target: "agents" as const,
      destination,
      contentHash: graduationContentHash(memory, "agents"),
      graduatedAt: "2026-07-20T00:00:00.000Z",
      status: "active" as const,
    };
    const rolledBack = await rollbackGraduation(record, memory, "2026-07-21T00:00:00.000Z", "autonomy disabled");
    expect(rolledBack.status).toBe("rolled_back");
    expect(await fs.readFile(destination, "utf8")).toBe("");
    expect((await fs.readdir(path.join(root, ".pi-learning-quarantine"))).length).toBe(1);
  });

  test("quarantines orphaned generated skill directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-orphan-skill-"));
    roots.push(root);
    const agentDir = path.join(root, "agent");
    const destination = await graduateMemory(procedureMemory, "skill", root, agentDir);
    expect(await cleanupOrphanedSkills(agentDir, new Set())).toBe(1);
    expect(fs.access(destination)).rejects.toThrow();
    expect((await fs.readdir(path.join(agentDir, "learning-quarantine"))).length).toBe(1);
  });

  test("quarantines orphaned global skill directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-orphan-global-"));
    roots.push(root);
    const agentDir = path.join(root, "agent");
    const globalMemory = { ...procedureMemory, id: "global-orphan-procedure", scope: "global" as const };
    const destination = await graduateMemory(globalMemory, "skill", root, agentDir);
    expect(await cleanupOrphanedSkills(agentDir, new Set())).toBe(1);
    expect(fs.access(destination)).rejects.toThrow();
  });

  test("startup cleanup quarantines malformed legacy Senpi fragments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-malformed-startup-"));
    roots.push(root);
    const destination = path.join(root, "AGENTS.md");
    await fs.writeFile(destination, "User content\n<!-- senpi-learned:broken -->\nunsafe autonomous guidance\n");
    expect(await cleanupOrphanedAgentBlocks(root, new Set())).toBe(1);
    expect(await fs.readFile(destination, "utf8")).toBe("");
    expect((await fs.readdir(path.join(root, ".pi-learning-quarantine"))).length).toBe(1);
  });

  test("preserves active legacy markers without duplicating Pi guidance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-legacy-marker-"));
    roots.push(root);
    const destination = path.join(root, "AGENTS.md");
    await fs.writeFile(destination, `<!-- senpi-learned:${memory.id} -->\nlegacy guidance\n<!-- /senpi-learned:${memory.id} -->\n`);
    expect(await cleanupOrphanedAgentBlocks(root, new Set([memory.id]))).toBe(0);
    await graduateMemory(memory, "agents", root, path.join(root, ".pi", "agent"));
    const content = await fs.readFile(destination, "utf8");
    expect(content).toContain(`<!-- senpi-learned:${memory.id} -->`);
    expect(content).not.toContain(`<!-- pi-learned:${memory.id} -->`);
  });
});
