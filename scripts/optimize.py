#!/usr/bin/env python3
from __future__ import annotations

import argparse
import atexit
import hashlib
import hmac
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import dspy
from dspy.clients.base_lm import BaseLM
from dspy.dsp.utils.utils import dotdict


ROOT = Path(__file__).resolve().parent.parent
os.environ["PATH"] = f"{ROOT / 'node_modules' / '.bin'}:{os.environ.get('PATH', '')}"


class PiLM(BaseLM):
    def __init__(self, provider: str, model: str, bridge: Path):
        super().__init__(model=f"{provider}/{model}", max_tokens=4000, cache=False)
        self.provider = provider
        self.model_id = model
        self.bridge = bridge

    def forward(self, prompt=None, messages=None, **kwargs):
        del kwargs
        if prompt is None:
            prompt = "\n\n".join(
                f"[{message.get('role', 'user')}]\n{message.get('content', '')}" for message in (messages or [])
            )
        request = {
            "provider": self.provider,
            "model": self.model_id,
            "system": "You are an offline trace optimizer. Return only the requested structured result.",
            "prompt": prompt,
        }
        completed = subprocess.run(
            ["bun", str(self.bridge)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=300,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "Pi model bridge failed")
        response = json.loads(completed.stdout)
        output = response["output"]
        usage = response.get("usage", {})
        return dotdict(
            choices=[dotdict(message=dotdict(content=output, tool_calls=None), finish_reason="stop")],
            usage=dotdict(
                prompt_tokens=usage.get("input", 0),
                completion_tokens=usage.get("output", 0),
                total_tokens=usage.get("totalTokens", usage.get("input", 0) + usage.get("output", 0)),
                cost=(usage.get("cost") or {}).get("total", 0),
            ),
            model=f"{self.provider}/{self.model_id}",
        )


def make_interpreter() -> dspy.PythonInterpreter:
    cutoff = time.time() - 60 * 60
    for pattern in ("pi-dspy-runner-*.js", "senpi-dspy-runner-*.js"):
        for stale in Path(tempfile.gettempdir()).glob(pattern):
            try:
                if stale.stat().st_mtime < cutoff:
                    stale.unlink()
            except FileNotFoundError:
                pass
    upstream_runner = Path(dspy.__file__).parent / "primitives" / "runner.js"
    runner_source = upstream_runner.read_text().replace(
        'import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";',
        """async function* readLines(reader) {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(8192);
  let pending = "";
  while (true) {
    const count = await reader.read(buffer);
    if (count === null) break;
    pending += decoder.decode(buffer.subarray(0, count), { stream: true });
    const lines = pending.split(/\\r?\\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) yield line;
  }
  pending += decoder.decode();
  if (pending) yield pending;
}""",
    )
    with tempfile.NamedTemporaryFile("w", prefix="pi-dspy-runner-", suffix=".js", delete=False) as handle:
        handle.write(runner_source)
        runner = Path(handle.name)
    runner.chmod(0o600)
    atexit.register(lambda: runner.unlink(missing_ok=True))
    deno_dir = dspy.PythonInterpreter._get_deno_dir()
    read_paths = [str(runner), str(ROOT / "node_modules")]
    if deno_dir:
        read_paths.append(deno_dir)
    return dspy.PythonInterpreter(
        deno_command=[
            str(ROOT / "node_modules" / ".bin" / "deno"),
            "run",
            f"--allow-read={','.join(read_paths)}",
            str(runner),
        ]
    )


class CandidateRefinement(dspy.Signature):
    """Refine one evidence-backed learning candidate without broadening its applicability.

    Return strict JSON with optimizedRule, optimizedKeywords, equivalenceClass,
    semanticScore, and optional procedure. Preserve the candidate's actual evidence,
    prefer a reusable decomposition over surface-domain wording, and reject generic advice.
    Apply a bounded edit: preserve most existing rule wording, add at most four keywords,
    and change only what the replay evidence justifies.
    """

    trace_bundle: str = dspy.InputField()
    candidate: str = dspy.InputField()
    rlm_analysis: str = dspy.InputField()
    optimized_json: str = dspy.OutputField()


class CandidateRefiner(dspy.Module):
    def __init__(self):
        self.refine = dspy.Predict(CandidateRefinement)

    def forward(self, trace_bundle: str, candidate: str, rlm_analysis: str):
        return self.refine(trace_bundle=trace_bundle, candidate=candidate, rlm_analysis=rlm_analysis)


def parse_json(value: str) -> dict[str, Any]:
    stripped = value.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped, flags=re.S)
    parsed = json.loads(stripped)
    if not isinstance(parsed, dict):
        raise ValueError("optimizer output must be an object")
    return parsed


def tokens(value: str) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9]+", value.lower()) if len(token) >= 3}


def replay_score(candidate: dict[str, Any], cases: list[dict[str, Any]]) -> tuple[float, float]:
    keywords = tokens(" ".join(candidate.get("optimizedKeywords", [])))
    positives = [case for case in cases if case.get("expectedRelevant")]
    negatives = [case for case in cases if not case.get("expectedRelevant")]
    match = lambda case: len(tokens(case.get("prompt", "")) & keywords) >= 2
    recall = sum(match(case) for case in positives) / max(1, len(positives))
    false_positive_rate = sum(match(case) for case in negatives) / max(1, len(negatives))
    return max(0.0, min(1.0, recall * (1.0 - false_positive_rate))), false_positive_rate


def metric(example, prediction, trace=None, pred_name=None, pred_trace=None):
    del trace, pred_name, pred_trace
    try:
        candidate = parse_json(prediction.optimized_json)
        cases = json.loads(example.trace_bundle)
        score, false_positive_rate = replay_score(candidate, cases)
        rule = candidate.get("optimizedRule", "")
        semantic_class = candidate.get("equivalenceClass", "")
        valid = 20 <= len(rule) <= 360 and len(candidate.get("optimizedKeywords", [])) >= 2 and bool(semantic_class)
        if json.loads(example.candidate).get("kind") == "procedure":
            procedure = candidate.get("procedure") or {}
            valid = (
                valid
                and len(procedure.get("steps", [])) >= 2
                and len(procedure.get("verification", [])) >= 1
                and isinstance(procedure.get("recovery"), list)
                and bool(procedure.get("decomposition"))
            )
        final = score if valid else 0.0
        feedback = (
            f"Replay score={score:.3f}; false-positive-rate={false_positive_rate:.3f}. "
            "Keep the rule evidence-specific, preserve the decomposition, and avoid unrelated prompts."
            if valid else
            "Output valid strict JSON with a concrete rule, at least two technical keywords, an equivalence class, "
            "and structured procedure fields when kind=procedure."
        )
        return dspy.Prediction(score=final, feedback=feedback)
    except Exception as error:
        return dspy.Prediction(score=0.0, feedback=f"Invalid optimizer output: {error}")


def semantic_domain(prompt: str) -> str:
    patterns = {
        "security": r"\b(auth|credential|secret|token|permission)\b",
        "data": r"\b(sql|database|schema|query|record)\b",
        "text": r"\b(parse|unicode|regex|string|format)\b",
        "graph": r"\b(graph|node|edge|dependency)\b",
        "ui": r"\b(ui|react|css|browser|component)\b",
    }
    return next((name for name, pattern in patterns.items() if re.search(pattern, prompt, re.I)), "general")


def partition_cases(candidate: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    train = [case for case in candidate["cases"] if case["split"] == "train"]
    validation = [case for case in candidate["cases"] if case["split"] == "validation"]
    test = [case for case in candidate["cases"] if case["split"] == "test"]
    if not train or not validation or not test:
        raise ValueError(f"candidate {candidate['id']} needs non-empty train, validation, and test splits")
    return train, validation, test


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--provider", default="openai-codex")
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--bridge", type=Path, default=Path(__file__).with_name("model-bridge.ts"))
    parser.add_argument("--max-metric-calls", type=int, default=6)
    parser.add_argument("--signing-key-file", type=Path, required=True)
    args = parser.parse_args()

    payload = json.loads(args.input.read_text())
    if payload.get("version") != 1 or payload.get("model") != f"{args.provider}/{args.model}":
        raise ValueError("input model identity does not match optimizer model")
    candidates = payload.get("candidates", [])
    if not candidates:
        raise ValueError("replay input has no candidates")
    for candidate in candidates:
        partition_cases(candidate)

    lm = PiLM(args.provider, args.model, args.bridge)
    dspy.configure(lm=lm)
    training_context = [{
        **{key: value for key, value in candidate.items() if key != "cases"},
        "cases": [case for case in candidate["cases"] if case["split"] == "train"],
    } for candidate in candidates]
    context = json.dumps(training_context, separators=(",", ":"))
    iteration_parameter = "max_iters" if "max_iters" in inspect.signature(dspy.RLM.__init__).parameters else "max_iterations"
    rlm = dspy.RLM(
        "context, query -> decomposition_taxonomy, candidate_advice",
        max_llm_calls=3,
        max_output_chars=6000,
        sub_lm=lm,
        interpreter=make_interpreter(),
        **{iteration_parameter: 3},
    )
    analysis = rlm(
        context=context,
        query=(
            "Analyze these scrubbed traces as offloaded data. Identify reusable decomposition equivalence classes, "
            "false-positive risks, and locally-in-distribution procedures. Compare against this bounded prior epoch memory: "
            f"{payload.get('previousMetaMemory', 'none')}. Do not repeat secrets or broad advice."
        ),
    )
    analysis_text = json.dumps({
        "taxonomy": analysis.decomposition_taxonomy,
        "advice": analysis.candidate_advice,
    })

    trainset = []
    valset = []
    for candidate in candidates:
        train_cases, validation_cases, _test_cases = partition_cases(candidate)
        candidate_without_cases = {key: value for key, value in candidate.items() if key != "cases"}
        base = {"candidate": json.dumps(candidate_without_cases), "rlm_analysis": analysis_text}
        trainset.append(dspy.Example(trace_bundle=json.dumps(train_cases), **base).with_inputs("trace_bundle", "candidate", "rlm_analysis"))
        valset.append(dspy.Example(trace_bundle=json.dumps(validation_cases), **base).with_inputs("trace_bundle", "candidate", "rlm_analysis"))

    optimizer = dspy.GEPA(
        metric=metric,
        max_metric_calls=args.max_metric_calls,
        reflection_lm=lm,
        reflection_minibatch_size=min(2, len(trainset)),
        track_stats=True,
        num_threads=1,
        seed=17,
    )
    compiled = optimizer.compile(CandidateRefiner(), trainset=trainset, valset=valset)

    results = []
    for candidate in candidates:
        candidate_without_cases = {key: value for key, value in candidate.items() if key != "cases"}
        train_cases, _validation_cases, test_cases = partition_cases(candidate)
        prediction = compiled(
            trace_bundle=json.dumps(train_cases),
            candidate=json.dumps(candidate_without_cases),
            rlm_analysis=analysis_text,
        )
        optimized = parse_json(prediction.optimized_json)
        if candidate.get("kind") == "procedure":
            original_procedure = candidate.get("procedure") or {}
            optimized_procedure = optimized.setdefault("procedure", {})
            for field in ("goal", "steps", "verification", "recovery", "decomposition"):
                if field not in optimized_procedure:
                    optimized_procedure[field] = original_procedure.get(field, [] if field in {"steps", "verification", "recovery"} else "")
        score, false_positive_rate = replay_score(optimized, test_cases)
        baseline_score, _ = replay_score({"optimizedKeywords": candidate["keywords"]}, test_cases)
        domains = {semantic_domain(case["prompt"]) for case in test_cases}
        long_cases = [case for case in test_cases if case["taskStratum"].endswith("/long")]
        long_score, _ = replay_score(optimized, long_cases) if long_cases else (0.0, 1.0)
        results.append({
            "id": candidate["id"],
            "sourceHash": candidate["sourceHash"],
            "score": score,
            "baselineScore": baseline_score,
            "cases": len(candidate["cases"]),
            "falsePositiveRate": false_positive_rate,
            "equivalenceClass": optimized["equivalenceClass"],
            "semanticScore": min(score, float(optimized.get("semanticScore", score))),
            "heldOutDomains": len(domains),
            "longContextScore": long_score,
            "optimizedRule": optimized["optimizedRule"],
            "optimizedKeywords": optimized["optimizedKeywords"],
            **({"procedure": optimized["procedure"]} if optimized.get("procedure") else {}),
        })

    artifact = {
        "version": 1,
        "model": payload["model"],
        "generatedAt": payload["generatedAt"],
        "optimizer": "rlm-gepa",
        "metaMemory": analysis_text[:2000],
        "candidates": results,
    }
    key = bytes.fromhex(args.signing_key_file.read_text().strip())
    signed_payload = json.dumps(artifact, separators=(",", ":"), ensure_ascii=False)
    artifact = {
        "signedPayload": signed_payload,
        "signature": hmac.new(
        key,
        signed_payload.encode(),
        hashlib.sha256,
        ).hexdigest(),
    }
    args.output.write_text(json.dumps(artifact, indent=2) + "\n")
    sys.stdout.write(f'{json.dumps({"candidates": len(results), "output": str(args.output)})}\n')


if __name__ == "__main__":
    main()
