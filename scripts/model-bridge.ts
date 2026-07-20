import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface Request {
  provider: string;
  model: string;
  system: string;
  prompt: string;
}

const executable = Bun.which("senpi");
if (!executable) throw new Error("senpi executable is not available on PATH");
const realExecutable = await fs.realpath(executable);
const distDirectory = path.dirname(realExecutable);
const senpi = await import(pathToFileURL(path.join(distDirectory, "index.js")).href);
const { ModelRuntime } = await import(pathToFileURL(path.join(distDirectory, "core", "model-runtime.js")).href);
const request = JSON.parse(await Bun.stdin.text()) as Request;
const agentDir = senpi.getAgentDir();
const settingsManager = senpi.SettingsManager.create(agentDir);
const modelRuntime = ModelRuntime.createSync({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const model = modelRuntime.getModel(request.provider, request.model);
if (!model) throw new Error(`Model not found: ${request.provider}/${request.model}`);

const loader = new senpi.DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPrompt: request.system,
});
await loader.reload();
const { session } = await senpi.createAgentSession({
  cwd: process.cwd(),
  model,
  thinkingLevel: "medium",
  resourceLoader: loader,
  sessionManager: senpi.SessionManager.inMemory(process.cwd()),
  settingsManager,
  tools: [],
});

let output = "";
try {
  await session.prompt(request.prompt);
  const messages = session.messages;
  const assistant = [...messages].reverse().find((message: { role?: string }) => message.role === "assistant") as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
  } | undefined;
  output = assistant?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  process.stdout.write(JSON.stringify({ output, usage: assistant?.usage ?? {} }));
} finally {
  session.dispose();
}
