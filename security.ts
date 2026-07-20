import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizeRemoteUrl, scrubSecrets } from "./core.ts";

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

function sanitizeRegistryValue(value: unknown, key = ""): { value: unknown; redactions: number } {
  if (typeof value === "string") {
    if (key === "remote" || key === "url" || key === "repository") {
      const sanitized = sanitizeRemoteUrl(value);
      return { value: sanitized, redactions: sanitized === value ? 0 : 1 };
    }
    const sanitized = sanitizeKnownCredentials(value);
    return { value: sanitized, redactions: sanitized === value ? 0 : 1 };
  }
  if (Array.isArray(value)) {
    let redactions = 0;
    const items = value.map((item) => {
      const result = sanitizeRegistryValue(item, key);
      redactions += result.redactions;
      return result.value;
    });
    return { value: items, redactions };
  }
  if (value && typeof value === "object") {
    let redactions = 0;
    const entries = Object.entries(value).map(([childKey, child]) => {
      const result = sanitizeRegistryValue(child, childKey);
      redactions += result.redactions;
      return [childKey, result.value] as const;
    });
    return { value: Object.fromEntries(entries), redactions };
  }
  return { value, redactions: 0 };
}

function sanitizeKnownCredentials(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

async function scrubTextCorpus(directory: string): Promise<number> {
  let redactions = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      redactions += await scrubTextCorpus(filePath);
      continue;
    }
    if (!/\.(?:json|jsonl|md|log)$/i.test(entry.name)) continue;
    const source = await fs.readFile(filePath, "utf8");
    const sanitized = sanitizeKnownCredentials(source);
    if (sanitized === source) continue;
    redactions += 1;
    await atomicWrite(filePath, sanitized);
  }
  return redactions;
}

export async function sanitizeLegacyCorpus(baseDir: string): Promise<number> {
  const registryPath = path.join(baseDir, "projects.json");
  let registry: Record<string, unknown> = {};
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let redactions = 0;
  const projectsDir = path.join(baseDir, "projects");
  try {
    for (const entry of await fs.readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(projectsDir, entry.name, "project.json");
      try {
        const raw = JSON.parse(await fs.readFile(projectPath, "utf8")) as Record<string, unknown>;
        const result = sanitizeRegistryValue(raw);
        redactions += result.redactions;
        const sanitized = result.value as Record<string, unknown>;
        registry[entry.name] = sanitized;
        if (result.redactions > 0) await atomicWrite(projectPath, `${JSON.stringify(sanitized, null, 2)}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const registryResult = sanitizeRegistryValue(registry);
  redactions += registryResult.redactions;
  if (Object.keys(registry).length > 0) await atomicWrite(registryPath, `${JSON.stringify(registryResult.value, null, 2)}\n`);
  redactions += await scrubTextCorpus(baseDir);
  return redactions;
}

export async function sanitizeLegacyRegistry(filePath: string): Promise<number> {
  try {
    const source = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const result = sanitizeRegistryValue(source);
    if (result.redactions > 0) await atomicWrite(filePath, `${JSON.stringify(result.value, null, 2)}\n`);
    return result.redactions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function appendDiagnostic(filePath: string, event: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify({ at: new Date().toISOString(), event, error: scrubSecrets(message) })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");
  if (lines.length > 200) await atomicWrite(filePath, `${lines.slice(-200).join("\n")}\n`);
  await fs.chmod(filePath, 0o600);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
