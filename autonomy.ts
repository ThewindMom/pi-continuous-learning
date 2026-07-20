import { createHash } from "node:crypto";

import {
  applyCorrection,
  applyOutcome,
  type ArmEvidence,
  type ExperimentArm,
  type LearnedMemory,
  type MemoryExperiment,
  type MemorySelection,
  memoryArtifactHash,
  type SelectionContext,
  type StratumEvidence,
  tokenize,
} from "./core.ts";

export interface RolloutConfig {
  candidateControlRate: number;
  activeControlRate: number;
}

export interface MemoryAssignment {
  selection: MemorySelection;
  arm: ExperimentArm;
  graduated: boolean;
}

export interface ExperimentOutcome {
  verified: boolean;
  corrected: boolean;
  tokens: number;
  cost: number;
  latencyMs: number;
  failedAttempts: number;
  taskStratum: string;
}

export const PRODUCTION_THRESHOLDS = {
  candidateTrialsPerArm: 10,
  candidateProbability: 0.95,
  candidateMinimumLift: 0.03,
  activeTrialsPerArm: 10,
  activeRetirementProbability: 0.05,
  graduationTreatmentTrials: 25,
  graduationControlTrials: 10,
  graduationVerifiedTreatments: 20,
  graduationProbability: 0.99,
  graduationMinimumLift: 0.03,
} as const;

const EMPTY_STRATUM: StratumEvidence = {
  trials: 0,
  verified: 0,
  corrected: 0,
  tokens: 0,
  cost: 0,
  latencyMs: 0,
  failedAttempts: 0,
};

const EMPTY_ARM: ArmEvidence = {
  ...EMPTY_STRATUM,
  strata: {},
};

const DECOMPOSITION_PATTERNS: Array<[string, RegExp]> = [
  ["map-reduce", /\b(all|aggregate|count|group|summari[sz]e|across|each|every)\b/i],
  ["search-filter", /\b(find|search|filter|select|match|locate|query)\b/i],
  ["graph-walk", /\b(graph|node|edge|topological|dependency|reachable)\b/i],
  ["parse-transform", /\b(convert|normalize|parse|format|redact|serialize|merge|sort)\b/i],
  ["diagnose-verify", /\b(debug|broken|failure|fails?|error|wrong|verify|test)\b/i],
  ["plan-execute", /\b(plan|implement|build|create|migrate|refactor|workflow)\b/i],
  ["review-synthesize", /\b(review|audit|inspect|analyze|compare|explain)\b/i],
];

export function classifyTaskStratum(prompt: string): string {
  const tokens = tokenize(prompt);
  const decomposition = DECOMPOSITION_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? "direct";
  const complexity = tokens.length < 24 ? "short" : tokens.length < 80 ? "medium" : "long";
  return `${decomposition}/${complexity}`;
}

export function experimentFor(memory: LearnedMemory): MemoryExperiment {
  return memory.experiment ?? {
    treatment: { ...EMPTY_ARM },
    control: { ...EMPTY_ARM },
    decision: memory.status === "active" ? "promoted" : "exploring",
  };
}

function assignmentUnit(memory: LearnedMemory, context: SelectionContext): number {
  const experiment = experimentFor(memory);
  const opportunity = experiment.treatment.trials + experiment.control.trials;
  const digest = createHash("sha256")
    .update(`${context.projectId}\0${context.model}\0${memory.id}\0${classifyTaskStratum(context.prompt)}\0${context.prompt}\0${opportunity}`)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function assignMemories(
  selections: MemorySelection[],
  context: SelectionContext,
  graduatedIds: Set<string>,
  config: RolloutConfig,
): MemoryAssignment[] {
  const candidate = selections.find(({ memory }) => memory.status === "candidate");
  const considered = candidate ? [candidate] : selections.slice(0, 1);
  return considered.map((selection) => {
    const { memory } = selection;
    const graduated = graduatedIds.has(memory.id);
    const controlRate = memory.status === "candidate" ? config.candidateControlRate : config.activeControlRate;
    const arm: ExperimentArm = graduated || assignmentUnit(memory, context) >= controlRate ? "treatment" : "control";
    return { selection, arm, graduated };
  });
}

function betaPosterior(arm: Pick<ArmEvidence, "trials" | "verified" | "corrected">): { mean: number; variance: number } {
  const alpha = 1 + arm.verified;
  const beta = 1 + Math.max(0, arm.trials - arm.verified) + 2 * arm.corrected;
  const total = alpha + beta;
  return {
    mean: alpha / total,
    variance: alpha * beta / (total * total * (total + 1)),
  };
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function posteriorProbability(experiment: MemoryExperiment, minimumLift = 0): number | undefined {
  if (experiment.treatment.trials === 0 || experiment.control.trials === 0) return undefined;
  const shared = Object.keys(experiment.treatment.strata).filter((stratum) => experiment.control.strata[stratum]?.trials > 0);
  if (shared.length > 0) {
    const weighted = shared.map((stratum) => {
      const treatment = betaPosterior(experiment.treatment.strata[stratum]!);
      const control = betaPosterior(experiment.control.strata[stratum]!);
      return {
        mean: treatment.mean - control.mean,
        variance: treatment.variance + control.variance,
        weight: Math.min(experiment.treatment.strata[stratum]!.trials, experiment.control.strata[stratum]!.trials),
      };
    });
    const totalWeight = weighted.reduce((sum, value) => sum + value.weight, 0);
    const mean = weighted.reduce((sum, value) => sum + value.mean * value.weight, 0) / totalWeight;
    const variance = weighted.reduce((sum, value) => sum + value.variance * (value.weight / totalWeight) ** 2, 0);
    return normalCdf((mean - minimumLift) / Math.sqrt(Math.max(Number.EPSILON, variance)));
  }
  const treatment = betaPosterior(experiment.treatment);
  const control = betaPosterior(experiment.control);
  const deviation = Math.sqrt(treatment.variance + control.variance);
  if (deviation === 0) return treatment.mean - control.mean > minimumLift ? 1 : 0;
  return normalCdf((treatment.mean - control.mean - minimumLift) / deviation);
}

export function stratifiedCoverage(experiment: MemoryExperiment): number {
  const shared = Object.keys(experiment.treatment.strata).filter((stratum) => experiment.control.strata[stratum]?.trials > 0);
  const treatment = shared.reduce((sum, stratum) => sum + experiment.treatment.strata[stratum]!.trials, 0) /
    Math.max(1, experiment.treatment.trials);
  const control = shared.reduce((sum, stratum) => sum + experiment.control.strata[stratum]!.trials, 0) /
    Math.max(1, experiment.control.trials);
  return Math.min(treatment, control);
}

function relativePenalty(treatment: number, control: number, weight: number): number {
  if (control <= 0) return 0;
  return weight * (treatment - control) / control;
}

function netDifference(treatment: StratumEvidence, control: StratumEvidence): number {
  const treatmentPosterior = betaPosterior(treatment);
  const controlPosterior = betaPosterior(control);
  const treatmentTrials = Math.max(1, treatment.trials);
  const controlTrials = Math.max(1, control.trials);
  return treatmentPosterior.mean - controlPosterior.mean
    - relativePenalty(treatment.tokens / treatmentTrials, control.tokens / controlTrials, 0.08)
    - relativePenalty(treatment.cost / treatmentTrials, control.cost / controlTrials, 0.12)
    - relativePenalty(treatment.latencyMs / treatmentTrials, control.latencyMs / controlTrials, 0.05)
    - relativePenalty(treatment.failedAttempts / treatmentTrials, control.failedAttempts / controlTrials, 0.15);
}

export function experimentScore(experiment: MemoryExperiment): number | undefined {
  if (experiment.treatment.trials === 0 || experiment.control.trials === 0) return undefined;
  const sharedStrata = Object.keys(experiment.treatment.strata)
    .filter((stratum) => experiment.control.strata[stratum]?.trials > 0);
  if (sharedStrata.length === 0) return netDifference(experiment.treatment, experiment.control);
  const weighted = sharedStrata.map((stratum) => {
    const treatment = experiment.treatment.strata[stratum]!;
    const control = experiment.control.strata[stratum]!;
    return { score: netDifference(treatment, control), weight: Math.min(treatment.trials, control.trials) };
  });
  const weight = weighted.reduce((sum, value) => sum + value.weight, 0);
  return weighted.reduce((sum, value) => sum + value.score * value.weight, 0) / Math.max(1, weight);
}

export function evaluateExperimentDecision(memory: LearnedMemory, now: string): LearnedMemory {
  const experiment = experimentFor(memory);
  const score = experimentScore(experiment);
  const probabilityPositive = posteriorProbability(experiment, 0);
  const probabilityLift = posteriorProbability(experiment, PRODUCTION_THRESHOLDS.candidateMinimumLift);
  const treatmentTrials = experiment.treatment.trials;
  const controlTrials = experiment.control.trials;
  let status = memory.status;
  let decision = experiment.decision;
  let confidence = memory.confidence;

  if (
    memory.status === "candidate" &&
    treatmentTrials >= PRODUCTION_THRESHOLDS.candidateTrialsPerArm &&
    controlTrials >= PRODUCTION_THRESHOLDS.candidateTrialsPerArm &&
    score !== undefined && probabilityLift !== undefined
  ) {
    const replayPassed = memory.replay?.status === "passed" && memory.replay.model === memory.model &&
      memory.replay.optimizer === "rlm-gepa" &&
      memory.replay.fresh === true &&
      memory.replay.artifactHash === memoryArtifactHash(memory);
    if (replayPassed && stratifiedCoverage(experiment) >= 0.8 && probabilityLift >= PRODUCTION_THRESHOLDS.candidateProbability && score > 0) {
      status = "active";
      decision = "promoted";
      confidence = Math.max(confidence, 0.75);
    } else if (
      (probabilityPositive !== undefined && probabilityPositive <= 0.1) ||
      (treatmentTrials + controlTrials >= 40 && probabilityLift < 0.6)
    ) {
      status = "retired";
      decision = "rejected";
    }
  }

  if (
    memory.status === "active" &&
    (experiment.treatment.corrected >= 2 ||
      treatmentTrials >= PRODUCTION_THRESHOLDS.activeTrialsPerArm &&
      controlTrials >= PRODUCTION_THRESHOLDS.activeTrialsPerArm &&
      probabilityPositive !== undefined &&
      probabilityPositive <= PRODUCTION_THRESHOLDS.activeRetirementProbability)
  ) {
    status = "retired";
    decision = "rejected";
  }

  return {
    ...memory,
    status,
    confidence,
    experiment: {
      ...experiment,
      decision,
      ...(score === undefined ? {} : { score }),
      ...(probabilityPositive === undefined ? {} : { probabilityPositive }),
      ...(probabilityLift === undefined ? {} : { probabilityLift }),
      updatedAt: now,
    },
    updatedAt: now,
  };
}

export function recordExperimentOutcome(
  memory: LearnedMemory,
  arm: ExperimentArm,
  outcome: ExperimentOutcome,
  now: string,
): LearnedMemory {
  if (["retired", "conflicted"].includes(memory.status)) return memory;
  const experiment = experimentFor(memory);
  const previous = experiment[arm];
  const nextArm: ArmEvidence = {
    trials: previous.trials + 1,
    verified: previous.verified + Number(outcome.verified),
    corrected: previous.corrected + Number(outcome.corrected),
    tokens: previous.tokens + Math.max(0, outcome.tokens),
    cost: previous.cost + Math.max(0, outcome.cost),
    latencyMs: previous.latencyMs + Math.max(0, outcome.latencyMs),
    failedAttempts: previous.failedAttempts + Math.max(0, outcome.failedAttempts),
    strata: {
      ...previous.strata,
      [outcome.taskStratum]: {
        ...(previous.strata[outcome.taskStratum] ?? EMPTY_STRATUM),
        trials: (previous.strata[outcome.taskStratum]?.trials ?? 0) + 1,
        verified: (previous.strata[outcome.taskStratum]?.verified ?? 0) + Number(outcome.verified),
        corrected: (previous.strata[outcome.taskStratum]?.corrected ?? 0) + Number(outcome.corrected),
        tokens: (previous.strata[outcome.taskStratum]?.tokens ?? 0) + Math.max(0, outcome.tokens),
        cost: (previous.strata[outcome.taskStratum]?.cost ?? 0) + Math.max(0, outcome.cost),
        latencyMs: (previous.strata[outcome.taskStratum]?.latencyMs ?? 0) + Math.max(0, outcome.latencyMs),
        failedAttempts: (previous.strata[outcome.taskStratum]?.failedAttempts ?? 0) + Math.max(0, outcome.failedAttempts),
      },
    },
  };
  const withExperiment = { ...experiment, [arm]: nextArm };
  const withOutcome = arm === "treatment"
    ? applyOutcome(memory, { verified: outcome.verified, harmful: outcome.corrected }, now)
    : memory;
  return evaluateExperimentDecision({ ...withOutcome, experiment: withExperiment }, now);
}

export function recordExperimentCorrection(
  memory: LearnedMemory,
  arm: ExperimentArm,
  taskStratum: string,
  now: string,
): LearnedMemory {
  if (["retired", "conflicted"].includes(memory.status)) return memory;
  const experiment = experimentFor(memory);
  const updatedArm = {
    ...experiment[arm],
    corrected: experiment[arm].corrected + 1,
    strata: {
      ...experiment[arm].strata,
      [taskStratum]: {
        ...(experiment[arm].strata[taskStratum] ?? EMPTY_STRATUM),
        corrected: (experiment[arm].strata[taskStratum]?.corrected ?? 0) + 1,
      },
    },
  };
  const withCorrection = arm === "treatment" ? applyCorrection(memory, now) : memory;
  return evaluateExperimentDecision({ ...withCorrection, experiment: { ...experiment, [arm]: updatedArm } }, now);
}

export function autonomousGraduationEligible(memory: LearnedMemory, now: string): boolean {
  const experiment = experimentFor(memory);
  const score = experimentScore(experiment);
  const probability = posteriorProbability(experiment, PRODUCTION_THRESHOLDS.graduationMinimumLift);
  const ageDays = (Date.parse(now) - Date.parse(memory.createdAt)) / 86_400_000;
  return memory.status === "active" &&
    ageDays >= 7 &&
    memory.confidence >= 0.8 &&
    memory.evidence.helpful >= 8 &&
    memory.evidence.harmful === 0 &&
    experiment.treatment.trials >= PRODUCTION_THRESHOLDS.graduationTreatmentTrials &&
    experiment.control.trials >= PRODUCTION_THRESHOLDS.graduationControlTrials &&
    experiment.treatment.verified >= PRODUCTION_THRESHOLDS.graduationVerifiedTreatments &&
    memory.replay?.status === "passed" && memory.replay.model === memory.model &&
    memory.replay.optimizer === "rlm-gepa" &&
    memory.replay.fresh === true &&
    memory.replay.artifactHash === memoryArtifactHash(memory) &&
    stratifiedCoverage(experiment) >= 0.8 &&
    score !== undefined && score > 0 &&
    probability !== undefined && probability >= PRODUCTION_THRESHOLDS.graduationProbability;
}
