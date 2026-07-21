import { describe, expect, test } from "bun:test";

import { parseInteractions, type HistoryEntry } from "../history.ts";

function entry(id: string, parentId: string | null, role: string, text: string): HistoryEntry {
  return { type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } };
}

describe("Pi history cursor processing", () => {
  test("parses completed interactions and advances idempotently", () => {
    const entries = [
      entry("u1", null, "user", "fix the parser"),
      entry("a1", "u1", "assistant", "Verified: tests passed."),
      entry("u2", "a1", "user", "that is wrong, fix the parser"),
      entry("a2", "u2", "assistant", "The test failed and I corrected it."),
    ];
    const first = parseInteractions(entries, { attributions: [] }, "a2", 10);
    expect(first.interactions).toHaveLength(2);
    expect(first.interactions[1]?.harmful).toBe(true);
    const second = parseInteractions(entries, first.cursor, "a2", 10);
    expect(second.interactions).toHaveLength(0);
  });

  test("ignores unknown entries and incomplete trailing turns", () => {
    const entries = [
      { type: "custom", id: "custom-1" },
      entry("u1", null, "user", "run the check"),
      entry("a1", "u1", "assistant", "Verified and complete."),
      entry("u2", "a1", "user", "continue"),
    ];
    const result = parseInteractions(entries, { attributions: [] }, "u2", 10);
    expect(result.interactions).toHaveLength(1);
    expect(result.cursor.entryId).toBe("a1");
  });
});
