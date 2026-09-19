# Prompt: WSR research plan

You are a senior quantitative researcher specialising in crypto perpetual-futures microstructure. We built an end-to-end research and backtesting system from
./specs/implemenation-spec.md for the Wick-Sweep-Reclaim (WSR) strategy defined in ./specs/strategy.md.
The codebase is the pnpm workspace in this repo (@wsr/core, @wsr/data, @wsr/backtest, @wsr/cli; CLI entry `wsr`).

YOUR TASK
Write the end-to-end research plan that, once executed step by step by a Claude Code coding agent against this codebase,
answers every open question in strategy.md §12 / spec Appendix B and reaches one of exactly three verdicts:
  (a) no edge — stop;
  (b) edge exists only under conditions C (symbol tier / regime / session / setup features) — stated precisely,
      with the conditional numbers that support it and the multiple-testing correction that survived;
  (c) unconditional edge — with the parameter plateau, latency ceiling and venues where it holds.
The plan must be built so that a null result is as informative as a
positive one, and so that a positive result cannot be an artefact of the search itself.

Do NOT execute the research now. Produce the plan. You may run cheap read-only checks to ground it:
`wsr --help`, `wsr <cmd> --help`, `wsr data fetch --dry-run`, reading configs/, README, package scripts, and
the code of the CLI/backtest packages. Do not download data or start replays.

BEFORE WRITING: GROUND THE PLAN IN THE REAL CODEBASE
1. Read both specs fully. Then inspect the implementation and record every place where the implemented CLI,
   config schema, venue adapters, variants (`--variants`), latency sweep, grid, report sections or output files
   differ from the spec. The plan must use commands and flags that actually exist. Anything the plan needs that
   the codebase does not provide goes into a "Tooling gaps" section as a concrete, small change request
   (command, flag, output column) — never as a hand-wave. Note: historical trade data ingestion for all
   venues (Binance, Bybit, OKX, Bitget, Gate, KuCoin) from static file sources (daily/monthly archive files) is
   already implemented; verify it via `wsr data fetch --help` / `--dry-run` rather than filing tickets for it,
   and do not propose REST or websocket ingestion of historical trades.
2. Estimate compute cost per experiment from spec §10 (a 13-month ETHUSDT cell ≈ 5 min/worker; the 1 296-cell
   grid ≈ 7 h on 16 workers) and from the machine actually available (`os.availableParallelism()`, RAM, disk) - see the terraform infrastructure configuration for this, read infra/oci/README.md, also you can also connect to OCI infrastructure to get the needed information.
   The ETHUSDT figure is the spec's benchmark only: ETH and BTC are excluded from the research universe, so
   scale the estimate by each selected symbol's measured event count.
   The plan must be affordable: the expensive grid is run only where cheap tests have earned it.

WHAT THE PLAN MUST CONTAIN

A. Data universe design (the "where to look" half of the edge search)
   The cost floor (strategy.md §7.4, §12.1) is the most likely killer: SweepDepth of a few bps vs a 9–13 bps
   round trip. So the universe must be chosen to span the dimensions that move SweepDepth-in-bps and
   VolUnit-in-bps, not just "the top coins". Specify, with selection rules the agent can compute from data
   (not from opinion):
   - Symbol tiers, each with 4–6 symbols selected by an explicit, reproducible rule
     (e.g. 30-day median USDT volume rank on Binance USDⓈ-M; VolUnit/price in bps; tick/price ratio in bps;
     median trades/minute; funding-rate volatility; listing age). At minimum: majors (BNB, XRP, SOL; BTC and ETH are excluded), large liquid alts, mid-caps,
     low-cap/high-VolUnit perps where the cost floor is loose, and a recently-listed-perp tier.
     Include one or two symbols where tick size is coarse relative to price (tick/price ≥ 1 bp) because
     PivotReversal, MinSweepDepth and SpreadEst all floor on ticks there.
   - Exclusion: BTC and ETH (every quote/contract variant, on every venue) are excluded from the research
     universe because of their data size. They are not selected into any tier, do not appear in the data
     manifest or in any config, and all volume/rank-based selection rules are computed after removing them.
   - Venues: Binance, Bybit, OKX, Bitget, Gate, KuCoin. All historical trade data
     for every venue comes exclusively from static file archives — never from REST or websockets. State exactly
     which (venue, symbol, span) triples are feasible given each venue's static-archive coverage (listing dates,
     missing days, file granularity), and which are dropped.
   - Date ranges: ≥ 12 months ending at the run date for every primary run (spec §9.3, walk-forward needs
     ≥ 12 folds), plus a longer multi-year window on two Binance symbols from the large-liquid-alts tier
     (the two with the longest listing age, ties broken by 30-day volume rank) for regime diversity and
     edge-decay-over-time analysis. Define the warm-up (WarmupDays + 7) explicitly in every `--from`.
   - Regime labelling, computed from the data, not from market narrative: partition every span into
     volume-days labelled by (i) realised-vol quantile of RVol, (ii) TrendEfficiency tercile (trend-up /
     range / trend-down), (iii) burst density (§8.7), (iv) session (UTC hour blocks / weekday vs weekend),
     (v) distance to funding settlement, (vi) funding-rate sign and magnitude. Each label must be available as
     a per-trade and per-approach-event column so every result can be sliced by it. If the report does not
     emit these columns, that is a Tooling gap.
   - Data hygiene acceptance: what coverage/suspect-partition thresholds a (venue, symbol, span) must meet
     before it is admitted to any test, and how blacklisted buckets are counted in the reaction test denominator.
     Gaps in the static archives are recorded as coverage gaps and are never back-filled via REST or websockets.
   - A data manifest: table of every (venue, symbol, from, to, tier, purpose) with expected event counts and
     disk, and the exact `wsr data fetch` commands (static-archive downloads only).

B. Hypothesis register (the "what to test, in what order" half)
   Every hypothesis as a row: id, statement, the metric that answers it, the pre-registered pass/fail threshold
   with CI rule, the command/config that produces it, its dependencies, and what happens on FAIL (stop, or
   branch to which alternative). Fix thresholds before any data is seen. Order them so the cheapest,
   most-likely-to-kill tests run first. Required content, in this order:
   H0  Harness sanity: synthetic driftless HitRate(2,1) ≈ 1/3, reaction gate FAILS on noise, determinism
       (byte-identical rerun), look-ahead property tests green. Nothing else runs until H0 passes.
   H1  Cost-floor feasibility, per symbol tier, BEFORE any P&L: distribution of SweepDepth/price and
       VolUnit/price in bps vs RoundTripCost; share of Spikes where the 2·RoundTripCost floor binds;
       BreakevenHitRate distribution; expected trades/day after the floor. Pre-declare the tier-level cut:
       symbols whose median BreakevenHitRate exceeds a stated value are demoted to reaction-test-only.
   H2  Level existence (reaction test §9.2): (1)−(4) > 0, significant, monotone in WickStrength, per
       (venue, symbol). This is the pipeline gate; also report it per regime label to see where levels react.
   H3  Does "fast" matter: (1)−(2) contrast. Branch: if not, treat SlowExtremes as tradable candidates in a
       diagnostic run and note that the Spike gates G1–G6 are pure trade-count filters.
   H4  Placebo geometry: (1)−(3), and swept-placebo HitRate(2,1) vs actual setups — is it the level or the sweep
       geometry doing the work?
   H5  Mechanism: post-reclaim aggressor imbalance separates winners from losers (sign = reclaim direction,
       CI excludes 0). A P&L edge without a mechanism is treated as suspect, not as a result.
   H6  Trade-level edge: HitRate(2,1) − BreakevenHitRate > 0 pooled OOS with CI; plateau (TargetMult, StopMult)
       stable in ≥ 75 % of folds; SweepDepth-scaled vs VolUnit-scaled target; two-stage exit; conservative vs
       optimistic Target fill (report both, decide on conservative).
   H7  Conditioning — where the edge concentrates. Pre-declare the conditioning dimensions and the ONLY slices
       allowed: WickStrength decile, SweepDepth/VolUnit bin, regime (trend/range × vol quantile), session,
       SweepCount, PriorTouches, ReturnSpeed bin, burst proximity, funding proximity, symbol tier, venue.
       State the multiple-testing rule for the slice search (number of slices, Bonferroni/BH or the
       reality-check p-value from the harness) and the minimum trades per slice. A slice edge counts only if it
       (i) survives the correction, (ii) holds in the same direction in ≥ 75 % of walk-forward folds,
       (iii) holds on at least one transfer venue, (iv) has a mechanism story that H5 supports in that slice.
   H8  Entry mechanism: RestEarly vs ArmOnApproach on total OOS P&L (not per-trade), with skippedSlowReclaim
       accounted; TriggerOffset variant; TimeStop on/off; counter-trend block; wall-clock vs volume ageing.
   H9  Execution robustness: latency curve {0, 50, 150, 500} ms — the plan must state the ceiling (edge must
       survive 150 ms to be tradable from cloud); slippage ×{1,2,4}; touch-and-reverse and touch-and-fly shares;
       burst-window fills; how often the liquidity cap and MaxPending bind.
   H10 Stability: edge by calendar quarter / year on the long Binance window (decay test); parameter plateau
       agreement across folds; sensitivity tables for every `sensitivity` parameter; DSR and reality-check p
       reported with N_configs.
   H11 Transfer: sign and plateau agreement across venues and symbols; symbol-level results pooled with
       explicit shrinkage toward the tier mean, never naive pooling across symbols.
   H12 Follow-ups if H2 passes but H6 fails: the limit-at-level "bounce" hypothesis (strategy.md §12.2) and
       WickStrength Stage B as a pure level-quality model — listed as next-project candidates, out of scope
       for this codebase, with what would need to change.

C. Execution phases
   Group the hypotheses into phases with hard go/no-go gates between them. For each phase give: goal,
   inputs, the exact commands and config files (write the config JSONs the phase needs under
   configs/research/, one per experiment, each with a comment field naming the hypothesis it serves), outputs
   and where they land under runs/, the decision rule, estimated wall-clock and disk, and what is skipped
   downstream on FAIL. Expected shape:
     Phase 0  harness sanity + data download + hygiene admission (H0, data manifest)
     Phase 1  cost-floor screen across the whole universe (H1) — cheap, decides who gets P&L at all
     Phase 2  reaction tests across the whole admitted universe (H2–H4), by regime label
     Phase 3  default-config P&L + target validation + mechanism on every symbol that passed the gate (H5–H6)
     Phase 4  variants, latency, slippage on the survivors (H8–H9)
     Phase 5  full grid + walk-forward only on the best 2–3 (venue, symbol) survivors (H6, H10)
     Phase 6  conditioning search with the pre-registered slices and correction (H7)
     Phase 7  transfer, decay, and the final verdict (H10–H11)
   Every phase ends with a short written memo (runs/<runId>/MEMO.md) that records the numbers, the verdict
   against the pre-registered threshold, and any deviation from the plan with its reason.

D. Anti-fooling rules (binding on the executing agent)
   - Thresholds and slices are fixed in the plan; the agent may not add slices, widen grids, or move
     thresholds after seeing results. New ideas go into a "post-hoc observations" appendix, flagged as
     exploratory, and are not counted in the verdict.
   - `--force-pnl` only for diagnostics, never for verdicts; forced runs are labelled everywhere.
   - Optimised degrees of freedom stay ≤ 6 (the spec's grid); every additional configuration evaluated
     increments N_configs and the DSR/reality-check inputs.
   - Never change strategy logic, gates, cost assumptions or the conservative execution choices (touch-and-
     reverse must fill, conservative Target fill, cost floor) to improve a number. If the agent believes a
     spec rule is a bug, it files it as a finding with a failing test, not as a silent patch.
   - Report every HitRate next to HitRate_0 and BreakevenHitRate; report only net-of-cost expectancy.
   - Levels that were INVALIDATED/EXPIRED/RETIRED stay in the reaction-test denominator (level survivorship).
   - Venues and symbols are never mixed in one engine run.
   - Fees marked [VERIFY] must be verified against the venue's current schedule before Phase 3; the plan
     lists the exact endpoints/pages to check.

E. Deliverables you produce now
   1. ./specs/research-plan.md — the plan (sections A–D above, plus the compute budget and the data manifest).
   2. ./specs/hypothesis-register.md — the H0–H12 table, one row per hypothesis, thresholds fixed.
   3. ./configs/research/*.json — one validated config per experiment (run `wsr` config validation on each).
   4. ./research/data-manifest.json — every (venue, symbol, from, to, tier, purpose) with fetch commands.
   5. ./specs/tooling-gaps.md — every capability the plan needs that the codebase lacks, as small tickets
      with the spec section they extend (e.g. regime-label columns in trades.parquet, a symbol-screening
      command, a cross-symbol comparison report, quarter-by-quarter breakdown).
   6. A final "Verdict template" section in the plan: the exact table the last phase fills in, with one row per
      Appendix B question plus rows for H1, H7, H10, so that the answer to "where is the edge, or is there
      none" is a filled template, not an essay.

Style: concrete over general. Every claim in the plan should be executable (a command, a config, a threshold)
or checkable (a citation to strategy.md §x / spec §y). Prefer tables. Where you must assume something about
the market or the data (event counts, regime prevalence), mark it ASSUMPTION and add the Phase-0 check that
replaces the assumption with a measurement. Do not pad; if a section has nothing to say, say so in one line.