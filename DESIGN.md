# Small continuous-learning design

The harness has one job: improve future Pi runs without slowing current runs.

## Four durable concepts

1. Pi session history is the source of truth.
2. Approved memories are trusted rules eligible for injection.
3. Candidates are repeated, untrusted possible improvements.
4. A history cursor records processed Pi entries.

The extension never stores a second transcript or tool-result database.

## Fast path

`before_agent_start` loads the compact state, performs bounded local keyword
selection, injects approved rules, optionally assigns one deterministic
canary candidate, and records only memory/candidate attribution. It performs
no model calls, optimizer calls, or tool interception.

## Idle path

One project-owned, debounced worker reads completed interactions from the
active Pi session history. It derives small objective outcomes, detects
repeated patterns, locally replays candidate applicability, evaluates bounded
canaries, promotes useful candidates, disables harmful memories, and advances
the cursor in one atomic state write.

The worker is conservative around incomplete lines, branches, session changes,
crashes, duplicate events, and concurrent sessions. Unknown history entries are
ignored.

## Deployment

Only mature approved memories may be explicitly graduated to `AGENTS.md` or a
learned skill. Candidates and raw history evidence cannot write deployment
targets. GEPA and other expensive optimizers are not in the default loop.
