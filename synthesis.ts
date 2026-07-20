import { scrubSecrets, type LearningEpisode, type SynthesizedCandidate } from "./core.ts";

export const SYNTHESIS_SYSTEM_PROMPT = `You distill evidence-backed operational memories for a coding agent.

Return JSON only with this shape:
{"candidates":[{"title":"short title","rule":"one concrete actionable rule","kind":"guidance|procedure","keywords":["specific","retrieval","terms"],"evidenceEpisodeIds":["episode-id"],"confidence":0.0,"procedure":{"goal":"bounded goal","steps":["step one","step two"],"verification":["exact check"],"recovery":["bounded recovery"],"decomposition":"search-filter|map-reduce|graph-walk|parse-transform|diagnose-verify|plan-execute|review-synthesize|direct"}}]}

Rules:
- Propose at most three memories.
- A memory must be supported by at least three episodes showing the same causal pattern.
- Prefer specific technical triggers over broad advice.
- Use kind "guidance" for a stable constraint or fact-like operational rule. Omit procedure.
- Use kind "procedure" only for a reusable decomposition with at least two bounded steps and one exact verification action.
- A procedure must keep task-specific bulk data out of the root context and describe how to pass bounded slices to subcalls or tools.
- Keywords must identify the technical domain, API, or data format; omit generic terms such as input, value, invalid, error, negative, test, and code.
- Never include credentials, repository secrets, personal data, absolute paths, or executable code.
- Do not convert one-off preferences into memories.
- Confidence must be between 0 and 1.
- Return {"candidates":[]} when evidence is insufficient.`;

export function buildSynthesisInput(episodes: LearningEpisode[]): string {
  const evidence = episodes.slice(-12).map((episode) => ({
    id: episode.id,
    prompt: scrubSecrets(episode.prompt).slice(0, 1_200),
    response: scrubSecrets(episode.response).slice(0, 1_200),
    verified: episode.verified,
    corrected: episode.corrected,
    toolCalls: episode.toolCalls,
    toolErrors: episode.toolErrors,
  }));
  return `Analyze these completed coding episodes and return only evidence-backed candidate memories.\n${JSON.stringify(evidence)}`;
}

function isCandidate(value: unknown): value is SynthesizedCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind === undefined || candidate.kind === "guidance" || candidate.kind === "procedure";
  const procedure = candidate.procedure as Record<string, unknown> | undefined;
  const validProcedure = candidate.kind !== "procedure" || Boolean(
    procedure &&
    typeof procedure.goal === "string" &&
    Array.isArray(procedure.steps) && procedure.steps.length >= 2 && procedure.steps.every((item) => typeof item === "string") &&
    Array.isArray(procedure.verification) && procedure.verification.length >= 1 && procedure.verification.every((item) => typeof item === "string") &&
    Array.isArray(procedure.recovery) && procedure.recovery.every((item) => typeof item === "string") &&
    typeof procedure.decomposition === "string",
  );
  return kind && validProcedure && typeof candidate.title === "string" &&
    typeof candidate.rule === "string" &&
    Array.isArray(candidate.keywords) && candidate.keywords.every((item) => typeof item === "string") &&
    Array.isArray(candidate.evidenceEpisodeIds) && candidate.evidenceEpisodeIds.length >= 3 && candidate.evidenceEpisodeIds.every((item) => typeof item === "string") &&
    typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence);
}

export function parseCandidateResponse(response: string): SynthesizedCandidate[] {
  const cleaned = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.filter(isCandidate).slice(0, 3);
  } catch {
    return [];
  }
}
