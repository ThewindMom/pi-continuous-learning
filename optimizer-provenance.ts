import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function ensureOptimizerSigningKey(filePath: string): Promise<Buffer> {
  try {
    return Buffer.from((await fs.readFile(filePath, "utf8")).trim(), "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    await fs.writeFile(filePath, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return Buffer.from((await fs.readFile(filePath, "utf8")).trim(), "hex");
  }
}

export function verifyOptimizerArtifact(value: unknown, key: Buffer): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Optimizer artifact must be an object");
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.signedPayload !== "string" ||
    typeof artifact.signature !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.signature)
  ) {
    throw new Error("Optimizer artifact has no valid provenance signature");
  }
  const expected = createHmac("sha256", key).update(artifact.signedPayload).digest();
  const actual = Buffer.from(artifact.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Optimizer artifact provenance signature does not match");
  }
  const payload = JSON.parse(artifact.signedPayload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Signed optimizer payload is invalid");
  return payload as Record<string, unknown>;
}
