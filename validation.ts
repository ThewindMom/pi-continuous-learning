export function isObjectiveValidationStart(toolName: string, argsValue: unknown): boolean {
  const args = argsValue && typeof argsValue === "object" ? argsValue as Record<string, unknown> : {};
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const masksFailure = /[\n\r;&|><$`\\]/.test(command);
  const noOpFlag = /(?:^|\s)(?:-h|--help|--version|--list|--collect-only|--dry-run)(?:\s|$)/i.test(command);
  const commandValidation = toolName === "bash" && !masksFailure && !noOpFlag &&
    /^(?:bun\s+(?:test|build\b|run\s+(?:test|lint|typecheck|build)\b)|cargo\s+test\b|go\s+test\b|pytest\b|python\s+-m\s+(?:pytest|unittest)\b)/i.test(command);
  const browserValidation = toolName === "agent_browser" && Boolean(args.qa);
  return commandValidation || browserValidation;
}

export function objectiveValidationSucceeded(toolName: string, argsValue: unknown, resultValue: unknown): boolean {
  if (!isObjectiveValidationStart(toolName, argsValue)) return false;
  if (toolName === "agent_browser") return true;
  const args = argsValue as Record<string, unknown>;
  const command = String(args.command ?? "");
  if (!/\b(?:test|pytest|unittest)\b/i.test(command)) return true;
  const output = JSON.stringify(resultValue ?? "");
  return /(?:\b[1-9]\d*\s+pass(?:ed)?\b|Ran\s+[1-9]\d*\s+tests?\b|test result:\s+ok\.[^]*\b[1-9]\d*\s+passed\b|\bok\s+\S+)/i.test(output);
}
