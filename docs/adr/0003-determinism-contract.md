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

Scope: outputs are byte-identical on the same platform. Across platforms (macOS arm64 vs Linux x64) the Stage B logistic fit can differ in the last ulp of a float, and that difference reaches the files derived from it. The e2e golden tests therefore compare `stageB.json` and `run.json` as parsed JSON, and `trades.jsonl` line by line, with a 1e-12 relative tolerance on numbers (integer fields stay exact), `report.md` with decimals rounded to 9 significant digits, and the Parquet goldens by decoded rows when the bytes differ (`packages/cli/src/golden-compare.ts`). Every other golden stays byte-exact.

## Consequences
- Regressions show up as golden diffs.
- Adding a random draw to one stream does not shift any other.
- New code has to respect the ordering and summation rules. Reviewers check this against the contract.
