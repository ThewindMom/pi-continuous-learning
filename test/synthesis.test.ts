import { describe, expect, test } from "bun:test";
import { buildSynthesisInput, parseCandidateResponse } from "../synthesis.ts";

describe("memory synthesis protocol", () => {
  test("parses fenced structured candidates", () => {
    const candidates = parseCandidateResponse(`\`\`\`json
{"candidates":[{"title":"Unicode equality","rule":"Normalize names to NFC before deduplication.","keywords":["unicode","nfc","names"],"evidenceEpisodeIds":["e1","e2","e3"],"confidence":0.74}]}
\`\`\``);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceEpisodeIds).toEqual(["e1", "e2", "e3"]);
  });

  test("rejects malformed candidate output", () => {
    expect(parseCandidateResponse("not-json")).toEqual([]);
    expect(parseCandidateResponse('{"candidates":[{"title":2}]}')).toEqual([]);
  });

  test("sends bounded scrubbed episode evidence", () => {
    const input = buildSynthesisInput([
      {
        id: "e1",
        status: "settled",
        timestamp: "2026-07-20T00:00:00.000Z",
        projectId: "p",
        model: "openai-codex/gpt-5.6-sol",
        prompt: `API_KEY=secret ${"x".repeat(5000)}`,
        response: "Tests passed",
        autonomous: true,
        memoryAssignments: [],
        injectedMemoryIds: [],
        toolCalls: 2,
        toolErrors: 0,
        verified: true,
        corrected: false,
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.01,
        latencyMs: 1_000,
        failedAttempts: 0,
        taskStratum: "diagnose-verify/short",
      },
    ]);
    expect(input).not.toContain("secret");
    expect(input.length).toBeLessThan(5000);
    expect(input).toContain("e1");
  });
});
