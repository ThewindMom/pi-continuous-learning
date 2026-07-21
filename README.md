# Pi Continuous Learning

This extension quietly improves future Pi runs without adding work to the
foreground path.

## Durable state

Pi session history is the source of truth. The extension stores only:

- approved memories that are eligible for injection;
- untrusted candidates;
- a cursor into the active Pi history;
- bounded attribution showing which memories were injected.

State is kept at
`~/.pi/continuous-learning-hybrid/v3/projects/<project-id>/state.json`.
Existing active memories are migrated conservatively; raw legacy transcripts,
episodes, tool results, and optimizer artifacts are not copied.

## Runtime

Before each prompt, the extension reads a compact local index, selects a
bounded set of relevant approved rules, injects them, and records attribution.
It makes no model calls and does not intercept tool execution.

After the agent settles, one project-owned debounced worker reads completed
history after the cursor. It derives objective outcomes, creates candidates
only after repeated evidence, replays them locally, canaries useful candidates,
promotes candidates with positive evidence, and disables harmful memories.
Cursor and state changes commit atomically and reprocessing is idempotent.

GEPA and other optimizers are not part of the autonomous loop.

## Controls

Normal work needs no commands. Optional diagnostics are:

```text
/learn status
/learn run
/learn rollback <memory-id>
/learn graduate <memory-id> agents|skill
/learn migrate
```

Notifications are limited to promotions, rollbacks, and worker failures.
Graduation is explicit and requires a mature approved memory; candidates and
raw observations can never write `AGENTS.md` or a learned skill directly.
