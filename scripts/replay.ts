import { applyNativeReplay, buildReplayOptimizerInput } from "../replay.ts";
import { loadStore } from "../core.ts";

const [statePath, artifactPath] = process.argv.slice(2);
if (!statePath) {
  throw new Error("Usage: bun run replay <state.json> [--export <provider/model>]");
}
let store = await loadStore(statePath);
const now = new Date().toISOString();
if (artifactPath === "--export") {
  const model = process.argv[4];
  if (!model) throw new Error("Usage: bun run replay <state.json> --export <provider/model>");
  process.stdout.write(`${JSON.stringify(buildReplayOptimizerInput(store, model, now), null, 2)}\n`);
  process.exit(0);
}
if (artifactPath) throw new Error("Artifact imports are only allowed through the signed /learn replay command");
store = applyNativeReplay(store, now);
process.stdout.write(`${JSON.stringify({
  candidates: store.memories.filter((memory) => memory.status === "candidate").map((memory) => ({
    id: memory.id,
    replay: memory.replay?.status ?? "missing",
    score: memory.replay?.score ?? 0,
  })),
})}\n`);
