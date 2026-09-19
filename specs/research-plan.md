# WSR research plan — from `wsr` CLI to a three-way verdict

Written 2026-09-19 against commit `85834fa` (`feat(infra): OCI Terraform for the WSR research VM`).
Executed by a Claude Code agent on the OCI VM (`infra/oci/README.md`) inside `tmux`, from
`~/wick-sweep-reclaim`, with `data/` and `runs/` symlinked to `/mnt/wsr` by `wsr-bootstrap`.
Nothing in this document has been executed; every number marked **ASSUMPTION** carries the Phase-0
step that replaces it with a measurement.

Companion files: `specs/hypothesis-register.md` (H0–H12, thresholds), `specs/tooling-gaps.md`
(G1–G10), `configs/research/*.json` + `configs/research/README.md` (one config per experiment),
`research/data-manifest.json` (+ `research/build-manifest.mjs`, its generator).

Citation keys: **S:n** = `specs/strategy.md` line n, **I:n** = `specs/implemenation-spec.md` line n,
**code** = path under `packages/`. `CLI` = `node packages/cli/dist/main.js` (the `wsr` bin exists
only through `pnpm link`; the VM uses the path form). Global flags: `--data-root` (default `./data`,
symlinked; `WSR_DATA_ROOT` is set on the VM but the CLI does not read it — pass nothing and rely on
the symlink), `--config`, `--log-level`, `--json`.

Verdict definitions (prompt): **(a)** no edge — stop; **(b)** edge only under conditions C (tier /
regime / session / setup feature / venue), stated with the numbers and the multiple-testing
correction that survived; **(c)** unconditional edge — with plateau, latency ceiling and venues.

---

## §0 Codebase-vs-spec deviations that shape the plan

Read before anything else. Every row is a fact checked in the code on 2026-09-19.

| # | Spec / prompt wants | Codebase has | Effect on the plan |
|---|---|---|---|
| 0.1 | `wsr run`, `wsr config validate`, a screening command, `wsr data status` | Commands are exactly `data {fetch,merge,hygiene,meta,verify}`, `reaction`, `backtest`, `grid`, `report`, `bench` (`cli/src/program.ts`) | Screening = Tooling gap **G1** (manual steps in Phase 0). Config validation = `node -e` with `parseRunConfig` (`core/src/config.ts:181`), **G2**. |
| 0.2 | Config with a `comment` field per experiment (prompt §C) | `RunConfigSchema` is `.strict()`; no comment key; `fees` (six venues, `verifiedAt`) and `data.lowCapSymbol` are required (`core/src/config.ts`) | `configs/research/README.md` is the comment surrogate (**G2**). |
| 0.3 | `TriggerOffset` as a scenario variant | `--variants` accepts only `armMode,timeStop,counterTrendBlock,targetMode,ageClock` (`backtest/src/grid-space.ts:104`); `TriggerOffset` is a config key (0–2) | TriggerOffset 1/2 are separate configs (`p4-h8-triggeroffset{1,2}.json`) and separate runs; each needs `--run-reaction` (row 0.5). |
| 0.4 | Reaction test reused by the P&L backtest | `backtest`/`grid` refuse without a stored `reaction.json` matching (venue, symbol, span, `gateConfigHash`, B) unless `--run-reaction` / `--force-pnl` (`program.ts` `storedReactionFor`, `backtest/src/reaction-run.ts:126–140`) | Phase 2 uses `p2-h2-reaction.json` whose gate keys equal `p3-h6-baseline.json`; Phase-3 backtests reuse Phase-2 `reaction.json` automatically (search over `runs/*/reaction.json` by directory name). |
| 0.5 | — | `gateConfigHash` excludes only `data, minStrengthPassRate, search, stageB` (`core/src/config.ts:173`) | Any config that touches another key (`strengthModel`, `TriggerOffset`, `blacklistFunding`, `ArmMode`, `latencyMs`, `fees`, `seed` …) has a new gate hash ⇒ its own reaction replay (`--run-reaction`). `--variants`, `--latency-sweep`, `--slippage-sweep` are applied inside one run and share the run's gate. |
| 0.6 | Regime labels per trade and per approach event: vol quantile, TE tercile, burst density, session, funding distance, funding sign | `TradeRecord` has `regime` (4 labels from TE ≥ 0.4 / < 0.2, `backtest/src/regime.ts`), `hourOfDay`, `burst`, `decile`, `fundingAccrued_bps`, `SweepCount`, `PriorTouches`, `ReturnSpeed`, `postEntryImbalance2`, `TrendEfficiency`, `BreakevenHitRate` (`backtest/src/trade-record.ts:20–45`). `reaction.json` is aggregate only. | Missing columns = **G4** (trade) and **G3** (approach event). H7 runs on the 50 slices computable now; the 18 G4 slices are "not tested" until G4 lands (register H7). |
| 0.7 | Quarter-by-quarter decay, cross-symbol shrinkage, slice search with BH | Not present (`fold-metrics.ts` breakdowns are decile / sweep-depth bin / regime / hour / SweepCount / PriorTouches / ReturnSpeed) | **G5**, **G6**; documented arithmetic over `trades.jsonl` + `folds.json` meanwhile (Phase 6, Phase 7). |
| 0.8 | Cost-floor screen before P&L (H1) | Cost floor appears only in report §3 of a P&L run (`backtest/src/cost-floor.ts`) and in `levels.parquet.minSweepFloorBinding` | **G9**; H1a proxy from the static screen + fees, H1b from Phase-3 reports (register H1). |
| 0.9 | Walk-forward ≥ 12 folds | 56/14/14 calendar days, `MIN_FOLDS = 12` ⇒ span ≥ 224 days or `ReplayInputError` (`backtest/src/walk-forward.ts:11–48`); hidden `--folds` waives it (diagnostic only) | Primary span 366 days ⇒ 23 folds. T5 floor of 250 days ⇒ ≥ 12 folds. Never use `--folds` for a verdict run. |
| 0.10 | Grid one venue at a time | `wsr grid` rejects a venue list (`program.ts` "one venue at a time"); `--run-id` resumes; hidden `--min-trades-train` (100), `--bootstrap` | Phase 5 grids are Binance only; resume after burst reboot with `--run-id`. |
| 0.11 | `N_configs` | `backtest`: `nConfigs = {cells: 1, variants, latencyPoints}`; with the full variant list 8 variants × 4 latency points = 32. `grid`: cells × variants × 1 latency point (`grid-space.ts:158`); DSR `N` = that (`grid-run.ts`) | Every run's `nConfigs.N` is copied into `runs/INDEX.md` (**G10**); the verdict reports the sum per symbol. |
| 0.12 | Fees verified | Config `fees.*.verifiedAt = 2026-09-19`, `FEES_VERIFIED_AT = '2026-09-19'` (`data/src/venues/common.ts:65`); `[VERIFY]` remain for funding interval (Binance default 8 h, `binance.ts:10–12`), Gate signed-size aggressor (`gate.ts:9`), funding sign convention | Phase 0 P0.9 checklist with the exact pages/endpoints. |
| 0.13 | Listing dates per venue | No table; `wsr data fetch --dry-run` HEAD-probes every day and prints `planned` / `unavailable` per partition (`program.ts` fetch action, `pipeline.ts`) | The dry-run **is** the feasibility oracle (§A.4). |
| 0.14 | Run directory named by the agent | `runId` = 16 hex of sha256(venue\|symbol\|from\|to\|configHash\|seed) (`docs/determinism.md`); reruns overwrite the same directory | `runs/INDEX.md` ledger maps runId → phase / hypothesis / config file (**G10**). Identical config files (`p2`, `p3-baseline`, `p7`) give identical runIds for the same inputs: the backtest writes into the reaction run's directory (a superset of files). |
| 0.15 | `wsr bench` baseline | `benchmarks/baseline.json` is an M3 Pro number (2.19 M ev/s); `pnpm bench` exits 2 below 80 % of it | On the A1 VM `pnpm bench` exits 2 by design; record the number, do not treat it as H0. |
| 0.16 | Synthetic acceptance reads the config | `--synthetic driftless` ignores `--config` (`program.ts` `runSynthetic`) | `p0-h0-synthetic.json` exists for the ledger only. |
| 0.17 | Determinism check by hashing outputs | `run.json` / `reaction.json` embed `runManifest.{createdAt, gitCommit, wsrVersion}` (`docs/determinism.md`) | Hash after `jq 'del(.runManifest.createdAt,.runManifest.gitCommit,.runManifest.wsrVersion)'`. |

---

## §A Data universe design

### A.1 Screening source (pre-registered, static files only)

Run date **D = 2026-09-19**. All inputs are static Binance USDⓈ-M archives plus one metadata endpoint;
no REST or websocket trade ingestion anywhere (prompt §A).

| Quantity | Source (static) | Definition |
|---|---|---|
| Symbol enumeration, listing day | S3 listing `https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/daily/trades/` (paginate with `marker`), then per symbol the first key under `…/daily/trades/{S}/` | `listedOn` = date of the first daily trades archive; `ageDays = D − listedOn` |
| 30-day quote volume, trades/min, close | Daily 1d klines `https://data.binance.vision/data/futures/um/daily/klines/{S}/1d/{S}-1d-{YYYY-MM-DD}.zip` for the 30 complete UTC days 2026-08-20 … 2026-09-18 (columns `open_time,open,high,low,close,volume,close_time,quote_volume,count,…`) | `quoteVol30d` = median of `quote_volume`; `tpm` = median of `count / 1440`; `price` = median close |
| VolUnit proxy (bps) | Daily 1m klines `…/daily/klines/{S}/1m/{S}-1m-{YYYY-MM-DD}.zip`, same 30 days | `volUnitBps` = median over days of [median over the day's 1-min bars of `(high − low) / close × 1e4`] (S §2.3 VolUnit is a range statistic; this is its 1-minute proxy) |
| Tick / price (bps) | `GET https://fapi.binance.com/fapi/v1/exchangeInfo` (the endpoint `wsr data meta` already uses, `data/src/venues/binance.ts:9`): `PRICE_FILTER.tickSize`, `contractType = PERPETUAL`, `quoteAsset = USDT`, `status = TRADING` | `tickBps = tickSize / price × 1e4` |
| Funding-rate volatility | Monthly funding archive `…/monthly/fundingRate/{S}/{S}-fundingRate-2026-08.zip` (last complete month) | `fundingStd30d` = std of `last_funding_rate` (descriptive; used only as a tie-break column) |

Output: `research/universe.json` with rows `{symbol, listedOn, ageDays, quoteVol30d, rank, tpm,
price, volUnitBps, tickBps, fundingStd30d, tier}` (schema in `specs/tooling-gaps.md` G1). Until G1
exists the agent writes `research/screen-universe.mjs` in Phase 0 P0.3 implementing exactly the table
above and commits nothing else (research artefact, not a codebase change).

### A.2 Exclusion (applied before any ranking)

Base assets `BTC` and `ETH` and any base **starting with** `BTC` or `ETH` (`BTCDOM`, `ETHW`, `ETHFI`, …;
regex `^(BTC|ETH)` on the base) are removed from the symbol list before ranks are computed. They never
appear in a tier, in `research/data-manifest.json`, in any `configs/research/*.json`, or in any
command of this plan, on any venue. `configs/default.json`'s own default symbol list mentions them
only in the CLI help text of `--symbol`; every command in this plan passes `--symbol` explicitly.

### A.3 Tiers (rules only; each rule yields 4–6 symbols)

Admission floor for every tier: `tpm ≥ 10` (median trades/min over the 30 days) and `ageDays ≥ 410`
(395-day primary span incl. warm-up + 15 days slack), except T5. Rank = descending `quoteVol30d`
after exclusion. "Quantile positions {min, p25, p50, p75, max}" = the symbols whose `volUnitBps` is
the minimum, nearest-rank 25th, 50th, 75th percentile and maximum within the rank window (ties →
lower rank number), so each tier spans the VolUnit-in-bps dimension that drives the cost floor.

| Tier | Rule | Count | Why |
|---|---|---|---|
| T1 majors | `{BNBUSDT, XRPUSDT, SOLUSDT}` ∪ next symbols by rank until 5 | 5 | prompt minimum; tight VolUnit ⇒ cost floor binds hardest |
| T2 large liquid alts | ranks 6–25, quantile positions of `volUnitBps` | 5 | liquid enough for the fill model, spread of VolUnit |
| T3 mid-caps | ranks 26–75, quantile positions of `volUnitBps` | 5 | mid VolUnit, thinner prints |
| T4 low-cap / high-VolUnit | ranks 76–200 ∧ `tpm ≥ 10`, top 5 by `volUnitBps` | 5 | where the floor is loosest; T4 #1 → `data.lowCapSymbol` |
| T5 recent listings | `ageDays ∈ [250, 410)` ∧ `tpm ≥ 10`, top 4 by `quoteVol30d` | 4 | listing-regime diversity; span = `listedOn + 15 d → 2026-09-18` (span ≥ 235 days ⇒ folds = ⌊(235 − 70)/14⌋ + 1 = 12 ≥ `MIN_FOLDS`; the 250-day floor keeps that true when the first archive days are missing) |
| T6 coarse tick | `tickBps ≥ 1`, top 2 by `quoteVol30d`; may duplicate a T1–T4 symbol (labelled `T6+Tx`, fetched once) | 2 | PivotReversal, MinSweepDepth, SpreadEst all floor on ticks (prompt §A) |

Universe ≈ 24–26 symbols. Phase 0 P0.3 records the ranked table; the agent may not swap a symbol
by hand — a symbol that fails hygiene admission (A.6) is replaced by the **next symbol by the same
rule** (next rank / next quantile neighbour), recorded in the manifest as `replacedBy`.

**Long window**: the two T2 symbols with the greatest `ageDays` (tie → lower rank), Binance only,
run span 2022-01-01 → 2026-09-18 (fetch from 2021-12-17). Purpose: regime diversity and decay
(H10 vi).

### A.4 Venues and feasibility

Venues: `binance, bybit, okx, bitget, gate, kucoin` (`data/src/venues/index.ts`, also the default
`--venue` order). Archive facts that decide feasibility (`data/src/venues/*.ts` header comments):

| Venue | Archive | Granularity | Feasibility notes |
|---|---|---|---|
| binance | `data.binance.vision/data/futures/um/daily/trades/{S}/{S}-trades-{D}.zip` + `.CHECKSUM` | daily, UTC | checksum verified; hygiene `checksumFailed` ⇒ partition excluded |
| bybit | `public.bybit.com/trading/{S}/{S}{D}.csv.gz` | daily, UTC | no checksum; early files may lack a header |
| okx | `static.okx.com/cdn/okex/traderecords/trades/daily/{YYYYMMDD}/{S}-SWAP-trades-{D}.zip` | daily, **UTC+8** | one UTC day needs files D and D+1 ⇒ the last requested day needs D+1 published; `--to 2026-09-18` needs the 2026-09-19 file |
| bitget | `img.bitgetimg.com/online/trades/UMCBL/{S}/{YYYYMMDD}_{NNN}.zip` | daily parts, **UTC+8** | part count unpublished (probe until 403); same D/D+1 rule |
| gate | `download.gatedata.org/futures_usdt/trades/{YYYYMM}/{S}-{YYYYMM}.csv.gz` | **monthly**, published after month end; ~140 MB gz for the benchmark symbol | September 2026 is not available until October ⇒ Gate spans end 2026-08-31 in practice; the dry-run shows every September day `unavailable`; the 95 % rule below tolerates it (18/381 = 4.7 %) — but the missing tail is a **coverage gap, never back-filled**; funding history only 180 days back (`fundingMissing` listed) |
| kucoin | `historical-data.kucoin.com/data/futures/daily/trades/{S}M/{S}M-trades-{D}.zip` | daily, UTC | size in contracts (× multiplier) |

There is no listing-date table per venue; **the feasibility oracle is `wsr data fetch --dry-run`**
(`planned` / `unavailable` per partition, no download).

**MEASURED on the VM, 2026-09-19** (`--dry-run --json`, BNBUSDT / XRPUSDT / SOLUSDT, fetch span
2025-09-03 → 2026-09-18; the three symbols gave identical results, so this is publication lag, not
symbol coverage; logs `/mnt/wsr/logs/dryrun-*.jsonl`):

| Venue | planned / 381 | unavailable days | Pre-registered consequence |
|---|---|---|---|
| binance, bybit, kucoin | 381 | none | run `--to 2026-09-18` |
| okx | 380 | 2026-09-18 (needs the D+1 file) | run `--to 2026-09-17` |
| gate | 363 | 2026-09-01 … 09-18 (monthly archive) | run `--to 2026-08-31` |
| bitget | 348 | 2026-08-17 … 09-18 (33 days, ≈ 33-day lag) | run `--to 2026-08-16` |

Rule (fixed now, before any download): a venue's run span ends on its **last published day**
(`research/data-manifest.json.venueTo`; generator constant `VENUE_TO`), so a publication lag is not a
coverage gap. Runs on lagging venues therefore have shorter spans (bitget 333 days ⇒ 19 folds) and a
different `reactionKey`; cross-venue comparisons are labelled with each venue's span. The feasibility
rule below is then applied in Phase 0 P0.6 to every (venue, symbol) of the manifest over its own fetch
span; `unavailable` days **after** `venueTo` are ignored by construction:

- keep the triple iff `planned ≥ 0.95 × requested days` **and** no run of ≥ 7 consecutive `unavailable` days
  inside the run span (warm-up days before `--from` may be unavailable: the replay then starts its warm-up
  at the first present day, `reaction-run.ts` warning "warm-up ran into the span" ⇒ the run is still
  admitted only if the first fold's train window starts after the first present day);
- otherwise drop the triple; `research/data-manifest.json` row gets `feasibility: "dropped"` and `reason`.
- Binance is the primary venue: a symbol whose Binance triple is dropped is replaced by the next symbol
  of its rule (A.3). Other venues drop only the triple.
- Dropped triples are recorded as coverage gaps; no REST/websocket back-fill exists in the codebase
  and none is added.

### A.5 Date ranges and warm-up

`WarmupDays = 8` (Spec §3.2.4; the replay reads it before `--from`, `program.ts` help text), plus 7
days slack for archive holes at the start ⇒ **fetch `--from` = run `--from` − 15 days**.

| Purpose | Run span (`--from`/`--to` of reaction/backtest/grid) | Fetch span (`wsr data fetch`) | Folds (56/14/14) |
|---|---|---|---|
| primary (all tiers except T5) | 2025-09-18 → 2026-09-18 (366 days) | 2025-09-03 → 2026-09-18 (381 days) | 23 |
| T5 | `listedOn + 15 d` → 2026-09-18 | `listedOn` → 2026-09-18 | ≥ 12 (A.3 floor) |
| long window (2 × T2, Binance) | 2022-01-01 → 2026-09-18 (1 722 days) | 2021-12-17 → 2026-09-18 (1 737 days) | 119 |
| H0 determinism / bench spans | 2026-07-01 → 2026-08-31 (reaction only; no fold requirement) | inside the primary fetch | — |
| venue end dates (A.4, measured) | okx `--to 2026-09-17`, gate `--to 2026-08-31`, bitget `--to 2026-08-16`; others 2026-09-18 | same `--to` | okx 23, gate 22, bitget 19 |

`--to 2026-09-18` = yesterday UTC at D (the CLI default) — fixed here so a run started on a later
day is byte-comparable.

### A.6 Regime labels (computed from data, per trade and per approach event)

| Label | Definition (pre-registered bins) | Per trade today | Per approach event today |
|---|---|---|---|
| (i) realised-vol quantile | RVol_60 of the volume-day (Spec §3.2.6) vs the trailing 30 volume-days; terciles 1–3 | **G4** `volQuantile` | **G3** |
| (ii) TrendEfficiency tercile | `regime` ∈ {trend_aligned, trend_counter, neutral, range} (`backtest/src/regime.ts`, TE ≥ 0.4 trend, < 0.2 range; side-relative) — present; absolute-direction tercile of `TrendEfficiency` vs trailing 30 volume-days | `regime` ✔, `TrendEfficiency` ✔ (tercile = G4 `teTercile`) | G3 |
| (iii) burst density | `burst` (entry inside a burst window, S §8.7) — present; share of burst buckets in the volume-day, terciles | `burst` ✔; density = G4 `burstDensityDay` | G3 |
| (iv) session | `hourOfDay` (UTC) — present, binned 00–04, 04–08, 08–12, 12–16, 16–20, 20–24; weekday/weekend | `hourOfDay` ✔; `weekday` = G4 | G3 |
| (v) distance to funding | minutes to the next settlement on the venue's `fundingIntervalHours` grid (`instrument_history.json`); bins ≤ 30 min / > 30 min | G4 `minutesToFunding` | G3 |
| (vi) funding sign / size | last settled rate at entry: sign; \|rate\| terciles | G4 `fundingRateAtEntry` (`fundingAccrued_bps` ✔ is the realised accrual, not the label) | G3 |

Until G3/G4 land, H2 per regime is reported at the trade level only (Phase 3 `byRegime`, `byHour`)
and the G4 slices of H7 are "not tested" (register H7).

### A.7 Hygiene admission and the reaction-test denominator

Hygiene per partition (`data/src/hygiene.ts`, I §2.6.1): `suspect` = checksum failed ∨ non-monotone
timestamps > 0.1 % of raw rows; gap ≥ max(60 s, 20 × median inter-print gap) ⇒ blacklist interval
(+ 60 s pad); bad prints ⇒ ± 1 s blacklist; a day without `.done` = whole-day blacklist (I §2.6.3).
`wsr data hygiene --summary` prints per (venue, symbol): `daysRequested, daysPresent, daysSuspect,
blacklistedMinutes`.

Admission of a (venue, symbol, span) to **any** test — checked in Phase 0 P0.8 and written into the manifest:

| Check | Threshold | Source |
|---|---|---|
| coverage | `daysPresent / daysRequested ≥ 0.95` over the **run span** (warm-up days excluded from the ratio) | coverage table |
| suspect | `daysSuspect ≤ 0.02 × daysPresent` | coverage table |
| blacklist | `blacklistedMinutes ≤ 0.03 × daysPresent × 1440` | coverage table |
| holes | no ≥ 7 consecutive missing days inside the run span | `--json` partition lines (`skipped`/`done` vs `unavailable`) |
| integrity | `wsr data verify` reports 0 mismatches | exit code 0 (4 = fail) |

Failing Binance ⇒ the symbol is replaced (A.3); failing another venue ⇒ that triple only.

**Denominator rule for the reaction test** (S §9.2, prompt §D "level survivorship"): set (1) is built
from the `PivotStore` (every gated pivot, `reaction-run.ts` comment "set membership does not depend on
MinStrength… L9"), so WickLevels that were later INVALIDATED / EXPIRED / RETIRED in the trading pass
are in the denominator by construction. Blacklisted buckets are skipped by the replay (I §2.6.3), so
an approach cannot occur inside one; such levels stay in `sets.wick.n` as `notApproached` / `pending`.
The sample of every statistic is `approached ∧ complete` (`reaction.ts` `reactionStats`). Every
Phase-2 memo reports per run: `sets.wick.{n, approached, complete, unresolvedShare}`,
`blacklistedBuckets / totalBuckets`, `randomClipped`, and the Phase-0 consistency check
`sets.wick.n ≥ distinct pivotId count in levels.parquet` of the matching Phase-3 run (levels are a
subset of gated pivots; a violation is a bug finding).

### A.8 Disk and compute assumptions (Phase 0 replaces every one)

| Quantity | ASSUMPTION | Replaced by |
|---|---|---|
| benchmark-symbol Binance day (S:260) | 1.05 M merged events, 37 MB raw + merged Parquet | P0.7: `du -sh data/binance/<T1#1>` after the first fetch ÷ days, scaled by the dry-run day counts |
| symbol scale vs the Spec §10 benchmark symbol | T1 0.35, T2 0.15, T3 0.06, T4 0.03, T5 0.05, T6 0.05 | P0.7 per-symbol `du` and `mergeStats.rowsMerged` from hygiene reports |
| other venues vs Binance (same symbol) | bybit 0.45, okx 0.35, bitget 0.25, gate 0.15, kucoin 0.15 (Σ 1.35) | P0.8 `du` per venue |
| universe disk | ≈ 120 GB all venues, ≈ 62 GB Binance only, long window ≈ 19 GB (`research/data-manifest.json.totals`) | P0.7/P0.8 |
| end-to-end throughput on A1 (4 OCPU) | 0.4 M events/s per worker (core loop measured 0.65–0.71 M/s on A1 vs 2.19 M/s M3 Pro; Parquet decode + bootstrap overhead) | P0.10 `wsr bench --venue binance --symbol <T1#1> …` |
| memory per worker | < 1.5 GB (I:1419); 15 workers × 1.5 GB = 22.5 GB of 64 GB at burst | P0.10 RSS from the bench log |

**Trim rule** (pre-registered; user decision: fetch all six venues up front, trim only by rule): after
P0.6/P0.7, project the total for all admitted triples. If > 350 GB (of 492 GB on `/mnt/wsr`, 16 GB swap
excluded, ≥ 100 GB headroom for `runs/` and the transient download cache), drop venues for T3–T6 in the
order `kucoin, bitget, gate, okx` until ≤ 350 GB. T1–T2 keep all six venues. Dropped triples are
recorded (`feasibility: "trimmed"`). Never `--keep-cache`. `wsr data prune-raw` = **G8** (not needed
unless the rule triggers twice).

### A.9 Data manifest

`research/data-manifest.json` (generated by `research/build-manifest.mjs`; 158 triples at writing:
26 symbols × 6 venues + 2 long-window rows). One row per triple: `venue, symbol, tier, purpose, from,
to, fetchFrom, fetchDays, expectedEvents, expectedGB, feasibility, dryRun, fetch`. Symbols other than
BNB/XRP/SOL are placeholders `T2#1 …` (they contain `#`, so no `wsr` command can accept them) with a
`resolvedBy` rule; Phase 0 P0.3 writes `research/universe.json` and P0.4 reruns the generator.

Fetch command template (one per triple; `--concurrency 2` = the default, stated for the ledger):

```sh
node packages/cli/dist/main.js data fetch --venue binance --symbol BNBUSDT --from 2025-09-03 --to 2026-09-18 --concurrency 2
node packages/cli/dist/main.js data fetch --dry-run --venue binance --symbol BNBUSDT --from 2025-09-03 --to 2026-09-18
```

Summary of the manifest at writing (ASSUMPTION numbers, A.8):

| Purpose | Triples | Events (all venues) | GB (all venues) | GB (Binance only) |
|---|---|---|---|---|
| primary, T1–T6 | 156 | ≈ 2.9 G | ≈ 101 | ≈ 43 |
| long window | 2 | ≈ 0.55 G | ≈ 19 | ≈ 19 |
| **total** | **158** | **≈ 3.4 G** | **≈ 120** | **≈ 62** |

---

## §B Hypothesis register

The full table (id, statement, metric and file/field, threshold + CI rule, command/config, depends
on, on FAIL) is `specs/hypothesis-register.md`. Summary:

| Id | One line | Phase | Kill? |
|---|---|---|---|
| H0 | tests green, synthetic exit 3 within 3σ, byte-identical rerun | 0 | yes — stop |
| H1 | cost floor: `floorRatio = 4·RTC/VU ≤ 4` ⇒ P&L-eligible; measured p50 BreakevenHitRate ≤ 0.55 | 1 (3) | all demoted ⇒ (a) |
| H2 | reaction gate pass ∧ approached ≥ 500, per (venue, symbol) | 2 | all fail ⇒ (a) |
| H3 | (1)−(2) CI excludes 0 (informational) | 2 | no |
| H4 | (1)−(3) CI excludes 0; actual − placebo-swept HitRate ≥ 0.03 | 2, 3 | demotes |
| H5 | mechanism diff > 0, CI excludes 0 | 3 | labels H6 suspect |
| H6 | HitRate − Breakeven CI-lower > 0, expectancy > 0 conservative, plateau ≥ 75 % folds, ≥ 200 trades | 3, 5 | all fail ⇒ (a)/H12 |
| H7 | 68 pre-registered slices, BH q = 0.10, ≥ 200 trades, ≥ 75 % folds, transfer venue, in-slice H5 | 6 | no |
| H8 | variant adopted only if total OOS pnl_R higher and higher in ≥ 75 % folds | 4 | no |
| H9 | 150 ms CI-lower > 0 and slippage ×2 > 0; ceiling reported; 0.30 flags | 4 | limits (c) |
| H10 | DSR ≥ 0.95, RC p ≤ 0.05, 21 sensitivity signs, plateau within one step in ≥ 75 % folds, from-grid OOS, decay | 5, 7 | limits (c) |
| H11 | comparison `yes` on ≥ 1 venue, sign agreement with a same-tier symbol, shrunk mean > 0 | 7 | shapes C |
| H12 | follow-ups text | 7 | — |

---

## §C Execution phases

Common rules for every phase:

- Work from `~/wick-sweep-reclaim`; `runs/` and `data/` are symlinks to `/mnt/wsr/{runs,data}`.
  `--runs-root ./runs` is the default; never change it.
- Every command is appended to `runs/INDEX.md` **immediately after it returns** (columns:
  `utc, phase, hypothesis, command, configFile, runId(s), venue, symbol, span, gate, nConfigs.N,
  forced, exit`). runIds are printed by the CLI (`runId:` line, or `--json` field `runId`).
- Parallelism on 4 OCPU: at most **3 concurrent shell jobs** for `reaction`/`backtest` (each with
  `--workers 3` only when the run itself has sweeps/variants; plain runs are single-threaded); never
  more than one `grid` at a time.
- Each phase ends with `runs/MEMO-phase<N>.md` (phase-level) plus `runs/<runId>/MEMO.md` per run,
  using the template in C.9. Deviations from this plan go into the memo **and** into §G of this file.
- `--log-level info` (default) so `runs/<runId>/logs/*.jsonl` exist; `--json` when the output is parsed.
- Exit codes (I §2.7.2): 0 ok, 1 usage/config, 2 partial data failure, 3 reaction gate failed (expected
  outcome, not an error), 4 integrity, 5 invariant violated (**always a bug: stop, file it**), 130 interrupted.

### Phase 0 — harness sanity, universe, data, hygiene admission (H0, manifest)

Goal: H0 PASS, `research/universe.json` written, every admitted triple fetched, hygiene-admitted,
verified; all ASSUMPTIONs of A.8 replaced. Inputs: repo at the pinned commit, empty `/mnt/wsr/data`.
Wall-clock ASSUMPTION: tests 3 min; screen 30 min; Binance fetch ≈ 62 GB at ~10–20 MB/s ≈ 1–2 h;
other venues ≈ 58 GB ≈ 1–2 h (Gate monthly files are large single downloads); hygiene/verify ≈ 1 h.
Disk ≈ 120 GB (+ transient cache, deleted per partition).

| Step | Command(s) | Expected | Decision |
|---|---|---|---|
| P0.1 build + tests | `git pull` (VM is at `baef7eb`, §F.7); `pnpm install --frozen-lockfile && pnpm build`; `pnpm test`; `pnpm test:property`; `pnpm bench` (record `eventsPerSec`; exit 2 vs the M3 baseline is expected on A1, §0.15) | both test commands exit 0 | H0(a). FAIL ⇒ stop, file. |
| P0.2 synthetic | `CLI backtest --synthetic driftless --trades 20000 --seed 1`; repeat with `--seed 2` | exit **3**, stdout shows `HitRate(2,1)` within 1/3 ± 3σ and gate FAIL | H0(b). exit 5 (bias) or exit 0 (gate passes on noise) ⇒ FAIL, stop. |
| P0.3 universe screen (G1 workaround) | Write `research/screen-universe.mjs` implementing A.1 exactly (fetch S3 listing pages, 30 daily 1d + 1m kline zips per candidate, August funding zip, `exchangeInfo`), apply A.2 then A.3; write `research/universe.json` with the full ranked table and tier column. Candidate set for the kline downloads = ranks 1–200 by the *1d* quote volume (one 1d file per symbol first, then 1m only for ranks ≤ 200 and T5 candidates). | 24–26 symbols; T6 may duplicate | Record the table in `runs/MEMO-phase0.md`. No hand edits. |
| P0.4 resolve placeholders | `node research/build-manifest.mjs`; set `data.lowCapSymbol` = T4 #1 in **all** `configs/research/*.json` (one `sed`), re-validate: `for f in configs/research/*.json; do node -e "import('./packages/core/dist/config.js').then(m=>{m.parseRunConfig(JSON.parse(require('fs').readFileSync('$f','utf8')));console.log('ok $f')})"; done`; `grep -rniE 'BTC\|ETH' research configs/research` must match nothing but the exclusion text | 158 ± triples, 10 × `ok` | Hashes in `configs/research/README.md` are updated (config changes, gate does not). |
| P0.5 fees + meta `[VERIFY]` | `CLI data meta --venue binance,bybit,okx,bitget,gate,kucoin --symbol <all universe symbols, comma list> --from 2025-09-03 --to 2026-09-18`; read every `[VERIFY]` line. Verify VIP-0 taker/maker against: Binance `https://www.binance.com/en/fee/futureFee` (USDⓈ-M), Bybit `https://www.bybit.com/en/help-center/article/Trading-Fee-Structure` (derivatives), OKX `https://www.okx.com/fees` (perpetual), Bitget `https://www.bitget.com/fee` (USDT-M futures), Gate `https://www.gate.io/fee` (perpetual), KuCoin `https://www.kucoin.com/vip/level` (futures). Funding interval per symbol: Binance `GET /fapi/v1/fundingInfo` (listed = non-8 h), Bybit `instruments-info.fundingInterval`, OKX `nextFundingTime − fundingTime`, Bitget `fundInterval`, Gate `funding_interval`, KuCoin `fundingRateGranularity`. Gate signed-size aggressor: `https://www.gate.io/docs/developers/apiv4/#retrieve-trades-list-2` (`size` sign). | fee table in `configs/research/*.json` equals the pages (bps: 5.0/5.5/5.0/6.0/5.0/6.0 taker, 2.0 maker) | Any difference ⇒ edit **all** research configs + `configs/default.json` fee rows, set `verifiedAt` to the check date, re-run P0.4 validation, note in the memo. Must be done **before Phase 3** (§D rule 9). |
| P0.6 feasibility probe | For every manifest row: its `dryRun` command with `--json`; count `planned` vs `unavailable` per triple; apply A.4 | table of `planned/requested` per triple | Drop / replace per A.4; rerun `build-manifest.mjs` after editing `research/universe.json` (`feasibility`, `reason` fields). |
| P0.7 Binance fetch + disk measurement | `fetch` commands of all Binance rows, 3 shell jobs in parallel (each `--concurrency 2`); after the first T1 symbol finishes: `du -sh data/binance/<sym>`; compute events/day from hygiene `mergeStats.rowsMerged` (`data/hygiene/**` JSON) and replace A.8 rows 1–2; re-project total GB; apply the trim rule | exit 0 or 2 (list failed partitions; retry once; a day still `failed` after two retries is a coverage gap) | Projection ≤ 350 GB ⇒ continue; else trim per A.8 before P0.8. |
| P0.8 other venues fetch | `fetch` commands of the remaining admitted rows, order bybit, okx, gate, bitget, kucoin (I §12.1 order), 3 parallel jobs | as above | Gate September `unavailable` is expected (A.4). |
| P0.9 hygiene admission | `CLI data hygiene --summary --venue … --symbol … --from <run from> --to 2026-09-18` per venue (run span, not fetch span); `CLI data verify --venue … --symbol … --from … --to …`; apply A.7 | coverage table, `verified N partition(s), 0 mismatch(es)` | Mark each triple `admitted` / `rejected(reason)` in the manifest; replace symbols per A.3. |
| P0.10 end-to-end bench | `CLI bench --venue binance --symbol <T1#1> --from 2026-07-01 --to 2026-08-31 --config configs/research/base.json` | events/s end-to-end, RSS | Replace A.8 throughput; recompute the C.8 budget table in the memo. |
| P0.11 determinism | `CLI reaction --venue binance --symbol <T2#1> --from 2026-07-01 --to 2026-08-31 --config configs/research/p2-h2-reaction.json`; `cp runs/<runId>/reaction.json /tmp/r1.json`; rerun the identical command; `for f in /tmp/r1.json runs/<runId>/reaction.json; do jq -S 'del(.runManifest.createdAt,.runManifest.gitCommit,.runManifest.wsrVersion)' $f | sha256sum; done` | identical hashes | H0(c). FAIL ⇒ stop, file with both files attached. |
| P0.12 memo | `runs/MEMO-phase0.md`: H0 verdict, universe table, manifest diff, measured A.8 values, admitted triple list | — | Go to Phase 1 iff H0 PASS and ≥ 1 admitted Binance triple. |

### Phase 1 — cost-floor screen across the universe (H1a)

Goal: decide who gets a P&L run at all, before any P&L. Inputs: `research/universe.json`, fee table.
Cost: minutes. Command: arithmetic (documented here; the agent writes it as `research/costfloor-proxy.mjs`
and pastes the table into the memo):

```
RTC_bps      = 2·taker_bps + 2·max(0.5·tickBps, 0.4) + 1.0        (S §7.4: taker both legs, half-spread ≈ 0.4 bps or half a tick, slippage 1 bps)
floorRatio   = 4·RTC_bps / volUnitBps                              (= 2·RTC / (0.5·VU): ≥ 1 ⇒ floor binds at MinSweepMult 0.5)
BE_atFloor   = (SweepDepth + RTC)/(3·SweepDepth) with SweepDepth = max(0.5·VU, 2·RTC)   (≤ 0.5 by construction; reported)
```

Decision (register H1a): symbol P&L-eligible iff `floorRatio ≤ 4`; tier eligible iff ≥ 2 of its symbols.
Outputs: `research/costfloor-proxy.json` + table in `runs/MEMO-phase1.md` with, per tier: p10/p50/p90 of
`volUnitBps`, `tickBps`, `RTC_bps`, `floorRatio`, eligible count. Universe-level kill: 0 eligible symbols ⇒
verdict (a) "cost floor" is pre-announced; Phase 2 still runs (reaction results are informative), Phases 3–7
are skipped. H1b (measured share of floor-set levels, `BreakevenHitRate` percentiles, trades/day after the
floor) is read from report §3 / `levels.parquet` in Phase 3 and can demote but not promote.

### Phase 2 — reaction tests across the admitted universe (H2–H4a)

Goal: level existence per (venue, symbol). Inputs: admitted triples; `configs/research/p2-h2-reaction.json`.

```sh
# per symbol, one command per venue end date (A.4); a venue list runs one independent replay per venue (never mixed)
node packages/cli/dist/main.js reaction --venue binance,bybit,kucoin --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 --config configs/research/p2-h2-reaction.json
node packages/cli/dist/main.js reaction --venue okx    --symbol BNBUSDT --from 2025-09-18 --to 2026-09-17 --config configs/research/p2-h2-reaction.json
node packages/cli/dist/main.js reaction --venue gate   --symbol BNBUSDT --from 2025-09-18 --to 2026-08-31 --config configs/research/p2-h2-reaction.json
node packages/cli/dist/main.js reaction --venue bitget --symbol BNBUSDT --from 2025-09-18 --to 2026-08-16 --config configs/research/p2-h2-reaction.json
# T5 symbols: --from <listedOn + 15 d>
```

Run 3 symbols concurrently (one shell job each). Outputs: `runs/<runId>/{run.json, reaction.json,
report.md (sections 0–2, 12), logs/}` per venue. Exit 3 = gate FAIL for ≥ 1 venue of the command (read
`reaction.json.gate` per venue, not the exit code). Decision per register H2/H3/H4(a). Per-regime slicing of
the reaction test is **G3**; the memo states the deviation and points to Phase-3 `byRegime`. Memo table per
run: `venue, symbol, tier, sets.wick.{n, approached, complete, unresolvedShare}, blacklistedBuckets/
totalBuckets, contrasts 1-4/1-2/1-3 (diffDisp, ci95), monotone.slope (ci95), gate.pass, gate.reasons`.

Cost ASSUMPTION (A.8, 0.4 M ev/s): Σ events of all primary triples ≈ 2.9 G ⇒ ≈ 2 h serial, ≈ 45 min on
3 jobs, plus bootstrap (B = 2000, fast) ⇒ **≈ 1–1.5 h**. Disk: negligible (no trades file).
Kill: H2 FAIL on every Binance symbol ⇒ write `runs/MEMO-phase2.md` with the verdict-template rows Q1, Q2,
H1 filled and stop with verdict (a). Otherwise the **passer list** P2 = {(venue, symbol): H2 PASS ∧ H4(a) PASS}
is the input of Phases 3–7; H2 "underpowered" runs (approached < 500) are listed separately and not used.

### Phase 3 — default-config P&L, target validation, mechanism (H1b, H4b, H5, H6)

Goal: baseline P&L on every P&L-eligible (H1a) Binance symbol in P2. Inputs: Phase-2 `reaction.json`
(reused automatically: same span, same gate hash `8abb77f93458`, B = 2000), `p3-h6-baseline.json`.

```sh
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p3-h6-baseline.json --workers 3
# long window (the two T2 long-window symbols, only if they are in P2 and H1a-eligible):
node packages/cli/dist/main.js backtest --venue binance --symbol <LONG#1> --from 2022-01-01 --to 2026-09-18 \
  --config configs/research/p3-h6-baseline.json --run-reaction --workers 3
# Stage B as level-quality evidence (H12), same symbols, separate gate hash ⇒ --run-reaction:
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p3-h6-stageb.json --run-reaction --workers 3
```

Outputs per run: `run.json, reaction.json, trades.{parquet,jsonl}, levels.parquet, pivots.parquet,
transitions.parquet, folds.json, target_grid.json, stageB.json, report.md, logs/`. The baseline run has the
same runId as the Phase-2 run (identical config) and writes into the same directory (§0.14). Decision per
register H1b, H4(b), H5, H6. The Phase-0 consistency check (A.7, `sets.wick.n` vs `levels.parquet`) is done
here for every run. Memo table per run: pooled OOS `trades, HitRate, HitRate_0, BreakevenHitRate,
HitRateMinusBreakeven (ci from target_grid.placeboSwept.configured.ci95), expectancy_bps
(conservative), targetFill.optimistic, stability (pair, share), placeboSwept diff, mechanism (diff, ci95),
costFloor.shareOfSpikes, BreakevenHitRate p50, trades/volumeDay, blacklistedBucketShare, killSwitchTrips,
ringUnderflow`, report Q3–Q5, Q7 lines verbatim.

Cost ASSUMPTION: Binance primary events ≈ 1.3 G ⇒ ≈ 55 min serial replay; a backtest ≈ 1.5 × replay
(fits, target grid, bootstrap) ⇒ ≈ 1.4 h serial, ≈ 30 min on 3 jobs; long window 2 × (0.27 G ⇒ 17 min);
Stage B runs on survivors only (2 replays each). **≈ 1.5–2 h**. Disk: ≈ 50–200 MB per run.
Survivors S3 = {Binance symbols with H6 PASS} (H5 FAIL ⇒ "suspect" label, still a survivor for Phase 4).
Downstream skip: no survivor ⇒ Phase 4 and 5 skipped; Phase 6 still runs on the Phase-3 trades (an H7
slice may rescue a (b)); Phase 7 runs transfer only for the verdict's H11 rows.

### Phase 4 — variants, latency, slippage on the survivors (H8, H9)

Goal: entry mechanism and execution robustness on S3. Inputs: S3, Phase-2/3 `reaction.json`.

```sh
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p3-h6-baseline.json --latency-sweep --slippage-sweep \
  --variants armMode,timeStop,counterTrendBlock,targetMode,ageClock --workers 3
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p4-h8-triggeroffset1.json --run-reaction --workers 3
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p4-h8-triggeroffset2.json --run-reaction --workers 3
node packages/cli/dist/main.js backtest --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p4-h9-blacklist-funding.json --run-reaction --workers 3   # diagnostic only
```

The first command is 13 trading replays in one run (baseline + 3 latency points + 2 slippage + 7 variant
passes: `armMode`, `timeStop`, `counterTrendBlock`, `targetMode.{volUnit,market,twoStage}`, `ageClock`);
`folds.json.nConfigs = {cells: 1, variants: 8, latencyPoints: 4, N: 32}`. Its runId equals the Phase-3
baseline's (same config) — it overwrites that directory with a superset (`folds.json` now has `variants`,
`latencyCurve`, `slippageCurve`); record both entries in `runs/INDEX.md`. Decision per register H8, H9.
Memo table: per variant total OOS pnl_R (Σ `pnl_R` over `trades.jsonl` rows with `foldId ≥ 0` of the
variant pass — the variant passes are in `folds.json.variants[*]`; per-trade rows of variants are not
written, so use `expectancy_R × realised` per fold from `folds.json.variants[*].folds`), folds-won count,
`skippedSlowReclaim`; latency curve; slippage curve; the four 0.30 flags; TriggerOffset runs' pooled rows;
`blacklistFunding` ΔExpectancy.

Cost ASSUMPTION: per survivor 13 + 2·3 = 19 replays (TriggerOffset/funding runs = reaction + trading pass
each); T1 ≈ 19 × 6 min = 1.9 h / 3 workers ≈ 40 min; T2 ≈ 16 min; T3–T6 ≈ 5 min. For ≤ 8 survivors
**≈ 2–4 h** on 4 OCPU (or `burst.sh up` first and `--workers 15` ⇒ < 1 h, ≈ $0.2). Disk ≈ 0.2 GB/run.
Selection for Phase 5: rank S3 by the lower CI bound of pooled OOS `HitRate − BreakevenHitRate` (Phase 3),
tie → expectancy_bps; take the best **2** (3 if the third is within 0.01 of the second) that also pass H9
(150 ms) — S5.

### Phase 5 — full grid + walk-forward on the best 2–3 (H6, H10)

Goal: parameter plateau, DSR, reality check, sensitivity, OOS replay of the chosen cells. Inputs: S5,
`p5-h6-grid.json` (gate hash = Phase 2 ⇒ `reaction.json` reused), burst VM.

```sh
infra/oci/scripts/burst.sh up                      # from the laptop: 16 OCPU / 64 GB, reboots the VM
# on the VM, inside tmux:
node packages/cli/dist/main.js grid --venue binance --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 \
  --config configs/research/p5-h6-grid.json --workers 15
# interrupted (reboot, SIGINT)? resume:
node packages/cli/dist/main.js grid --run-id <gridRunId> --workers 15
node packages/cli/dist/main.js backtest --from-grid <gridRunId> --workers 15
node packages/cli/dist/main.js report --run-id <gridRunId>,<fromGridRunId>
infra/oci/scripts/burst.sh down
```

Baseline only (no `--variants` on the grid, so `N_configs = 1 296 × 1 × 1`; the Phase-4 variant that
H8 adopted, if any, is applied by editing a **copy** `p5-h6-grid-<variant>.json` — one extra config in the
ledger, its gate hash may change ⇒ `--run-reaction`). Outputs: `grid.json` (walk-forward per fold: admissible
cells, top 20 %, chosen cell, train/test stats; `dsr`; `realityCheck`; `cells`), `sensitivity.json` (21 rows +
base), `cells/`, and the `--from-grid` run's `folds.json`/`report.md` (Q4 re-evaluated OOS on the chosen
cells; the backtest run's `nConfigs` counts one more). Decision per register H10 (i)–(v); (vi) needs the
long window (Phase 3 run; decay arithmetic in Phase 7).

Degenerate-axis rule (§D 3): when the cost floor binds, the `MinSweepMult` axis {0.3, 0.5, 1.0} collapses
(all three floored to `2·RoundTripCost`, I:1218). The grid still counts 1 296 in `N_configs` (conservative);
the memo reports how many distinct `MinSweepDepth` values the cells produced (`levels.parquet` of the
`--from-grid` run, `minSweepFloorBinding` share).

Cost ASSUMPTION (0.4 M ev/s, 15 workers): T1 1 296 × 6 min / 15 ≈ 8.6 h (≈ $1.6), T2 ≈ 3.6 h ($0.65),
T3 ≈ 1.4 h ($0.25), T4–T6 < 1 h; + fits, 21 sensitivity replays, from-grid ≈ +5 %. **Total burst ≈ 4–20 h,
$1–4** for 2–3 grids (the register's "plan must be affordable" test: a T1 grid is run only if it is in S5).
Disk: `cells/` ≈ 1 296 × ~50 KB ≈ 70 MB per grid. If A1 16-OCPU capacity is unavailable, the README's
E5 fallback applies (`ocpus = 12` ⇒ 11 workers, times × 1.4).

### Phase 6 — conditioning search with the pre-registered slices (H7)

Goal: where does the edge concentrate. Inputs: `trades.jsonl` + `folds.json` of every Phase-3/4/5 Binance
run in P2 (not only survivors) and, for criterion (iii), the Phase-7 transfer runs (Phase 6 is therefore
finalised after Phase 7's runs exist; the slice statistics on Binance are computed first). Tool: **G6**
(`wsr slices`); meanwhile `research/slices.mjs` written by the agent implementing exactly:

1. Rows = test-window trades (`foldId ≥ 0`) of the Binance baseline runs (Phase 3; Phase-5 `--from-grid`
   runs for S5 symbols, labelled separately).
2. For each of the 68 slices of register H7 (columns: `decile`, `SweepDepth/VolUnit_created`, `regime`,
   `hourOfDay`, `SweepCount`, `PriorTouches`, `ReturnSpeed`, `burst`, tier, venue; G4 columns when present):
   n, `HitRate`, mean `BreakevenHitRate`, `HitRate − Breakeven`, mean `pnl_bps`; one-sided p-value of
   `HitRate − Breakeven > 0` by block bootstrap (blocks = UTC day of `TriggerTime`, B = 2000, RNG seeded 1,
   `xoshiro128**` via `backtest/dist/rng.js` `rngStream(1, 'slices', sliceIndex)` for determinism);
   folds-same-sign share; in-slice mechanism (mean `postEntryImbalance2` winners − losers, bootstrap CI).
3. BH at q = 0.10 over the `m` slices with n ≥ 200 (m stated). Criteria (i)–(v) of register H7.
4. Output `runs/slices-<sha16 of run ids>/slices.{json,md}`; memo lists surviving slices with all five
   criteria's values.

No slice may be added, merged, or re-binned. Cost: minutes. Disk: negligible.

### Phase 7 — transfer, decay, verdict (H10 vi, H11, H12, template)

Goal: fill the verdict template. Inputs: everything above.

```sh
# transfer runs: every non-Binance venue of P2 for each Phase-3/5 symbol (reaction.json from Phase 2 is reused;
# --to per venue as in Phase 2, otherwise the reactionKey does not match and the run is refused)
node packages/cli/dist/main.js backtest --venue bybit,kucoin --symbol BNBUSDT --from 2025-09-18 --to 2026-09-18 --config configs/research/p7-h11-transfer.json --workers 3
node packages/cli/dist/main.js backtest --venue okx    --symbol BNBUSDT --from 2025-09-18 --to 2026-09-17 --config configs/research/p7-h11-transfer.json --workers 3
node packages/cli/dist/main.js backtest --venue gate   --symbol BNBUSDT --from 2025-09-18 --to 2026-08-31 --config configs/research/p7-h11-transfer.json --workers 3
node packages/cli/dist/main.js backtest --venue bitget --symbol BNBUSDT --from 2025-09-18 --to 2026-08-16 --config configs/research/p7-h11-transfer.json --workers 3
# (a venue list writes runs/compare-{hash}/comparison.{json,md} automatically; also explicit:)
node packages/cli/dist/main.js report --compare <binanceRunId>,<bybitRunId>,<okxRunId>,…
# same-tier symbol comparison (Binance runs of one tier):
node packages/cli/dist/main.js report --compare <runId T2#1>,<runId T2#2>,…
```

Decay (H10 vi, **G5** workaround): from the long-window run's `trades.jsonl`, group test-window trades by
UTC quarter of `TriggerTime`; per quarter n, `HitRate − Breakeven`, mean `pnl_bps`; Spearman ρ of quarterly
mean `pnl_bps` vs quarter index with a bootstrap CI (resample quarters, B = 2000, seed 1); last-4-quarters
positive count. Shrinkage (**G6** workaround): per tier, `x̄_tier` = trade-weighted mean of pooled OOS
`expectancy_bps` over the tier's Binance runs; `x̂_s = w·x_s + (1 − w)·x̄_tier`, `w = n_s/(n_s + 500)`; never
pool trades across symbols. Decision per register H10 (vi), H11. Cost ASSUMPTION: transfer runs ≈ Phase-3
cost × 1.35 ⇒ **≈ 2 h** on 4 OCPU; arithmetic minutes.

Verdict: fill §E; write `runs/VERDICT.md` (= §E filled) and `runs/MEMO-phase7.md`.

### C.8 Compute and disk budget (ASSUMPTION; Phase 0 P0.7/P0.10 replace the two inputs)

Inputs: `E_sym` = Binance events per symbol-year (benchmark 1.05 M/day × 366 × tier scale), `v` = 0.4 M ev/s per
worker. Replay minutes = `E_sym / v / 60`.

| Tier | E_sym (ASSUMPTION) | one replay | Phase 2 (6 venues, Σ 2.35×) | Phase 3 (Binance, ×1.5) | Phase 4 (19 replays / 3 workers) | Phase 5 grid (1 296 / 15 workers) |
|---|---|---|---|---|---|---|
| T1 | 135 M | 5.6 min | 13 min | 8 min | 36 min | 8.1 h ≈ $1.5 |
| T2 | 58 M | 2.4 min | 5.6 min | 3.6 min | 15 min | 3.5 h ≈ $0.65 |
| T3 | 23 M | 1.0 min | 2.3 min | 1.5 min | 6 min | 1.4 h ≈ $0.25 |
| T4 | 12 M | 0.5 min | 1.1 min | 0.7 min | 3 min | 0.7 h ≈ $0.15 |
| T5/T6 | 15–20 M | 0.7 min | 1.6 min | 1 min | 4.5 min | 1 h ≈ $0.2 |
| long window (T2) | 270 M | 11 min | — | 17 min (+ reaction 11 min) | — | — |

Totals: Phase 0 ≈ 4–6 h (download-bound), Phase 1 minutes, Phase 2 ≈ 1–1.5 h (3 jobs), Phase 3 ≈ 1.5–2 h,
Phase 4 ≈ 2–4 h (4 OCPU) or < 1 h burst, Phase 5 ≈ 4–20 h burst ($1–4), Phase 6 minutes, Phase 7 ≈ 2 h.
Wall-clock ≈ 2–3 days including the agent's memos; burst cost ≈ $2–6; disk ≈ 120 GB data + < 5 GB runs.
Spec §10 reference (I:1421): 13-month ETHUSDT cell ≤ 5 min per worker at ≥ 1 M ev/s end-to-end; the A1 is
≈ 0.3× the M3 baseline on the core loop, hence 0.4 M ev/s here.

### C.9 Memo template (`runs/<runId>/MEMO.md` and `runs/MEMO-phase<N>.md`)

```
# MEMO — phase <N> / <hypothesis ids> — <runId or "phase">
date (UTC) | command(s) verbatim | config file + configHash + gateConfigHash | exit code | nConfigs.N | forced? (yes = diagnostic only)
## Numbers (the register's metric fields, with CI)
| metric | value | CI | threshold | pass? |
## Verdict against the pre-registered threshold
<one line per hypothesis touched: PASS / FAIL / underpowered / not run (reason)>
## Deviations from specs/research-plan.md
<none | what, why, effect on the verdict; copied to research-plan.md §G>
## Post-hoc observations (exploratory, not in the verdict)
<anything noticed; never a new slice or threshold>
```

---

## §D Anti-fooling rules (binding on the executing agent)

1. **Thresholds, slices, grids are fixed** in `specs/hypothesis-register.md` and this plan. The agent may not
   add a slice, widen or shift a grid axis, change a bin edge, or move a threshold after any result is seen.
   New ideas go to §G "post-hoc observations", flagged exploratory, and never enter §E.
2. **`--force-pnl` is diagnostic only.** A forced run carries the `FORCED_BANNER` (`backtest/src/backtest-run.ts:24`)
   in `report.md` and `gate: "forced"` in `run.json`; it is labelled `forced = yes` in `runs/INDEX.md` and in
   every memo table, and never feeds §E. No forced run is planned; if one is needed for a bug report, say so.
3. **Optimised degrees of freedom ≤ 6** (the grid's six axes, `core/src/config.ts` `GridSchema` rejects a 7th).
   Every extra configuration evaluated — each config file, each `--variants` pass, each latency point, each
   TriggerOffset / Stage B / funding-blacklist run, each `p5-h6-grid-<variant>.json` copy — increments the
   symbol's `N_configs` in `runs/INDEX.md` (sum of `nConfigs.N` across its runs). The grid's DSR / reality
   check use their own `N` (`grid.json.nConfigs.N`); §E reports both the grid `N` and the ledger sum.
   The degenerate `MinSweepMult` axis is **not** subtracted (Phase 5 rule).
4. **Never change strategy logic, gates, cost assumptions or the conservative execution choices**
   (touch-and-reverse must fill, conservative Target fill, `2·RoundTripCost` floor, `SlipCoef`, fees) to
   improve a number. A suspected spec bug is filed as a finding with a failing test under `packages/*/src/*.test.ts`
   (in a branch, not merged during the research) — never patched silently.
5. **Every HitRate is reported next to `HitRate_0` and `BreakevenHitRate`**; only net-of-cost expectancy
   (`expectancy_bps`, `expectancy_R`, conservative fill) is reported; `targetFill.optimistic` appears only as
   the second column of the same row.
6. **Level survivorship**: INVALIDATED / EXPIRED / RETIRED levels stay in the reaction denominator (A.7); the
   `sets.wick.n` vs `levels.parquet` check is run for every Phase-3 run.
7. **Venues and symbols are never mixed in one engine run**: the CLI enforces it (comma lists = independent
   runs, `grid` one venue); cross-symbol statements use only `report --compare` and the shrinkage rule (H11).
   No trade-level pooling across symbols or venues, anywhere.
8. **Ledger**: `runs/INDEX.md` gets one line per command immediately after it returns (§C common rules,
   **G10**). A run missing from the ledger does not exist for §E.
9. **Fees `[VERIFY]`** (P0.5) are verified against the listed pages before any Phase-3 command. A run whose
   `run.json.feesVerifiedAt` is null or older than the P0.5 check is not admissible for §E.
10. **Seeds**: `seed: 1` in every config, `--seed` never passed (the config seed applies). Seed 2 only in P0.2.
11. **Gate reuse is automatic and exact**: a backtest that prints `NO REACTION TEST OF THESE INPUTS` was run
    with the wrong config/span — fix the command, never add `--run-reaction` to a config whose gate hash is
    meant to equal Phase 2's (`README.md` column "needs its own reaction run").
12. **No `--folds`, no `--bootstrap` overrides, no `--min-trades-train`** in any run that feeds §E.
13. **Data**: no REST/websocket trade back-fill; an archive hole is a coverage gap in the manifest and memo.
14. **Symbol swaps** only by the A.3 "next by rule" mechanism, recorded as `replacedBy`.

---

## §E Verdict template (filled by Phase 7; copied to `runs/VERDICT.md`)

One row per Appendix B question (I:1633–1643) plus H1, H7, H10. "Folds" = share of folds agreeing;
"Venues" = venues agreeing / venues run; "N" = `N_configs` (grid `N` / ledger sum); "DSR / RC-p" from
`grid.json` of the symbol's grid run (or `n/a`). Fill one table per symbol in S5 (and one per Binance
survivor for rows 1–2, 4, 7), then the final box.

| Row | Question | Metric (file.field) | Threshold (register) | Value | CI | Folds | Venues | N / DSR / RC-p | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | WickLevels react above random & placebo, monotone? | `reaction.json.contrasts["1-4"], ["1-3"], monotone, gate.pass` | H2, H4(a) | | | — | /  | — | PASS / FAIL / underpowered |
| Q2 | Does "fast" matter (1)−(2)? | `reaction.json.contrasts["1-2"]` | H3 | | | — | / | — | YES / NO |
| Q3 | Sign of PriorTouches | report Q3 (`stageB.json` β₁₁ per fold; `byPriorTouches`) | ≥ 75 % folds same sign | | — | | / | — | + / − / inconsistent |
| Q4 | HitRate(2,1) > Breakeven; plateau stable? | `folds.json` pooled `HitRateMinusBreakeven`; `target_grid.json.stability` | H6 (i)–(iv) | | | | / | | PASS / FAIL |
| Q5 | Target scales with SweepDepth or VolUnit? | report Q5; `target_grid.json.byTargetUnits` | H6 Q5 rule | | — | | / | — | SweepDepth / VolUnit / undecided |
| Q6 | RestEarly vs ArmOnApproach (total OOS P&L) | `folds.json.variants[armMode]` vs baseline; `skippedSlowReclaim` | H8 | | — | | / | +1 config | RestEarly / ArmOnApproach |
| Q7 | Mechanism: imbalance separates winners? | `folds.json` pooled `mechanism.diff, ci95` | H5 | | | | / | — | PASS / FAIL |
| Q8 | Latency: where does the edge vanish? | `folds.json` pooled `latencyCurve`; `slippageCurve[2]` | H9 (150 ms CI-lower > 0; ×2 > 0) | ceiling = __ ms | | — | / | — | tradable / not tradable from cloud |
| Q9 | Transfer across venues & symbols? | `comparison.json.{signAgreement, plateauAgreement, verdict}`; shrunk `x̂_s`, `x̄_tier` | H11 | | — | — | / | — | yes / partly / no |
| H1 | Cost floor: eligible tiers; floor-set share; Breakeven p50; trades/day | `costfloor-proxy.json`; report §3; `levels.parquet` | `floorRatio ≤ 4`; p50 BE ≤ 0.55; ≥ 200 trades | | — | — | — | — | eligible / reaction-only per tier |
| H7 | Surviving slices (list) | `slices.json` | BH q = 0.10, m = __, criteria (i)–(v) | | | | / | m | list or "none" |
| H10 | Stability: DSR, RC-p, sensitivity signs, plateau agreement, decay | `grid.json.dsr.DSR`, `realityCheck.p`, `sensitivity.json`, `walkForward`, quarterly table | H10 (i)–(vi) | | | | — | N = __ / DSR = __ / p = __ | PASS / FAIL / decaying |

**Final verdict box** (exactly one):

```
VERDICT: (a) no edge | (b) conditional edge | (c) unconditional edge

(a) reason ∈ {H0 fail, cost floor (H1: 0 eligible), no level effect (H2 all FAIL), no trade edge (H6 all FAIL, no H7 survivor), search-explained (H10 i/ii FAIL everywhere)}
(b) conditions C = { tier ∈ {…} | slice ∈ {H7 survivors…} | venue ∈ {…} | latency ≤ __ ms }, each with: symbols, pooled OOS HitRate − Breakeven [CI], expectancy_bps, folds share, venues, N_configs, BH m and q, H5 in-slice CI
(c) plateau = {PivotMult, BandWidthMult, MinSpikeSize, MinSweepMult, BreakoutMult, minStrengthPassRate} (grid centre, per symbol), TargetMult/StopMult pair, latency ceiling = __ ms, venues = {…}, DSR / RC-p / N per symbol, decay statement
Supporting runIds: …   Ledger N_configs total: …   Forced runs used: none
```

Decision rule for the box (pre-registered): **(c)** iff, for **every** symbol in S5: H5 PASS, H6 PASS (Phase 3
and `--from-grid`), H9 tradable at 150 ms, H10 (i)–(v) PASS and (vi) not "decaying" where run, H11 (i) `yes`
and (ii) PASS — **and** S5 spans ≥ 2 tiers, **and** H1 leaves ≥ 3 tiers eligible. **(a)** iff one of the (a)
reasons holds. Otherwise **(b)**, with C = the union of (tier, slice, venue, latency) conditions under which
H5 ∧ H6 ∧ H9 ∧ (H10 i–ii or an H7-surviving slice) ∧ H11 hold; a (b) with an empty C is an (a).

---

## §F Verification of this deliverable (done 2026-09-19, local M3 Pro, Node 24.13.0, pnpm 10.17.1)

1. `pnpm install --frozen-lockfile && pnpm build` — exit 0.
2. Every `configs/research/*.json` parsed by `parseRunConfig` — 10 × ok; hashes in `configs/research/README.md`.
3. `node research/build-manifest.mjs` — 158 triples; `research/data-manifest.json` parses; every `fetch` string
   matches `data fetch --venue … --symbol … --from … --to …`.
4. `wsr data fetch --dry-run --venue binance --symbol BNBUSDT --from 2026-09-17 --to 2026-09-17 --config configs/research/base.json` executed locally → `planned binance BNBUSDT 2026-09-17`, exit 0 (HEAD probe only, nothing downloaded); the full per-triple
   probe runs on the VM in P0.6.
5. `grep -rniE 'BTC|ETH'` over `research/`, `configs/research/`, this file and the register returns only
   exclusion sentences and the spec's ETHUSDT benchmark citations.
6. Every command in §C uses only flags present in `cli/src/program.ts` (`--venue --symbol --from --to --config
   --workers --run-reaction --latency-sweep --slippage-sweep --variants --from-grid --run-id --synthetic --trades
   --seed --dry-run --concurrency --summary --compare --run-id`).
7. **VM checked over SSH 2026-09-19** (`ubuntu@<VM_PUBLIC_IP>`): 4 OCPU (`availableParallelism() = 4`), 23 GB RAM,
   `/mnt/wsr` 492 GB (471 free), 16 GB swap, Node 22.23.2, pnpm 10.34.5, repo at `baef7eb` (one commit behind
   `85834fa`, which adds only `infra/` — `git pull` in P0.1), `packages/cli/dist/main.js` built, `data/` and `runs/`
   symlinked to `/mnt/wsr`, both empty.
8. **H0(b) preview on the VM**: `backtest --synthetic driftless --trades 20000 --seed 1` → `HitRate(2,1) 0.3400 vs
   1/3 ± 0.0100 (z 2.00) — PASS`, gate FAIL as expected, exit 3, 24 s. (Phase 0 P0.2 repeats it for the ledger.)
9. **Feasibility probes on the VM** (A.4 table): 3 symbols × 6 venues × 381 days, all `planned` except the
   publication-lag tails; logs `/mnt/wsr/logs/dryrun-{BNBUSDT,XRPUSDT,SOLUSDT}.jsonl`. Manifest regenerated with
   `venueTo` (119 GB projected).

## §G Deviations and post-hoc observations (filled during execution)

| Date | Phase | Deviation / observation | Reason | Effect on the verdict (must be "none" for observations) |
|---|---|---|---|---|
| — | — | — | — | — |
