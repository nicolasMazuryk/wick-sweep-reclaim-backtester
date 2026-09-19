P&L run despite failed reaction test (§9.2)

# WSR backtest — binance ETHUSDT 2025-01-09…2025-01-22

[VERIFY] fees unverified

## 0. Run manifest

- runId: ca705ef826b52ddd
- createdAt: 2026-09-19T00:00:00.000Z
- configHash: 90f1f4f2b9d9ee02c3665716d39841433c7f04bf81accb691f3d7331bdd29a3e
- seed: 1
- gitCommit: e2e-fixture
- wsrVersion: e2e-fixture
- venue / symbol / span: binance ETHUSDT 2025-01-09…2025-01-22
- data checksums: 22 partition(s)
- fees verifiedAt: unverified
- strengthModel: stageB
- Parquet key-value metadata: wsr.configHash, wsr.seed, wsr.runId (Spec §8.3)
- folds: 5 (4/2/2 days)
- MinSweepMult: configured 0.3; effective (MinSweepDepth/VolUnit_created over 1314 levels) median 2.000, p90 2.000; cost floor binding on 1314 (100.0 %) levels
- warnings:
  - [VERIFY] fees unverified
  - --folds 4,2,2: non-standard fold lengths (Spec §6.3: 56/14/14 days), F = 5 < 12
  - P&L run despite failed reaction test (§9.2)

## 1. Data coverage & hygiene

| days requested | present | suspect | checksum failed | blacklisted minutes |
|---|---|---|---|---|
| 14 | 14 | 0 | 0 | 16 |

- suspect days: 0
- feedKind aggregated: 0
- tick-size changes: 0
- gaps: 1; bad prints: 0; duplicate tradeIds: 0; non-monotone timestamps: 0; missing funding prints: 0

Blacklisted buckets (reaction replay, span): 2/21916 (0.0 %).

| fold | window | from | to | volume-days | blacklisted bucket share |
|---|---|---|---|---|---|
| 0 | train | 2025-01-09 | 2025-01-12 | 4.03 | 0.03 % |
| 0 | test | 2025-01-13 | 2025-01-14 | 2.04 | 0.00 % |
| 1 | train | 2025-01-11 | 2025-01-14 | 4.06 | 0.00 % |
| 1 | test | 2025-01-15 | 2025-01-16 | 2.05 | 0.00 % |
| 2 | train | 2025-01-13 | 2025-01-16 | 4.09 | 0.00 % |
| 2 | test | 2025-01-17 | 2025-01-18 | 2.05 | 0.00 % |
| 3 | train | 2025-01-15 | 2025-01-18 | 4.10 | 0.00 % |
| 3 | test | 2025-01-19 | 2025-01-20 | 2.03 | 0.00 % |
| 4 | train | 2025-01-17 | 2025-01-20 | 4.08 | 0.00 % |
| 4 | test | 2025-01-21 | 2025-01-22 | 2.01 | 0.00 % |

## 2. Reaction test (§9.2)

B = 200 volume-day block-bootstrap resamples over 15 volume-days; random levels clipped at the span start: 0.

| set | n | approached | complete | E[ReactionDisplacement] (95 % CI) | P(ReactionHit) (95 % CI) | unresolved |
|---|---|---|---|---|---|---|
| wick | 1226 | 1046 | 1045 | -0.062 [-0.343, 0.172] | 0.490 [0.472, 0.507] | 0.000 |
| slow | 5968 | 5189 | 5186 | -0.120 [-0.226, -0.003] | 0.504 [0.494, 0.514] | 0.001 |
| placebo | 4904 | 4203 | 4198 | -0.018 [-0.189, 0.145] | 0.509 [0.493, 0.524] | 0.001 |
| random | 1046 | 1046 | 1046 | -0.021 [-0.235, 0.263] | 0.494 [0.462, 0.526] | 0.001 |

### WickLevels by WickStrength decile

| decile | n | approached | complete | E[ReactionDisplacement] (95 % CI) | P(ReactionHit) (95 % CI) | unresolved |
|---|---|---|---|---|---|---|
| 1 | 123 | 106 | 105 | -0.209 [-0.980, 0.444] | 0.495 [0.398, 0.576] | 0.000 |
| 2 | 123 | 108 | 108 | 0.200 [-0.603, 0.840] | 0.519 [0.455, 0.596] | 0.000 |
| 3 | 122 | 109 | 109 | -0.116 [-0.821, 0.546] | 0.569 [0.494, 0.632] | 0.000 |
| 4 | 123 | 107 | 107 | 0.128 [-1.019, 0.890] | 0.449 [0.352, 0.553] | 0.000 |
| 5 | 122 | 95 | 95 | -0.038 [-1.011, 0.937] | 0.537 [0.410, 0.664] | 0.000 |
| 6 | 123 | 106 | 106 | 0.258 [-0.348, 0.961] | 0.519 [0.438, 0.594] | 0.000 |
| 7 | 123 | 101 | 101 | -0.691 [-1.157, -0.216] | 0.475 [0.398, 0.552] | 0.000 |
| 8 | 122 | 104 | 104 | 0.010 [-0.683, 0.628] | 0.538 [0.460, 0.624] | 0.000 |
| 9 | 123 | 110 | 110 | -0.201 [-0.901, 0.390] | 0.327 [0.239, 0.413] | 0.000 |
| 10 | 122 | 100 | 100 | 0.015 [-0.651, 0.556] | 0.480 [0.393, 0.573] | 0.000 |

### Contrasts

| contrast | ΔDisp (95 % CI) | ΔHit (95 % CI) | significant |
|---|---|---|---|
| (1)−(4) | -0.041 [-0.356, 0.244] | -0.004 [-0.033, 0.027] | no |
| (1)−(2) | 0.058 [-0.245, 0.289] | -0.014 [-0.035, 0.005] | no |
| (1)−(3) | -0.044 [-0.244, 0.136] | -0.019 [-0.045, 0.009] | no |

Monotone in WickStrength: slope -0.0142 [-0.0926, 0.0690], Spearman -0.018 — FAIL.

(1)−(2) CI contains 0: fast/decisive is irrelevant and only extremum matters.

**GATE VERDICT: FAIL**
- (1)−(4): E[ReactionDisplacement] of WickLevels not above random levels
- (1)−(4): 95 % block-bootstrap CI contains 0
- ReactionDisplacement not monotone in WickStrength (decile slope ≤ 0 or CI contains 0)

## 3. Cost floor diagnostic (§7.4, §12.1)

Trades triggered in the span: 94. Percentiles are over trades with a finite value.

| quantity | n | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|---|
| RoundTripCost_bps | 94 | 0.10 | 0.15 | 0.20 | 0.29 | 0.40 |
| BreakevenHitRate | 94 | 0.410 | 0.446 | 0.524 | 0.608 | 0.732 |

- MinSweepDepth set by the 2·RoundTripCost floor: 873 WickLevels created in the pooled test windows (100.0 % of them).
- Pooled test mean BreakevenHitRate 0.551 vs HitRate 0.099 (HitRate_0 0.333).

## 4. Target validation (§6.5)

### Train plateau and OOS at the plateau, per fold

| fold | train trades | test trades | train plateau (TargetMult, StopMult) | top / admissible cells | OOS n | OOS HitRate | HitRate_0 | OOS Expectancy bps | VolUnit plateau (TargetUnits, StopMult) | OOS HitRate (VolUnit) | HitRate_0 (VolUnit) | OOS Expectancy bps (VolUnit) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 23 | 22 | (1, 0.75) | 6 / 28 | 22 | 0.182 | 0.429 | -0.45 | (0.5, 0.75) | 0.545 | 0.807 | -0.37 |
| 1 | 27 | 11 | (1.5, 0.75) | 6 / 28 | 11 | 0.091 | 0.333 | -0.43 | (0.5, 0.75) | 0.273 | 0.786 | -0.43 |
| 2 | 33 | 5 | (1.5, 0.75) | 6 / 28 | 5 | 0.000 | 0.333 | -0.56 | (0.5, 0.75) | 0.600 | 0.781 | -0.38 |
| 3 | 16 | 16 | (2, 0.75) | 6 / 28 | 16 | 0.188 | 0.273 | -0.34 | (1, 0.75) | 0.563 | 0.643 | -0.26 |
| 4 | 21 | 17 | (1.5, 0.75) | 6 / 28 | 17 | 0.000 | 0.333 | -0.55 | (0.5, 0.75) | 0.588 | 0.799 | -0.33 |

Plateau stability: (1.5, 0.75) in 60 % of 5 folds (Appendix B Q4: ≥ 75 %).

VolUnit plateau stability: (0.5, 0.75) in 80 % of 5 folds.

### (TargetMult × StopMult), pooled test windows

| TargetMult | StopMult | n | HitRate | HitRate_0 | Expectancy bps | unresolved |
|---|---|---|---|---|---|---|
| 0.5 | 0.75 | 71 | 0.324 | 0.600 | -0.40 | 0.197 |
| 0.5 | 1 | 71 | 0.366 | 0.667 | -0.44 | 0.282 |
| 0.5 | 1.25 | 71 | 0.380 | 0.714 | -0.50 | 0.296 |
| 0.5 | 1.5 | 71 | 0.380 | 0.750 | -0.57 | 0.352 |
| 1 | 0.75 | 71 | 0.183 | 0.429 | -0.43 | 0.254 |
| 1 | 1 | 71 | 0.225 | 0.500 | -0.47 | 0.352 |
| 1 | 1.25 | 71 | 0.225 | 0.556 | -0.55 | 0.423 |
| 1 | 1.5 | 71 | 0.254 | 0.600 | -0.61 | 0.479 |
| 1.5 | 0.75 | 71 | 0.113 | 0.333 | -0.45 | 0.310 |
| 1.5 | 1 | 71 | 0.127 | 0.400 | -0.52 | 0.423 |
| 1.5 | 1.25 | 71 | 0.141 | 0.455 | -0.60 | 0.493 |
| 1.5 | 1.5 | 71 | 0.169 | 0.500 | -0.65 | 0.549 |
| 2 | 0.75 | 71 | 0.085 | 0.273 | -0.45 | 0.338 |
| 2 | 1 | 71 | 0.099 | 0.333 | -0.53 | 0.451 |
| 2 | 1.25 | 71 | 0.113 | 0.385 | -0.60 | 0.521 |
| 2 | 1.5 | 71 | 0.141 | 0.429 | -0.65 | 0.577 |
| 2.5 | 0.75 | 71 | 0.070 | 0.231 | -0.46 | 0.352 |
| 2.5 | 1 | 71 | 0.070 | 0.286 | -0.56 | 0.479 |
| 2.5 | 1.25 | 71 | 0.085 | 0.333 | -0.63 | 0.549 |
| 2.5 | 1.5 | 71 | 0.113 | 0.375 | -0.68 | 0.606 |
| 3 | 0.75 | 71 | 0.070 | 0.200 | -0.45 | 0.352 |
| 3 | 1 | 71 | 0.070 | 0.250 | -0.54 | 0.479 |
| 3 | 1.25 | 71 | 0.085 | 0.294 | -0.61 | 0.549 |
| 3 | 1.5 | 71 | 0.113 | 0.333 | -0.66 | 0.606 |
| 4 | 0.75 | 71 | 0.014 | 0.158 | -0.52 | 0.408 |
| 4 | 1 | 71 | 0.014 | 0.200 | -0.63 | 0.535 |
| 4 | 1.25 | 71 | 0.014 | 0.238 | -0.73 | 0.620 |
| 4 | 1.5 | 71 | 0.014 | 0.273 | -0.83 | 0.704 |

### VolUnit-scaled Target (TargetUnits × StopMult), pooled test windows

HitRate_0 = mean over trades of S_u/(TargetUnits + S_u), S_u = StopMult·SweepDepth/VolUnit_created (the stop in VolUnits; A-137).

| TargetUnits | StopMult | n | HitRate | HitRate_0 | Expectancy bps | unresolved |
|---|---|---|---|---|---|---|
| 0.5 | 0.75 | 71 | 0.549 | 0.794 | -0.35 | 0.099 |
| 0.5 | 1 | 71 | 0.577 | 0.837 | -0.38 | 0.141 |
| 0.5 | 1.25 | 71 | 0.592 | 0.865 | -0.42 | 0.155 |
| 0.5 | 1.5 | 71 | 0.592 | 0.885 | -0.46 | 0.197 |
| 1 | 0.75 | 71 | 0.394 | 0.661 | -0.37 | 0.183 |
| 1 | 1 | 71 | 0.423 | 0.721 | -0.42 | 0.254 |
| 1 | 1.25 | 71 | 0.437 | 0.763 | -0.47 | 0.282 |
| 1 | 1.5 | 71 | 0.437 | 0.794 | -0.53 | 0.324 |
| 1.5 | 0.75 | 71 | 0.324 | 0.567 | -0.39 | 0.183 |
| 1.5 | 1 | 71 | 0.352 | 0.634 | -0.44 | 0.268 |
| 1.5 | 1.25 | 71 | 0.366 | 0.684 | -0.50 | 0.310 |
| 1.5 | 1.5 | 71 | 0.366 | 0.721 | -0.56 | 0.366 |
| 2 | 0.75 | 71 | 0.225 | 0.497 | -0.42 | 0.225 |
| 2 | 1 | 71 | 0.268 | 0.567 | -0.47 | 0.310 |
| 2 | 1.25 | 71 | 0.282 | 0.620 | -0.53 | 0.380 |
| 2 | 1.5 | 71 | 0.296 | 0.661 | -0.60 | 0.437 |
| 3 | 0.75 | 71 | 0.127 | 0.398 | -0.46 | 0.296 |
| 3 | 1 | 71 | 0.169 | 0.468 | -0.51 | 0.394 |
| 3 | 1.25 | 71 | 0.183 | 0.522 | -0.58 | 0.465 |
| 3 | 1.5 | 71 | 0.211 | 0.567 | -0.63 | 0.521 |

### HitRate(2, 1) | SweepDepth/VolUnit_created, pooled test windows

| SweepDepth/VolUnit_created | n | HitRate | HitRate_0 |
|---|---|---|---|
| [0.3,0.5) | 0 | n/a | 0.333 |
| [0.5,0.75) | 0 | n/a | 0.333 |
| [0.75,1) | 0 | n/a | 0.333 |
| [1,1.5) | 0 | n/a | 0.333 |
| [1.5,2.5] | 31 | 0.065 | 0.333 |

### Two-stage exit (half at 1·SweepDepth, stop to EntryFill, half at TargetMult; StopMult 1), pooled test windows

| TargetMult | n | Expectancy bps | first half hit | second half hit | second half unresolved |
|---|---|---|---|---|---|
| 0.5 | 71 | -0.50 | 0.225 | 1.000 | 0.000 |
| 1 | 71 | -0.47 | 0.225 | 1.000 | 0.000 |
| 1.5 | 71 | -0.48 | 0.225 | 0.563 | 0.250 |
| 2 | 71 | -0.47 | 0.225 | 0.438 | 0.375 |
| 2.5 | 71 | -0.48 | 0.225 | 0.313 | 0.500 |
| 3 | 71 | -0.47 | 0.225 | 0.313 | 0.500 |
| 4 | 71 | -0.50 | 0.225 | 0.063 | 0.750 |

### Placebo swept levels (§9.2 second test, Spec §6.1.4), pooled test windows

Placebo levels = every WickLevel shifted ±1, ±2 VolUnit_created (4904 levels), put through the sweep → confirm → reclaim geometry of the LevelBook; hypothetical entry at the reclaim print (no latency, no slippage); B = 200 volume-day block-bootstrap resamples over 11 volume-days, groups paired within each resample.

| setups | n | HitRate(2, 1) (95 % CI) | HitRate_0 | CI vs 1/3 | unresolved |
|---|---|---|---|---|---|
| actual (filled trades) | 71 | 0.099 [0.059, 0.137] | 0.333 | below 1/3 |  |
| placebo swept | 1495 | 0.126 [0.095, 0.149] | 0.333 | below 1/3 | 0.514 |

Actual − placebo: -0.027 [-0.060, 0.005] — not significant (CI contains 0).

## 5. Walk-forward (§9.3)

Parameters: the configured ones in every fold (`wsr backtest --from-grid <runId>` trades each fold with its grid cell). HitRate at (TargetMult, StopMult) = (2, 1); expectancies net of §7.4 costs.

| fold | window | from | to | MinStrength | parameters | trades | HitRate | HitRate_0 | Breakeven | HitRate − Breakeven | exp bps | exp R | PF | Sharpe/trade | Sharpe/day | MaxDD_R | hold buckets |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | train | 2025-01-09 | 2025-01-12 | 0.5236 | configured | 23 | 0.043 | 0.333 | 0.503 | -0.460 | -0.25 | -0.534 | 0.432 | -0.412 | -2.334 | 14.37 | 13.3 |
| 0 | test | 2025-01-13 | 2025-01-14 | 0.5236 | configured | 22 | 0.091 | 0.333 | 0.543 | -0.452 | -0.13 | -0.367 | 0.620 | -0.220 | -66.623 | 11.05 | 19.3 |
| 1 | train | 2025-01-11 | 2025-01-14 | 0.5145 | configured | 27 | 0.074 | 0.333 | 0.526 | -0.452 | -0.21 | -0.512 | 0.500 | -0.322 | -3.450 | 13.83 | 16.9 |
| 1 | test | 2025-01-15 | 2025-01-16 | 0.5145 | configured | 11 | 0.091 | 0.333 | 0.552 | -0.461 | -0.41 | -0.838 | 0.323 | -0.540 | -1.007 | 9.24 | 9.4 |
| 2 | train | 2025-01-13 | 2025-01-16 | 0.5242 | configured | 33 | 0.091 | 0.333 | 0.546 | -0.455 | -0.23 | -0.524 | 0.504 | -0.323 | -1.625 | 20.27 | 16.0 |
| 2 | test | 2025-01-17 | 2025-01-18 | 0.5242 | configured | 5 | 0.000 | 0.333 | 0.588 | -0.588 | -0.43 | -0.940 | 0.210 | -0.753 | -0.707 | 4.70 | 8.7 |
| 3 | train | 2025-01-15 | 2025-01-18 | 0.5178 | configured | 16 | 0.063 | 0.333 | 0.563 | -0.501 | -0.42 | -0.870 | 0.289 | -0.611 | -0.990 | 13.94 | 9.2 |
| 3 | test | 2025-01-19 | 2025-01-20 | 0.5178 | configured | 16 | 0.250 | 0.333 | 0.562 | -0.312 | 0.04 | 0.082 | 1.121 | 0.049 | -1.878 | 6.70 | 13.2 |
| 4 | train | 2025-01-17 | 2025-01-20 | 0.4995 | configured | 21 | 0.190 | 0.333 | 0.568 | -0.378 | -0.07 | -0.161 | 0.799 | -0.099 | -0.891 | 10.58 | 12.1 |
| 4 | test | 2025-01-21 | 2025-01-22 | 0.4995 | configured | 17 | 0.000 | 0.333 | 0.540 | -0.540 | -0.33 | -0.635 | 0.363 | -0.503 | -2.723 | 11.09 | 17.8 |
| pooled | test | 2025-01-13 | 2025-01-22 |  |  | 71 | 0.099 | 0.333 | 0.551 | -0.453 | -0.20 | -0.443 | 0.542 | -0.288 | -1.375 | 34.45 | 15.3 |

## 6. Latency and slippage curves (§7.1, §9.4)

### Latency curve (pooled test windows)

| latency ms | trades | expectancy bps |
|---|---|---|
| 150 | 71 | -0.20 |

Latency sweep not run (`wsr backtest --latency-sweep`): only the configured latency (150 ms) was evaluated.

### Slippage curve (SlipCoef × {1, 2, 4}, pooled test windows)

| SlipCoef multiplier | expectancy bps |
|---|---|
| ×1 | -0.20 |

Slippage sweep not run (`wsr backtest --slippage-sweep`): only ×1 was evaluated.

N_configs (§6.4) = 1 cell × 1 variant(s) × 1 latency point(s) = 1.

## 7. Execution realism (§7.2)

Pooled test-window trades: 71.

| fill event | trades (share) |
|---|---|
| touch-and-reverse (filled, price back through the level) | 0 (0.0 %) |
| touch-and-fly | 2 (2.8 %) |
| burst fill (300 ms window, 3× slippage) | 0 (0.0 %) |
| no-print fallback | 69 (97.2 %) |
| partial fill (FilledQty < Qty) | 0 (0.0 %) |

| exit | stop | target | time | kill | none |
|---|---|---|---|---|---|
| trades | 45 | 26 | 0 | 0 | 0 |

Target fill: conservative (touch + FillWindow rule) -0.20 bps vs optimistic (touch = fill) -0.20 bps expectancy; the conservative figure is the one used everywhere else.

## 8. Breakdowns (§9.4), pooled test windows

### WickStrength decile (vs the fold's train WickLevels; −1 = outside every test window)

| decile | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 07 | 14 | 0.214 | 0.333 | 0.14 | 0.268 |
| 08 | 20 | 0.100 | 0.333 | -0.12 | -0.356 |
| 09 | 16 | 0.063 | 0.333 | -0.24 | -0.547 |
| 10 | 21 | 0.048 | 0.333 | -0.48 | -0.922 |

Monotonicity (§4.3): decreasing in WickStrength (Spearman ρ -1.000, slope -0.198 bps/decile over 4 deciles; point estimates, no CI).

### SweepDepth/VolUnit_created bin

| bin | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| [1.5,2.5] | 31 | 0.065 | 0.333 | -0.40 | -0.944 |
| outside | 40 | 0.125 | 0.333 | -0.05 | -0.055 |

### Regime at arming

| regime | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| neutral | 10 | 0.200 | 0.333 | -0.40 | -0.817 |
| range | 61 | 0.082 | 0.333 | -0.17 | -0.382 |

### Hour of day (UTC)

| hour | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 00 | 4 | 0.000 | 0.333 | -0.22 | -0.178 |
| 01 | 6 | 0.333 | 0.333 | 0.54 | 0.915 |
| 02 | 9 | 0.000 | 0.333 | -0.40 | -0.798 |
| 03 | 3 | 0.000 | 0.333 | -0.21 | -0.420 |
| 04 | 3 | 0.000 | 0.333 | -0.40 | -0.842 |
| 05 | 3 | 0.000 | 0.333 | -0.68 | -1.484 |
| 06 | 5 | 0.400 | 0.333 | -0.09 | -0.323 |
| 07 | 5 | 0.000 | 0.333 | -0.51 | -1.185 |
| 08 | 1 | 0.000 | 0.333 | -1.10 | -2.750 |
| 09 | 1 | 0.000 | 0.333 | 0.77 | 1.533 |
| 10 | 1 | 0.000 | 0.333 | -0.97 | -1.526 |
| 11 | 1 | 0.000 | 0.333 | 1.03 | 1.550 |
| 12 | 1 | 0.000 | 0.333 | 0.30 | 0.818 |
| 13 | 1 | 0.000 | 0.333 | -0.83 | -1.786 |
| 15 | 2 | 0.000 | 0.333 | -0.53 | -0.918 |
| 17 | 1 | 0.000 | 0.333 | -0.80 | -1.200 |
| 19 | 1 | 0.000 | 0.333 | -0.63 | -1.462 |
| 20 | 4 | 0.000 | 0.333 | -0.33 | -0.494 |
| 21 | 9 | 0.000 | 0.333 | -0.38 | -0.841 |
| 22 | 6 | 0.333 | 0.333 | 0.09 | 0.142 |
| 23 | 4 | 0.250 | 0.333 | 0.26 | 0.514 |

### SweepCount

| SweepCount | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 1 | 63 | 0.095 | 0.333 | -0.28 | -0.607 |
| 2 | 8 | 0.125 | 0.333 | 0.38 | 0.845 |

### PriorTouches

| PriorTouches | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| 0 | 8 | 0.000 | 0.333 | -0.26 | -0.508 |
| 1 | 17 | 0.118 | 0.333 | -0.18 | -0.498 |
| 2 | 12 | 0.000 | 0.333 | -0.38 | -0.731 |
| 3 | 10 | 0.200 | 0.333 | -0.13 | -0.211 |
| 4 | 4 | 0.250 | 0.333 | -0.14 | -0.397 |
| 5 | 5 | 0.000 | 0.333 | -0.23 | -0.249 |
| 6 | 5 | 0.200 | 0.333 | -0.48 | -1.005 |
| 7 | 2 | 0.000 | 0.333 | 0.10 | 0.113 |
| 9 | 1 | 0.000 | 0.333 | 1.97 | 3.930 |
| 10 | 1 | 0.000 | 0.333 | -0.50 | -1.364 |
| 11 | 2 | 0.000 | 0.333 | -0.75 | -1.485 |
| 13 | 1 | 0.000 | 0.333 | -0.50 | -1.364 |
| 16 | 1 | 0.000 | 0.333 | -0.53 | -1.333 |
| 17 | 1 | 0.000 | 0.333 | 0.60 | 1.286 |
| 25 | 1 | 1.000 | 0.333 | 0.97 | 1.381 |

PriorTouches sign (§8.3, Stage B coefficient per fold): 1 positive, 4 negative of 5 folds — negative.

### ReturnSpeed bin (VolUnit per bucket)

| ReturnSpeed | trades | HitRate | HitRate_0 | exp bps | exp R |
|---|---|---|---|---|---|
| [0,0.3) | 6 | 0.167 | 0.333 | 0.35 | 0.848 |
| [0.3,0.5) | 4 | 0.500 | 0.333 | -0.01 | -0.313 |
| [0.5,1) | 11 | 0.182 | 0.333 | -0.06 | -0.211 |
| [1,2) | 13 | 0.000 | 0.333 | 0.03 | -0.025 |
| [2,inf) | 37 | 0.054 | 0.333 | -0.44 | -0.883 |

### Scenario variants (grid walk-forward, OOS)

_No scenario variant ran (`wsr backtest --variants armMode` or `wsr grid --variants armMode`)._

## 9. Mechanism check (§1, §9.4)

postEntryImbalance2 = −Side·Σ s·q / Σ q over the 2 completed buckets after entry (positive = reclaim direction); winners have pnl_R > 0; 95 % volume-day block-bootstrap CI.

| fold | window | winners mean | losers mean | diff (95 % CI) |
|---|---|---|---|---|
| 0 | test | -0.196 | -0.000 | -0.196 [-0.359, 0.244] |
| 1 | test | -0.011 | -0.131 | 0.120 [0.072, 0.179] |
| 2 | test | -0.200 | -0.144 | -0.056 [-0.056, -0.019] |
| 3 | test | 0.028 | -0.031 | 0.060 [-0.056, 0.169] |
| 4 | test | -0.199 | -0.093 | -0.106 [-0.186, -0.057] |
| pooled | test | -0.116 | -0.067 | -0.049 [-0.192, 0.055] |

Pooled verdict: no — CI contains 0.

## 10. Rule/cap binding (§5, §11) and level survivorship (§9.5)

### Rule-binding counters (whole replay)

| counter | count |
|---|---|
| book.bound.blacklist | 1 |
| book.bound.conflict | 5 |
| book.bound.killSwitch | 376 |
| book.bound.minStrength | 415 |
| book.bound.nested | 38 |
| book.bound.position | 61 |
| book.invalidatedMaxSweeps | 78 |
| book.minSweepFloor.cost | 1314 |
| book.missedReclaim.killSwitch | 125 |
| book.missedReclaim.minStrength | 354 |
| book.missedReclaim.nested | 3 |
| book.missedReclaim.position | 13 |
| book.priorTouchesHist.0 | 8 |
| book.priorTouchesHist.1 | 23 |
| book.priorTouchesHist.2 | 16 |
| book.priorTouchesHist.3+ | 52 |
| book.reclaimSlow | 6 |
| book.reclaimViolent | 43 |
| book.resweeps | 370 |
| book.retiredNestedInner | 119 |
| book.suppress.killSwitch | 142 |
| book.suppress.minStrength | 415 |
| book.suppress.position | 20 |
| book.suppressedNested | 7 |
| book.sweepLegStrongerSpike | 18 |
| book.tradesLostToKillSwitch | 113 |
| engine.blacklistedBuckets | 2 |
| engine.burstPivots | 0 |
| engine.liquidityGuardBuckets | 0 |
| engine.ringUnderflow | 0 |
| engine.tickChanges | 0 |
| engine.totalBuckets | 21916 |
| exec.capG | 99 |
| exec.capLiquidity | 99 |
| exec.killSwitchTrips | 13 |
| exec.noPrintFallback | 160 |
| exec.stopReplaced | 17 |
| exec.touchAndFly | 4 |

Kill-switch trips in the pooled test windows: 9.

TradeRing underflows (Spec §3.1, capacity doubled): none in any fold window.

### Sizing caps on pooled test-window trades

| cap | trades (share) |
|---|---|
| counter-trend size halved | 0 (0.0 %) |
| liquidity cap | 71 (100.0 %) |
| minimum Qty | 0 (0.0 %) |

Median g: 0.500.

### Level transitions by reason (whole replay)

| from | to | reason | count |
|---|---|---|---|
| PIVOT_PENDING | WICK_ACTIVE | register | 1314 |
| WICK_ACTIVE | SWEEPING | sweep | 1015 |
| SWEEPING | SWEEP_CONFIRMED | confirm | 827 |
| WICK_ACTIVE | WICK_ACTIVE | merge | 789 |
| SWEEP_CONFIRMED | SWEEP_CONFIRMED | missedReclaim | 495 |
| SWEEPING | INVALIDATED | breakout | 463 |
| SWEEP_CONFIRMED | CANCELLED | missedReclaim | 307 |
| SWEEP_CONFIRMED | SWEEPING | resweep | 264 |
| WICK_ACTIVE | EXPIRED | age | 148 |
| SWEEP_CONFIRMED | ORDER_ARMED | arm | 121 |
| WICK_ACTIVE | RETIRED | nestedInner | 119 |
| CLOSED | RETIRED | usesExhausted | 99 |
| ORDER_ARMED | IN_TRADE | trigger | 99 |
| SWEEP_CONFIRMED | INVALIDATED | maxSweeps | 71 |
| IN_TRADE | CLOSED | stop | 65 |
| SWEEP_CONFIRMED | INVALIDATED | breakout | 64 |
| IN_TRADE | CLOSED | target | 34 |
| ORDER_ARMED | SWEEPING | resweep | 28 |
| WICK_ACTIVE | INVALIDATED | breakout | 21 |
| SWEEPING | ORDER_ARMED | reconfirm | 17 |
| ORDER_ARMED | INVALIDATED | maxSweeps | 7 |
| ORDER_ARMED | INVALIDATED | breakout | 4 |

### Level survivorship (state of every WickLevel at the end of the replay, levels.parquet)

| state | levels (share) |
|---|---|
| CANCELLED | 307 (23.4 %) |
| EXPIRED | 148 (11.3 %) |
| INVALIDATED | 630 (47.9 %) |
| RETIRED | 218 (16.6 %) |
| WICK_ACTIVE | 11 (0.8 %) |

Share of WickLevels INVALIDATED: 47.9 % of 1314.

## 11. Parameter search (§9.3)

_Not available — grid.json / sensitivity.json missing (run `wsr grid`)._

### Stage B per fold (strengthModel stageB)

| fold | train WickLevels | IPW rows | approached | labelled | converged | IPW converged | MinStrength | β PriorTouches |
|---|---|---|---|---|---|---|---|---|
| 0 | 353 | 1992 | 1815 | 1811 | yes | yes | 0.5236 | 0.0508 |
| 1 | 372 | 1988 | 1764 | 1763 | yes | yes | 0.5145 | -0.0269 |
| 2 | 340 | 1967 | 1706 | 1704 | yes | yes | 0.5242 | -0.0959 |
| 3 | 318 | 1942 | 1752 | 1751 | yes | yes | 0.5178 | -0.0826 |
| 4 | 343 | 2004 | 1813 | 1813 | yes | yes | 0.4995 | -0.1812 |

### Stage B calibration (labelled train rows, equal-count bins of P̂)

Pooled over folds (n-weighted):

| bin | n | mean P̂ | mean y |
|---|---|---|---|
| 1 | 883 | 0.433 | 0.431 |
| 2 | 883 | 0.459 | 0.461 |
| 3 | 884 | 0.474 | 0.483 |
| 4 | 885 | 0.486 | 0.469 |
| 5 | 884 | 0.497 | 0.505 |
| 6 | 883 | 0.508 | 0.504 |
| 7 | 885 | 0.520 | 0.504 |
| 8 | 884 | 0.533 | 0.552 |
| 9 | 883 | 0.548 | 0.544 |
| 10 | 888 | 0.579 | 0.582 |

Per fold:

| fold | bin | n | mean P̂ | mean y |
|---|---|---|---|---|
| 0 | 1 | 181 | 0.429 | 0.464 |
| 0 | 2 | 181 | 0.452 | 0.431 |
| 0 | 3 | 181 | 0.466 | 0.431 |
| 0 | 4 | 181 | 0.479 | 0.492 |
| 0 | 5 | 181 | 0.491 | 0.475 |
| 0 | 6 | 181 | 0.505 | 0.470 |
| 0 | 7 | 181 | 0.520 | 0.552 |
| 0 | 8 | 181 | 0.536 | 0.564 |
| 0 | 9 | 181 | 0.554 | 0.586 |
| 0 | 10 | 182 | 0.587 | 0.555 |
| 1 | 1 | 176 | 0.439 | 0.455 |
| 1 | 2 | 176 | 0.464 | 0.460 |
| 1 | 3 | 176 | 0.480 | 0.489 |
| 1 | 4 | 177 | 0.493 | 0.480 |
| 1 | 5 | 176 | 0.504 | 0.534 |
| 1 | 6 | 176 | 0.514 | 0.432 |
| 1 | 7 | 177 | 0.525 | 0.480 |
| 1 | 8 | 176 | 0.537 | 0.602 |
| 1 | 9 | 176 | 0.551 | 0.551 |
| 1 | 10 | 177 | 0.583 | 0.605 |
| 2 | 1 | 170 | 0.418 | 0.394 |
| 2 | 2 | 170 | 0.453 | 0.447 |
| 2 | 3 | 171 | 0.469 | 0.515 |
| 2 | 4 | 170 | 0.482 | 0.476 |
| 2 | 5 | 171 | 0.495 | 0.474 |
| 2 | 6 | 170 | 0.508 | 0.559 |
| 2 | 7 | 170 | 0.522 | 0.482 |
| 2 | 8 | 171 | 0.537 | 0.538 |
| 2 | 9 | 170 | 0.559 | 0.535 |
| 2 | 10 | 171 | 0.595 | 0.614 |
| 3 | 1 | 175 | 0.444 | 0.457 |
| 3 | 2 | 175 | 0.468 | 0.434 |
| 3 | 3 | 175 | 0.482 | 0.509 |
| 3 | 4 | 175 | 0.492 | 0.446 |
| 3 | 5 | 175 | 0.502 | 0.531 |
| 3 | 6 | 175 | 0.510 | 0.549 |
| 3 | 7 | 175 | 0.519 | 0.526 |
| 3 | 8 | 175 | 0.528 | 0.514 |
| 3 | 9 | 175 | 0.541 | 0.509 |
| 3 | 10 | 176 | 0.565 | 0.574 |
| 4 | 1 | 181 | 0.433 | 0.387 |
| 4 | 2 | 181 | 0.457 | 0.530 |
| 4 | 3 | 181 | 0.471 | 0.475 |
| 4 | 4 | 182 | 0.483 | 0.451 |
| 4 | 5 | 181 | 0.494 | 0.508 |
| 4 | 6 | 181 | 0.504 | 0.514 |
| 4 | 7 | 182 | 0.514 | 0.478 |
| 4 | 8 | 181 | 0.525 | 0.541 |
| 4 | 9 | 181 | 0.538 | 0.536 |
| 4 | 10 | 182 | 0.566 | 0.566 |

## 12. Open questions (§12, Appendix B)

| # | open question | answered by | verdict |
|---|---|---|---|
| 1 | Is E[ReactionDisplacement] for WickLevels significantly above random and placebo levels, and monotone in WickStrength? | §2 sets table, contrasts (1)−(4), (1)−(3), monotonicity; reaction.json gate | no — gate FAIL; the pipeline stops (exit 3) |
| 2 | Does "fast" matter: WickLevels vs SlowExtremes? | §2 contrast (1)−(2) | no — "fast/decisive is irrelevant and only extremum matters" |
| 3 | Sign of PriorTouches | §8 byPriorTouches; §11 Stage B β PriorTouches per fold | negative (1+ / 4− of 5 folds; ≥ 75 % needed) |
| 4 | Is HitRate(2,1) above BreakevenHitRate, and is the optimal (TargetMult, StopMult) stable across folds? | §4 target tables and placebo swept levels; §5 HitRate − Breakeven; plateau per fold | no — HitRate − Breakeven -0.453 [-0.492, -0.414] (volume-day block bootstrap); plateau (1.5, 0.75) in 60 % of folds |
| 5 | Should the Target scale with SweepDepth or with VolUnit? | §4 VolUnit-scaled table vs (TargetMult × StopMult) table; conditional table | VolUnit — plateau expectancy -0.43 bps (SweepDepth 1×) vs -0.35 bps (VolUnit 0.5×); VolUnit ahead in 5 of 5 folds (OOS at each fold's train plateaus) — consistent (≥ 75 %) |
| 6 | RestEarly vs ArmOnApproach: does requiring a violent Reclaim pay for the lost trades? | §8 scenario variants (backtest / grid); byReturnSpeed | not run (`wsr backtest --variants armMode` or `wsr grid --variants armMode`) |
| 7 | Does post-entry aggressor imbalance separate winners from losers? | §9 mechanism check | no — CI contains 0 |
| 8 | Latency curve: where does the edge vanish? | §6 latency curve | expectancy ≤ 0 already at 150 ms (only point evaluated; latency sweep not run) |
| 9 | Transfer across venues and symbols? | §5 per (venue, symbol) + runs/compare-*/comparison.md | not answered by a single run — `wsr report --compare <a>,<b>` writes the cross-venue comparison (Spec §6.5) |
