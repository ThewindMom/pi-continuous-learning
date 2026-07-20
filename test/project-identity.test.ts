import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { projectIdForPath } from "../core.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("project identity", () => {
  test("deduplicates clones across Git transport variants", async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), "pi-identity-a-"));
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "pi-identity-b-"));
    roots.push(first, second);
    for (const [root, remote] of [
      [first, "git@github.com:Example/Repository.git"],
      [second, "ssh://git@github.com/Example/Repository.git"],
    ]) {
      expect(Bun.spawnSync(["git", "init", root]).exitCode).toBe(0);
      expect(Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", remote]).exitCode).toBe(0);
    }
    expect(projectIdForPath(first)).toBe(projectIdForPath(second));
  });
});
