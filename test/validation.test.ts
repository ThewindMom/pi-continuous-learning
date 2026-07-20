import { describe, expect, test } from "bun:test";

import { isObjectiveValidationStart, objectiveValidationSucceeded } from "../validation.ts";

describe("objective validation detection", () => {
  test("accepts real validators and rejects mentions or echoed text", () => {
    expect(isObjectiveValidationStart("bash", { command: "bun test ./test" })).toBe(true);
    expect(isObjectiveValidationStart("bash", { command: "echo 'bun test passed'" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "bun test || true" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "bun test; exit 0" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "pytest || echo failed" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "bun test\nexit 0" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "bun test >/dev/null\ntrue" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "bun test &" })).toBe(false);
    expect(isObjectiveValidationStart("bash", { command: "python -m unittest --help" })).toBe(false);
    expect(isObjectiveValidationStart("read", { path: "bun test" })).toBe(false);
    expect(isObjectiveValidationStart("agent_browser", { qa: { attached: true } })).toBe(true);
    expect(isObjectiveValidationStart("agent_browser", { args: ["snapshot"] })).toBe(false);
    expect(isObjectiveValidationStart("lsp_diagnostics", {})).toBe(false);
    expect(objectiveValidationSucceeded("bash", { command: "bun test" }, "0 pass")).toBe(false);
    expect(objectiveValidationSucceeded("bash", { command: "bun test" }, "50 pass\n0 fail")).toBe(true);
    expect(objectiveValidationSucceeded("bash", { command: "python -m unittest discover" }, "Ran 3 tests\nOK")).toBe(true);
  });
});
