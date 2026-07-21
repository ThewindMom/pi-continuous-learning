import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import extension from "../index.ts";
import { loadStore, projectIdForPath } from "../core.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function context(root: string, entries: unknown[]) {
  return {
    cwd: root,
    hasUI: true,
    ui: { notify() {}, confirm: async () => false },
    sessionManager: {
      getSessionFile: () => path.join(root, "session.jsonl"),
      getSessionId: () => "session-1",
      getLeafId: () => "assistant-1",
      getEntries: () => entries,
    },
  } as any;
}

function api() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const value = {
    handlers,
    commands,
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) { commands.set(name, command); },
  };
  extension(value as any);
  return value;
}

describe("small continuous-learning lifecycle", () => {
  test("injects locally and does not depend on tool events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "small-learning-"));
    roots.push(root);
    const previousRoot = process.env.PI_CONTINUOUS_LEARNING_ROOT;
    process.env.PI_CONTINUOUS_LEARNING_ROOT = root;
    const entries: unknown[] = [];
    const ctx = context(root, entries);
    const handlers = api().handlers;
    try {
      await handlers.get("session_start")?.({}, ctx);
      const result = await handlers.get("before_agent_start")?.({ prompt: "normalize unicode usernames", systemPrompt: "base" }, ctx);
      expect(result).toBeUndefined();
      expect(handlers.has("tool_execution_start")).toBe(false);
      expect(handlers.has("tool_execution_end")).toBe(false);
      await handlers.get("session_shutdown")?.({}, ctx);
    } finally {
      if (previousRoot === undefined) delete process.env.PI_CONTINUOUS_LEARNING_ROOT;
      else process.env.PI_CONTINUOUS_LEARNING_ROOT = previousRoot;
    }
  });

  test("coalesces settled events and records only bounded attribution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "small-learning-"));
    roots.push(root);
    const previousRoot = process.env.PI_CONTINUOUS_LEARNING_ROOT;
    process.env.PI_CONTINUOUS_LEARNING_ROOT = root;
    const entries = [
      { type: "message", id: "user-1", parentId: null, message: { role: "user", content: [{ type: "text", text: "fix unicode username tests" }] } },
      { type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "text", text: "Verified: tests passed." }] } },
    ];
    const ctx = context(root, entries);
    const value = api();
    try {
      await value.handlers.get("session_start")?.({}, ctx);
      await value.handlers.get("before_agent_start")?.({ prompt: "fix unicode username tests", systemPrompt: "base" }, ctx);
      await value.handlers.get("agent_settled")?.({}, ctx);
      await value.handlers.get("agent_settled")?.({}, ctx);
      await value.handlers.get("session_shutdown")?.({}, ctx);
      const persisted = await loadStore(path.join(root, "projects", projectIdForPath(root), "state.json"));
      expect(persisted.historyCursor.attributions).toHaveLength(1);
      expect(JSON.stringify(persisted)).not.toContain("tests passed");
    } finally {
      if (previousRoot === undefined) delete process.env.PI_CONTINUOUS_LEARNING_ROOT;
      else process.env.PI_CONTINUOUS_LEARNING_ROOT = previousRoot;
    }
  });
});
