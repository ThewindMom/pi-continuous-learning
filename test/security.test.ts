import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { sanitizeLegacyCorpus } from "../security.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("legacy corpus migration", () => {
  test("removes remote credentials without corrupting long project paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-security-"));
    roots.push(root);
    const projectDir = path.join(root, "projects", "abc123");
    await fs.mkdir(projectDir, { recursive: true });
    const project = {
      id: "abc123",
      name: "repo",
      root: "/home/example/a-very-long-but-legitimate-workspace-directory-name-that-must-survive",
      remote: "https://user:ghp_dummycredential1234567890@example.com/org/repo.git",
    };
    await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project));
    await fs.writeFile(path.join(projectDir, "observations.jsonl"), JSON.stringify({ output: "token ghp_dummycredential1234567890" }));
    await fs.writeFile(path.join(root, "projects.json"), JSON.stringify({ abc123: { ...project, root: "[REDACTED]" } }));

    expect(await sanitizeLegacyCorpus(root)).toBeGreaterThan(0);
    const registry = JSON.parse(await fs.readFile(path.join(root, "projects.json"), "utf8"));
    expect(registry.abc123.root).toBe(project.root);
    expect(registry.abc123.remote).toBe("https://example.com/org/repo.git");
    expect(await fs.readFile(path.join(projectDir, "observations.jsonl"), "utf8")).not.toContain("ghp_");
    expect((await fs.stat(path.join(root, "projects.json"))).mode & 0o777).toBe(0o600);
  });
});
