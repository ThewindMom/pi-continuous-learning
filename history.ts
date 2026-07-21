import * as fs from "node:fs/promises";

import { scrubSecrets, type Attribution, type HistoryCursor } from "./core.ts";

export interface HistoryEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Interaction {
  id: string;
  entryId: string;
  userPrompt: string;
  assistantText: string;
  completed: boolean;
  helpful: boolean;
  harmful: boolean;
  keywords: string[];
  sourceEntryIds: string[];
}

export interface HistoryBatch {
  interactions: Interaction[];
  cursor: HistoryCursor;
  hasMore: boolean;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function messageText(entry: HistoryEntry): string {
  return textContent(entry.message?.content);
}

function isMessage(entry: HistoryEntry, role?: string): boolean {
  return entry.type === "message" && typeof entry.message?.role === "string" &&
    (role === undefined || entry.message.role === role);
}

function branchEntries(entries: HistoryEntry[], leafId?: string): HistoryEntry[] {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  let current = leafId ? byId.get(leafId) : entries.at(-1);
  const branch: HistoryEntry[] = [];
  const seen = new Set<string>();
  while (current && current.id && !seen.has(current.id)) {
    branch.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

function outcome(text: string, nextUserPrompt?: string): Pick<Interaction, "helpful" | "harmful"> {
  const combined = `${text}\n${nextUserPrompt ?? ""}`;
  const harmful = /(?:correction|wrong|broke|failed|revert|undo|doesn't work|did not work)/i.test(combined);
  const helpful = !harmful && /(?:pass(?:ed)?|success(?:ful)?|verified|fixed|working|complete|clean)/i.test(text);
  return { helpful, harmful };
}

function interactionFrom(
  user: HistoryEntry,
  assistantEntries: HistoryEntry[],
  nextUserPrompt?: string,
): Interaction | undefined {
  const userPrompt = scrubSecrets(messageText(user)).trim();
  if (!userPrompt || assistantEntries.length === 0) return undefined;
  const assistantText = scrubSecrets(assistantEntries.map(messageText).filter(Boolean).join("\n")).slice(-4_000);
  if (!assistantText) return undefined;
  const terminal = assistantEntries.at(-1)!;
  const id = user.id ?? terminal.id;
  if (!id) return undefined;
  const result = outcome(assistantText, nextUserPrompt);
  const keywords: string[] = [...new Set(userPrompt.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])].slice(0, 16);
  return {
    id,
    entryId: terminal.id ?? id,
    userPrompt: userPrompt.slice(0, 2_400),
    assistantText,
    completed: true,
    ...result,
    keywords,
    sourceEntryIds: [user.id, ...assistantEntries.map((entry) => entry.id)].filter(
      (entryId): entryId is string => Boolean(entryId),
    ),
  };
}

export function parseInteractions(
  entries: HistoryEntry[],
  cursor: HistoryCursor,
  leafId?: string,
  batchSize = 100,
): HistoryBatch {
  const branch = branchEntries(entries, leafId);
  const startIndex = cursor.entryId ? Math.max(0, branch.findIndex((entry) => entry.id === cursor.entryId) + 1) : 0;
  const usable = startIndex === 0 && cursor.entryId ? branch : branch.slice(startIndex);
  const interactions: Interaction[] = [];
  let user: HistoryEntry | undefined;
  let assistants: HistoryEntry[] = [];
  for (let index = 0; index < usable.length; index += 1) {
    const entry = usable[index]!;
    if (isMessage(entry, "user")) {
      if (user && assistants.length > 0) {
        const completed = interactionFrom(user, assistants, messageText(entry));
        if (completed) interactions.push(completed);
      }
      user = entry;
      assistants = [];
      continue;
    }
    if (user && isMessage(entry, "assistant")) assistants.push(entry);
  }
  if (user && assistants.length > 0) {
    const completed = interactionFrom(user, assistants);
    if (completed) interactions.push(completed);
  }
  const bounded = interactions.slice(0, batchSize);
  const last = bounded.at(-1);
  const lastEntry = last?.entryId ?? cursor.entryId;
  return {
    interactions: bounded,
    hasMore: bounded.length < interactions.length,
    cursor: {
      ...cursor,
      entryId: lastEntry ?? cursor.entryId,
      previousInteractionId: last?.id ?? cursor.previousInteractionId,
      processedAt: new Date().toISOString(),
    },
  };
}

export async function readHistoryFile(filePath: string): Promise<HistoryEntry[]> {
  const content = await fs.readFile(filePath, "utf8");
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as HistoryEntry;
      return parsed.type === "session" ? [] : [parsed];
    } catch {
      return [];
    }
  });
}

export function attributionOutcome(
  attribution: Attribution,
  interaction: Interaction,
): Attribution {
  return {
    ...attribution,
    outcome: interaction.harmful ? "harmful" : interaction.helpful ? "helpful" : "neutral",
  };
}
