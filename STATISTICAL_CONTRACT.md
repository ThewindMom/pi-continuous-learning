# Statistical Decision Contract

Every generated rule is an untrusted hypothesis. Source traces can nominate a
rule but can never activate it.

## Units

- An opportunity is a prompt that passes project, model, confidence, and
  technical-keyword retrieval gates.
- Assignment is deterministic from project, model, memory, prompt, and
  opportunity count.
- Candidates receive 50% treatment and 50% control. Active memories retain a
  15% control holdout.
- At most one memory is assigned per turn.
- Results are grouped by decomposition and prompt-complexity stratum.
- Assignment is persisted before execution; interrupted runs are recovered as
  unsuccessful opportunities.

## Outcome

The Bernoulli outcome is objectively verified completion. A validator must be a
recognized single command, must not contain shell metacharacters or no-op flags,
must exit successfully, and for test commands must report at least one executed
test. Explicit attributable correction adds two posterior failures.

Net utility subtracts normalized penalties for failed attempts, tokens, cost,
latency, and corrections. Unknown telemetry contributes zero penalty rather
than fabricated evidence.

## Bayesian decision

Each arm and task stratum uses a Beta(1, 1) prior. Decisions combine only strata
observed in both arms and require at least 80% overlap coverage.

- **Candidate promotion:** 10 treatment and 10 control trials; a fresh,
  current-model, installation-signed RLM/GEPA replay for the exact artifact;
  95% posterior probability that lift exceeds `0.08`; positive stratified
  utility.
- **Candidate rejection:** 10 trials per arm and probability of positive lift
  at most `0.10`, or 40 total trials without reaching `0.60`.
- **Active retirement:** probability of positive lift at most `0.05` after 10
  trials per arm, or two treatment corrections.
- **Project graduation:** 25 treatment and 10 control trials; 20 verified
  treatment outcomes; zero harmful outcomes; 99% probability that lift exceeds
  `0.08`; positive utility; fresh exact-artifact replay; seven evidence days.
- **Global federation:** pairwise-compatible project graduations from three
  clone-deduplicated Git identities; 50 combined treatment opportunities; two
  held-out domains scoring at least `0.75`; long-context score at least `0.75`.

## Replay and optimization

RLM sees bounded scrubbed training traces. GEPA optimizes against train and
validation splits. The candidate is frozen before unseen post-synthesis test
episodes are scored locally.

The optimizer emits an installation-HMAC-signed wrapper. Import verifies exact
payload bytes, schema, model identity, immutable case IDs, complete source
coverage, source hash, artifact hash, edit budget, locally recomputed test
metrics, and secret scrubbing. Native replay is a retrieval prefilter and can
never promote a memory.

## Model changes

Evidence is model-specific. A model change rolls back old artifacts and creates
a new candidate with no inherited positive episodes, experiment, or replay.
New-model evidence invalidates replay before it can affect a decision.

## Safety

- Managed writes use private permissions, atomic temporary files, owner-bound
  locks, heartbeats, serialized persistence, and content hashes.
- Rollback removes unchanged artifacts and quarantines modified or malformed
  artifacts outside load paths.
- Startup quarantines orphaned project and global skills.
- Global nominations are recomputed against persisted project state.
- `/learn autonomy off` kills optimizer process groups, stops analysis and
  decisions, removes or quarantines project artifacts, disables global skills,
  and retains the underlying evidence.
