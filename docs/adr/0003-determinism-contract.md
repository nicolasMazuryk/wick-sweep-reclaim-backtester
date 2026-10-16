# 0003. Byte-identical determinism contract

Status: accepted

## Context
A research result is only useful if someone else can rerun it and get the same bytes. Parallel grid search, bootstrap resampling and floating-point sums all threaten that.

## Decision
Same data, config and seed give byte-identical outputs (`docs/determinism.md`). Concretely:
- All randomness comes from one `seed`, via per-purpose `xoshiro128**` streams keyed by a hash of `(seed, purpose, ids)`, never by call order.
- Events are processed in `(t, seq)` order. Anything that reaches an output iterates over sorted keys.
- Float sums use Kahan–Babuška (Neumaier) compensation in a fixed order.
- Grid tasks run in parallel but are persisted per task and merged in task-id order. A resumed run is byte-identical to an uninterrupted one.
- `@wsr/core` has no I/O, no `Date.now()` and no `Math.random()`.
- The e2e tests run each fixture twice and compare against checked-in goldens.

## Consequences
- Regressions show up as golden diffs.
- Adding a random draw to one stream does not shift any other.
- New code has to respect the ordering and summation rules. Reviewers check this against the contract.
