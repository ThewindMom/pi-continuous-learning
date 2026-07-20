# Senpi Continuous Learning

An autonomous, model-specific learning extension for Senpi. It treats every
learned rule as a hypothesis, tests one hypothesis at a time, and deploys only
artifacts that pass offline replay and online treatment/control evidence.

## Installation

The extension is installed at:

```text
~/.senpi/agent/extensions/selective-learning/index.ts
```

Senpi loads it through:

```json
{
  "extensions": [
    "/home/thewind/.senpi/agent/extensions/selective-learning/index.ts"
  ]
}
```

Install standalone dependencies after cloning:

```bash
bun install
python3 -m venv .venv
.venv/bin/pip install -e .
```

## Learning loop

1. **Observe**
   - Store scrubbed, bounded session episodes.
   - Persist treatment assignment before the model runs.
   - Recover interrupted assignments as failed opportunities.
   - Count validation only after a recognized validator finishes successfully.

2. **Synthesize**
   - Analyze at least six high-signal episodes.
   - Require three independent supporting episode IDs.
   - Reject broad, destructive, malformed, or oversized guidance.
   - Keep facts, guidance, and executable procedures separate.

3. **Replay**
   - Run a native retrieval canary.
   - Export bounded trace data to DSPy.
   - Use `dspy.RLM` to analyze training traces in a Deno sandbox with no network.
   - Use `dspy.GEPA` to optimize the candidate against train and validation data.
   - Freeze the candidate before scoring it on an unseen test split.
   - Recompute test metrics locally during artifact import.
   - Bind replay evidence to immutable case IDs, source hashes, artifact hashes,
     the model identity, and the exact rendered procedure.

4. **Experiment**
   - Assign at most one memory per turn.
   - Randomize treatment/control deterministically from project, model, prompt,
     memory, and opportunity count.
   - Require overlapping task strata.
   - Measure verified success, explicit corrections, cost, tokens, latency, and
     failed attempts.

5. **Promote or retire**
   - Promote only after the RLM/GEPA replay is fresh and Bayesian evidence clears
     the configured threshold.
   - Retire repeated corrections immediately.
   - Continue holdouts while a memory remains active.

6. **Graduate**
   - Graduate mature project guidance into a managed `AGENTS.md` block.
   - Use the exact procedure that was tested online.
   - Roll back automatically after an attributable correction or model change.
   - Quarantine user-modified managed artifacts instead of leaving them active.

7. **Federate**
   - Nominate only executable procedures with fresh RLM/GEPA evidence.
   - Verify each nomination against its persisted project state.
   - Deduplicate cloned repositories using sanitized Git identity.
   - Require pairwise semantic compatibility, three projects, fifty treatment
     trials, two measured transfer domains, and a passing long-context canary.

## Evidence thresholds

Candidate promotion requires:

- 10 treatment trials;
- 10 control trials;
- 95% posterior probability that treatment beats control by at least `0.08`;
- at least 80% overlap in matched task strata;
- a fresh, model-matched RLM/GEPA replay artifact;
- positive net utility after cost, token, latency, retry, and correction penalties.

Automatic project graduation requires:

- confidence at least `0.80`;
- age of at least seven days;
- 25 treatment and 10 control trials;
- at least 20 verified treatment outcomes;
- zero harmful outcomes;
- 99% posterior probability of lift greater than `0.08`;
- fresh exact-artifact replay evidence.

Global skill graduation additionally requires:

- three independently verified Git identities;
- at least fifty treatment trials;
- pairwise-compatible procedures;
- at least two held-out domains scoring `0.75` or better;
- a long-context score of at least `0.75`.

## Commands

```text
/learn status
/learn autonomy on
/learn autonomy off
/learn analyze
/learn replay [artifact.json]
/learn optimize
/learn add <keywords> :: <guidance>
/learn remember <keywords> :: <fact>
/learn procedure <keywords> :: <goal> :: <step 1; step 2> :: <verification> :: <recovery>
/learn conflicts
/learn maintain
/learn migrate
/learn graduate <id> agents|skill
/learn retire <id>
/learn inspect <id>
```

`/learn autonomy off` is an emergency stop. It disables synthesis and
optimization, removes or quarantines managed project artifacts, withdraws the
project from federation, and disables all managed global skills. Only explicit
user-authored active memories remain eligible for runtime injection.

## Storage and concurrency

State is private and project/model scoped:

```text
~/.senpi/continuous-learning-hybrid/v3/
```

- Directories use mode `0700`.
- Files use mode `0600`.
- Writes use randomized atomic temporary files.
- One learner owns a project at a time.
- The project lock has an owner token and heartbeat.
- Secondary sessions are read-only and fail closed.
- Global reconciliation and managed artifact writes use separate locks.
- Diagnostics retain at most 200 entries.
- Episodes, candidates, retired memories, retries, and optimizer batches are
  bounded.

## Offline optimizer

Run native replay:

```bash
bun run replay /path/to/state.json
```

Export optimizer input:

```bash
bun run replay /path/to/state.json --export openai-codex/gpt-5.6-sol
```

Run RLM and GEPA:

```bash
.venv/bin/python scripts/optimize.py \
  replay-input.json replay-artifact.json \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --signing-key-file ~/.senpi/continuous-learning-hybrid/v3/optimizer-signing.key
```

Import the resulting artifact:

```text
/learn replay replay-artifact.json
```

Automatic optimization uses the current session model and is bounded to four
candidates, six GEPA metric calls, three attempts per candidate, and twenty
minutes per process.

## Verification

```bash
bun test ./test
.venv/bin/python -m unittest discover -s test -p '*_test.py'
bunx tsc --noEmit
bun run lint
bun run build
```

The test suite covers statistical promotion, stratified overlap, replay
freshness, train/validation/test isolation, destructive artifact rejection,
model revalidation, concurrent sessions, CAS writes, modified-artifact
quarantine, forged nominations, semantic federation, global shutdown, secret
scrubbing, migration, and the real Senpi extension lifecycle.
