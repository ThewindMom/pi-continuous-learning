# Autonomous Learning Safety Contract

## Objective

Improve verified task completion per unit of cost for one project, model, and
task stratum. Learning is accepted only when a frozen candidate outperforms a
matched control and remains safe under replay.

## Units

- **Fact:** explicit project information. It is never inferred from generic
  success and is retrieved only through the project/model relevance gate.
- **Guidance:** a temporary behavioral hypothesis.
- **Procedure:** a structured, executable workflow containing goal, bounded
  steps, verification, recovery, and decomposition.
- **Skill:** a graduated procedure. The complete rendered procedure is the unit
  tested before deployment.

## Invariants

1. Every memory is project- and model-scoped.
2. At most one memory is experimentally assigned per turn.
3. Assignment is persisted before execution.
4. Missing or interrupted runs count as unsuccessful opportunities.
5. Positive evidence requires a paired, successful objective validator.
6. Shell-masked validation and ambiguous diagnostic calls do not count.
7. Ordinary tool errors do not imply that a memory was harmful.
8. Only explicit attributable corrections create harmful evidence.
9. Promotion requires matched task-stratum coverage.
10. Native replay is a retrieval prefilter, never a promotion credential.
11. Promotion requires a fresh RLM/GEPA artifact.
12. The candidate is frozen before an unseen test split is scored.
13. Replay metrics are recomputed locally, not trusted from optimizer output.
14. Replay binds model, immutable case IDs, source hash, and exact artifact hash.
15. Any behavior-changing optimization resets online evidence.
16. Facts, guidance, and procedures never silently change type.
17. Destructive generated instructions are rejected at synthesis and import.
18. Automatic graduation uses CAS-protected managed artifacts.
19. Modified managed artifacts are quarantined during rollback.
20. Model changes roll back old artifacts and require new-model evidence.
21. Global nominations are verified against persisted project state.
22. Global federation requires pairwise compatibility and measured transfer.
23. Clone identity comes from sanitized Git remote plus repository-relative root.
24. One session owns project learning; other sessions are read-only.
25. Locks have owner identity, heartbeat, stale recovery, and bounded lifetime.
26. Autonomy off disables analysis, optimization, project artifacts, and global
    artifacts. It fails closed.

## Offline optimization

RLM receives only training traces and bounded prior optimizer memory. GEPA sees
training and validation examples. The compiled candidate is executed once more
using training context, then frozen. Test labels are never passed to candidate
generation. Test scoring happens outside the model.

SkillOpt-inspired controls:

- bounded edit ratio;
- bounded keyword edits;
- validation-gated revisions;
- retained revision history;
- cross-epoch optimizer memory;
- no-regression comparison against the frozen baseline.

## Statistical decisions

The learner uses Beta-Binomial posterior estimates over shared task strata.
Promotion and graduation require minimum sample floors, posterior lift
probabilities, overlap coverage, fresh replay, and positive net utility.

Utility penalizes:

- correction rate;
- token overhead;
- monetary cost;
- latency;
- failed attempts.

Repeated explicit treatment corrections retire an active memory immediately.

## Artifact lifecycle

```text
candidate
  -> native retrieval canary
  -> RLM/GEPA train-validation optimization
  -> unseen local test gate
  -> randomized online treatment/control
  -> active
  -> mature project artifact
  -> optional multi-project global skill
```

Every managed write has a provenance marker and content hash. Startup removes
or quarantines orphaned project artifacts. Global support is withdrawn when a
project artifact rolls back. Modified artifacts are moved outside load paths.

## Security and privacy

- Secrets, authenticated URLs, private keys, common tokens, and assignments are
  scrubbed before persistence or model calls.
- Historical continuous-learning data is migrated and sanitized.
- The RLM Deno interpreter has read-only access to its runner and dependencies
  and no network permission.
- Optimizer artifacts are schema validated, source-bound, locally rescored, and
  edit-budget constrained.
- Raw nomination files are not authority; corresponding locked project state
  must contain the exact active memory and graduation.
- Storage permissions are private and retention is bounded.

## Emergency recovery

```text
/learn autonomy off
```

This removes unchanged managed artifacts, quarantines modified ones, stops
automatic analysis/optimization, withdraws federation support, and disables
global skills. Re-enabling autonomy does not restore an artifact unless the
memory still satisfies every current evidence gate.
