# Evidence contract

Candidates are untrusted until repeated history evidence and bounded future
canaries show measurable benefit.

- A repeated normalized history pattern is required before candidate creation.
- Local replay counts only matching completed interactions.
- A candidate enters canary state only when replay reaches the configured
  match and success thresholds.
- Promotion requires the configured minimum helpful canary trials and no
  harmful canary result.
- An approved memory is disabled after the configured harmful rate over the
  minimum number of attributed trials.
- Ambiguous outcomes are neutral and do not count as helpful.
- Candidate and memory attribution is bounded and contains IDs only, never
  transcript bodies.

GEPA, RLM, treatment/control arms, and global federation are intentionally not
part of the autonomous decision loop. Any future expensive optimizer must be
an explicit, separately budgeted diagnostic.
