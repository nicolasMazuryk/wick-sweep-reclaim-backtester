# Determinism (Spec §9.2)

**Contract:** the same data, config and seed give byte-identical outputs:
`run.json`, `reaction.json`, `folds.json`, `target_grid.json`, `stageB.json`,
`grid.json`, `sensitivity.json`, `trades.parquet`, `report.md`, and every
other file under `runs/{runId}/`.

## What the outputs may depend on

| Input | How it enters |
|---|---|
| Data | Parquet partitions under `--data-root`. Their sha256 checksums are recorded in `run.json.dataChecksums`. |
| Config | Validated `RunConfig`. `configHash` is sha256 of the canonical JSON (sorted keys, no whitespace; `core/src/config.ts`). |
| Seed | One uint32 `--seed`. |
| Run identity | `runId` = first 16 hex chars of sha256(`venue\|symbol\|from\|to\|configHash\|seed`) (A-72), so a rerun writes to the same directory. |
| Provenance | `run.json.createdAt`, `gitCommit`, `wsrVersion`. The CLI takes these from injected `now()` / `gitCommit()` / `version`. The e2e tests pin them, so the goldens stay byte-stable. Two real runs differ **only** in these three fields. |

Nothing else may change the output bytes. That rules out wall-clock time,
`Math.random`, `crypto.randomUUID`, host name, worker count, scheduling order
and object key insertion order.

## Randomness

Every random draw comes from `seed` via `backtest/src/rng.ts`:
`splitmix32` expands the seed into per-purpose `xoshiro128**` streams, and
`rngStream(seed, purpose, ...ids)`
derives each stream from an FNV-1a hash of `(seed, purpose, ids)`. It never
derives a stream from call order. The purposes in use are:

- `bootstrap(foldId, window)`: fold-metric CIs.
- `bootstrap(SPAN_FOLD_ID)`: reaction test.
- `randomLevels(srcPivotId)`: set (4), one stream per source level.
- `realityCheck`.
- `bench` and `syntheticDataRoot`: synthetic inputs only.

Grid tasks draw no random numbers of their own. The Spec's
`workerShard(cellId)` stream is therefore not needed. Because streams are
keyed this way, adding a draw to one stream never shifts another, and a task
produces the same numbers on any worker and in any order.

`Math.random` / `Date.now` appear only in `@wsr/data` networking (HTTP retry
jitter, request timing, venue look-back windows). They affect *when* a request
is made, never the bytes stored. Stored partitions are checked by checksum.

## Ordering

- **Engine:** events are processed in `(t, seq)` order. Levels touched by one
  print are processed in `levelId` order (Spec §3.12). Snapshots and the
  truncation / determinism property tests hash canonical JSON (sorted keys,
  `core/src/engine.ts` `canonicalJson`).
- **Maps and sets:** iteration goes over sorted keys wherever the result reaches
  an output. Counters are emitted sorted by key, for example.
- **Grid / workers (A-80):** tasks run in parallel but their results are
  persisted per task. Results are merged in task-id order (`cellId`, `foldId`),
  never in completion order. A resumed run skips tasks with a valid
  `cells/{taskId}.done` (A-81), and its outputs are byte-identical to an
  uninterrupted run (tested in e2e).
- **Ties:** sorts that feed outputs break ties on a stable index (for example
  Stage B calibration bins sort by `(p, i)`).

## Floating-point reductions

Floating-point addition is not associative. Every sum over trades,
observations or days is therefore:

1. taken in a fixed order (input order, which is itself deterministic), and
2. compensated with `KahanSum` (Kahan–Babuška / Neumaier,
   `backtest/src/numeric.ts`), or its `sum` / `mean` / `variance` helpers.

These include fold metrics (expectancy, profit factor, daily P&L,
equity-curve drawdown), Stage B calibration means, grid-cell statistics,
reality-check per-volume-day series, bootstrap statistics, regressions and
target validation. The reality-check bootstrap inlines the same Neumaier
update in its hot loop. No reduction depends on thread scheduling, because
workers return per-task results and the merge happens on the main thread in
a fixed order.

Prices never take part in float reductions: they are integer `Ticks`
(Spec §3.11, `wsr/no-float-price`, A-120).

## Parquet

`parquet-wasm` is configured for reproducible bytes (`data/src/parquet.ts`):

- `setCreatedBy('wsr-data')` / `setCreatedBy('wsr-backtest')`: a static
  created-by string. The footer carries no library version string and no
  wall-clock value.
- Fixed `ZSTD` compression and fixed row-group boundaries
  (`setMaxRowGroupSize(1 048 576)`; streamed writes slice at the same size).
- Run artefacts (`writeRecordsParquet`) have dictionary encoding disabled.
  Their key-value metadata (`wsr.configHash`, `wsr.seed`, `wsr.runId`, …)
  is written in sorted key order.
- Integer columns are checked to be integers before writing.

Because the writer is configured this way, the byte-identity check compares
raw Parquet bytes directly. The canonical re-serialisation fallback of
Spec §9.2 is not needed. If a future `parquet-wasm` injects a timestamp or
version into the footer, the determinism test fails, and the fallback
(compare the decoded rows plus sorted key-value metadata) must be added here
and in the e2e tests.

## How it is tested

- `packages/core/src/engine.property.test.ts`: two independent engines agree
  on snapshot hashes at 100 checkpoints and on every trade and transition.
  The truncation property (L1–L4) runs over 200 paths × 20 cuts in CI
  (`pnpm test:property`).
- `packages/cli/src/e2e-{reaction,backtest,grid,fixture}.test.ts`: each
  end-to-end fixture runs twice. Every output file must be byte-identical and
  must match the checked-in goldens under `fixtures/e2e/`, `trades.parquet` and
  `transitions.parquet` compared as bytes. `e2e-fixture` replays the recorded
  Binance ETHUSDT day of A-150, so the golden bytes descend from real prints.
  `wsr report` re-renders `report.md` to the same bytes. An interrupted and
  resumed grid run equals an uninterrupted one.
- `pnpm goldens:update` rewrites the goldens. Any golden change is an output
  change, and the commit that makes it must say so.
