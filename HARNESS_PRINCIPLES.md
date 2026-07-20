# Harness Principles

The learning system follows the locally-in-distribution harness argument described in Alex Zhang and Omar Khattab's “Language model harnesses are compositional generalizers.”

## Adopted

- Learn decomposition strategies rather than surface-domain slogans.
- Group evidence by latent execution shape such as search/filter, map/reduce, graph walk, parse/transform, diagnose/verify, and plan/execute.
- Offload large trace bodies as data for RLM inspection instead of appending them to the optimizer's root prompt.
- Let programmatic subcalls inspect bounded slices and keep intermediate task-specific content out of the root trajectory.
- Evaluate strategies on held-out longer traces and different domains sharing the same decomposition class.
- Prefer executable skills that turn complex tasks into familiar, bounded calls over additional prose injected into the main context.

## Not adopted blindly

- Similar surface tokens are not proof of a shared strategy.
- Harness complexity is accepted only when treatment/control evidence shows net utility after cost and latency.
- RLM or GEPA output is a proposal, never direct production mutation.
- Cross-domain transfer must pass held-out canaries and online model-specific evaluation.
