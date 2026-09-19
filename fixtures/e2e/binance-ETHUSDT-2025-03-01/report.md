P&L run despite failed reaction test (§9.2)

# WSR backtest — binance ETHUSDT 2025-02-28…2025-03-01

## 0. Run manifest

- runId: 9d6f9a2299fe375a
- createdAt: 2026-09-19T00:00:00.000Z
- configHash: 90f1f4f2b9d9ee02c3665716d39841433c7f04bf81accb691f3d7331bdd29a3e
- seed: 1
- gitCommit: e2e-fixture
- wsrVersion: e2e-fixture
- venue / symbol / span: binance ETHUSDT 2025-02-28…2025-03-01
- data checksums: 10 partition(s)
- fees verifiedAt: 2026-09-19
- strengthModel: stageB
- Parquet key-value metadata: wsr.configHash, wsr.seed, wsr.runId (Spec §8.3)
- folds: 1 (1/1/n/a days)
- MinSweepMult: configured 0.3; effective (MinSweepDepth/VolUnit_created over 781 levels) median 0.727, p90 2.000; cost floor binding on 781 (100.0 %) levels
- warnings:
  - --folds 1,1,1: non-standard fold lengths (Spec §6.3: 56/14/14 days), F = 1 < 12
  - P&L run despite failed reaction test (§9.2)

## 1. Data coverage & hygiene

| days requested | present | suspect | checksum failed | blacklisted minutes |
|---|---|---|---|---|
| 2 | 2 | 0 | 0 | 0 |

- suspect days: 0
- feedKind aggregated: 0
- tick-size changes: 0
- gaps: 0; bad prints: 0; duplicate tradeIds: 0; non-monotone timestamps: 0; missing funding prints: 0

Blacklisted buckets (reaction replay, span): 0/419027 (0.0 %).

| fold | window | from | to | volume-days | blacklisted bucket share |
|---|---|---|---|---|---|
| 0 | train | 2025-02-28 | 2025-02-28 | 1.03 | 0.00 % |
| 0 | test | 2025-03-01 | 2025-03-01 | 288.94 | 0.00 % |

## 2. Reaction test (§9.2)

B = 200 volume-day block-bootstrap resamples over 290 volume-days; random levels clipped at the span start: 1.

| set | n | approached | complete | E[ReactionDisplacement] (95 % CI) | P(ReactionHit) (95 % CI) | unresolved |
|---|---|---|---|---|---|---|
| wick | 587 | 300 | 300 | -0.233 [-1.354, 0.612] | 0.360 [0.179, 0.434] | 0.197 |
| slow | 23672 | 9723 | 9723 | -0.683 [-0.797, -0.570] | 0.214 [0.194, 0.238] | 0.424 |
| placebo | 2348 | 1123 | 1123 | -0.404 [-1.499, -0.024] | 0.430 [0.242, 0.497] | 0.151 |
| random | 300 | 300 | 300 | -0.013 [-0.578, 0.378] | 0.393 [0.194, 0.470] | 0.223 |

### WickLevels by WickStrength decile

| decile | n | approached | complete | E[ReactionDisplacement] (95 % CI) | P(ReactionHit) (95 % CI) | unresolved |
|---|---|---|---|---|---|---|
| 1 | 59 | 45 | 45 | 0.140 [0.063, 0.250] | 0.533 [0.000, 0.571] | 0.067 |
| 2 | 59 | 27 | 27 | 0.524 [-2.146, 3.170] | 0.259 [0.100, 0.474] | 0.444 |
| 3 | 59 | 29 | 29 | -1.508 [-4.064, 0.628] | 0.207 [0.041, 0.369] | 0.414 |
| 4 | 58 | 28 | 28 | 0.276 [-1.279, 2.005] | 0.286 [0.117, 0.421] | 0.321 |
| 5 | 59 | 36 | 36 | 0.901 [-0.272, 2.473] | 0.444 [0.250, 0.594] | 0.111 |
| 6 | 59 | 40 | 40 | 0.096 [-1.531, 5.467] | 0.325 [0.000, 0.413] | 0.125 |
| 7 | 58 | 26 | 26 | -0.709 [-4.283, 0.694] | 0.231 [0.000, 0.333] | 0.115 |
| 8 | 59 | 30 | 30 | -1.391 [-6.779, 0.905] | 0.500 [0.165, 0.641] | 0.067 |
| 9 | 59 | 23 | 23 | 0.024 [-0.584, 1.501] | 0.478 [0.000, 0.638] | 0.174 |
| 10 | 58 | 16 | 16 | -1.943 [-4.376, 0.372] | 0.125 [0.000, 0.308] | 0.313 |

### Contrasts

| contrast | ΔDisp (95 % CI) | ΔHit (95 % CI) | significant |
|---|---|---|---|
| (1)−(4) | -0.220 [-1.344, 0.947] | -0.033 [-0.086, 0.045] | no |
| (1)−(2) | 0.450 [-0.675, 1.381] | 0.146 [-0.021, 0.209] | no |
| (1)−(3) | 0.171 [-0.303, 1.218] | -0.070 [-0.120, -0.024] | no |

Monotone in WickStrength: slope -0.1540 [-0.4139, 0.0196], Spearman -0.564 — FAIL.

(1)−(2) CI contains 0: fast/decisive is irrelevant and only extremum matters.

**GATE VERDICT: FAIL**
- (1)−(4): E[ReactionDisplacement] of WickLevels not above random levels
- (1)−(4): 95 % block-bootstrap CI contains 0
- ReactionDisplacement not monotone in WickStrength (decile slope ≤ 0 or CI contains 0)

## 3. Cost floor diagnostic (§7.4, §12.1)

Trades triggered in the span: 22. Percentiles are over trades with a finite value.

| quantity | n | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|---|
| RoundTripCost_bps | 22 | 0.27 | 0.36 | 0.52 | 1.05 | 3.19 |
| BreakevenHitRate | 22 | 0.404 | 0.482 | 0.636 | 1.247 | 2.162 |

- MinSweepDepth set by the 2·RoundTripCost floor: 390 WickLevels created in the pooled test windows (100.0 % of them).
- Pooled test mean BreakevenHitRate 1.587 vs HitRate 0.545 (HitRate_0 0.333).

## 4. Target validation (§6.5)

### Train plateau and OOS at the plateau, per fold

| fold | train trades | test trades | train plateau (TargetMult, StopMult) | top / admissible cells | OOS n | OOS HitRate | HitRate_0 | OOS Expectancy bps | VolUnit plateau (TargetUnits, StopMult) | OOS HitRate (VolUnit) | HitRate_0 (VolUnit) | OOS Expectancy bps (VolUnit) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 11 | 11 | (2, 0.75) | 6 / 28 | 11 | 0.364 | 0.273 | -1.59 | (1, 0.75) | 0.364 | 0.679 | -1.97 |

Plateau stability: (2, 0.75) in 100 % of 1 folds (Appendix B Q4: ≥ 75 %).

VolUnit plateau stability: (1, 0.75) in 100 % of 1 folds.

### (TargetMult × StopMult), pooled test windows

| TargetMult | StopMult | n | HitRate | HitRate_0 | Expectancy bps | unresolved |
|---|---|---|---|---|---|---|
| 0.5 | 0.75 | 11 | 0.364 | 0.600 | -1.92 | 0.000 |
| 0.5 | 1 | 11 | 0.545 | 0.667 | -1.87 | 0.000 |
| 0.5 | 1.25 | 11 | 0.545 | 0.714 | -1.93 | 0.091 |
| 0.5 | 1.5 | 11 | 0.545 | 0.750 | -1.98 | 0.182 |
| 1 | 0.75 | 11 | 0.364 | 0.429 | -1.81 | 0.000 |
| 1 | 1 | 11 | 0.545 | 0.500 | -1.72 | 0.000 |
| 1 | 1.25 | 11 | 0.545 | 0.556 | -1.77 | 0.091 |
| 1 | 1.5 | 11 | 0.545 | 0.600 | -1.83 | 0.182 |
| 1.5 | 0.75 | 11 | 0.364 | 0.333 | -1.70 | 0.000 |
| 1.5 | 1 | 11 | 0.545 | 0.400 | -1.56 | 0.000 |
| 1.5 | 1.25 | 11 | 0.545 | 0.455 | -1.62 | 0.091 |
| 1.5 | 1.5 | 11 | 0.545 | 0.500 | -1.68 | 0.182 |
| 2 | 0.75 | 11 | 0.364 | 0.273 | -1.59 | 0.000 |
| 2 | 1 | 11 | 0.545 | 0.333 | -1.41 | 0.000 |
| 2 | 1.25 | 11 | 0.545 | 0.385 | -1.47 | 0.091 |
| 2 | 1.5 | 11 | 0.545 | 0.429 | -1.52 | 0.182 |
| 2.5 | 0.75 | 11 | 0.364 | 0.231 | -1.48 | 0.000 |
| 2.5 | 1 | 11 | 0.545 | 0.286 | -1.25 | 0.000 |
| 2.5 | 1.25 | 11 | 0.545 | 0.333 | -1.31 | 0.091 |
| 2.5 | 1.5 | 11 | 0.545 | 0.375 | -1.37 | 0.182 |
| 3 | 0.75 | 11 | 0.182 | 0.200 | -1.79 | 0.182 |
| 3 | 1 | 11 | 0.364 | 0.250 | -1.55 | 0.182 |
| 3 | 1.25 | 11 | 0.364 | 0.294 | -1.64 | 0.273 |
| 3 | 1.5 | 11 | 0.364 | 0.333 | -1.72 | 0.364 |
| 4 | 0.75 | 11 | 0.091 | 0.158 | -1.90 | 0.182 |
| 4 | 1 | 11 | 0.273 | 0.200 | -1.58 | 0.182 |
| 4 | 1.25 | 11 | 0.273 | 0.238 | -1.68 | 0.273 |
| 4 | 1.5 | 11 | 0.273 | 0.273 | -1.77 | 0.364 |

### VolUnit-scaled Target (TargetUnits × StopMult), pooled test windows

HitRate_0 = mean over trades of S_u/(TargetUnits + S_u), S_u = StopMult·SweepDepth/VolUnit_created (the stop in VolUnits; A-137).

| TargetUnits | StopMult | n | HitRate | HitRate_0 | Expectancy bps | unresolved |
|---|---|---|---|---|---|---|
| 0.5 | 0.75 | 11 | 0.364 | 0.807 | -2.00 | 0.000 |
| 0.5 | 1 | 11 | 0.545 | 0.848 | -1.97 | 0.000 |
| 0.5 | 1.25 | 11 | 0.545 | 0.874 | -2.03 | 0.091 |
| 0.5 | 1.5 | 11 | 0.545 | 0.893 | -2.09 | 0.182 |
| 1 | 0.75 | 11 | 0.364 | 0.679 | -1.97 | 0.000 |
| 1 | 1 | 11 | 0.545 | 0.737 | -1.92 | 0.000 |
| 1 | 1.25 | 11 | 0.545 | 0.778 | -1.98 | 0.091 |
| 1 | 1.5 | 11 | 0.545 | 0.807 | -2.04 | 0.182 |
| 1.5 | 0.75 | 11 | 0.364 | 0.586 | -1.93 | 0.000 |
| 1.5 | 1 | 11 | 0.545 | 0.653 | -1.87 | 0.000 |
| 1.5 | 1.25 | 11 | 0.545 | 0.701 | -1.93 | 0.091 |
| 1.5 | 1.5 | 11 | 0.545 | 0.737 | -1.99 | 0.182 |
| 2 | 0.75 | 11 | 0.364 | 0.516 | -1.90 | 0.000 |
| 2 | 1 | 11 | 0.545 | 0.586 | -1.82 | 0.000 |
| 2 | 1.25 | 11 | 0.545 | 0.638 | -1.88 | 0.091 |
| 2 | 1.5 | 11 | 0.545 | 0.679 | -1.94 | 0.182 |
| 3 | 0.75 | 11 | 0.364 | 0.417 | -1.83 | 0.000 |
| 3 | 1 | 11 | 0.545 | 0.487 | -1.72 | 0.000 |
| 3 | 1.25 | 11 | 0.545 | 0.542 | -1.78 | 0.091 |
| 3 | 1.5 | 11 | 0.545 | 0.586 | -1.84 | 0.182 |

### HitRate(2, 1) | SweepDepth/VolUnit_created, pooled test windows

| SweepDepth/VolUnit_created | n | HitRate | HitRate_0 |
|---|---|---|---|
| [0.3,0.5) | 0 | n/a | 0.333 |
| [0.5,0.75) | 0 | n/a | 0.333 |
| [0.75,1) | 0 | n/a | 0.333 |
| [1,1.5) | 0 | n/a | 0.333 |
| [1.5,2.5] | 4 | 0.250 | 0.333 |

### Two-stage exit (half at 1·SweepDepth, stop to EntryFill, half at TargetMult; StopMult 1), pooled test windows

| TargetMult | n | Expectancy bps | first half hit | second half hit | second half unresolved |
|---|---|---|---|---|---|
| 0.5 | 11 | -1.79 | 0.545 | 1.000 | 0.000 |
| 1 | 11 | -1.72 | 0.545 | 1.000 | 0.000 |
| 1.5 | 11 | -1.64 | 0.545 | 1.000 | 0.000 |
| 2 | 11 | -1.56 | 0.545 | 1.000 | 0.000 |
| 2.5 | 11 | -1.49 | 0.545 | 1.000 | 0.000 |
| 3 | 11 | -1.58 | 0.545 | 0.667 | 0.167 |
| 4 | 11 | -1.57 | 0.545 | 0.500 | 0.167 |

### Placebo swept levels (§9.2 second test, Spec §6.1.4), pooled test windows

Placebo levels = every WickLevel shifted ±1, ±2 VolUnit_created (2348 levels), put through the sweep → confirm → reclaim geometry of the LevelBook; hypothetical entry at the reclaim print (no latency, no slippage); B = 200 volume-day block-bootstrap resamples over 98 volume-days, groups paired within each resample.

| setups | n | HitRate(2, 1) (95 % CI) | HitRate_0 | CI vs 1/3 | unresolved |
|---|---|---|---|---|---|
| actual (filled trades) | 11 | 0.545 [0.200, 0.846] | 0.333 | contains 1/3 |  |
| placebo swept | 204 | 0.348 [0.277, 0.426] | 0.333 | contains 1/3 | 0.152 |

Actual − placebo: 0.197 [-0.113, 0.489] — not significant (CI contains 0).

## 5. Walk-forward (§9.3)

Parameters: the configured ones in every fold (`wsr backtest --from-grid <runId>` trades each fold with its grid cell). HitRate at (TargetMult, StopMult) = (2, 1); expectancies net of §7.4 costs.

| fold | window | from | to | MinStrength | parameters | trades | HitRate | HitRate_0 | Breakeven | HitRate − Breakeven | exp bps | exp R | PF | Sharpe/trade | Sharpe/day | MaxDD_R | hold buckets |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | train | 2025-02-28 | 2025-02-28 | 0.5276 | configured | 11 | 0.182 | 0.333 | 0.602 | -0.420 | 0.05 | -0.345 | 0.618 | -0.223 | n/a | 5.40 | 6.9 |
| 0 | test | 2025-03-01 | 2025-03-01 | 0.5276 | configured | 11 | 0.545 | 0.333 | 1.587 | -1.042 | -1.33 | -2.192 | 0.169 | -0.597 | n/a | 26.05 | 230.2 |
| pooled | test | 2025-03-01 | 2025-03-01 |  |  | 11 | 0.545 | 0.333 | 1.587 | -1.042 | -1.33 | -2.192 | 0.169 | -0.597 | n/a | 26.05 | 230.2 |

## 6. Latency and slippage curves (§7.1, §9.4)

### Latency curve (pooled test windows)

| latency ms | trades | expectancy bps |
|---|---|---|
| 150 | 11 | -1.33 |

Latency sweep not run (`wsr backtest --latency-sweep`): only the configured latency (150 ms) was evaluated.

### Slippage curve (SlipCoef × {1, 2, 4}, pooled test windows)

| SlipCoef multiplier | expectancy bps |
|---|---|
| ×1 | -1.33 |

Slippage sweep not run (`wsr backtest --slippage-sweep`): only ×1 was evaluated.

N_configs (§6.4) = 1 cell × 1 variant(s) × 1 latency point(s) = 1.

## 7. Execution realism (§7.2)

Pooled test-window trades: 11.

| fill event | trades (share) |
|---|---|
| touch-and-reverse (filled, price back through the level) | 2 (18.2 %) |
| touch-and-fly | 0 (0.0 %) |
| burst fill (300 ms window, 3× slippage) | 5 (45.5 %) |
| no-print fallback | 2 (18.2 %) |
| partial fill (FilledQty < Qty) | 0 (0.0 %) |

| exit | stop | target | time | kill | none |
|---|---|---|---|---|---|
| trades | 4 | 7 | 0 | 0 | 0 |

Target fill: conservative (touch + FillWindow rule) -1.33 bps vs optimistic (touch = fill) -1.33 bps expectancy; the conservative figure is the one used everywhere else.

## 8. Breakdowns (§9.4), pooled test windows

### WickStrength decile (vs the fold's train WickLevels; −1 = outside every test window)

| decile | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 09 | 3 | 0.333 | 0.333 | -1.99 | -2.937 |
| 10 | 8 | 0.625 | 0.333 | -1.08 | -1.913 |

Monotonicity (§4.3): inconclusive (2 decile(s) with realised trades).

### SweepDepth/VolUnit_created bin

| bin | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| [1.5,2.5] | 4 | 0.250 | 0.333 | -2.29 | -4.487 |
| outside | 7 | 0.714 | 0.333 | -0.78 | -0.881 |

### Regime at arming

| regime | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| neutral | 4 | 0.500 | 0.333 | -1.47 | -2.194 |
| range | 4 | 0.500 | 0.333 | -1.88 | -3.121 |
| trend_aligned | 1 | 0.000 | 0.333 | -2.12 | -4.273 |
| trend_counter | 2 | 1.000 | 0.333 | 0.48 | 0.712 |

### Hour of day (UTC)

| hour | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 07 | 1 | 1.000 | 0.333 | 0.22 | 0.357 |
| 12 | 2 | 1.000 | 0.333 | 0.60 | 0.792 |
| 15 | 1 | 0.000 | 0.333 | -4.77 | -5.722 |
| 16 | 2 | 1.000 | 0.333 | 0.69 | 0.922 |
| 17 | 1 | 1.000 | 0.333 | 0.77 | 1.133 |
| 18 | 2 | 0.000 | 0.333 | -3.32 | -6.682 |
| 21 | 1 | 0.000 | 0.333 | -4.02 | -4.944 |
| 23 | 1 | 0.000 | 0.333 | -2.72 | -5.000 |

### SweepCount

| SweepCount | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 1 | 10 | 0.600 | 0.333 | -1.19 | -1.911 |
| 2 | 1 | 0.000 | 0.333 | -2.72 | -5.000 |

### PriorTouches

| PriorTouches | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 0 | 2 | 0.500 | 0.333 | -1.53 | -1.889 |
| 1 | 4 | 0.500 | 0.333 | -1.50 | -2.131 |
| 2 | 2 | 1.000 | 0.333 | 0.43 | 0.567 |
| 3 | 1 | 1.000 | 0.333 | 0.23 | 0.417 |
| 4 | 1 | 0.000 | 0.333 | -2.12 | -4.273 |
| 16 | 1 | 0.000 | 0.333 | -4.53 | -9.091 |

PriorTouches sign (§8.3, Stage B coefficient per fold): 1 positive, 0 negative of 1 folds — positive.

### ReturnSpeed bin (VolUnit per bucket)

| ReturnSpeed | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| [0,0.3) | 6 | 0.667 | 0.333 | -1.16 | -1.341 |
| [0.3,0.5) | 1 | 0.000 | 0.333 | -4.53 | -9.091 |
| [0.5,1) | 1 | 1.000 | 0.333 | 0.77 | 1.133 |
| [1,2) | 1 | 1.000 | 0.333 | 0.96 | 1.167 |
| [2,inf) | 2 | 0.000 | 0.333 | -2.42 | -4.636 |

### Scenario variants (grid walk-forward, OOS)

_No scenario variant ran (`wsr backtest --variants armMode` or `wsr grid --variants armMode`)._

## 9. Mechanism check (§1, §9.4)

postEntryImbalance2 = −Side·Σ s·q / Σ q over the 2 completed buckets after entry (positive = reclaim direction); winners have pnl_R > 0; 95 % volume-day block-bootstrap CI.

| fold | window | winners mean | losers mean | diff (95 % CI) |
|---|---|---|---|---|
| 0 | test | -0.523 | 0.037 | -0.560 [-1.363, 0.272] |
| pooled | test | -0.523 | 0.037 | -0.560 [-1.329, 0.368] |

Pooled verdict: no — CI contains 0.

## 10. Rule/cap binding (§5, §11) and level survivorship (§9.5)

### Rule-binding counters (whole replay)

| counter | count |
|---|---|
| book.armsBlockedLiquidity | 35 |
| book.bound.conflict | 2 |
| book.bound.counterTrendBlocked | 8 |
| book.bound.killSwitch | 232 |
| book.bound.liquidity | 38 |
| book.bound.minStrength | 165 |
| book.bound.nested | 14 |
| book.bound.position | 18 |
| book.counterTrendAllowed | 3 |
| book.counterTrendBlockedByStrength | 8 |
| book.counterTrendHalved | 3 |
| book.invalidatedMaxSweeps | 88 |
| book.minSweepFloor.cost | 781 |
| book.missedReclaim.killSwitch | 128 |
| book.missedReclaim.liquidity | 20 |
| book.missedReclaim.minStrength | 153 |
| book.missedReclaim.nested | 6 |
| book.missedReclaim.position | 7 |
| book.ordersPulledLiquidity | 3 |
| book.priorTouchesHist.0 | 3 |
| book.priorTouchesHist.1 | 5 |
| book.priorTouchesHist.2 | 3 |
| book.priorTouchesHist.3+ | 15 |
| book.reclaimSlow | 7 |
| book.reclaimViolent | 2 |
| book.resweeps | 279 |
| book.retiredNestedInner | 40 |
| book.suppress.counterTrendBlocked | 3 |
| book.suppress.killSwitch | 123 |
| book.suppress.liquidity | 26 |
| book.suppress.minStrength | 165 |
| book.suppress.position | 10 |
| book.suppressedNested | 7 |
| book.sweepLegStrongerSpike | 13 |
| book.tradesLostToKillSwitch | 95 |
| book.unarmedInResweep.liquidity | 1 |
| engine.blacklistedBuckets | 0 |
| engine.burstPivots | 29248 |
| engine.liquidityGuardBuckets | 235162 |
| engine.ringUnderflow | 0 |
| engine.tickChanges | 0 |
| engine.totalBuckets | 419027 |
| exec.capCounterTrend | 2 |
| exec.capG | 26 |
| exec.capLiquidity | 26 |
| exec.fillsInBurst | 6 |
| exec.killSwitchTrips | 7 |
| exec.noPrintFallback | 26 |
| exec.stopReplaced | 4 |
| exec.touchAndReverse | 2 |

Kill-switch trips in the pooled test windows: 5.

TradeRing underflows (Spec §3.1, capacity doubled): none in any fold window.

### Sizing caps on pooled test-window trades

| cap | trades (share) |
|---|---|
| counter-trend size halved | 2 (18.2 %) |
| liquidity cap | 11 (100.0 %) |
| minimum Qty | 0 (0.0 %) |

Median g: 0.500.

### Level transitions by reason (whole replay)

| from | to | reason | count |
|---|---|---|---|
| PIVOT_PENDING | WICK_ACTIVE | register | 781 |
| WICK_ACTIVE | SWEEPING | sweep | 528 |
| SWEEPING | SWEEP_CONFIRMED | confirm | 504 |
| SWEEP_CONFIRMED | SWEEP_CONFIRMED | missedReclaim | 314 |
| WICK_ACTIVE | WICK_ACTIVE | merge | 286 |
| SWEEPING | INVALIDATED | breakout | 205 |
| SWEEP_CONFIRMED | SWEEPING | resweep | 182 |
| SWEEP_CONFIRMED | CANCELLED | missedReclaim | 179 |
| WICK_ACTIVE | EXPIRED | age | 149 |
| SWEEP_CONFIRMED | INVALIDATED | maxSweeps | 86 |
| WICK_ACTIVE | INVALIDATED | breakout | 54 |
| WICK_ACTIVE | RETIRED | nestedInner | 40 |
| SWEEP_CONFIRMED | ORDER_ARMED | arm | 39 |
| CLOSED | RETIRED | usesExhausted | 26 |
| ORDER_ARMED | IN_TRADE | trigger | 25 |
| SWEEP_CONFIRMED | INVALIDATED | breakout | 18 |
| IN_TRADE | CLOSED | stop | 13 |
| IN_TRADE | CLOSED | target | 13 |
| WICK_ACTIVE | INVALIDATED | regime | 10 |
| ORDER_ARMED | SWEEPING | resweep | 9 |
| SWEEPING | EXPIRED | age | 5 |
| ORDER_ARMED | INVALIDATED | breakout | 4 |
| SWEEPING | ORDER_ARMED | reconfirm | 4 |
| IN_TRADE | IN_TRADE | retireAfterClose | 3 |
| ORDER_ARMED | INVALIDATED | maxSweeps | 2 |
| ORDER_ARMED | SWEEP_CONFIRMED | liquidity | 2 |
| SWEEP_CONFIRMED | INVALIDATED | regime | 2 |
| ORDER_ARMED | SWEEP_CONFIRMED | counterTrendBlocked | 1 |
| SWEEPING | IN_TRADE | trigger | 1 |
| SWEEP_CONFIRMED | EXPIRED | age | 1 |

### Level survivorship (state of every WickLevel at the end of the replay, levels.parquet)

| state | levels (share) |
|---|---|
| CANCELLED | 179 (22.9 %) |
| EXPIRED | 155 (19.8 %) |
| INVALIDATED | 381 (48.8 %) |
| RETIRED | 66 (8.5 %) |

Share of WickLevels INVALIDATED: 48.8 % of 781.

## 11. Parameter search (§9.3)

_Not available — grid.json / sensitivity.json missing (run `wsr grid`)._

### Stage B per fold (strengthModel stageB)

| fold | train WickLevels | IPW rows | approached | labelled | converged | IPW converged | MinStrength | β PriorTouches |
|---|---|---|---|---|---|---|---|---|
| 0 | 197 | 594 | 583 | 577 | yes | yes | 0.5276 | 0.3611 |

### Stage B calibration (labelled train rows, equal-count bins of P̂)

Pooled over folds (n-weighted):

| bin | n | mean P̂ | mean y |
|---|---|---|---|
| 1 | 57 | 0.364 | 0.333 |
| 2 | 58 | 0.399 | 0.414 |
| 3 | 58 | 0.424 | 0.483 |
| 4 | 57 | 0.447 | 0.456 |
| 5 | 58 | 0.475 | 0.414 |
| 6 | 58 | 0.498 | 0.466 |
| 7 | 57 | 0.523 | 0.596 |
| 8 | 58 | 0.552 | 0.500 |
| 9 | 58 | 0.582 | 0.586 |
| 10 | 58 | 0.656 | 0.690 |

Per fold:

| fold | bin | n | mean P̂ | mean y |
|---|---|---|---|---|
| 0 | 1 | 57 | 0.364 | 0.333 |
| 0 | 2 | 58 | 0.399 | 0.414 |
| 0 | 3 | 58 | 0.424 | 0.483 |
| 0 | 4 | 57 | 0.447 | 0.456 |
| 0 | 5 | 58 | 0.475 | 0.414 |
| 0 | 6 | 58 | 0.498 | 0.466 |
| 0 | 7 | 57 | 0.523 | 0.596 |
| 0 | 8 | 58 | 0.552 | 0.500 |
| 0 | 9 | 58 | 0.582 | 0.586 |
| 0 | 10 | 58 | 0.656 | 0.690 |

## 12. Open questions (§12, Appendix B)

| # | open question | answered by | verdict |
|---|---|---|---|
| 1 | Is E[ReactionDisplacement] for WickLevels significantly above random and placebo levels, and monotone in WickStrength? | §2 sets table, contrasts (1)−(4), (1)−(3), monotonicity; reaction.json gate | no — gate FAIL; the pipeline stops (exit 3) |
| 2 | Does "fast" matter: WickLevels vs SlowExtremes? | §2 contrast (1)−(2) | no — "fast/decisive is irrelevant and only extremum matters" |
| 3 | Sign of PriorTouches | §8 byPriorTouches; §11 Stage B β PriorTouches per fold | positive (1+ / 0− of 1 folds; ≥ 75 % needed) |
| 4 | Is HitRate(2,1) above BreakevenHitRate, and is the optimal (TargetMult, StopMult) stable across folds? | §4 target tables and placebo swept levels; §5 HitRate − Breakeven; plateau per fold | no — HitRate − Breakeven -1.042 [-1.387, -0.741] (volume-day block bootstrap); plateau (2, 0.75) in 100 % of folds |
| 5 | Should the Target scale with SweepDepth or with VolUnit? | §4 VolUnit-scaled table vs (TargetMult × StopMult) table; conditional table | SweepDepth — plateau expectancy -1.25 bps (SweepDepth 2.5×) vs -1.72 bps (VolUnit 3×); SweepDepth ahead in 1 of 1 folds (OOS at each fold's train plateaus) — consistent (≥ 75 %) |
| 6 | RestEarly vs ArmOnApproach: does requiring a violent Reclaim pay for the lost trades? | §8 scenario variants (backtest / grid); byReturnSpeed | not run (`wsr backtest --variants armMode` or `wsr grid --variants armMode`) |
| 7 | Does post-entry aggressor imbalance separate winners from losers? | §9 mechanism check | no — CI contains 0 |
| 8 | Latency curve: where does the edge vanish? | §6 latency curve | expectancy ≤ 0 already at 150 ms (only point evaluated; latency sweep not run) |
| 9 | Transfer across venues and symbols? | §5 per (venue, symbol) + runs/compare-*/comparison.md | not answered by a single run — `wsr report --compare <a>,<b>` writes the cross-venue comparison (Spec §6.5) |
