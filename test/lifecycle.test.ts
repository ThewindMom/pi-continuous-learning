import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { newStore, projectIdForPath, saveStore, type LearnedMemory } from "../core.ts";
import { assignMemories } from "../autonomy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("extension lifecycle", () => {
  test("injects relevant guidance and rewards objective validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-lifecycle-"));
    roots.push(root);
    const previousHome = process.env.HOME;
    const previousRoot = process.env.PI_CONTINUOUS_LEARNING_ROOT;
    process.env.HOME = root;
    process.env.PI_CONTINUOUS_LEARNING_ROOT = path.join(root, ".pi", "continuous-learning-hybrid", "v3");
    try {
      const cwd = path.join(root, "project");
      await fs.mkdir(cwd, { recursive: true });
      const projectId = projectIdForPath(cwd);
      const statePath = path.join(root, ".pi", "continuous-learning-hybrid", "v3", "projects", projectId, "state.json");
      const memory: LearnedMemory = {
        id: "unicode-normalization",
        title: "Normalize Unicode usernames",
        rule: "Normalize usernames to Unicode NFC before deduplication.",
        keywords: ["unicode", "nfc", "username"],
        scope: "project",
        kind: "guidance",
        origin: "synthesized",
        projectId,
        model: "openai-codex/gpt-5.6-sol",
        status: "active",
        confidence: 0.72,
        evidence: { observations: 3, helpful: 1, harmful: 0, neutral: 0 },
        sourceEpisodeIds: ["a", "b"],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
      };
      await saveStore(statePath, { ...newStore(), memories: [memory] });

      const handlers = new Map<string, (event: any, ctx: any) => any>();
      const commands = new Map<string, any>();
      const notices: string[] = [];
      const pi = {
        on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
        registerCommand(name: string, command: any) { commands.set(name, command); },
      };
      const extension = (await import("../index.ts")).default;
      extension(pi as any);
      const ctx = {
        cwd,
        hasUI: false,
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "disabled" }) },
        ui: { notify(message: string) { notices.push(message); }, confirm: async () => false },
      };
      await handlers.get("session_start")?.({}, ctx);
      await commands.get("learn")?.handler("status", ctx);
      expect(notices.at(-1)).toContain('"active":1');
      const unrelated = await handlers.get("before_agent_start")?.({ prompt: "Sort graph nodes topologically", systemPrompt: "base" }, ctx);
      expect(unrelated).toBeUndefined();
      const relevantPrompt = Array.from({ length: 20 }, (_, index) => `Normalize a Unicode username to NFC case ${index}`)
        .find((prompt) => assignMemories(
          [{ memory, relevance: 1, overlap: 3 }],
          { prompt, projectId, model: "openai-codex/gpt-5.6-sol" },
          new Set(),
          { candidateControlRate: 0.5, activeControlRate: 0.15 },
        )[0]?.arm === "treatment")!;
      const relevant = await handlers.get("before_agent_start")?.({ prompt: relevantPrompt, systemPrompt: "base" }, ctx);
      expect(relevant.systemPrompt).toContain("Normalize usernames to Unicode NFC");

      const secondaryHandlers = new Map<string, (event: any, ctx: any) => any>();
      const secondaryCommands = new Map<string, any>();
      const secondaryNotices: string[] = [];
      extension({
        on(name: string, handler: (event: any, ctx: any) => any) { secondaryHandlers.set(name, handler); },
        registerCommand(name: string, command: any) { secondaryCommands.set(name, command); },
      } as any);
      const secondaryCtx = { ...ctx, ui: { ...ctx.ui, notify(message: string) { secondaryNotices.push(message); } } };
      await secondaryHandlers.get("session_start")?.({}, secondaryCtx);
      const secondaryInjection = await secondaryHandlers.get("before_agent_start")?.({ prompt: relevantPrompt, systemPrompt: "base" }, secondaryCtx);
      expect(secondaryInjection).toBeUndefined();
      await secondaryCommands.get("learn")?.handler("add unicode,nfc :: A second-session write must fail.", secondaryCtx);
      expect(secondaryNotices.at(-1)).toContain("read-only");
      await secondaryHandlers.get("session_shutdown")?.({}, secondaryCtx);

      await handlers.get("tool_execution_start")?.({ toolCallId: "validate-1", toolName: "bash", args: { command: "bun test" } }, ctx);
      await handlers.get("tool_execution_end")?.({ toolCallId: "validate-1", isError: false, result: "1 pass\n0 fail" }, ctx);
      await handlers.get("agent_end")?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "Verified." }] }] }, ctx);
      await handlers.get("agent_settled")?.({}, ctx);
      await handlers.get("session_shutdown")?.({}, ctx);
      const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
      expect(persisted.memories[0].confidence).toBeCloseTo(0.74);
      expect(persisted.version).toBe(3);
      const attributedEpisode = persisted.episodes.find((episode: { memoryAssignments: unknown[] }) => episode.memoryAssignments.length > 0);
      expect(attributedEpisode.verified).toBe(true);
      expect(attributedEpisode.memoryAssignments[0].memoryId).toBe("unicode-normalization");
      if (attributedEpisode.memoryAssignments[0].arm === "treatment") {
        expect(persisted.memories[0].evidence.helpful).toBe(2);
      } else {
        expect(persisted.memories[0].experiment.control.verified).toBe(1);
      }
      expect(commands.has("learn")).toBe(true);
    } finally {
      process.env.HOME = previousHome;
      if (previousRoot === undefined) delete process.env.PI_CONTINUOUS_LEARNING_ROOT;
      else process.env.PI_CONTINUOUS_LEARNING_ROOT = previousRoot;
    }
  });
});
