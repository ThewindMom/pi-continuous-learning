import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { verifyOptimizerArtifact } from "../optimizer-provenance.ts";

describe("optimizer provenance", () => {
  test("accepts an exact signed artifact and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const signedPayload = JSON.stringify({ version: 1, model: "openai-codex/gpt-5.6-sol", candidates: [] });
    const artifact: Record<string, unknown> = {
      signedPayload,
      signature: createHmac("sha256", key).update(signedPayload).digest("hex"),
    };
    expect(verifyOptimizerArtifact(artifact, key).model).toBe("openai-codex/gpt-5.6-sol");
    artifact.signedPayload = signedPayload.replace("gpt-5.6-sol", "forged");
    expect(() => verifyOptimizerArtifact(artifact, key)).toThrow(/does not match/);
  });
});
