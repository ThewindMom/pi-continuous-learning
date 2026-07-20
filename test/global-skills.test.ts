import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { memoryArtifactHash, newStore, saveStore, type LearnedMemory } from "../core.ts";
import { disableGlobalSkills, nominateGlobalSkill, reconcileGlobalSkills, withdrawGlobalNomination } from "../global-skills.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function memory(projectId: string): LearnedMemory {
  const learned: LearnedMemory = {
    id: `unicode-${projectId}`,
    title: "Normalize Unicode usernames",
    rule: "Normalize usernames to Unicode NFC before deduplication.",
    keywords: ["unicode", "nfc", "username"],
    scope: "project",
    kind: "procedure",
    origin: "synthesized",
    procedure: {
      goal: "Normalize and deduplicate usernames consistently.",
      steps: ["Normalize each username to NFC.", "Deduplicate normalized usernames."],
      verification: ["Run the username normalization test suite."],
      recovery: ["Restore the previous implementation if verification fails."],
      decomposition: "parse-transform",
    },
    projectId,
    model: "openai-codex/gpt-5.6-sol",
    status: "active",
    confidence: 0.88,
    evidence: { observations: 35, helpful: 25, harmful: 0, neutral: 0 },
    sourceEpisodeIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    experiment: {
      treatment: { trials: 25, verified: 25, corrected: 0, tokens: 2_000, cost: 1, latencyMs: 20_000, failedAttempts: 0, strata: { "parse-transform/short": { trials: 25, verified: 25, corrected: 0, tokens: 2_000, cost: 1, latencyMs: 20_000, failedAttempts: 0 } } },
      control: { trials: 10, verified: 5, corrected: 0, tokens: 1_000, cost: 0.5, latencyMs: 10_000, failedAttempts: 0, strata: { "parse-transform/short": { trials: 10, verified: 5, corrected: 0, tokens: 1_000, cost: 0.5, latencyMs: 10_000, failedAttempts: 0 } } },
      decision: "promoted",
    },
    replay: {
      status: "passed",
      model: "openai-codex/gpt-5.6-sol",
      score: 0.92,
      cases: 20,
      falsePositiveRate: 0.05,
      sourceHash: "trace-source",
      optimizer: "rlm-gepa",
      equivalenceClass: "normalize-then-deduplicate",
      semanticScore: 0.94,
      heldOutDomains: 2,
      longContextScore: 0.9,
      domainScores: { text: 0.9, data: 0.85 },
      caseIds: ["a", "b", "c", "d", "e", "f"],
      fresh: true,
    },
  };
  return { ...learned, replay: { ...learned.replay!, artifactHash: memoryArtifactHash(learned) } };
}

function unrelatedMemory(projectId: string): LearnedMemory {
  const base = memory(projectId);
  const unrelated: LearnedMemory = {
    ...base,
    id: `auth-redaction-${projectId}`,
    title: "Redact authentication tokens",
    rule: "Redact authorization bearer tokens before logging requests.",
    keywords: ["authorization", "bearer", "redaction"],
    procedure: {
      goal: "Prevent authentication tokens from entering request logs.",
      steps: ["Inspect authorization headers.", "Replace bearer credentials with a redaction marker."],
      verification: ["Run the request logging security tests."],
      recovery: ["Disable request logging when redaction verification fails."],
      decomposition: "parse-transform",
    },
  };
  return { ...unrelated, replay: { ...unrelated.replay!, artifactHash: memoryArtifactHash(unrelated) } };
}

async function nominateTrusted(stateRoot: string, item: LearnedMemory): Promise<void> {
  await saveStore(path.join(stateRoot, "projects", item.projectId, "state.json"), {
    ...newStore(),
    memories: [item],
    graduations: [{
      memoryId: item.id,
      target: "agents",
      destination: path.join(stateRoot, "projects", item.projectId, "AGENTS.md"),
      contentHash: "trusted-test-record",
      graduatedAt: "2026-07-20T00:00:00.000Z",
      status: "active",
    }],
  });
  await nominateGlobalSkill(stateRoot, item.projectId, item);
}

describe("cross-project skill federation", () => {
  test("creates a skill after three projects and removes it when support drops", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    for (const projectId of ["project-a", "project-b"]) {
      await nominateTrusted(stateRoot, memory(projectId));
    }
    let ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-20T00:00:00.000Z");
    expect(ledger.skills).toHaveLength(0);

    await nominateTrusted(stateRoot, memory("project-c"));
    ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    expect(ledger.skills.filter((record) => record.status === "active")).toHaveLength(1);
    const record = ledger.skills[0]!;
    expect(await fs.readFile(record.destination, "utf8")).toContain("Normalize each username to NFC");

    await withdrawGlobalNomination(stateRoot, "project-c", "unicode-project-c");
    ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-22T00:00:00.000Z");
    expect(ledger.skills.at(-1)?.status).toBe("rolled_back");
    expect(fs.access(record.destination)).rejects.toThrow();
  });

  test("does not merge procedures with different semantic equivalence classes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-semantic-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    const variants = [
      memory("project-a"),
      { ...memory("project-b"), replay: { ...memory("project-b").replay!, equivalenceClass: "normalize-without-deduplication" } },
      { ...memory("project-c"), replay: { ...memory("project-c").replay!, equivalenceClass: "normalize-without-deduplication" } },
    ];
    for (const item of variants) await nominateTrusted(stateRoot, item);
    const ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    expect(ledger.skills).toHaveLength(0);
  });

  test("rejects unrelated procedures that claim the same equivalence class", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-adversarial-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    const variants = [memory("project-a"), unrelatedMemory("project-b"), unrelatedMemory("project-c")];
    for (const item of variants) await nominateTrusted(stateRoot, item);
    const ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    expect(ledger.skills).toHaveLength(0);
  });

  test("globally disables every managed skill artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-disable-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    for (const projectId of ["project-a", "project-b", "project-c"]) {
      await nominateTrusted(stateRoot, memory(projectId));
    }
    const ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    const destination = ledger.skills[0]!.destination;
    expect(await disableGlobalSkills(stateRoot, "2026-07-22T00:00:00.000Z")).toBe(1);
    expect(fs.access(destination)).rejects.toThrow();
  });

  test("rejects forged nomination files without project-state authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-forged-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    for (const projectId of ["fake-a", "fake-b", "fake-c"]) {
      const item = memory(projectId);
      const destination = path.join(stateRoot, "global", "nominations", `${projectId}-${item.id}.json`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, JSON.stringify({
        key: "forged",
        projectId,
        memoryId: item.id,
        model: item.model,
        rule: item.rule,
        keywords: item.keywords,
        procedure: item.procedure,
        equivalenceClass: "normalize-then-deduplicate",
        semanticScore: 1,
        treatmentTrials: 999,
        heldOutDomains: 99,
        longContextScore: 1,
        artifactHash: memoryArtifactHash(item),
      }));
    }
    const ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    expect(ledger.skills).toHaveLength(0);
  });

  test("rejects inflated nomination metrics despite valid project state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-global-inflated-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const agentDir = path.join(root, "agent");
    for (const projectId of ["project-a", "project-b", "project-c"]) {
      const item = memory(projectId);
      await nominateTrusted(stateRoot, item);
      const destination = path.join(stateRoot, "global", "nominations", `${projectId}-${item.id}.json`);
      const forged = JSON.parse(await fs.readFile(destination, "utf8"));
      forged.semanticScore = 1;
      forged.helpful = 999;
      forged.treatmentTrials = 999;
      await fs.writeFile(destination, JSON.stringify(forged));
    }
    const ledger = await reconcileGlobalSkills(stateRoot, agentDir, 3, 50, "2026-07-21T00:00:00.000Z");
    expect(ledger.skills).toHaveLength(0);
  });
});
