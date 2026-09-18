# IMPLEMENTATION_SPEC.md — WSR Backtest System (TypeScript / Node.js)

| | |
|---|---|
| Source of truth for strategy logic | `strategy.md` — *Wick-Sweep-Reclaim (WSR) Strategy, Quantitative Specification for Trade-Stream Implementation* (§0–§12, Appendix A) |
| Spec date | 2026-09-18 |
| Target stack | Node.js current LTS (24.x at spec date), TypeScript `strict: true`, ESM (`"type": "module"`), pnpm workspace |
| Prohibited | Trading or backtesting frameworks; candle data; order-book data; live order routing |

**Reading conventions used in this document**

- `§n.m` without a prefix cites `strategy.md`. `Spec §n` cites *this* document.
- Every rule that is strategy logic carries a `strategy.md` citation. A rule with no citation is an engineering decision and is listed in **Appendix A** with its rationale.
- **[VERIFY]** marks a fact about an external venue, library or fee schedule that the engineer must confirm against the venue's or library's *current* documentation before writing code. Build the adapter from the documentation, not from this table.
- Identifiers in `code font` that appear in `strategy.md` §0–§11 are **reserved**: they must be used verbatim in code (§0: "Every name below is usable verbatim as a code identifier"). See Spec §1.4.
- All prices are integer **ticks**, all sizes integer **lots**, all timestamps integer **milliseconds UTC** unless stated otherwise (Spec §3.11).
- "Conservative" means: the interpretation that, if wrong, makes the strategy look *worse*, never better (§12 cost floor, adverse selection, optimistic-fill bias are the three named biases and are never softened).

---

## 1. System overview

### 1.1 Purpose

Build a deterministic, trade-stream-only research system that answers, in the order §12 lists them, the nine open questions of the WSR hypothesis. The system's job is to find out **whether and where the strategy fails** (§12), not to make it look tradable. Concretely it must:

1. Download, normalise, merge and store historical **trade** data for USDT-margined perpetual futures on Binance, Bybit, OKX, Bitget, Gate and KuCoin.
2. Replay that data through the §9.1 per-print loop with the §5/§6/§8 state machine and the §7 execution model.
3. Run the §9.2 reaction test **before** any P&L backtest and refuse to run the P&L backtest when the reaction test fails.
4. Run the §6.5 target validation, §9.3 walk-forward and parameter search, and produce the §9.4 reports.

### 1.2 Scope and non-goals

| In scope | Out of scope (non-goals) |
|---|---|
| Historical raw trades (`t, p, q, s`) per §2.1 | Live trading, order routing, exchange keys |
| Funding-rate history (needed for §7.4 `funding accrued`) | Order-book / quote data (§2.1: "No quote feed is available") |
| Instrument metadata: tick size, lot size, contract multiplier, fee schedule | Candles of any kind (§3 is "candle-free") |
| Six venue adapters behind one contract | Portfolio-level allocation across symbols |
| Trade-only execution model (§7) as bounds | Any claim of measured fills (§12 weakness 5) |

### 1.3 Component diagram

```mermaid
flowchart LR
  subgraph data["packages/data"]
    A[Venue adapters ×6] --> B[Normalise → CanonicalTrade]
    B --> C[Merge §2.1 → MergedEvent]
    B --> D[(raw Parquet\nvenue/symbol/date)]
    C --> E[(merged Parquet\nvenue/symbol/date)]
    C --> F[Hygiene report §9.5\n+ blacklist intervals]
    G[Instrument meta\nticks, lots, fees, funding] --> D
  end
  subgraph core["packages/core"]
    E --> H[TradeRing]
    H --> I[BucketBuilder §2.2]
    I --> J[VolUnit / SpreadEst §2.1 §2.3]
    H --> K[Zigzag §3.1]
    K --> L[ExcursionFeatures §3.2]
    L --> M[SpikeGates §3.3]
    M --> N[PivotStore]
    N --> O[WickStrength §4]
    O --> P[LevelBook + state machine §5 §6 §8]
    P --> Q[Execution model §7]
  end
  subgraph backtest["packages/backtest"]
    N --> R[Reaction test §9.2]
    Q --> S[Target validation §6.5]
    Q --> T[Walk-forward + grid §9.3]
    R --> U{Gate: (1)−(4) > 0,\nsignificant, monotone}
    U -- pass --> T
    U -- fail --> V[Report: P&L NOT RUN]
    T --> W[Reports §9.4\nJSON + Markdown]
    S --> W
  end
  subgraph cli["packages/cli"]
    X[wsr data / hygiene / reaction / backtest / grid / report / bench]
  end
  F -. blacklist .-> H
  X --> data
  X --> backtest
```

### 1.4 pnpm workspace layout and dependency direction

```
wsr/
  package.json              # pnpm workspace root, "type": "module"
  pnpm-workspace.yaml       # packages/*
  tsconfig.base.json        # strict: true, module: NodeNext, target: ES2022, noUncheckedIndexedAccess: true
  packages/
    data/      @wsr/data
    core/      @wsr/core
    backtest/  @wsr/backtest
    cli/       @wsr/cli
  fixtures/                 # recorded venue responses, golden outputs (Spec §11)
  runs/                     # default output root (git-ignored)
```

| Package | Responsibility | May import |
|---|---|---|
| `@wsr/core` | Pure engine: types, numeric conventions, TradeRing, BucketBuilder, VolUnit, SpreadEst, Zigzag, ExcursionFeatures, SpikeGates, WickStrength, PivotStore, LevelBook + state machine, execution model, per-print loop, config schema. **No I/O, no `fs`, no network, no `Date.now()`, no `Math.random()`.** | nothing in the workspace |
| `@wsr/data` | Venue adapters, download, normalise, merge, Parquet storage, hygiene report, instrument/fee/funding metadata. | `@wsr/core` (types only) |
| `@wsr/backtest` | Replay driver, reaction test, target validation, walk-forward, grid, statistics (bootstrap, DSR), reporting, worker-thread orchestration. | `@wsr/core`, `@wsr/data` |
| `@wsr/cli` | Command parsing, exit codes, progress, logging. Thin. | `@wsr/backtest`, `@wsr/data`, `@wsr/core` |

Dependency direction is enforced with an ESLint `import/no-restricted-paths` rule (or `dependency-cruiser`); a violation fails CI.

Allowed third-party runtime dependencies (anything else requires an Appendix A entry): `apache-arrow`, `parquet-wasm` **[VERIFY current version supports zstd write/read]**, `zod` (config validation), `undici` (HTTP), `yauzl`/`node:zlib` (zip/gzip/zstd), `commander` (CLI), `pino` (logging). No numeric or ML library: the L2 logistic regression (§4.2) and the bootstrap are implemented in `@wsr/backtest` (Spec §6.1, §6.5).

### 1.5 Glossary — `strategy.md` identifier → code identifier

Rule: a `strategy.md` name is used **verbatim** (same case, same underscores) as the TypeScript identifier for the field, constant, function or type that implements it. Camel-casing a reserved name is a lint error (custom ESLint rule `wsr/reserved-identifiers` with the list below as its allow-list; `@typescript-eslint/naming-convention` is disabled for these). Names that `strategy.md` uses as prose only (e.g. "Approach", "Rejection") are also reserved because §0 makes the whole naming map usable verbatim.

| `strategy.md` | Code | Kind | Defined in |
|---|---|---|---|
| `Spike`, `WickLevel`, `SweepExtreme`, `SweepDepth`, `Target`, `WickStrength`, `VolUnit`, `Reclaim` (§0) | same | types / `Level` fields | `core/src/types.ts`, `core/src/level.ts` |
| `t, p, q, s`, `Tick` (§2.1) | `t`, `p`, `q`, `s`, `Tick` | `MergedEvent` fields; `Tick` is `InstrumentMeta.Tick` | `core/src/types.ts` |
| `SpreadEst` (§2.1) | `SpreadEst` | class + live value `SpreadEst_t` | `core/src/spread.ts` |
| `Vol(t)`, `BucketVolume`, `High_k, Low_k, Imbalance_k, Vwap_k, Count_k, WallDuration_k` (§2.2) | `Vol`, `BucketVolume`, `High_k` … | `BucketBuilder`, `Bucket` fields | `core/src/buckets.ts` |
| `VolUnit_t`, `UnitWindow`, `RVol`, `VolUnit_created`, `VolUnit_now` (§2.3) | same | | `core/src/volunit.ts` |
| `Side` (§2.4) | `Side` (`1 \| -1`) | type | `core/src/types.ts` |
| `LegDir, LegExtreme, LegExtremeTime, PivotReversal, PivotMult, PivotHigh/PivotLow, confirmed_at, MergeTolerance, PriorTouches` (§3.1) | same | | `core/src/zigzag.ts` |
| `BandEdge, BandWidthMult, EnterTime, ExitTime, Approach, Rejection, Anchor, AnchorWindow` and every feature name in the §3.2 table | same | `ExcursionFeatures` fields | `core/src/features.ts` |
| `G1`…`G6`, `MinSpikeSize, MaxSpikeDuration, MinRejectSpeed, MinRejectImbalance, MinRetrace, RetraceWindow, MaxTopDwell, TopBandMult, SlowExtreme` (§3.3) | same | | `core/src/gates.ts` |
| `RankWindow, WickStrength_0, MinStrength` (§4) | same | | `core/src/strength.ts` |
| `Age, Distance, Relevance, AgeScale, DistanceScale, MaxAge, MaxUses` (§5) | same | `Level` methods/fields | `core/src/level.ts` |
| `MinSweepDepth, MinSweepMult, BreakoutDepth, BreakoutMult, SweepRunningMax, ArmMode, ArmDistance, ReturnSpeed, MinReturnSpeed, TriggerOffset, StopLoss, StopOffset, TargetMult, StopMult, TimeStop, MaxHold, MFE, MAE, HitRate, HitRate_0, Expectancy, TargetUnits` (§6) | same | | `core/src/level.ts`, `core/src/exits.ts` |
| `TriggerTime, SendTime, FillTime, ObsLatency, DecisionLatency, ExchangeLatency, Latency, FillPrice, FillWindow, Slippage, SlipTicks, SlipCoef, Vol100ms, QueueProxy, RoundTripCost, BreakevenHitRate, TakerFee, MakerFee, MaxPending` (§7) | same | | `core/src/execution.ts` |
| `TrendEfficiency, VolRatio, RegimeWindow, SweepCount, MaxSweeps, ReturnImbalance, Burst, UseCount` (§8) | same | | `core/src/regime.ts`, `core/src/level.ts` |
| `TradeRing, BucketBuilder, Zigzag, PivotStore, LevelBook` and the states `PIVOT_PENDING, WICK_ACTIVE, SWEEPING, SWEEP_CONFIRMED, ORDER_ARMED, IN_TRADE, CLOSED, INVALIDATED, EXPIRED, CANCELLED` (§9.1) | same | classes / `LevelState` enum | `core/src/*.ts` |
| `ApproachTol, ReactionWindow, ReactionDisplacement, ReactionHit` (§9.2) | same | | `backtest/src/reaction.ts` |
| `RiskFraction, RiskPerTrade, Qty, g, DailyLossLimit` (§11) | same | | `core/src/sizing.ts` |

Engineering names introduced by this document (not in `strategy.md`) are camelCase and are listed where they are introduced: `CanonicalTrade`, `MergedEvent`, `seq`, `InstrumentMeta`, `VenueAdapter`, `HygieneReport`, `blacklist`, `RETIRED`, `BurstPivot`, `Unresolved`, `volumeDay`, `dayIndex`, `runManifest`, `cellId`, `foldId`.

---

## 2. Data pipeline specification (`packages/data`)

### 2.1 Venue adapter contract

Every venue implements exactly this interface. **Adding a venue = adding one file `data/src/venues/<venue>.ts` that exports a `VenueAdapter`, plus one row in `data/src/venues/index.ts`.** Nothing else in the workspace may reference a venue by name (lint: `wsr/no-venue-literal` outside `data/src/venues/`).

```ts
// packages/data/src/venue.ts
export type VenueId = 'binance' | 'bybit' | 'okx' | 'bitget' | 'gate' | 'kucoin';

export type Ms = number;          // integer milliseconds since Unix epoch, UTC
export type Ticks = number;       // integer, price / Tick
export type Lots = number;        // integer, base-asset size / LotSize
export type Side = 1 | -1;        // §2.1: +1 buy aggressor, −1 sell aggressor

export interface UtcDay { readonly y: number; readonly m: number; readonly d: number; } // UTC calendar day

export interface CanonicalTrade {
  readonly venue: VenueId;
  readonly symbol: string;        // canonical symbol, e.g. 'ETHUSDT' (Spec §2.3)
  readonly tradeId: string;       // venue trade id as string (never parsed as number: may be UUID)
  readonly t: Ms;                 // ms; sub-ms venue precision truncated (Spec §2.3.1)
  readonly seq: number;           // 0-based position in the venue's own delivery order within the day (tie-break)
  readonly p: Ticks;              // integer ticks at the Tick in force at t
  readonly q: Lots;               // integer lots, base-asset units (contract multipliers applied)
  readonly s: Side;               // aggressor (taker) side, from the venue's explicit field only
}

export interface RateLimit {
  readonly requestsPerSecond: number;   // token-bucket refill rate
  readonly burst: number;               // token-bucket capacity
  readonly concurrent: number;          // max in-flight requests
}

export interface RetryPolicy {
  readonly maxAttempts: number;         // default 6
  readonly baseDelayMs: number;         // default 500
  readonly maxDelayMs: number;          // default 60_000
  readonly multiplier: number;          // default 2, full jitter (Spec §2.6.4)
  readonly retryOn: ReadonlyArray<number | 'ECONNRESET' | 'ETIMEDOUT' | 'checksum'>; // HTTP status codes + errors
}

export interface DayAvailability {
  readonly day: UtcDay;
  readonly source: 'archive' | 'rest' | 'unavailable';
  readonly expectedChecksum?: { readonly algo: 'sha256' | 'md5'; readonly value: string }; // when the venue publishes one
}

export interface RawDayPayload {
  readonly day: UtcDay;
  readonly source: 'archive' | 'rest';
  readonly bytes: Uint8Array | AsyncIterable<Uint8Array>;   // archive file body, or concatenated REST pages
  readonly contentType: 'csv' | 'csv.gz' | 'zip' | 'jsonl';
  readonly checksumVerified: boolean;                       // true only if a venue-published checksum matched
  readonly restPageCount?: number;
}

export interface InstrumentMeta {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly venueSymbol: string;           // e.g. 'ETH-USDT-SWAP'
  readonly Tick: number;                  // price tick as decimal string parsed exactly (Spec §3.11)
  readonly LotSize: number;               // base-asset units per lot (after contract multiplier)
  readonly contractMultiplier: number;    // base units per contract (1 if venue quotes base units directly)
  readonly TakerFee: number;              // fraction, e.g. 0.00055
  readonly MakerFee: number;
  readonly fundingIntervalHours: number;  // 8 (or 4 on some venues) [VERIFY]
  readonly validFrom: Ms;                 // tick/lot history: one record per change (Spec §2.3.2)
}

export interface FundingRecord { readonly t: Ms; readonly rate: number; } // signed fraction per interval

export interface VenueAdapter {
  readonly id: VenueId;
  readonly rateLimit: RateLimit;
  readonly retryPolicy: RetryPolicy;
  readonly timestampResolution: 'ms' | 'us' | 'ns' | 's_fractional';
  readonly feedKind: 'raw' | 'aggregated';            // Spec §2.2: raw required; aggregated is a flagged quirk
  readonly tradeIdKind: 'monotonic_int' | 'uuid' | 'opaque';

  /** Canonical → venue symbol, e.g. 'ETHUSDT' → 'ETH-USDT-SWAP'. Pure. */
  toVenueSymbol(symbol: string): string;

  /** Which UTC days in [from, to] can be obtained, and from which source. Must not download trade data. */
  listAvailable(symbol: string, from: UtcDay, to: UtcDay): Promise<ReadonlyArray<DayAvailability>>;

  /** Obtain one UTC day of raw trades. Must be idempotent and honour rateLimit/retryPolicy. */
  fetch(symbol: string, day: UtcDay, opts: { readonly signal: AbortSignal }): Promise<RawDayPayload>;

  /** Parse the raw payload into canonical records in venue delivery order. Pure except for meta lookup. */
  normalise(raw: RawDayPayload, meta: InstrumentMetaHistory): AsyncIterable<CanonicalTrade>;

  /** Instrument metadata now, plus historical tick/lot changes where the venue exposes them. */
  fetchInstrumentMeta(symbol: string): Promise<InstrumentMetaHistory>;

  /** Funding-rate history for [from, to]; empty array if the venue exposes none (Spec §4.7). */
  fetchFunding(symbol: string, from: Ms, to: Ms): Promise<ReadonlyArray<FundingRecord>>;
}

export interface InstrumentMetaHistory {
  readonly records: ReadonlyArray<InstrumentMeta>;      // sorted by validFrom ascending
  at(t: Ms): InstrumentMeta;                              // last record with validFrom ≤ t
}
```

**Contract invariants (tested in Spec §11.5 with recorded fixtures):**

1. `normalise` never derives `s` from a price change. If the venue payload lacks an explicit taker-side / buyer-is-maker field, `normalise` throws `MissingAggressorField` and the venue is marked unusable (§2.1 requires `s_i`).
2. `normalise` yields records in the venue's delivery order and assigns `seq` = 0,1,2,… in that order; sorting is done later by the merge step, not by the adapter.
3. `p` and `q` are produced by exact decimal-string arithmetic (Spec §3.11), never by `parseFloat(price) / tick`.
4. `fetch` for the same `(symbol, day)` returns byte-identical payloads for archive sources; for REST sources it returns the same *set* of trades (order may differ across runs — the merge step sorts).

### 2.2 Per-venue sections

All six venues: instrument type is the **USDT-margined linear perpetual** (§9.3: trade the venue you will trade; ETHUSDT-class). Every cell below is **[VERIFY]** at build time; the engineer records the verified endpoint, field names and rate limits in `data/src/venues/<venue>.ts` header comments with the documentation URL and the date checked. Fee values are placeholders to be replaced from the venue's *current* VIP-0 futures schedule.

| | Binance | Bybit | OKX | Bitget | Gate | KuCoin |
|---|---|---|---|---|---|---|
| Venue symbol for `ETHUSDT` | `ETHUSDT` (USDⓈ-M) | `ETHUSDT` (linear) | `ETH-USDT-SWAP` | `ETHUSDT` + `productType=USDT-FUTURES` | `ETH_USDT` (futures/usdt) | `ETHUSDTM` |
| Data source | **Bulk archive**: `data.binance.vision/data/futures/um/daily/trades/{SYM}/{SYM}-trades-{YYYY-MM-DD}.zip` (raw trades; **not** `aggTrades`) | **Bulk archive**: `public.bybit.com/trading/{SYM}/{SYM}{YYYY-MM-DD}.csv.gz` | **Bulk archive** via the OKX historical-data download (CDN path under `static.okx.com/cdn/okex/traderecords/trades/daily/{YYYYMMDD}/…`); fall back to REST `GET /api/v5/market/history-trades` (paginated by `after`=tradeId, ≤100/req, limited look-back) | REST `GET /api/v2/mix/market/fills-history` (`startTime`,`endTime`,`limit≤1000`,`idLessThan` cursor); check whether a bulk download exists — if it does, prefer it | **Bulk archive**: `download.gatedata.org/futures_usdt/trades/{YYYYMM}/{SYM}-{YYYYMM}.csv.gz` (monthly); fall back to REST `GET /api/v4/futures/usdt/trades` (`from`,`to`,`last_id`, ≤1000/req) | **No archive and no deep REST history known** (`GET /api/v1/trade/history` returns only the most recent ~100 trades). Adapter is a **forward recorder** on WebSocket topic `/contractMarket/execution:{SYM}`; `listAvailable` reports `unavailable` for any day not recorded locally |
| Pagination / cursor | none (one file/day); `.CHECKSUM` sidecar (sha256) | none (one file/day); no checksum published | archive: none; REST: `after` = last tradeId, walk backwards | `idLessThan` = last `tradeId`, walk backwards within `[startTime,endTime]`; window limits apply | archive: none; REST: `last_id` cursor, `from/to` window limits apply | WebSocket `sequence` for gap detection; reconnect must resume and detect sequence gaps → hygiene gap interval |
| Rate limit (start values) | 5 req/s to data.binance.vision; REST weight limits N/A | 2 req/s | 10 req/s (REST 20 req/2s) | 10 req/s | 5 req/s | 1 WS connection, ping 18 s |
| Timestamp field / resolution | `time`, ms | `timestamp`, seconds with fractional part (resolution to be measured from data; treat as ms) | `created_time`, ms | `ts`, ms | `create_time_ms` (REST) / `timestamp` (archive), ms | `ts`, **ns** → truncate to ms, keep ns in `tNsRemainder` sidecar column |
| Aggressor `s` from | `is_buyer_maker` (`true` → `s=−1`, `false` → `s=+1`) | `side` = taker side (`Buy`→`+1`, `Sell`→`−1`) | `side` = taker side (`buy`/`sell`) | `side` = taker side (`buy`/`sell`) | archive `side`/REST `size` sign: **confirm which field encodes the taker side** (Gate documents `size` sign as taker direction) | `side` = taker side (`buy`/`sell`) |
| Feed kind | raw fills | raw fills | raw fills (archive `trades`, not `aggtrades`) | raw fills | raw fills | raw fills |
| Trade-ID semantics | monotonic int per symbol | `trdMatchID` UUID (not ordered) → order by `(t, file order)` | monotonic int per instrument | monotonic int | monotonic int | `tradeId` opaque string + `sequence` monotonic int |
| Size units | base asset (ETH) | base asset | **contracts**; multiply by `ctVal` (ETH-USDT-SWAP: 0.1 ETH) | base asset | **contracts**; multiply by `quanto_multiplier` (ETH_USDT: 0.01 ETH) | **contracts**; multiply by `multiplier` (ETHUSDTM: 0.01 ETH) |
| Instrument meta endpoint | `GET /fapi/v1/exchangeInfo` (`PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize`) | `GET /v5/market/instruments-info?category=linear` | `GET /api/v5/public/instruments?instType=SWAP` (`tickSz`,`lotSz`,`ctVal`) | `GET /api/v2/mix/market/contracts` | `GET /api/v4/futures/usdt/contracts` (`order_price_round`, `quanto_multiplier`) | `GET /api/v1/contracts/active` (`tickSize`,`multiplier`) |
| Funding history | `GET /fapi/v1/fundingRate` | `GET /v5/market/funding/history` | `GET /api/v5/public/funding-rate-history` | `GET /api/v2/mix/market/history-fund-rate` | `GET /api/v4/futures/usdt/funding_rate` | `GET /api/v1/contract/funding-rates` |
| Fee placeholders (taker / maker, VIP 0) | 5.0 / 2.0 bps | 5.5 / 2.0 bps | 5.0 / 2.0 bps | 6.0 / 2.0 bps | 5.0 / 1.5 bps | 6.0 / 2.0 bps |
| Last-price trigger available for stop orders (§6.3) | `workingType=CONTRACT_PRICE` | `triggerBy=LastPrice` | `triggerPxType=last` | `triggerType=fill_price` | `price_type=0` | `stopPriceType=TP` |
| Known quirks | Header row present in futures CSVs; `quote_qty` ignored; occasional duplicate day files after re-uploads (checksum decides) | Early files may lack a header; `tickDirection` ignored; symbol folder names case-sensitive | Archive publishes with 1–2 day delay; REST history limited look-back makes REST unsuitable for 12 months | REST window limits may cap look-back at 90 days [VERIFY]; if so **Bitget cannot satisfy §9.3's 12 months from REST alone** — record as coverage gap | Monthly files are large (GB); stream-decompress; contract size can change (`quanto_multiplier` history) | 12-month backfill impossible; KuCoin coverage = recorded span only, reported as such |

**Hard rule (§2.1, §9.5 "aggregated vs raw prints"):** if a venue only offers a pre-aggregated feed, the adapter sets `feedKind='aggregated'`, the hygiene report flags the partition, and the merge step (Spec §2.4) is still applied; results for that venue are labelled `feedKind=aggregated` in every report.

### 2.3 Canonical record schema

#### 2.3.1 Schema (Parquet, both raw and merged)

| Column | Type | Raw | Merged | Notes |
|---|---|---|---|---|
| `venue` | dictionary(utf8) | ✓ | ✓ | |
| `symbol` | dictionary(utf8) | ✓ | ✓ | canonical symbol |
| `tradeId` | utf8 | ✓ | — | |
| `t` | int64 | ✓ | ✓ | ms UTC |
| `tNsRemainder` | int32 | ✓ | — | 0 unless venue has sub-ms precision (KuCoin) |
| `seq` | int64 | ✓ | ✓ | raw: venue delivery order; merged: index in merged day |
| `p` | int64 | ✓ | ✓ | ticks at `Tick(t)` |
| `q` | int64 | ✓ | ✓ | lots |
| `s` | int8 | ✓ | ✓ | +1 / −1 |
| `n` | int32 | — | ✓ | number of raw records merged into this event |
| `pFirst` | int64 | — | ✓ | first raw price in the merged group (for hygiene only) |
| `rawSeqFirst` | int64 | — | ✓ | `seq` of first raw record |

**`Tick` and lot size** come from `InstrumentMetaHistory.at(t)` (Spec §2.1). `p = round(price / Tick)` computed in exact decimal (Spec §3.11); if `price / Tick` is not an integer within `1e-9` relative tolerance the record is a **bad print** (Spec §2.6.1) and is stored with `p` rounded and flagged. `q = round(size × contractMultiplier / LotSize)` likewise.

#### 2.3.2 Tick-size changes

- `InstrumentMetaHistory` stores one `InstrumentMeta` per change with `validFrom`. Sources: the venue's instrument endpoint gives the *current* value only; historical changes are detected by the hygiene check `tickSizeChange` (Spec §2.6.1): a day whose price decimals imply a finer/coarser tick than the metadata. When detected, the pipeline writes a new `InstrumentMeta` record with `validFrom` = first trade of that day (**[VERIFY]** venue announcements for the exact time) into `meta/{venue}/{symbol}/instrument_history.json`, re-normalises the affected partitions, and records the change in the hygiene report.
- A tick-size change **inside the replay span** is a hygiene event: the backtest treats the change instant as a blacklist boundary (Spec §2.6.3) and the engine re-bases all integer-tick state (`ResetOnTickChange`, Spec §3.11).

#### 2.3.3 Canonical symbols

Canonical symbol = base + `USDT` in upper case, no separators (`ETHUSDT`, `BTCUSDT`, `<LOWCAP>USDT`). The low-cap perp is configured as `data.lowCapSymbol` and must exist on the venue being run.

### 2.4 Merge rule (§2.1)

§2.1: "merge records with identical `(t_i, s_i)` and monotone prices into one aggressor event. All counts below refer to merged events." The exact algorithm:

```
Input:  raw records of one (venue, symbol, day), possibly unordered.
Step 1  Stable sort by (t asc, seq asc).                                     // seq = venue delivery order
Step 2  Scan; maintain current group G = { t, s, pPrev, pFirst, qSum, n, rawSeqFirst }.
        For record r:
          startNew = (G is empty)
                   || r.t !== G.t
                   || r.s !== G.s
                   || (G.s === +1 && r.p <  G.pPrev)     // buy aggressor: prices must be non-decreasing
                   || (G.s === -1 && r.p >  G.pPrev)     // sell aggressor: prices must be non-increasing
          if startNew: flush G (if non-empty); G = new group from r
          else:        G.qSum += r.q; G.pPrev = r.p; G.n += 1
Step 3  flush G.
Output: MergedEvent { t, seq: k (0-based output index), p: G.pPrev, q: G.qSum, s, n, pFirst, rawSeqFirst }
```

Decisions (Appendix A-1..A-3): the merged event's price `p` is the **last** (= most extreme in the aggressor direction) price of the monotone run, because §3.1 says the extreme *fill* is where stops were placed beyond; non-monotone same-`(t,s)` records start a new event rather than being merged as a VWAP; records with identical `(t, s, p)` merge (a run of equal prices is monotone). Raw and merged are both stored (§2.1 keeps raw for hygiene and re-merging under a changed rule).

Merging never crosses a UTC day boundary (partition boundary). A group split by midnight is at most one event of error per day and is recorded in the hygiene report as `midnightSplit=true` when the first record of the day has the same `(t,s)` as the last of the previous day.

### 2.5 Storage

| Aspect | Rule |
|---|---|
| Format | Apache Parquet, zstd compression (level 3), row groups of 1,048,576 rows, dictionary encoding on `venue`,`symbol`, delta-binary-packed on `t`,`seq`,`p`; written with `parquet-wasm` from an Arrow table **[VERIFY]**. Rationale: columnar, compressed, inspectable by DuckDB/pandas for research cross-checks. |
| Layout | `{dataRoot}/{kind}/{venue}/{symbol}/{YYYY}/{YYYY-MM-DD}.parquet` with `kind ∈ {raw, merged}`; `{dataRoot}/meta/{venue}/{symbol}/instrument_history.json`, `funding.parquet`; `{dataRoot}/hygiene/{venue}/{symbol}/{YYYY-MM-DD}.json` |
| Partition key | `venue/symbol/date` (UTC calendar day). Monthly archives (Gate) are split into daily partitions by the adapter's `normalise` output. |
| Append-only | A partition file is written to `{path}.tmp-{pid}-{rand}` then atomically renamed. Existing complete partitions are never rewritten except by `wsr data rebuild --force`. |
| Completion marker | `{path}.done` JSON: `{ schemaVersion, rowsRaw, rowsMerged, sha256Raw, sha256Merged, source, checksumVerified, fetchedAt, adapterVersion }`. A partition without `.done` is incomplete and is re-fetched. |
| Idempotency | `wsr data fetch` skips partitions whose `.done` exists and whose `schemaVersion` and `adapterVersion` match; otherwise re-fetches. Same inputs → byte-identical merged Parquet (writer must be deterministic: no timestamps in Parquet metadata other than `.done`). |
| Resumability | Work queue over `(venue, symbol, day)` sorted ascending; `SIGINT` finishes the in-flight partition or discards its `.tmp`; rerun resumes from the first missing `.done`. |
| Retry | Token-bucket per adapter (`rateLimit`); exponential backoff with full jitter per `retryPolicy`; a checksum mismatch counts as a retryable failure (max 2 extra attempts) then a hard failure recorded in hygiene as `checksumFailed`. |
| Checksums | Where the venue publishes one (Binance `.CHECKSUM`), verify before normalising; else compute and store our own sha256 of the payload in `.done`. |
| Schema versioning | `schemaVersion` integer embedded in Parquet key-value metadata (`wsr.schemaVersion`) and in `.done`. Readers refuse a mismatched major version. Current: `1`. |
| Retention | Raw is kept; merged can be regenerated with `wsr data merge --force`. |

### 2.6 Data-hygiene report (§9.5)

#### 2.6.1 Checks per partition (`venue/symbol/day`)

| Check id | Definition | Output |
|---|---|---|
| `duplicateTradeIds` | count of raw `tradeId` values occurring > 1 time; duplicates beyond the first are **dropped** before merge and listed (first 100) | count, sample |
| `nonMonotoneTimestamps` | number of raw records where `t` decreased relative to the previous record *in delivery order* before sorting | count; if > 0.1 % of records → partition flagged `suspect` |
| `gaps` | intervals `[tStart, tEnd]` with no prints for longer than `GapThresholdMs = max(60_000, 20 × median inter-print gap of the day)`; each gap becomes a **blacklist interval** `[tStart − 0, tEnd + GapPadMs]` with `GapPadMs = 60_000` | explicit interval list |
| `dayBoundaryGap` | first print of the day later than `00:00:00 + GapThresholdMs`, or last print earlier than `24:00:00 − GapThresholdMs` (outage spanning midnight) | interval |
| `tickSizeChange` | fraction of raw prices that are not integer multiples of `Tick(t)` from metadata; > 0 → change detected (Spec §2.3.2) | flag + inferred tick |
| `badPrints` | raw records with `price ≤ 0`, `size ≤ 0`, or price deviating > `BadPrintMult = 20 × VolUnit_dayProxy` from both neighbours (`VolUnit_dayProxy` = median 60-s range of the day); dropped and listed | count, sample; the print's `t` ± 1 s becomes a blacklist interval |
| `aggregatedFeed` | `adapter.feedKind === 'aggregated'` | flag |
| `mergeStats` | rows raw, rows merged, mean `n`, max `n` | stats |
| `midnightSplit` | Spec §2.4 | flag |
| `fundingCoverage` | funding records present for each expected funding timestamp of the day; missing → listed | list |
| `checksumFailed` | Spec §2.5 | flag (partition excluded from replay) |

#### 2.6.2 Report schema

```ts
export interface HygieneReport {
  readonly schemaVersion: 1;
  readonly venue: VenueId; readonly symbol: string; readonly day: string;      // 'YYYY-MM-DD'
  readonly rowsRaw: number; readonly rowsMerged: number;
  readonly duplicateTradeIds: { readonly count: number; readonly sample: readonly string[] };
  readonly nonMonotoneTimestamps: number;
  readonly gaps: ReadonlyArray<{ readonly tStart: Ms; readonly tEnd: Ms; readonly reason: 'gap' | 'dayBoundary' | 'badPrint' | 'tickChange' | 'checksum' | 'wsSequenceGap' }>;
  readonly tickSizeChange: { readonly detected: boolean; readonly inferredTick?: string };
  readonly badPrints: { readonly count: number; readonly sample: ReadonlyArray<{ tradeId: string; t: Ms; price: string }> };
  readonly aggregatedFeed: boolean;
  readonly mergeStats: { readonly meanN: number; readonly maxN: number };
  readonly midnightSplit: boolean;
  readonly fundingMissing: readonly Ms[];
  readonly checksumFailed: boolean;
  readonly suspect: boolean;
  readonly blacklist: ReadonlyArray<{ readonly tStart: Ms; readonly tEnd: Ms; readonly reason: string }>; // union of all intervals above, merged & sorted
}
```

#### 2.6.3 How the backtest consumes the blacklist

The replay driver (`@wsr/backtest`) loads all `HygieneReport.blacklist` intervals for the span, merges overlapping intervals, and passes them to the engine as `BlacklistIntervals` (sorted `Int64Array` pairs). Engine behaviour inside a blacklist interval, per print:

1. Prints inside an interval **are still fed** to `BucketBuilder`, `SpreadEst` and `Zigzag` (they are real prints; dropping them would create artificial gaps).
2. **No pivot confirmed inside an interval, and no pivot whose `[EnterTime, ExitTime + RetraceWindow]` overlaps an interval, becomes a `WickLevel`**: it is stored in `PivotStore` with class `Unresolved` (reason `blacklist`) and excluded from every level set and from `RankWindow` (§8.7 analogue: features unrepresentative).
3. Arming is suppressed while inside an interval (same mechanism as the liquidity guard, §8.8/§8.10: `ORDER_ARMED → SWEEP_CONFIRMED`, reason `blacklist`).
4. An open position keeps its exits (§8.8 "Open positions keep their exits"). Fills that fall inside a gap interval use the no-print fallback of §7.2.
5. The report lists `blacklistedBuckets / totalBuckets` per fold.

The optional §8.7 robustness variant (`blacklistMacroReleases`, `blacklistFunding`) adds `±2 min` around configured macro-release timestamps (config file `macro_releases.json`, user-supplied) and around every funding timestamp from `funding.parquet` to the same interval set.

### 2.7 CLI contract (`wsr data …`)

All commands: `--data-root <dir>` (default `./data`), `--config <file>` (Spec §8), `--log-level`, `--json` (machine-readable stdout). Exit codes are global (Spec §2.7.2).

| Command | Flags | Behaviour |
|---|---|---|
| `wsr data fetch` | `--venue <id>[,<id>…]` (default all six), `--symbol <s>[,…]` (default `ETHUSDT,BTCUSDT,<lowCapSymbol>` §9.3), `--from YYYY-MM-DD` (default run date − 12 months − `WarmupDays` (Spec §3.2.4) − 7), `--to YYYY-MM-DD` (default yesterday UTC), `--concurrency <n>` (default 2 per venue), `--dry-run` | Plan via `listAvailable`, then fetch, normalise, merge, write raw+merged+hygiene+`.done`. Prints per-partition status. Coverage default satisfies §9.3 "≥ 12 months ending at run date" plus warm-up. |
| `wsr data merge` | `--venue`, `--symbol`, `--from`, `--to`, `--force` | Re-run Spec §2.4 from stored raw partitions (rule change or schema bump). |
| `wsr data hygiene` | same selectors, `--summary` | (Re)compute hygiene reports; print a coverage table: days requested / present / suspect / blacklisted-minutes. |
| `wsr data meta` | `--venue`, `--symbol` | Fetch instrument meta, fee placeholders (marked `[VERIFY]` in the file until the engineer sets `verifiedAt`), funding history. |
| `wsr data verify` | selectors | Recompute sha256 of every partition and compare with `.done`; exit 4 on mismatch. |
| `wsr data record` | `--venue kucoin --symbol …` | Forward recorder (WebSocket) for venues with no history; writes daily partitions at UTC midnight rollover. |

#### 2.7.2 Exit codes (all `wsr` commands)

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | usage / config validation error |
| 2 | partial failure: some partitions failed after retries (list printed); completed partitions are valid |
| 3 | **reaction test failed — P&L backtest not run** (Spec §6.1.6) |
| 4 | data integrity failure (checksum / schema mismatch) |
| 5 | look-ahead or determinism invariant violated at runtime (Spec §9) — always a bug |
| 130 | interrupted (SIGINT) after clean partition finish |

---

## 3. Core engine specification (`packages/core`)

All modules are pure, synchronous, allocation-free on the hot path, and driven by one `Engine.onPrint(event)` call per merged event (Spec §3.10). Every module exposes `snapshot()` for tests and `reset()` for tick-size re-basing. Complexity budgets are per merged event unless stated.

### 3.0 Shared types

```ts
// packages/core/src/types.ts
export type Ms = number; export type Ticks = number; export type Lots = number; export type Side = 1 | -1;
export type Buckets = number;          // volume-clock length in buckets, may be fractional (Spec §3.5.2)

export interface MergedEvent {          // struct-of-arrays on the hot path; this is the logical record
  readonly t: Ms; readonly seq: number; readonly p: Ticks; readonly q: Lots; readonly s: Side; readonly n: number;
}

export interface Bucket {               // §2.2 fields, all fixed at close
  readonly k: number;                   // 0-based bucket index since engine start
  readonly dayIndex: number;            // UTC day index of the bucket's close print
  readonly tOpen: Ms; readonly tClose: Ms;
  readonly volOpen: Lots; readonly volClose: Lots;   // cumulative Vol at first / last print
  readonly High_k: Ticks; readonly Low_k: Ticks;
  readonly Imbalance_k: Lots;           // Σ s_i q_i
  readonly Vwap_k: number;              // float, ticks; Σ p q / Σ q
  readonly Count_k: number;
  readonly WallDuration_k: Ms;          // tClose − tOpen
  readonly targetVolume: Lots;          // BucketVolume in force when the bucket opened
  readonly maxPrintGap_k: Ticks;        // max |p_i − p_{i−1}| inside the bucket (§8.7 burst input)
}

export type PivotKind = 'PivotHigh' | 'PivotLow';
export interface Pivot {                // §3.1 emission
  readonly kind: PivotKind; readonly side: Side;        // PivotHigh ⇒ side=+1 (upper), PivotLow ⇒ side=−1
  readonly price: Ticks;                // = LegExtreme at emission
  readonly time: Ms; readonly seq: number;             // = LegExtremeTime (+ seq of that print)
  readonly confirmed_at: Ms; readonly confirmedSeq: number;
  readonly confirmedVol: Lots;          // Vol at confirmation
  readonly pivotId: number;             // monotone
}
```

### 3.1 `TradeRing`

| | |
|---|---|
| Responsibility | Bounded history of merged events for backward look-ups by time, sequence and volume clock (§9.1 "ring of merged events covering ≥ 2·UnitWindow buckets"). |
| Implements | §9.1, Appendix A (`ring.index_at`, `last_before`, `first_after`) |
| Capacity | `capacityEvents` chosen at run start so that the ring holds **≥ 2·UnitWindow = 120 buckets** of volume: `capacity = max(2^21, 2 × ceil(2·UnitWindow × BucketVolume_0 / medianEventSize_0)) ` rounded up to a power of two, where the `_0` values come from the warm-up day. If at any time the ring holds fewer than `2·UnitWindow` completed buckets, the engine sets `ringUnderflow=true`, doubles capacity (copy) and logs; underflow during a fold is reported. |
| Storage | Struct of typed arrays: `t: Float64Array` (ms; Float64 avoids BigInt cost, exact below 2^53), `seq: Float64Array`, `p: Int32Array` (ticks; Spec §3.11 asserts range), `q: Float64Array` (lots; exact integers), `s: Int8Array`, `n: Int32Array`, `vol: Float64Array` (cumulative `Vol` after this event), `bucketK: Int32Array`. |
| Public interface | see below |
| Update per print | `push(e, volAfter, bucketK)`: O(1). |
| Complexity | `indexAtTime`, `indexAtVol`: O(log N) binary search; `lastBefore/firstAfter(predicate)`: O(span). |

```ts
export class TradeRing {
  constructor(capacity: number);
  push(e: MergedEvent, volAfter: Lots, bucketK: number): number;   // returns absolute index (monotone, never wraps)
  get size(): number; get oldestIndex(): number; get newestIndex(): number;
  at(i: number): MergedEventView;                                   // throws RingEvicted if i < oldestIndex
  indexAtVol(vol: Lots): number;         // first index with ring.vol[i] ≥ vol
  indexAtTime(t: Ms): number;            // first index with t_i ≥ t
  lastBefore(i: number, pred: (view: MergedEventView) => boolean): number | -1;
  firstAfter(i: number, pred: (view: MergedEventView) => boolean): number | -1;   // -1 = not yet observed
  // typed-array windows for feature computation; views are valid until the next push
  window(iFrom: number, iTo: number): RingWindow;   // { t, p, q, s, n, vol, length } subarrays (no copy when contiguous)
}
```

### 3.2 `BucketBuilder` (§2.2)

| | |
|---|---|
| Responsibility | Partition the merged stream into volume buckets; maintain the volume clock `Vol`; on bucket close refresh every bucket-derived statistic **exactly once** (§2.2 "bucket statistics only from completed buckets"; §9.1 "on BucketVolume reached → push bucket, refresh VolUnit_now, RVol, TrendEfficiency, BurstFlag, LiquidityGuard, SpreadEst"). |
| Internal state | `Vol` (cumulative lots), `BucketVolume` (current), `BucketVolume_next` (takes effect at next bucket open), accumulator for the open bucket, `dayIndex`, completed-bucket history as struct of typed arrays sized `BucketHistory = 2·1440` (two volume-days; Spec §3.2.5), 60-s volume histogram for the daily `BucketVolume` computation, hour-of-day 100-ms volume profile (Spec §4.2.3). |

#### 3.2.1 Update rule per print

```
onPrint(e):
  if utcDay(e.t) > dayIndex:  onNewDay(utcDay(e.t))           // Spec §3.2.3
  Vol += e.q
  acc.High = max(acc.High, e.p); acc.Low = min(acc.Low, e.p)
  acc.Imbalance += e.s * e.q; acc.SumPQ += e.p * e.q; acc.SumQ += e.q; acc.Count += 1
  acc.maxPrintGap = max(acc.maxPrintGap, |e.p − pPrev|)   (pPrev = previous merged event price; 0 for the first)
  if acc.Count == 1: acc.tOpen = e.t; acc.volOpen = Vol − e.q
  if acc.SumQ ≥ BucketVolume:                              // §2.2: bucket "containing BucketVolume of traded size"
      close bucket k with tClose = e.t, volClose = Vol      // event assigned wholly; overshoot allowed (A-4)
      emit BucketClosed(k) → engine refreshes statistics in the fixed order of Spec §3.10 step 2
      BucketVolume = BucketVolume_next; open bucket k+1 (empty)
```

Rules: an event is never split across buckets (A-4). The bucket's `WallDuration_k = tClose − tOpen`. A bucket that is still open has **no** readable statistics (`BucketBuilder.current()` is not exposed to strategy modules; only `completed(k)`).

#### 3.2.2 `BucketVolume` (§2.2)

`BucketVolume` for UTC day `D` = median of traded volume per 60-s wall-clock window over the previous 7 UTC days (`D−7 … D−1`, 10 080 windows; empty windows count as 0). Computed once at the first print of day `D` (`onNewDay`) from the 60-s histogram that `BucketBuilder` maintains for the last 7 days; stored as `BucketVolume_next`; applied from the **next bucket open** (the in-flight bucket completes at its old target, A-5). Floor: `BucketVolume ≥ 1 lot`.

Bootstrap: if fewer than 7 prior days exist, use the available prior days (≥ 1). On the very first day of data there is no prior day: `BucketVolume` for that day = median 60-s volume over the day's first 60 minutes, applied from minute 61; the first 60 minutes are consumed only by `BucketBuilder`/`SpreadEst` (no buckets closed). This uses same-day data but only inside the warm-up span, which produces no pivots, levels, reaction events or trades (Spec §3.2.4, A-6).

#### 3.2.3 `onNewDay` (UTC calendar day boundary)

1. Compute `BucketVolume_next` (Spec §3.2.2).
2. Recompute the hour-of-day profile `Vol100ms[h]` and `ExpectedVolPerMs[h]` (Spec §4.2.3) from the previous 7 days.
3. The 24-h medians of the liquidity guard (Spec §3.2.6 #7) are rolling over buckets and are **not** touched here.
4. The daily kill switch **is not** reset here: the kill switch resets on **volume-day** boundaries (§11 "until next volume-day", Spec §3.2.5).

#### 3.2.4 Warm-up

The engine is in `warmup=true` until **all** of: 7 UTC days consumed (for `BucketVolume`, `Vol100ms`, `ExpectedVolume`), `UnitWindow` completed buckets (for `VolUnit_now`), 500 merged events (for `SpreadEst`), `RegimeWindow` completed buckets (for `TrendEfficiency`, `VolRatio`), 1440 completed buckets (for the 24-h medians of §8.8). During warm-up: no pivots are emitted (Spec §3.4), no levels exist, no reaction events, no trades. `WarmupDays` (Spec §2.7) = 8 calendar days by default; the replay span passed to the engine starts `WarmupDays` before the first fold's train window and the warm-up span is excluded from every statistic. `RankWindow` warm-up (Spec §3.7.2, `MinRankPivots`) is separate and longer.

#### 3.2.5 Volume-day

`volumeDay` = index `floor(k / 1440)` of completed bucket `k` counted from the end of warm-up (1440 buckets ≈ one median-liquidity day since a bucket ≈ one median-liquidity minute, §2.2). Used by: daily kill switch reset (§11), block bootstrap blocks (§9.2), `PriorTouches` look-back (§4.1: "last 24 h of volume-equivalent" = 1440 buckets), random-level time draws (Spec §6.1.3). Fold boundaries use calendar time (Spec §6.3).

#### 3.2.6 Statistics refreshed on bucket close (§9.1), in this order

| # | Quantity | Formula | Source |
|---|---|---|---|
| 1 | `SpreadEst_t` | Spec §3.3 | §2.1 |
| 2 | `VolUnit_now` | Spec §3.3 | §2.3 |
| 3 | `RVol_5`, `RVol_60` | `RVol_N = sqrt(EWMA_N((log Vwap_k − log Vwap_{k−1})²))`, `EWMA_N` with `α = 2/(N+1)`, seeded with the first observation | §2.3, §8.1 |
| 4 | `VolRatio = RVol_5 / RVol_60` | undefined (NaN → treated as 1) until 60 buckets | §8.1 |
| 5 | `TrendEfficiency = |Vwap_k − Vwap_{k−RegimeWindow}| / Σ_{j=k−RegimeWindow}^{k} (High_j − Low_j)`, `RegimeWindow = 60`; `TrendSign = sign(Vwap_k − Vwap_{k−RegimeWindow})` | denominator 0 → TE = 0 | §8.1 |
| 6 | `BurstFlag_k = (VolRatio > 3) ∨ (maxPrintGap_k > 3·VolUnit_now)` | evaluated with the *new* `VolUnit_now` | §8.7 |
| 7 | `LiquidityGuard = (SpreadEst_t > 2 × median(SpreadEst over last 1440 bucket closes)) ∨ (Σ WallDuration over last 5 buckets > 5 × 5 × median(WallDuration over last 1440 buckets))` — i.e. "the last 5 buckets took > 5× their median wall-clock duration" (A-7) | §8.8 |
| 8 | `PivotReversal_t = max(PivotMult·VolUnit_now, 3·Tick, 2·SpreadEst_t)` (integer ticks, ceil) | §3.1 |
| 9 | `eventSizeP99` = 99th percentile of `q` over the `TradeRing` contents (sampled: every 16th event, exact `nth_element`) — used by `MaxTradeSize` | §3.2 |
| 10 | `volumeDay`, kill-switch reset check | §11 |

Between bucket closes **none** of these change (§9.5 "Bucket look-ahead: any bucket statistic refreshed mid-bucket"). Test: Spec §11.2 `bucketStatsFrozenMidBucket`.

Complexity: O(1) amortised per print; O(log 1440) for the rolling medians (two order-statistic trees or sorted ring with binary insert) on close.

### 3.3 `VolUnit` and `SpreadEst` (§2.1, §2.3)

```ts
export class SpreadEst {
  constructor(eventWindow = 500);                                   // §2.1
  onPrint(p: Ticks, s: Side): void;   // keeps last 500 |p_i − p_{i−1}| where s_i ≠ s_{i−1} (ring of Int32)
  refresh(Tick: Ticks): Ticks;        // median of the ring, floored at Tick; returns SpreadEst_t
  get value(): Ticks;                 // last refreshed value
}
```

- **Refresh cadence.** §2.1 says "refresh every 100 events"; §9.1 lists `SpreadEst` among the statistics refreshed on bucket close. Resolution (A-8): the value **published** to consumers (`PivotReversal`, `MinSweepDepth`, `FillPrice`, liquidity guard) changes only on bucket close; the candidate median is recomputed at most every 100 events to bound cost, and the bucket-close refresh takes the latest candidate. No consumer may read a mid-bucket value (same test as Spec §3.2.6).
- Median is over the *sample* (fewer than 500 while warming up; undefined below 50 samples → `SpreadEst = Tick`).

```ts
export class VolUnit {
  constructor(UnitWindow = 60);                                     // §2.3, §10 (fixed)
  refresh(buckets: BucketHistory, k: number, Tick: Ticks, SpreadEst_t: Ticks): Ticks;
  // VolUnit_now = max( median(High_j − Low_j : j ∈ [k−UnitWindow+1, k]), 4·Tick, 3·SpreadEst_t )   (§2.3), integer ticks (ceil)
  get VolUnit_now(): Ticks;
}
```

- `VolUnit_created` is a `Level` field frozen at level creation = the `VolUnit_now` in force at the pivot's `confirmed_at` (A-9; §2.3 "freezes VolUnit_created at creation"). It is used for **all** level geometry: `BandEdge`, `SpikeSize`, `TopDwell` band, `MergeTolerance`, `Distance`, `MinSweepDepth`, `BreakoutDepth`, `ArmDistance`, `ApproachTol` in the reaction test, `TargetUnits` (§2.3, §3.2, §5, §6.1, §6.3, §6.5). `VolUnit_now` is used for: `PivotReversal`, `Slippage`, burst jump test, the regime ratio `VolUnit_now / VolUnit_created`, `ReactionDisplacement` normalisation for random levels (§2.3, §3.1, §7.2, §8.7, §5).
- `RVol` is kept for the regime filter only (§2.3: "Test the median range first… keep RVol for the regime filter").

### 3.4 `Zigzag` (§3.1, Appendix A)

| | |
|---|---|
| State | `LegDir ∈ {up, down, undefined}`, `LegExtreme: Ticks`, `LegExtremeTime: Ms`, `LegExtremeSeq`, `LegExtremeVol` |
| Input per print | `(t, seq, p, Vol)` and the current `PivotReversal_t` (Spec §3.2.6 #8; unchanged mid-bucket) |
| Output | `Pivot \| null` — at most one pivot per print (§3.1 pseudocode returns at most one) |
| Complexity | O(1) |

```
update(t, seq, p, vol, PivotReversal):
  if LegDir undefined:  (only after warm-up, Spec §3.2.4)  LegDir=up; LegExtreme=p; LegExtremeTime=t; ...; return null
  if LegDir == up:
     if p > LegExtreme:                       LegExtreme=p; LegExtremeTime=t; LegExtremeSeq=seq; LegExtremeVol=vol
     elif p ≤ LegExtreme − PivotReversal:     piv = PivotHigh(price=LegExtreme, time=LegExtremeTime, seq=LegExtremeSeq,
                                                              confirmed_at=t, confirmedSeq=seq, confirmedVol=vol, side=+1)
                                              LegDir=down; LegExtreme=p; LegExtremeTime=t; ...; return piv
  else (symmetric with min / +PivotReversal / PivotLow / side=−1)                                            (§3.1, App. A)
  return null
```

- **Look-ahead boundary (§3.1):** `LegExtreme`/`LegExtremeTime` are `private`; the only way to learn a pivot price is the emitted `Pivot`, which exists from `confirmed_at`. Test: Spec §11.2 `pivotNotVisibleBeforeConfirmedAt` (property test on random paths: no downstream state change may reference a price that is the current `LegExtreme`).
- `PivotReversal` uses `VolUnit_now` and `SpreadEst_t` as of the last bucket close (§3.1 `PivotReversal_t`).
- Variant `minExtremePrintQtyPct` (§3.1 "require the extreme print to have `q_i ≥` 10th percentile of trade size"): when enabled, a print updates `LegExtreme` only if `q ≥ eventSizeP10` (maintained like `eventSizeP99`, Spec §3.2.6 #9). Default off (`variant`).
- **Pivot merging (§3.1):** performed by `LevelBook.onPivot` (Spec §3.9.4), not by `Zigzag`: a new pivot within `MergeTolerance·VolUnit_created` (`MergeTolerance = 0.25`, fixed §10) of a level in state `WICK_ACTIVE` on the same side is not a new level; the level's `PriorTouches += 1` and `WickLevel` is set to the more extreme of the two prices (A-10: `VolUnit_created` and `WickStrength` are **not** recomputed on merge; `ExitTime` used by `Age` is not reset).

### 3.5 `ExcursionFeatures` (§3.2)

| | |
|---|---|
| Responsibility | For each emitted pivot, segment the excursion and compute the §3.2 feature table, waiting for `ExitTime` and `RetraceWindow` without peeking (§3.2 "wait until observed"; §9.5). |
| Internal state | A `PendingPivot` record per pivot in `PIVOT_PENDING` (Spec §3.9.6 state), holding `iPiv`, `iIn`, `iOut` (ring indices, −1 while unobserved), partial results. |
| Complexity | O(excursion length) once when `ExitTime` is observed, plus O(RetraceWindow prints) incremental min tracking; bounded by ring capacity. |

#### 3.5.1 Segmentation (§3.2, Appendix A) — written for `Side=+1`; `Side=−1` via side-normalised prices (Spec §3.12)

```
BandEdge  = PivotPrice − BandWidthMult · VolUnit_created                      (BandWidthMult start 0.5; integer ticks, ceil of the product)
iPiv      = ring index of the pivot print (by seq)
iIn       = ring.lastBefore(iPiv, e => e.p ≤ BandEdge)     → EnterTime = t[iIn]      ("last print before PivotTime with p ≤ BandEdge")
iOut      = ring.firstAfter(iPiv, e => e.p ≤ BandEdge)     → ExitTime  = t[iOut]     (−1 until observed → wait)
Approach  = ring[iIn .. iPiv]   (inclusive both ends, App. A);   Rejection = ring[iPiv .. iOut] (inclusive)
Anchor    = min p over prints with vol ∈ [vol[iIn] − AnchorWindow·BucketVolume, vol[iIn])   AnchorWindow = 20 buckets
```

- If `iIn = −1` (no print `≤ BandEdge` within the ring): the pivot is `Unresolved(reason=noEnter)` — stored, not a level, not a control (A-11). This can only happen for a drift longer than 120 buckets.
- If `iOut` is not observed by the time `Vol − confirmedVol > PendingLimit·BucketVolume` with `PendingLimit = 2·UnitWindow − AnchorWindow − RetraceWindow = 95` buckets (the ring would evict `Anchor` data): classify `SlowExtreme` with `featuresAvailable=false` (A-12: it is an extremum that was not rejected — the control-group class — but its features cannot be ranked, so it is excluded from `RankWindow` and from Stage B; it **is** in level set (2) of §9.2).
- **Early G2 verdict:** as soon as `ApproachDuration + (Vol − vol[iPiv])/BucketVolume > MaxSpikeDuration` with `iOut` still unobserved, G2 has already failed; the pivot's class is fixed as `SlowExtreme` **at that print** (its `classifiedAt`, needed by the reaction test, Spec §6.1) while feature computation continues until `iOut` or `PendingLimit` (A-13).

#### 3.5.2 Feature formulas (§3.2 table). Durations are volume-clock lengths in buckets; `dur(a,b) = max(vol[b] − vol[a], q[b]) / BucketVolume` (floored at one event's volume, A-14, cf. App. A `max(reject_vol, 1e-9)`).

| Feature | Exact formula (ticks/lots/buckets as stated) | Available at |
|---|---|---|
| `SpikeSize` | `(PivotPrice − Anchor) / VolUnit_created` | `ExitTime` (needs `Anchor`, which needs `iIn`; computed at confirmation but published with the set) |
| `ApproachVolume` | `Σ q` over Approach | confirmation |
| `RejectVolume` | `Σ q` over Rejection | `ExitTime` |
| `ApproachDuration` | `dur(iIn, iPiv)` | confirmation |
| `RejectDuration` | `dur(iPiv, iOut)` | `ExitTime` |
| `ApproachSpeed` | `(PivotPrice − BandEdge) / (VolUnit_created · ApproachDuration)` | confirmation |
| `RejectSpeed` | `(PivotPrice − BandEdge) / (VolUnit_created · RejectDuration)` | `ExitTime` |
| `SpeedAsymmetry` | `log(RejectSpeed / ApproachSpeed)` (natural log; both > 0 by construction) | `ExitTime` |
| `ApproachImbalance` | `+Side · Σ s q / ApproachVolume` over Approach ∈ [−1, 1] | confirmation |
| `RejectImbalance` | `−Side · Σ s q / RejectVolume` over Rejection ∈ [−1, 1] ("sell share of the rejection" for `Side=+1`) | `ExitTime` |
| `VolumeBurst` | `(ApproachVolume + RejectVolume) / ExpectedVolume`, `ExpectedVolume = (t[iOut] − t[iIn]) · ExpectedVolPerMs[hourOfDayUTC(t[iIn])]`, where `ExpectedVolPerMs[h]` = (total volume in hour `h` over the previous 7 days) / (7 · 3 600 000) (A-15), floored at 1 lot | `ExitTime` |
| `TopDwell` | `Σ q over prints in [iIn, iOut] with p ∈ [PivotPrice − TopBandMult·VolUnit_created, PivotPrice]` / `BucketVolume`, `TopBandMult = 0.15` | `ExitTime` |
| `RetraceFraction` | `(PivotPrice − min p over prints with vol ∈ [vol[iOut], vol[iOut] + RetraceWindow·BucketVolume]) / (PivotPrice − Anchor)`, `RetraceWindow = 5`; denominator ≤ 0 → feature = 0 | `ExitTime + RetraceWindow` buckets — **never before** (§9.5) |
| `MaxTradeSize` | `max q over [iIn, iOut] / eventSizeP99` (Spec §3.2.6 #9, value as of the last bucket close before `confirmed_at`) | `ExitTime` |
| `MaxAggressorRun` | longest run of consecutive events in Rejection with equal `s` (count of events) | `ExitTime` |
| `MaxPrintGap` | `max |p_i − p_{i−1}| over i ∈ (iIn, iOut] / VolUnit_created` (whole excursion; App. A shows the rejection half — the table says "inside the excursion", table wins, A-16) | `ExitTime` |

Feature record type:

```ts
export interface ExcursionFeatures {
  readonly SpikeSize: number; readonly ApproachVolume: Lots; readonly RejectVolume: Lots;
  readonly ApproachDuration: Buckets; readonly RejectDuration: Buckets;
  readonly ApproachSpeed: number; readonly RejectSpeed: number; readonly SpeedAsymmetry: number;
  readonly ApproachImbalance: number; readonly RejectImbalance: number; readonly VolumeBurst: number;
  readonly TopDwell: number; readonly RetraceFraction: number; readonly MaxTradeSize: number;
  readonly MaxAggressorRun: number; readonly MaxPrintGap: number;
  readonly EnterTime: Ms; readonly ExitTime: Ms; readonly Anchor: Ticks; readonly BandEdge: Ticks;
  readonly retraceAvailableAt: Ms;          // t of the print at which RetraceFraction became final
}
```

The sweep leg of a `SWEEPING` level is a zigzag pivot like any other and gets its own `ExcursionFeatures` through the same code path (§6.2 "The sweep leg gets its own Spike features"); `LevelBook` links it by `pivotId` (Spec §3.9.8, §8.5).

### 3.6 `SpikeGates` (§3.3)

```ts
export type PivotClass = 'WickLevel' | 'SlowExtreme' | 'BurstPivot' | 'Unresolved';
export interface GateResult { readonly cls: PivotClass; readonly failed: ReadonlyArray<'G1'|'G2'|'G3'|'G4'|'G5'|'G6'>; readonly classifiedAt: Ms; }

export function applyGates(f: ExcursionFeatures, cfg: GateConfig): GateResult;
```

| Gate | Rule (§3.3) | Default (§3.3/§10) |
|---|---|---|
| G1 | `SpikeSize ≥ MinSpikeSize` | 1.5 (grid) |
| G2 | `ApproachDuration + RejectDuration ≤ MaxSpikeDuration` | 3 buckets (sensitivity) |
| G3 | `RejectSpeed ≥ MinRejectSpeed` | 0.5 VolUnit/bucket |
| G4 | `RejectImbalance ≥ MinRejectImbalance` | 0.2 |
| G5 | `RetraceFraction ≥ MinRetrace` evaluated **only** at `retraceAvailableAt` | 0.6 within `RetraceWindow = 5` |
| G6 | `TopDwell ≤ MaxTopDwell` | 0.5 buckets |

- All six gates are evaluated at `retraceAvailableAt` (G5 is last available; §3.3 "G5 delays usability by up to `RetraceWindow` buckets"). Exception: the early G2 verdict (Spec §3.5.1) fixes `cls=SlowExtreme` earlier; `failed` is completed later for reporting.
- `cls=WickLevel` iff all six pass. Otherwise `SlowExtreme` (§3.3: "stored, never traded, used as the control group").
- **Burst exclusion (§8.7):** if any bucket whose close falls in `[vol[iIn], vol[iOut]]` has `BurstFlag`, or the bucket containing `confirmed_at` has `BurstFlag`, `cls = BurstPivot` regardless of gates ("no new WickLevels from pivots inside a burst window (features unrepresentative)"). `BurstPivot` is stored, never traded, **excluded** from `RankWindow` and from every §9.2 level set (A-17), and counted in the report.
- `classifiedAt` = `t` of the print at which the class became final. This is the level's *availability time* for the reaction test (Spec §6.1).

### 3.7 `WickStrength` (§4)

#### 3.7.1 Feature vector (§4.1)

`x = (SpikeSize, log RejectSpeed, SpeedAsymmetry, RejectImbalance, ApproachImbalance, VolumeBurst, TopDwell, RetraceFraction, MaxTradeSize, MaxAggressorRun, MaxPrintGap, PriorTouches, SpikeSize / RVol)` — 13 features, indices 0..12 in this order.

- `PriorTouches` at scoring time (§4.1) = number of earlier confirmed pivots (any class except `Unresolved`, same side) within `MergeTolerance·VolUnit_created` of `PivotPrice` whose `confirmed_at` lies within the last **1440 completed buckets** ("last 24 h of volume-equivalent", Spec §3.2.5) — a `PivotStore` range query (Spec §3.8).
- `RVol` in `SpikeSize / RVol` = `RVol_60` (in ticks: `RVol_60 · Vwap_k`, so the ratio is dimensionless like `SpikeSize`) as of the last bucket close before `confirmed_at` (A-18).

#### 3.7.2 Rolling-rank normalisation (§4.1)

`rank_j = (#{y ∈ W_j : y < x_j} + ½·#{y ∈ W_j : y = x_j} + ½) / (|W_j| + 1) ∈ (0, 1)`, where `W_j` is the multiset of feature `j` over the last `RankWindow = 500` confirmed pivots with `featuresAvailable=true` and class ∈ {`WickLevel`, `SlowExtreme`} (§4.1: "WickLevels and SlowExtremes together"), **excluding the pivot being scored** and any pivot whose `retraceAvailableAt` is in the future (no peeking). Implemented per feature as a sorted ring of 500 `Float64` with binary insert/remove (O(log RankWindow)). `WickStrength` is undefined (level not tradable, `WickStrength=NaN`) until `|W_j| ≥ MinRankPivots = 50` (A-19); such levels still enter `PivotStore` and level sets.

#### 3.7.3 Stage A (§4.2, no fitting)

```
WickStrength_0 = 0.15·rank(SpikeSize) + 0.20·rank(log RejectSpeed) + 0.10·rank(SpeedAsymmetry) + 0.20·rank(RejectImbalance)
               + 0.10·rank(VolumeBurst) + 0.10·(1 − rank(TopDwell)) + 0.05·rank(RetraceFraction) + 0.05·rank(MaxTradeSize)
               + 0.05·rank(MaxAggressorRun)                                                  (weights sum to 1.00)
```
`ApproachImbalance`, `PriorTouches`, `MaxPrintGap`, `SpikeSize/RVol` have weight 0 in the prior (§4.2 names the first two; the other two are absent from the weight list, hence 0, A-20).

#### 3.7.4 Stage B (§4.2, fitted per fold on train only) — model definition; fitting lives in `@wsr/backtest` (Spec §6.3.3)

```ts
export interface StageBModel {
  readonly foldId: number;
  readonly beta0: number; readonly beta: Float64Array;   // length 13, on rank features
  readonly lambda: number;                                // L2 penalty, default 1.0 on standardised ranks
  readonly ipwModel: { readonly gamma0: number; readonly gamma: Float64Array }; // P(approached | x)
  readonly minStrengthQuantile: number;                   // MinStrength realised on train (§4.3)
  readonly calibration: ReadonlyArray<{ bin: number; meanP: number; meanY: number; n: number }>;
}
export function stageBScore(m: StageBModel, ranks: Float64Array): number;   // σ(β0 + β·z), z_j = 2·rank_j − 1
```

- Label `y = ReactionHit` from §9.2 for levels that were approached; levels never approached have no label. **Inverse-probability weighting (§4.2):** fit `P(approached | x)` by unpenalised logistic regression on train (all `WickLevel`+`SlowExtreme` pivots with defined ranks); weight each labelled level by `w = 1 / max(P̂(approached | x), 0.05)`; fit the L2-penalised weighted logistic regression by IRLS / Newton with `λ = 1.0` (fixed, not optimised — it is not one of the six grid parameters, §9.3), 50 iterations max, tolerance `1e-8`, deterministic. Gradient boosting is **not** implemented in v1; the calibration table is reported so the §4.2 condition ("clearly non-monotone in ≥ 2 features") can be judged; if met, it is recorded as future work (A-21).
- `strengthModel ∈ {stageA, stageB}` config selects which score is `WickStrength`. Both are always computed and stored on the level (`WickStrength_0`, `WickStrength_B`) for the decile tables.

#### 3.7.5 `MinStrength` (§4.3) and `g(WickStrength)` (§11)

- `MinStrength` is specified as a **pass rate** (`minStrengthPassRate`, default 0.40; grid {0.30, 0.40, 0.50, 0.60}). Realised threshold = the `(1 − passRate)` quantile of `WickStrength` over gated Spikes (`cls=WickLevel`) in the fold's **train** window; fixed for the test window. In the reaction-test-only phase (no folds yet) the quantile is computed over the whole span (reported as such).
- `g(WickStrength) = clip((WickStrength − MinStrength) / (1 − MinStrength), 0.5, 1)` (§11), evaluated at arming.

### 3.8 `PivotStore`

| | |
|---|---|
| Responsibility | Full history of **every** confirmed pivot with features and class (§9.1; §9.5 "Keep the full PivotStore" — INVALIDATED levels must be counted in the reaction test). |
| Storage | Append-only struct of typed arrays keyed by `pivotId`; per-side sorted index on `price` for `PriorTouches` range queries; per-side ring of the last 1440-bucket window (by `confirmedVol`). Never evicts (memory: ~200 B × pivots; ETHUSDT ≈ a few 10⁵ pivots/year). |
| Interface | `add(p: Pivot, f: ExcursionFeatures \| null, g: GateResult, ranks: Float64Array \| null, WickStrength_0, WickStrength_B, levelId?)`, `countNear(side, price, tol, minVol)` (PriorTouches), `iterate(cls, fromT, toT)`, `byId(pivotId)`, `setLevelOutcome(pivotId, finalState, reason)` (for survivorship reporting). |
| Complexity | `countNear`: O(log n + hits). |

### 3.9 `LevelBook` and the state machine (§5, §6, §8, §9.1)

#### 3.9.1 `Level` record

```ts
export type LevelState = 'PIVOT_PENDING' | 'WICK_ACTIVE' | 'SWEEPING' | 'SWEEP_CONFIRMED' | 'ORDER_ARMED' | 'IN_TRADE' | 'CLOSED'
                       | 'INVALIDATED' | 'EXPIRED' | 'CANCELLED' | 'RETIRED';        // RETIRED added per §5 table (A-22)

export interface Level {
  readonly levelId: number; readonly pivotId: number; readonly Side: Side;
  WickLevel: Ticks;                       // may move outward on merge (§3.1)
  readonly VolUnit_created: Ticks;        // frozen (§2.3)
  WickStrength: number;                   // selected score; WickStrength_0 and WickStrength_B also stored
  State: LevelState; stateSince: Ms; stateReason: string;
  readonly createdAt: Ms;                 // = classifiedAt (Spec §3.6)
  readonly ExitTime: Ms;                  // from ExcursionFeatures; Age anchor (§5)
  SweepExtreme: Ticks | -1; SweepDepth: Ticks | -1; SweepRunningMax: Ticks | -1;
  sweepStartVol: Lots; sweepExtremeVol: Lots; sweepLegDurationBuckets: Buckets;   // for MaxHold (§6.4) and ReturnSpeed (§8.6)
  sweepPivotId: number | -1; WickStrength_sweep: number;                          // §8.5
  PriorTouches: number; SweepCount: number; UseCount: number;
  MinSweepDepth: Ticks; BreakoutDepth: Ticks;   // computed once at creation from VolUnit_created (§6.1); MinSweepDepth re-floored by 2·RoundTripCost at arming (Spec §4.7)
  OrderIds: { entry: number | -1; stop: number | -1; target: number | -1 };
  suppressed: 'none' | 'maxPending' | 'nested' | 'conflict' | 'liquidity' | 'blacklist' | 'killSwitch' | 'counterTrendBlocked';
  regimeAtArm: { TrendEfficiency: number; TrendSign: number; counterTrend: boolean } | null;
  ReturnSpeed: number; ReturnImbalance: number;   // at arming / trigger (§8.6)
  trades: readonly number[];              // tradeIds produced by this level
}
```

Derived quantities (§5), all functions of `(level, now)`:

```
Age(t)        = (Vol(t) − Vol(ExitTime)) / BucketVolume                                    [buckets]
Distance(t)   = Side · (WickLevel − p_t) / VolUnit_created                                  [VolUnits; positive = price below an upper level]
Relevance(t)  = exp(−Age/AgeScale) · exp(−max(Distance,0)/DistanceScale)   AgeScale=240, DistanceScale=5
MaxAge        = 3 · AgeScale = 720 buckets
```
`Relevance` is a stored feature and tie-breaker only (§5: "a feature and tie-breaker, not a rule"). Tie-breaks where `WickStrength` is equal (Spec §3.9.5) use higher `Relevance`, then lower `levelId`.

#### 3.9.2 Sorted maps and the scan set (§9.1)

`LevelBook.upper` and `LevelBook.lower` are sorted arrays of live levels (states `WICK_ACTIVE … IN_TRADE`) keyed by `Side·WickLevel` ascending, with binary insert/remove (live level count is small: tens). Per print the engine scans levels with `Distance(t) ≤ DistanceScale` — i.e. `p_i ≥ WickLevel − DistanceScale·VolUnit_created` for upper levels (§9.1 loop header) — plus **every** level in `SWEEPING`, `SWEEP_CONFIRMED`, `ORDER_ARMED`, `IN_TRADE` regardless of distance (their transitions depend on the print), and, on bucket close only, all levels for ageing/regime (§9.1 "all states: ageing → EXPIRED; regime → INVALIDATED"). Dormant levels (never within `DistanceScale`) cost nothing per print (§5 "dormant, no cost").

#### 3.9.3 Level geometry constants (§6.1), fixed at creation in integer ticks

```
MinSweepDepth = max( ceil(MinSweepMult · VolUnit_created), 3·Tick, 2·SpreadEst_t@creation, 2·RoundTripCostTicks )   MinSweepMult start 0.5
BreakoutDepth = ceil(BreakoutMult · VolUnit_created)                                                                  BreakoutMult start 2.5
```
`RoundTripCostTicks` = the §7.4 estimate expressed in ticks at the current price (Spec §4.7); §6.1/§7.4 make the floor mandatory. The engine records `minSweepFloorBinding ∈ {mult, tick, spread, cost}` per level (§11 "Report how often each cap binds").

#### 3.9.4 Pivot arrival (`onPivot`, §3.1, §8.4, §8.5)

```
onPivot(piv):
  // merge check (§3.1)
  L = nearest live level on piv.side with State == WICK_ACTIVE and |piv.price − L.WickLevel| ≤ MergeTolerance·L.VolUnit_created
  if L: L.PriorTouches += 1; L.WickLevel = Side-more-extreme(L.WickLevel, piv.price); PivotStore.add(piv, …, mergedInto=L); return
  // otherwise: PIVOT_PENDING (Spec §3.5) — features, gates, class, WickStrength follow; on cls == WickLevel:
  register(level)
```

Registration (`register`, at `classifiedAt`):
1. Freeze `VolUnit_created`, compute `MinSweepDepth`, `BreakoutDepth`, `WickStrength`, `PriorTouches` (Spec §3.7.1). State `WICK_ACTIVE`.
2. **Nested same-side levels (§8.4).** For each live same-side level `M` with `|M.WickLevel − level.WickLevel| ≤ BreakoutMult · max(M.VolUnit_created, level.VolUnit_created)` (A-23):
   - if the new level is **outer** (more extreme) and `M.State == WICK_ACTIVE`: `M → RETIRED(reason=nestedInner)` (§8.4a: outer qualified Spike is the WickLevel; retire the inner). If `M` is already `SWEEPING`/`SWEEP_CONFIRMED`/`ORDER_ARMED`/`IN_TRADE`, `M` is **not** retired (A-24: §8.5 requires the current trade to proceed when the sweep leg is itself a stronger Spike); the new level is registered normally.
   - if the new level is **inner**: both stay live; the "never run two orders on nested levels" rule is enforced at arming (Spec §3.9.5 `nested` suppression: only the higher `WickStrength` may hold an armed order).
   - §8.4b (outer extreme is *not* a Spike): nothing to do — that pivot is `SlowExtreme`, and the inner level's `SWEEPING` logic already treats the excursion as its sweep.
3. **Sweep leg as stronger Spike (§8.5).** If `piv.pivotId == M.sweepPivotId` for some level `M` in `SWEEP_CONFIRMED`/`ORDER_ARMED`/`IN_TRADE` (the pivot *is* `M`'s SweepExtreme) and `level.WickStrength > M.WickStrength`: register `level` with `UseCount=0` (it is), set `M.WickStrength_sweep = level.WickStrength`; `M` continues unchanged. `WickStrength_sweep` is recorded as a feature for the report; it is not in the 13-feature Stage B vector in v1 (A-25).
4. `PriorTouches` increments after creation (§8.3): each subsequent same-side pivot within `MergeTolerance·VolUnit_created` whose price does **not** exceed `WickLevel + MinSweepDepth` (Side-normalised) — this is exactly the §3.1 merge event, so §3.1 and §8.3 count the same thing (A-26). Approaches that exceed `MinSweepDepth` are sweeps (`SWEEPING`), not touches.

#### 3.9.5 Arming eligibility (evaluated whenever a level in `SWEEP_CONFIRMED` could arm, and re-evaluated on every print for suppressed levels)

A level may move `SWEEP_CONFIRMED → ORDER_ARMED` only if **all** hold; the first failing check is recorded in `suppressed` and counted:

| # | Check | Source |
|---|---|---|
| a | `WickStrength ≥ MinStrength` (and `WickStrength` defined) | §4.3 |
| b | `ArmMode` condition: `RestEarly` → immediately at `SWEEP_CONFIRMED`; `ArmOnApproach` → first print with `Side·p ≤ Side·WickLevel + ArmDistance·VolUnit_created` **and** `ReturnSpeed ≥ MinReturnSpeed` (`MinReturnSpeed = 0.3`, A-27) | §6.3, §8.6 |
| c | not `LiquidityGuard`, not in a blacklist interval | §8.8, Spec §2.6.3 |
| d | kill switch not active for this volume-day | §11 |
| e | no open position on the symbol; and not opposite to an open position's direction (never hold opposite positions) | §7.5, §8.9 |
| f | regime: if `TrendEfficiency ≥ 0.4` and `TrendSign == Side` (for a short, `Side=+1`, a rising Vwap is *against*): counter-trend → require `WickStrength ≥ MinStrength + 0.15` and mark `sizeHalved`; variant `counterTrendBlock=true` → suppress | §8.1 |
| g | **conflict (§8.9):** for every armed level `K` on the opposite side with `|WickLevel − K.WickLevel| < 2·max(SweepDepth, K.SweepDepth)`: keep the higher `WickStrength`; the loser is (or stays) suppressed with `conflict` (if the loser is `K` and already armed, `K → SWEEP_CONFIRMED(conflict)`, order cancelled) | §8.9 |
| h | **nested (§8.4):** among live same-side levels within `BreakoutDepth` (Spec §3.9.4 rule) that are `ORDER_ARMED`, only the highest `WickStrength` may be armed; lower ones are suppressed `nested` | §8.4 |
| i | **`MaxPending = 4`:** if 4 orders are already armed on the symbol, arm only if `WickStrength` exceeds the lowest armed one; that one is un-armed (`→ SWEEP_CONFIRMED(maxPending)`) | §7.5 |

Un-arming (`ORDER_ARMED → SWEEP_CONFIRMED`) is not terminal (§8.10 "liquidity guard while ORDER_ARMED → order pulled, back to SWEEP_CONFIRMED"); the level re-arms when checks pass again. Suppression reasons are counted per fold (§11 "how often each cap and each rule binds").

#### 3.9.6 State machine table

Written for `Side = +1` in side-normalised prices `P = Side·p`, `W = Side·WickLevel`, `S = Side·SweepExtreme`, `R = Side·SweepRunningMax` (Spec §3.12). "Print" transitions are evaluated per print in the order listed inside each state; "close" transitions on bucket close only. Terminal states: `INVALIDATED, EXPIRED, CANCELLED, RETIRED`.

| From | Guard (first true wins within a state) | Action | To | Source |
|---|---|---|---|---|
| `PIVOT_PENDING` | `iIn = −1` | `PivotStore.add(cls=Unresolved)` | — (dropped) | Spec §3.5.1 |
| `PIVOT_PENDING` | bucket close with `BurstFlag` overlapping the excursion or confirmation bucket | `cls=BurstPivot`; store | — | §8.7 |
| `PIVOT_PENDING` | early G2 failure (Spec §3.5.1) | `cls=SlowExtreme`, `classifiedAt=t`; keep computing features | — (SlowExtreme) | §3.3 |
| `PIVOT_PENDING` | `RetraceFraction` final and G1–G6 all pass | `register` (Spec §3.9.4) | `WICK_ACTIVE` | §3.3, §9.1 |
| `PIVOT_PENDING` | `RetraceFraction` final and any gate fails | store `SlowExtreme` | — | §3.3 |
| `PIVOT_PENDING` | `Vol − confirmedVol > PendingLimit·BucketVolume` | store `SlowExtreme(featuresAvailable=false)` | — | Spec §3.5.1 |
| `WICK_ACTIVE` | print: `P ≥ W + BreakoutDepth` | — | `INVALIDATED(breakout)` | §5, §8.10 |
| `WICK_ACTIVE` | print: `P ≥ W + MinSweepDepth` | `SweepRunningMax=p`, `sweepStartVol=Vol`, `SweepCount=1` | `SWEEPING` | §6.2, §9.1 |
| `WICK_ACTIVE` | pivot arrival within `MergeTolerance` (same side) | `PriorTouches+=1`, `WickLevel` outward | `WICK_ACTIVE` | §3.1, §8.3 |
| `WICK_ACTIVE` | registration of a nested outer Spike | — | `RETIRED(nestedInner)` | §8.4a |
| `WICK_ACTIVE` | close: `Age > MaxAge` | — | `EXPIRED` | §5 |
| `WICK_ACTIVE` | close: `VolUnit_now/VolUnit_created ∉ [0.4, 2.5]` | — | `INVALIDATED(regime)` | §5, §8.10 |
| `SWEEPING` | print: `P > W + BreakoutDepth` (after updating `R = max(R, P)`) | — | `INVALIDATED(breakout)` | §6.2, §8.10 |
| `SWEEPING` | print: `P ≤ R − PivotReversal` (the zigzag's reversal test for this leg; **the same print** on which `Zigzag` emits the PivotHigh for the leg — the engine checks `R − PivotReversal` directly so the sweep confirmation does not depend on zigzag leg alignment, A-28) and `R ≤ W + BreakoutDepth` | `SweepExtreme = SweepRunningMax; SweepDepth = S − W; sweepExtremeVol = vol at R; sweepLegDurationBuckets = (Vol − sweepStartVol)/BucketVolume; sweepPivotId = pivot emitted on this print for this side if any` | `SWEEP_CONFIRMED` | §6.2 |
| `SWEEPING` | print: otherwise | `R = max(R, P)` (update `sweepExtremeVol` when R increases) | `SWEEPING` | §6.2 |
| `SWEEPING` | close: `Age > MaxAge` / regime | — | `EXPIRED` / `INVALIDATED(regime)` | §8.10 |
| `SWEEP_CONFIRMED` | print: `P > W + BreakoutDepth` | — | `INVALIDATED(breakout)` | §8.2 |
| `SWEEP_CONFIRMED` | print: `P > S` (re-sweep) | `SweepCount+=1`; if `SweepCount ≥ MaxSweeps=3` → `INVALIDATED(maxSweeps)`; else re-enter sweep tracking: `SweepRunningMax=p`, keep `sweepStartVol` of the **new** leg = `Vol` | `SWEEPING` (re-entry) — on re-confirmation `SweepExtreme` is re-set only if the new max `> SweepExtreme` (it is, by the guard), `SweepDepth` recomputed, `StopLoss` cancel–replace if armed later | §8.2, §7.5, §8.10 |
| `SWEEP_CONFIRMED` | print: arming checks a–i pass (Spec §3.9.5) | `place entry stop-market at TriggerPrice = W − TriggerOffset·Tick` (§6.3 variant, default 0); record `regimeAtArm`, `ReturnSpeed`, `ReturnImbalance`; `OrderIds.entry` | `ORDER_ARMED` | §6.3, §7.5 |
| `SWEEP_CONFIRMED` | print: `P ≤ W` while suppressed/not yet armed (price reclaimed without an order) | count `missedReclaim` by suppression reason | `SWEEP_CONFIRMED` (level may still arm on a later re-sweep only) → after `RetraceWindow` buckets below `W` with no arm: `CANCELLED(missedReclaim)` (A-29) | §6.3 |
| `SWEEP_CONFIRMED` | close: `Age > MaxAge` / regime | — | `EXPIRED` / `INVALIDATED(regime)` | §8.10 |
| `ORDER_ARMED` | print: `P > W + BreakoutDepth` | cancel entry | `INVALIDATED(breakout)` | §8.2 |
| `ORDER_ARMED` | print: `P > S` (re-sweep before trigger) | as `SWEEP_CONFIRMED` re-sweep; entry stop **unchanged** (§7.5 "entry stop unchanged"); when re-confirmed, `StopLoss` cancel–replace | `SWEEPING(reentry, entryArmed=true)` — the entry order stays live during the re-sweep; if it triggers during the re-sweep leg the trade is entered with the *old* `SweepExtreme` (A-30) | §8.2, §7.5 |
| `ORDER_ARMED` | print: `P ≤ W − TriggerOffset·Tick` | `TriggerTime = t` (**the trigger print itself is never a fill print**, §9.5); run the §7 fill model (Spec §4.2) → `EntryFill`, `FilledQty`; open `Trade`; place `StopLoss` and `Target` OCO; apply §8.9 corridor cancellation to the opposite side | `IN_TRADE` | §6.3, §7.1–7.5, §9.1 |
| `ORDER_ARMED` | print/close: any arming check a–i now fails (liquidity guard, blacklist, kill switch, conflict lost, nested, maxPending) | cancel entry | `SWEEP_CONFIRMED(reason)` | §8.10 |
| `ORDER_ARMED` | fill of a higher-`WickStrength` conflicting opposite-side setup whose corridor contains `W` | cancel entry | `CANCELLED(conflictFilled)` | §8.9, §8.10 |
| `ORDER_ARMED` | close: `Age > MaxAge` / regime | cancel entry | `EXPIRED` / `INVALIDATED(regime)` | §8.10 |
| `IN_TRADE` | print: `P ≥ StopLoss` (side-normalised) | stop triggered → §7.3 fill | `CLOSED(stop)`, `UseCount+=1` | §6.4, §7.3, §8.10 |
| `IN_TRADE` | print: Target fill rule satisfied (conservative rule for the primary path) | exit at `Target` | `CLOSED(target)`, `UseCount+=1` | §6.4, §7.3 |
| `IN_TRADE` | print: `(Vol − entryVol)/BucketVolume ≥ MaxHold·sweepLegDurationBuckets` (variant on) | market exit §7.2 | `CLOSED(time)`, `UseCount+=1` | §6.4 |
| `IN_TRADE` | print: kill switch tripped | market exit §7.2 | `CLOSED(killSwitch)`, `UseCount+=1` | §11 |
| `IN_TRADE` | close: `Age > MaxAge` / regime | **no action on the open trade** (exits govern); flag `retireAfterClose` | `IN_TRADE` | A-31 (§8.8 analogue) |
| `CLOSED` | `UseCount ≥ MaxUses` (start 1) or `retireAfterClose` | — | `RETIRED(usesExhausted)` | §5 |
| `CLOSED` | `UseCount < MaxUses` | reset `SweepExtreme, SweepDepth, SweepCount, OrderIds`; keep `PriorTouches`, `UseCount` | `WICK_ACTIVE` | §5 (`MaxUses` test to 3) |
| `WICK_ACTIVE` (after a completed setup, `UseCount ≥ 1`) | print: `P > W + BreakoutDepth` | — | `RETIRED(breakoutAfterUse)` | §5 |

Every transition appends `{ t, seq, levelId, from, to, reason }` to the run's transition log (Spec §7.1 schema) — the survivorship accounting of §9.5 is derived from it.

#### 3.9.7 `LevelBook` interface

```ts
export class LevelBook {
  constructor(cfg: EngineConfig, store: PivotStore, exec: ExecutionModel, sizing: Sizing, clock: EngineClock);
  onPivot(piv: Pivot, side: Side): void;                       // Spec §3.9.4
  onPendingResolved(pending: PendingPivot, result: GateResult): void;
  onPrint(e: MergedEventView, ctx: PrintContext): void;         // scan set + per-state transitions, Spec §3.9.6
  onBucketClose(k: number, ctx: BucketContext): void;           // ageing, regime, re-evaluate suppressed
  live(side: Side): ReadonlyArray<Level>;
  armed(): ReadonlyArray<Level>; openTrade(): Trade | null;
}
```

### 3.10 Per-print loop (§9.1) — exact ordering

```
Engine.onPrint(e):                                     // e = merged event; called once per event in (t, seq) order
  1  ctx.inBlacklist = blacklist.contains(e.t)
  2  closedK = BucketBuilder.onPrint(e)                                                    // §2.2
     if closedK ≥ 0:
        2a  SpreadEst.refresh; 2b VolUnit.refresh; 2c RVol/VolRatio; 2d TrendEfficiency; 2e BurstFlag;
        2f  LiquidityGuard; 2g PivotReversal; 2h eventSizeP99/P10; 2i volumeDay + kill-switch reset       // Spec §3.2.6 order
        2j  if warmup and all warm-up conditions met: warmup=false; Zigzag.init(e)
        2k  ExcursionFeatures.onBucketClose(closedK)      // pending pivots: burst overlap, early-G2, PendingLimit
        2l  LevelBook.onBucketClose(closedK)              // EXPIRED / INVALIDATED(regime) for all live levels; re-evaluate suppressed
     if warmup: TradeRing.push(e); SpreadEst.onPrint(e); return
  3  TradeRing.push(e, Vol, currentBucketK)
  4  SpreadEst.onPrint(e)                                 // candidate only; published value unchanged until 2a
  5  ExecutionModel.onPrint(e)                            // resolve any pending fills whose window includes e (entry, stop, time, target)
                                                          // — BEFORE new triggers on this print, so a fill never uses the print that triggers it
  6  piv = Zigzag.update(e.t, e.seq, e.p, Vol, PivotReversal)                              // §3.1
  7  if piv: LevelBook.onPivot(piv, piv.side); ExcursionFeatures.open(piv)                 // merge or PIVOT_PENDING
  8  ExcursionFeatures.onPrint(e)                         // advance iOut searches, RetraceFraction mins; resolved → LevelBook.onPendingResolved
  9  LevelBook.onPrint(e, ctx)                            // for side ∈ {+1, −1}: scan set (Spec §3.9.2); per level, transitions in table order
                                                          //   IN_TRADE exits are checked before ORDER_ARMED triggers (one position per symbol)
 10  MFE/MAE path tracker update for open and virtual trades (Spec §6.2)
 11  ReactionTest.onPrint(e)   (only when the reaction harness is attached; reads PivotStore/LevelBook, never writes)
```

Rules the loop enforces: step 5 precedes step 9 so that a print that satisfies both "fill window" for an earlier trigger and "trigger" for a new order is used as a fill first; a print that triggers an order at step 9 becomes eligible as a fill print only at step 5 of a **later** print (§9.5 "Filling on the trigger print itself"). Bucket-derived statistics are refreshed only in step 2 (§9.5).

### 3.11 Numerical conventions

| Item | Rule |
|---|---|
| Prices | `Ticks` integers stored in `Int32Array` on the hot path; range assertion `|p| < 2^31` at data load (BTC at 0.1 tick ≈ 10⁶ ticks; fine). All comparisons between prices are integer comparisons; **no float price is ever compared** (lint: `wsr/no-float-price`, and every function taking a price parameter takes `Ticks`). |
| Products of a multiplier and a `VolUnit` (e.g. `MinSweepMult·VolUnit_created`) | Rounded **up** to an integer tick with `Math.ceil(x − 1e-9)` when they set a distance the price must exceed (conservative: harder to qualify); `Target` distance `TargetMult·SweepDepth` rounded **down** (target harder to reach), `StopLoss` offset exact. Each rounding direction is fixed in code with a named helper (`ceilTicksConservative`, `floorTicksConservative`). |
| Sizes | `Lots` integers in `Float64Array` (exact to 2^53). Cumulative `Vol` over a 13-month span must stay `< 2^52`; the data loader computes `Σq` per venue-symbol and aborts with a clear error if the bound is violated (would require a coarser lot unit). |
| Timestamps | `Ms` integers in `Float64Array`. Sub-ms venue precision is not used by the engine (A-32). |
| Decimal parsing | `p = round(price / Tick)` via exact decimal string arithmetic: scale both by 10^d (d = max decimals) as BigInt, divide, check remainder. Same for `q`. |
| Floats | Feature values, ranks, scores, ratios, `Vwap`, `RVol` are `number`; never used to gate a price transition without first being converted to `Ticks` by the helpers above. |
| Overflow | `Σ p·q` for `Vwap` uses `Float64` (p ≤ 2^31, q per bucket ≤ 2^31 → product ≤ 2^62 > 2^53): accumulate `Σ (p − p_first)·q` relative to the bucket's first price to keep magnitudes < 2^53, and add back `p_first`. |
| Tick-size change inside the span | `Engine.resetOnTickChange(newMeta)`: all live levels → `INVALIDATED(tickChange)`, rings and bucket history cleared, warm-up restarted; the change instant is a blacklist boundary. Reported. |
| Randomness | None in `@wsr/core`. |

### 3.12 Side symmetry (§2.4)

The engine never duplicates logic for longs. It maps the print into **side-normalised space** once per level scan:

```
P  = Side · p                     W  = Side · WickLevel        S = Side · SweepExtreme      R = Side · SweepRunningMax
StopLossN = S + StopOffset·Tick   TargetN = W − TargetMult·SweepDepth      Imbalance_N = −Side · Σ s q   (rejection / return legs)
ourAggressor = −Side              (Side=+1 short ⇒ we sell ⇒ aggressor −1)
```

Every comparison in Spec §3.9.6 is written in this space; `Zigzag` emits `PivotHigh` for `Side=+1` and `PivotLow` for `Side=−1`, and `ExcursionFeatures` uses `side·(e.p − BandEdge)` as in Appendix A. Converting back (`p = Side·P`) happens only when writing fills and reports. Property test (Spec §11.1): mirroring a price path (`p → 2·c − p`, `s → −s`) must produce the mirrored set of pivots, levels, transitions and trades with identical timestamps.

---

## 4. Execution model specification (§7)

The execution model is a pure module in `@wsr/core` (`ExecutionModel`), fed by the per-print loop (step 5) and by `LevelBook` (order placement). It is **identical for backtest and live** by construction (§7 heading): it consumes only prints.

### 4.1 Trigger and latency (§7.1)

```
TriggerTime = t of the first print with Side·p ≤ Side·WickLevel − TriggerOffset·Tick after arming     (§6.3, §7.1)
SendTime    = TriggerTime + ObsLatency + DecisionLatency
FillTime    = SendTime + ExchangeLatency
Latency     = ObsLatency + DecisionLatency + ExchangeLatency
```

| Config | Values | Meaning |
|---|---|---|
| `latencyMs` | sweep `{0, 50, 150, 500}` (§7.1), default run 150 | client-side stop: full `Latency` applies to entry, stop and time-stop orders |
| `stopMode` | `'client' \| 'exchangeNative'` | exchange-native stop: `Latency = ExchangeLatency` only (§7.1) for entry and stop triggers; `exchangeLatencyMs` default 30 |
| `latencySplit` | `ObsLatency:DecisionLatency:ExchangeLatency = 0.4:0.3:0.3` of `latencyMs` | only the sum matters for fills; the split is recorded for the live comparison |

The harness runs the four-point latency sweep for the chosen configuration and reports the expectancy curve (§7.1: "A strategy that dies between 50 and 150 ms is not tradable from a normal cloud region" — the report prints this sentence next to the curve when expectancy at 150 ms < 0 ≤ expectancy at 50 ms).

Trigger semantics: **last traded price** on all venues (§6.3 "use last-price triggers so the trade feed is the trigger source"); the per-venue table (Spec §2.2) lists the parameter that selects it live.

### 4.2 Fill price of a market order (§7.2)

```ts
export interface FillRequest { readonly side: Side; readonly ourAggressor: Side; readonly Qty: Lots; readonly triggerSeq: number; readonly TriggerTime: Ms; readonly FillTime: Ms; readonly kind: 'entry'|'stop'|'time'|'targetMarket'|'kill'; }
export interface FillResult  { readonly FillPrice: Ticks; readonly FilledQty: Lots; readonly fillSeq: number; readonly fillT: Ms; readonly windowPrints: number; readonly noPrintFallback: boolean; readonly touchAndReverse: boolean; readonly touchAndFly: boolean; readonly burst: boolean; readonly halfSpread: Ticks; readonly slippage: Ticks; }
```

#### 4.2.1 Algorithm (written for a **sell** market order, `Side=+1`; mirror for buy)

```
window   = prints e with (e.t > FillTime) or (e.t == FillTime and e.seq > triggerSeq),  e.t ≤ FillTime + FillWindow      (A-33)
           where FillWindow = 100 ms, or 300 ms if burstAtTrigger                                                          (§7.2, §8.7)
candidates = { e ∈ window : e.s == ourAggressor }                                       // "worst print … on our aggressor side" (§7.2)
touchAndFly: let n = first print after the trigger print (any side); if |n.p − triggerPrint.p| > 2·VolUnit_now
             then candidates ∪= {n}                                                    // §8.7 "fills at that next print"
if candidates empty:
     base = (last print at or before FillTime + FillWindow).p − SpreadEst_t            // §7.2 "fill at the last print − SpreadEst_t"
     noPrintFallback = true; halfSpread = 0
else:
     base = min p over candidates;  halfSpread = ceil(SpreadEst_t / 2)
Slippage  = SlipTicks·Tick + ceil( SlipCoef · (Qty / Vol100ms[h]) · VolUnit_now )      SlipTicks=1, SlipCoef=0.05        (§7.2)
if burstAtTrigger: Slippage = 3·Slippage                                               (§7.2, §8.7)
FillPrice = base − halfSpread − Slippage                                                (integer ticks; for a buy: + instead of −)
FilledQty = min(Qty, Σ q over candidates) if candidates non-empty else Qty              (partial fill, Spec §4.5)
```

- The fill is resolved at the first print with `t > FillTime + FillWindow` (or at the last window print when it already exceeds the window) — i.e. the engine **waits** until the window has elapsed; it does not choose the worst print before the window closes. `FillResult.fillT` = `t` of the worst print.
- `burstAtTrigger` = `BurstFlag` of the last closed bucket at `TriggerTime`, or a print jump `> 3·VolUnit_now` between the trigger print and its predecessor (§8.7).
- `h = hourOfDayUTC(FillTime)`.
- Property: `FillPrice ≤ every candidate price − halfSpread` (sell) — test Spec §11.1.

#### 4.2.2 Touch-and-reverse — hard invariant (§7.2)

**If the trigger print satisfies the trigger condition, the order fills. Always.** The engine has no code path in which a triggered order is cancelled or left unfilled because the next print is back above `WickLevel + PivotReversal` (or any other price). Such a fill is flagged `touchAndReverse = true` when the first print after `FillTime` satisfies `Side·p > Side·WickLevel + PivotReversal`, and its frequency is reported (§7.2 "Report its frequency"; §9.4 "touch-and-reverse frequency"; §12 weakness 2). Test (Spec §11.1 `touchAndReverseMustFill`): a synthetic path `… 100, 99 (trigger), 105, 106 …` with `WickLevel=100` must produce a trade with `FillPrice ≤ 99 − halfSpread − Slippage` and `touchAndReverse=true`; a fuzz test asserts `#triggers == #entries` for every random path.

#### 4.2.3 `Vol100ms` (§7.2)

`Vol100ms[h]`, `h ∈ 0..23`, = median of the traded volume (lots) over the **non-empty** 100-ms slots of hour `h` across the previous 7 UTC days, floored at 1 lot; recomputed at `onNewDay` (Spec §3.2.3) (A-34). Used by `Slippage`, `QueueProxy = 5·Vol100ms` (§7.3) and the liquidity cap `Qty ≤ 0.5·Vol100ms` (§11).

### 4.3 StopLoss, Target, TimeStop (§6.4, §7.3)

| Exit | Price | Trigger / fill rule |
|---|---|---|
| `StopLoss` | `Side·StopLoss = Side·SweepExtreme + StopOffset·Tick`, `StopOffset = 1` (§6.4) | stop-market: triggered on the first print with `Side·p ≥ Side·StopLoss` after entry (`triggerSeq` = that print); filled by Spec §4.2 with `ourAggressor = +Side` (buy-back for a short) and the configured latency (§7.3 "model 7.2") |
| `Target` (limit) | `Side·Target = Side·WickLevel − floor(TargetMult·SweepDepth)`, `TargetMult = 2` (§6.4) | **conservative (baseline):** filled at `Target` on the first print with `Side·p < Side·Target − Tick` (strictly beyond by more than one tick) after placement (§7.3). **Optimistic bound:** filled at `Target` when `Σ q` over prints with `p == Target` after placement `> QueueProxy = 5·Vol100ms[h]` (§7.3). Both are **always** evaluated on every trade (Spec §4.3.1). Maker fee on the exit. |
| `Target` as market (variant `targetAsMarket`) | same price | on the first print with `Side·p ≤ Side·Target` (touch), market fill by Spec §4.2 with taker fee (§7.3) |
| `TimeStop` (variant `timeStop=on`) | — | first print with `(Vol − entryVol)/BucketVolume ≥ MaxHold·sweepLegDurationBuckets`, `MaxHold = 4` (§6.4); market fill by Spec §4.2 |
| Kill-switch flatten (§11) | — | market fill by Spec §4.2 |

#### 4.3.1 Dual Target bookkeeping

The **primary** path (position occupancy, P&L, all breakdowns) uses the conservative Target rule. In parallel, every open trade tracks the optimistic Target fill time (`targetFillOptT`) and resolves an alternate outcome `exitOpt` (target-opt vs the same stop/time rules); it is stored on the `Trade` record. Reports show both (§7.3 "Report both; without book data the truth is between them"). The alternate outcome does not affect occupancy (A-35).

#### 4.3.2 Exit priority within one print (§11 "Exits, priority")

`StopLoss` trigger → conservative `Target` fill → `TimeStop` → kill switch. A single print cannot satisfy both stop and target; the order matters only when a stop trigger and a time-stop coincide (stop wins).

#### 4.3.3 OCO and partial fills (§7.5)

- On entry fill: `StopLoss` and `Target` are placed **immediately, on the entry fill print** (no latency: "exchange-side if supported" — modelled as exchange-side, A-36); either fill cancels the other.
- Partial fills: `FilledQty < Qty` ⇒ exits are sized to `FilledQty`; the unfilled remainder is cancelled at `FillTime + FillWindow` (§7.5). A `FilledQty = 0` cannot occur (no-print fallback fills `Qty`).
- Stop-loss cancel–replace on re-sweep (§7.5, §8.2): if a re-sweep is confirmed while `ORDER_ARMED`, the pending `StopLoss` price is updated before entry; once `IN_TRADE` there is no re-sweep handling (the stop is hit instead).

### 4.4 `RoundTripCost`, `BreakevenHitRate` (§7.4)

```
RoundTripCost      = TakerFee·EntryNotional + (TakerFee | MakerFee)·ExitNotional + E[Slippage_entry] + E[Slippage_exit] + fundingAccrued
                     (bps of entry price; MakerFee when the exit was the limit Target, TakerFee otherwise)                         (§7.4)
E[Slippage_x]      = expected Slippage(Qty) per Spec §4.2 at the planned Qty plus half-spread; realised values are used ex post
BreakevenHitRate   = (SweepDepth + RoundTripCost) / (3·SweepDepth)      for (TargetMult, StopMult) = (2, 1)                       (§7.4)
                   = (StopMult·SweepDepth + RoundTripCost) / ((TargetMult + StopMult)·SweepDepth)   general form used by §6.5 grid (A-37)
RoundTripCostTicks = RoundTripCost_bps · p_now / 10⁴ / Tick   (for the MinSweepDepth floor, Spec §3.9.3)
```
The ex-ante estimate (for the floor and for sizing) uses `TakerFee` on both legs (conservative) and `SlipTicks·Tick + halfSpread` per leg at the planned `Qty`. §7.4's own numbers (≈ 9–13 bps round trip on ETHUSDT-class, `SweepDepth ≈ 5 bps` ⇒ `BreakevenHitRate ≈ 1.0` ⇒ untradeable) are reproduced in the report as the *cost-floor diagnostic*: per fold, the share of gated Spikes whose `MinSweepDepth` was set by the cost floor rather than by `MinSweepMult` (§12 weakness 1).

Fee schedules per venue live in `meta/{venue}/{symbol}/instrument_history.json` with `verifiedAt`; a run whose fee record lacks `verifiedAt` prints `[VERIFY] fees unverified` in the report header.

### 4.5 Funding accrual (§7.4 "funding accrued", §9.5 "funding settlement")

For each funding timestamp `tf` from `funding.parquet` with `entryT < tf ≤ exitT`: `fundingAccrued += rate(tf) · notional · dirSign` where `dirSign = +1` for a short receiving when `rate < 0`… concretely: short pays `−rate·notional` when `rate < 0` and receives when `rate > 0`; long the opposite. Sign convention is tested against the venue's documentation **[VERIFY]**. Missing funding record for a timestamp inside a trade ⇒ charge `FallbackFundingRate = 0.01 % · notional` against the position regardless of sign (conservative, A-38) and count it.

### 4.6 Order-management rules (§7.5, §8.9, §11)

| Rule | Implementation | Source |
|---|---|---|
| Arm | `SWEEP_CONFIRMED → ORDER_ARMED` per `ArmMode` and the checks of Spec §3.9.5 | §6.3, §7.5 |
| Cancel–replace stop on re-sweep | Spec §4.3.3 | §7.5 |
| Cancel on invalidation, expiry, liquidity guard, conflicting fill | Spec §3.9.6 rows for `ORDER_ARMED` | §7.5, §8.10 |
| One open position per symbol | `LevelBook.openTrade()` non-null ⇒ no level may arm or trigger (armed orders remain armed but a trigger while a position is open is **not** possible because arming check (e) un-arms all others on entry fill; the engine asserts `#openTrades ≤ 1` per print) | §7.5, §9.5 |
| `MaxPending = 4` | Spec §3.9.5 (i) | §7.5 |
| Opposite-side conflicts | Spec §3.9.5 (g); on entry fill, every opposite-side armed level whose `WickLevel` lies inside `[Target, StopLoss]` of the new trade → `CANCELLED(conflictFilled)` | §8.9, §8.10 |
| Never hold opposite positions | consequence of one position per symbol | §8.9 |
| Daily kill switch | realised P&L in R for the current `volumeDay` ≤ `−DailyLossLimit = −3` ⇒ flatten the open position at market (Spec §4.2), cancel all armed orders (`→ SWEEP_CONFIRMED(killSwitch)`), no arming until the next `volumeDay`; count trips | §11 |

### 4.7 Sizing (§11)

```
E[Slippage]  = SlipTicks·Tick + halfSpread + ceil(SlipCoef·(Qty₀/Vol100ms[h])·VolUnit_now)   (Qty₀ from a first pass without the slippage term; one fixed-point iteration, A-39)
RiskPerTrade = SweepDepth + E[Slippage]                                                        [ticks]
Qty_raw      = RiskFraction · Equity / (RiskPerTrade · Tick · priceUnit)  × g(WickStrength)    (§11; RiskFraction default 0.25 %, policy)
Qty          = Qty_raw / 2 if counterTrend (§8.1)
Qty          = min(Qty, 0.5 · Vol100ms[h])                                                     (liquidity cap, §11)
Qty          = floor(Qty to whole lots); if Qty < 1 lot → do not arm (suppressed 'minQty'), count
```
`Equity` is **constant** (`equity` config, default 100 000 USDT; no compounding, A-40) so that R-multiples and bps are comparable across folds. The engine records per trade which caps bound: `{ g, counterTrendHalved, liquidityCap, minQty }` (§11 "Report how often each cap binds").

---

## 5. Scenario and risk rules (§8, §11)

Each rule below is a concrete, testable statement with its data dependencies and the counter the engine increments when the rule binds. All counters are emitted per fold in `RuleBindingStats` (Spec §7.1).

| § | Rule (as implemented) | Data dependencies | Counter(s) |
|---|---|---|---|
| 8.1 Regime | At arming: `TrendEfficiency`, `TrendSign` from the last closed bucket. `TE ≥ 0.4 ∧ TrendSign ≠ Side` (aligned) → allow. `TE ≥ 0.4 ∧ TrendSign == Side` (counter-trend) → allow iff `WickStrength ≥ MinStrength + 0.15`, `Qty` halved; variant `counterTrendBlock` → suppress. `TE < 0.2` → allow (range). `0.2 ≤ TE < 0.4` → allow, regime = `neutral` (A-41). Regime is stored on the trade and is a report dimension; **no** further regime logic is hard-coded (§8.1 last sentence). | `Vwap_k`, `High_k`, `Low_k` history (60 buckets) | `counterTrendAllowed`, `counterTrendBlockedByStrength`, `counterTrendHalved` |
| 8.2 Clean vs multiple sweeps | Spec §3.9.6 re-sweep rows; `SweepCount ∈ {1, 2, ≥3}` stored on the trade; `MaxSweeps = 3` → `INVALIDATED(maxSweeps)`. Re-set of `SweepExtreme` only when the new max lies in `(SweepExtreme, WickLevel + BreakoutDepth]`. | print stream, `SweepRunningMax` | `resweeps`, `invalidatedMaxSweeps` |
| 8.3 Prior touches | No filter in v1. `PriorTouches` at creation (§4.1) + increments (Spec §3.9.4 rule 4). Report by `PriorTouches ∈ {0, 1, 2, ≥3}` at trigger time; Stage B coefficient sign reported (§8.3 "Stage B decides the sign"). | `PivotStore.countNear` | `priorTouchesHist[4]` |
| 8.4 Nested levels | Spec §3.9.4 rule 2 and §3.9.5 (h). | `LevelBook` same-side neighbours | `retiredNestedInner`, `suppressedNested` |
| 8.5 Sweep leg is a stronger Spike | Spec §3.9.4 rule 3: current trade unchanged; new level registered with `UseCount = 0`; `WickStrength_sweep` stored on the trade (report dimension: `WickStrength_sweep > WickStrength` yes/no). | sweep pivot features | `sweepLegStrongerSpike` |
| 8.6 Slow vs violent Reclaim | `ReturnSpeed = (Side·SweepExtreme − Side·p) / (VolUnit_created · (Vol − sweepExtremeVol)/BucketVolume)` and `ReturnImbalance = −Side·Σ s q / Σ q` over prints since `sweepExtremeVol`, evaluated at arming (ArmOnApproach) and at trigger (stored). Violent = `ReturnSpeed ≥ RejectSpeed_sweep ∧ ReturnImbalance ≥ 0.2` → full size; slow = `ReturnSpeed < 0.3` → taken under `RestEarly`, skipped under `ArmOnApproach` (via `MinReturnSpeed = 0.3`, A-27). Report by `ReturnSpeed` bin `{<0.3, [0.3, RejectSpeed_sweep), ≥ RejectSpeed_sweep}`. | ring since `sweepExtremeVol`, sweep pivot's `RejectSpeed` | `reclaimViolent`, `reclaimSlow`, `skippedSlowReclaim` |
| 8.7 Bursts and print gaps | `BurstFlag_k` (Spec §3.2.6 #6). Pivots overlapping a burst bucket → `BurstPivot`, never a level. Armed orders remain; fills inside a burst use `Slippage × 3`, `FillWindow = 300 ms`. Touch-and-fly rule in Spec §4.2.1. Variant `blacklistMacroReleases`/`blacklistFunding` (Spec §2.6.3). | `VolRatio`, `maxPrintGap_k`, `VolUnit_now` | `burstPivots`, `fillsInBurst`, `touchAndFly` |
| 8.8 Low liquidity | `LiquidityGuard` (Spec §3.2.6 #7): no new arms; armed orders pulled (`→ SWEEP_CONFIRMED(liquidity)`); open positions keep their exits. | 1440-bucket medians of `SpreadEst`, `WallDuration` | `liquidityGuardBuckets`, `armsBlockedLiquidity`, `ordersPulledLiquidity` |
| 8.9 Opposite-side conflicts | Spec §3.9.5 (g) and Spec §4.6 corridor cancellation. | both sides of `LevelBook` | `conflictSuppressed`, `cancelledConflictFilled` |
| 8.10 Invalidation summary | Implemented as the terminal-transition rows of Spec §3.9.6; `UseCount += 1` on every `CLOSED`. | — | transition log counts by `reason` |
| 11 Sizing caps | Spec §4.7. | `Vol100ms`, `WickStrength`, regime | `capG`, `capCounterTrend`, `capLiquidity`, `capMinQty` (each: count of trades where the cap reduced `Qty`, and the mean reduction ratio) |
| 11 Kill switch | Spec §4.6. `DailyLossLimit = 3 ×` per-trade risk (R). | realised P&L per `volumeDay` | `killSwitchTrips`, `tradesLostToKillSwitch` (levels that would have triggered while switched off) |

Rule ordering when several bind on the same print: transitions are evaluated in the table order of Spec §3.9.6, and arming checks in the order a–i of Spec §3.9.5; the **first** failing check is the recorded reason (subsequent checks are still evaluated for the "would also have bound" counters, reported separately so that the counters are not order-dependent).

---

## 6. Validation harness specification (`packages/backtest`)

The harness drives `@wsr/core` engines over stored merged partitions, attaches observers, and computes statistics. Order of execution is fixed (Spec §12): reaction test → gate → target validation → walk-forward/grid → reports. Venues are **never mixed** in one engine run (§9.5 "Venue mismatch"; §9.3); every harness function takes exactly one `(venue, symbol)`.

### 6.1 Reaction test (§9.2)

#### 6.1.1 Level sets, one code path

```ts
export type LevelSetId = 'wick' | 'slow' | 'placebo' | 'random';
export interface RefLevel { readonly setId: LevelSetId; readonly srcPivotId: number; readonly Side: Side; readonly price: Ticks;
                            readonly VolUnit: Ticks; readonly availableAt: Ms; readonly availableVol: Lots;
                            readonly WickStrength: number; readonly decile: number | -1; readonly shift: -2|-1|0|1|2; }
```

| Set | Construction | Source |
|---|---|---|
| (1) `wick` | every `PivotStore` entry with `cls = WickLevel`, **regardless of its later state** (INVALIDATED/EXPIRED/RETIRED levels included — §9.5 "Level survivorship"); `decile` = decile of `WickStrength` among set (1) in the span (or fold); `price = WickLevel` at creation (before merges); `VolUnit = VolUnit_created`; `availableAt = classifiedAt` | §9.2 (1), §9.5 |
| (2) `slow` | every `cls = SlowExtreme` entry (including `featuresAvailable=false`); `VolUnit = VolUnit_now` at `classifiedAt` | §9.2 (2) |
| (3) `placebo` | for each level in (1): four levels at `WickLevel + shift·VolUnit_created`, `shift ∈ {−2, −1, +1, +2}`, same `Side`, same `availableAt` | §9.2 (3) |
| (4) `random` | for each **approach event** of a level in (1) (Spec §6.1.2) with approach print `(t_a, p_a)` and signed distance `d = Side·(ℓ − p_a)`: draw `u ~ U(0,1)` from the seeded PRNG, `t_r` = the print at volume `Vol_a − u·1440·BucketVolume` clipped to `≥` the span start, i.e. a uniformly drawn earlier time within one volume-day; the random level is `ℓ_r = p(t_r) + Side·d`, `Side` same, `VolUnit = VolUnit_now(t_r)`, `availableAt = t_r`, and its approach event is `t_r` **by construction** (A-42) | §9.2 (4) |

`BurstPivot` and `Unresolved` pivots are in no set (A-17).

#### 6.1.2 Approach event (§9.2)

For a level `ℓ` (any set): the **approach event** is the first print `i` with `|p_i − ℓ| ≤ ApproachTol·VolUnit`, `ApproachTol = 0.2`, such that (a) `Vol_i − availableVol ≥ RetraceWindow·BucketVolume` ("older than RetraceWindow") and (b) some earlier print `j` with `availableAt ≤ t_j < t_i` had `|p_j − ℓ| ≥ 3·VolUnit` ("after the level has been ≥ 3 VolUnits away"). One approach event per level (the *first*); levels never approached within `MaxAge` buckets of `availableVol` (A-43) are `notApproached` (this is what the IPW in Spec §3.7.4 corrects for). For set (4) the approach event is `t_r` and conditions (a)/(b) are waived by construction.

#### 6.1.3 Outcomes (§9.2)

Over the next `ReactionWindow = 10` buckets from the approach print (prints with `Vol ∈ (Vol_a, Vol_a + 10·BucketVolume]`):

```
p_end                 = p of the first print with Vol ≥ Vol_a + ReactionWindow·BucketVolume
ReactionDisplacement  = Side · (ℓ − p_end) / VolUnit                                     (signed move away from the level)
ReactionHit           = 1{ ∃ print with Side·(ℓ − p) ≥ 1·VolUnit  before any print with Side·(p − ℓ) ≥ 1·VolUnit }
                        within the window; neither within the window ⇒ 0 (conservative, A-44); count `unresolved`
```

#### 6.1.4 Statistics

- Per set (and per decile for set (1)): `E[ReactionDisplacement]`, `P(ReactionHit)`, `n`, `unresolvedShare`.
- **Block bootstrap:** blocks = `volumeDay` (Spec §3.2.5); `B = 2000` resamples of volume-days with replacement (seeded, Spec §9.2); statistic recomputed on each resample; 95 % percentile CI. Contrasts `(1)−(4)`, `(1)−(2)`, `(1)−(3)` are computed **within** each resample (paired), CI from the resampled differences.
- **Monotone in WickStrength:** OLS slope of decile-mean `ReactionDisplacement` on decile index (1..10) with bootstrap CI; monotone ⇔ slope > 0 and CI excludes 0 (A-45). Spearman ρ also reported.
- Second, trade-specific test (§9.2 last paragraph): `HitRate(2,1)` for actual setups vs `1/3` and vs **placebo swept levels** — every set-(3) level that was crossed by an excursion of depth in `[MinSweepDepth, BreakoutDepth]` and re-crossed (the same `SWEEPING → SWEEP_CONFIRMED → reclaim` geometry applied to the placebo price); reported with bootstrap CIs. This runs after the gate as part of Spec §6.2.

#### 6.1.5 Interfaces

```ts
export interface ReactionTestResult {
  readonly venue: VenueId; readonly symbol: string; readonly span: { from: Ms; to: Ms }; readonly seed: number;
  readonly sets: Record<LevelSetId, SetStats>;                 // SetStats = { n, approached, unresolvedShare, meanDisp, ci95Disp, pHit, ci95Hit }
  readonly wickByDecile: ReadonlyArray<SetStats & { decile: number }>;
  readonly contrasts: { '1-4': ContrastStats; '1-2': ContrastStats; '1-3': ContrastStats };   // { diffDisp, ci95, diffHit, ci95Hit, significant }
  readonly monotone: { slope: number; ci95: [number, number]; spearman: number; pass: boolean };
  readonly gate: { pass: boolean; reasons: readonly string[] };
}
export function runReactionTest(input: ReplayInput, cfg: RunConfig, seed: number): Promise<ReactionTestResult>;
```

#### 6.1.6 Gating rule (§9.2)

`gate.pass = contrasts['1-4'].diffDisp > 0 ∧ contrasts['1-4'].significant ∧ monotone.pass`. The P&L backtest (`wsr backtest`, `wsr grid`) **refuses to run** unless a `reaction.json` for the same `(venue, symbol, span, gateConfig)` exists with `gate.pass = true`; it exits with code 3 and the report's first line reads **"REACTION TEST FAILED — P&L backtest not run"** with the failing conditions. `--force-pnl` overrides for diagnostics only; every page of a forced report carries the banner "P&L run despite failed reaction test (§9.2)". If `(1) ≈ (2)` (contrast `1-2` CI contains 0) the report prints §9.2's conclusion verbatim: "fast/decisive is irrelevant and only extremum matters", and open question 2 (Appendix B) is answered *no*.

### 6.2 Target validation (§6.5)

- **MFE/MAE recording.** For every filled trade, from the entry fill print onward: `m(t) = Side·(EntryFill − p_t) / SweepDepth`; `MFE = max m`, `MAE = −min m`. Tracking continues **virtually** past the actual exit until `MAE ≥ max(StopMultGrid) = 1.5` or `MFE ≥ max(TargetMultGrid) = 4` or `8·sweepLegDurationBuckets` elapsed (A-46); virtual tracking ignores position occupancy (Spec §3.10 step 10).
- Grid: `TargetMult ∈ {0.5, 1, 1.5, 2, 2.5, 3, 4}`, `StopMult ∈ {0.75, 1, 1.25, 1.5}` (§6.5). Per cell: `HitRate(T,S) = P(MFE ≥ T before MAE ≥ S)` (path order matters: the engine records the ordered sequence of first-passage times `firstT[T]`, `firstS[S]`), unresolved ⇒ not hit, `unresolvedShare` reported.
- `Expectancy(T,S) = HitRate·(T·SweepDepth − RoundTripCost) − (1 − HitRate)·(S·SweepDepth + RoundTripCost)` in bps, `RoundTripCost` per trade ex post (Spec §4.4), averaged over trades; `HitRate_0(T,S) = S/(T+S)` printed beside every `HitRate` (§6.5).
- Plateau: on **train** trades of each fold, cells ranked by `Expectancy`; plateau = median `(T,S)` of the top 20 % cells (snapped to grid); OOS `Expectancy` at that pair and stability across folds reported (§6.5 "plateau, not the peak… verify the same pair OOS").
- VolUnit-scaled variant: `Target = WickLevel − TargetUnits·VolUnit_created`, `TargetUnits ∈ {0.5, 1, 1.5, 2, 3}`; MFE/MAE re-expressed in VolUnits (`m_u = Side·(EntryFill − p)/VolUnit_created`); same table (§6.5).
- Conditional table `HitRate(2,1) | SweepDepth/VolUnit_created ∈ {[0.3,0.5), [0.5,0.75), [0.75,1), [1,1.5), [1.5,2.5]}` (§6.5).
- Two-stage exit variant: half at `1·SweepDepth` (conservative limit rule), stop moved to `EntryFill`, half at `TargetMult` (§6.5); simulated from the recorded path per trade.

### 6.3 Walk-forward (§9.3)

- **Fold boundaries are calendar:** train = 8 calendar weeks (56 UTC days), test = the following 2 calendar weeks (14 days), rolling by 2 weeks; `foldId` 0..F−1; `F ≥ 12` required (12 months ⇒ up to 22 folds). Justification (A-47): the data partitions, `BucketVolume` resets, funding and fee schedules are all calendar-keyed; calendar folds are reproducible across venues/symbols (identical dates ⇒ comparable folds for open question 9) and interpretable ("this fortnight"); volume-time is already used where the *strategy* needs it (ageing, bootstrap blocks, kill switch). Fold lengths in volume-days are reported per fold so uneven volume is visible.
- Engine state carries across fold boundaries (levels, warm-up); only **fitted quantities** are fold-scoped: Stage B model, `MinStrength` quantile, plateau `(TargetMult, StopMult)`, chosen grid cell. Each is fitted on `[trainStart, trainEnd)` and applied on `[testStart, testEnd)`; the engine receives a `foldSchedule` and switches `StageBModel`/`MinStrength` at `testStart` **using values fitted only from data with `t < trainEnd`** (the fit is computed by a separate pass over recorded pivots/labels of the train window; Spec §9.1 invariant).
- Stage B per fold (§4.2, §9.3): labels from the reaction test's approach outcomes **restricted to train-window approach events** (`ReactionHit` resolved before `trainEnd`).

### 6.4 Parameter search (§9.3)

| Parameter | Grid values | Cells |
|---|---|---|
| `PivotMult` | {0.8, 1.2, 2.0} | 3 |
| `BandWidthMult` | {0.3, 0.5, 0.8} | 3 |
| `MinSpikeSize` | {1.0, 1.5, 2.0, 3.0} | 4 |
| `MinSweepMult` | {0.3, 0.5, 1.0} (each still floored by `2·RoundTripCost`) | 3 |
| `BreakoutMult` | {1.5, 2.5, 4.0} | 3 |
| `minStrengthPassRate` | {0.30, 0.40, 0.50, 0.60} | 4 |
| **Total** | | **1 296 cells** |

- Exactly these six are optimised (§9.3; "Optimised degrees of freedom ≤ 6" — a config with any other parameter marked `grid` fails validation, Spec §8). All other parameters at their §10 defaults during the grid.
- Each cell = one full-span replay with Stage A scoring (Stage B is fitted only for the chosen plateau cell, A-48). Objective per fold = net `Expectancy` (bps, primary path, conservative Target) on the **train** window, cells with `< MinTradesTrain = 100` trades excluded. **Plateau selection:** top 20 % of admissible cells by objective; chosen cell = per-parameter **median** of those cells (snapped to the nearest grid value) (§9.3 "centre of the best plateau… not the argmax"). Applied OOS on the fold's test window. The per-fold chosen cells and their OOS results are the walk-forward result.
- **One-at-a-time sensitivity** for every `sensitivity` parameter of §10 (`MaxSpikeDuration, MinRejectSpeed, MinRejectImbalance, MinRetrace, RetraceWindow, MaxTopDwell, AgeScale`) at its §10 range endpoints and midpoint, all else at the chosen plateau; reported as a table of OOS expectancy vs value (not optimised).
- **Multiple testing (§9.3):** `N_configs` = grid cells × scenario variants × latency points evaluated; reported. **Deflated Sharpe ratio** (Bailey–López de Prado): `DSR = Φ( (SR̂ − SR₀)·sqrt(T − 1) / sqrt(1 − γ₃·SR̂ + (γ₄ − 1)/4 · SR̂²) )` with `SR₀ = sqrt(V[SR]) · ((1 − γ_E)·Φ⁻¹(1 − 1/N) + γ_E·Φ⁻¹(1 − 1/(N·e)))`, `γ_E = 0.5772`, `V[SR]` the variance of trial Sharpes across the `N` cells, `γ₃, γ₄` skew/kurtosis of the chosen configuration's trade returns, `T` its trade count; computed on OOS trade-level returns pooled across folds. **Reality check** (White): stationary bootstrap (`B = 1000`, mean block = one volume-day) of the max over cells of OOS mean return; p-value of the chosen cell reported.
- Parallelism: cells × folds distributed over worker threads (Spec §10).

### 6.5 Cross-venue (§9.3, §9.5)

- A run is `(venue, symbol)`. `wsr backtest --venue a,b` runs two independent pipelines and produces two reports plus a comparison table (open question 9). Levels, Stage B models and plateaus are never shared across venues or symbols.
- The default coverage runs `ETHUSDT` (primary), `BTCUSDT` and the low-cap perp separately (§9.3 "reported separately").

---

## 7. Reporting specification (§9.4)

### 7.1 Typed output schema (JSON)

All numbers in JSON are finite (`NaN` → `null` with an explicit `*Defined:false` sibling). Every file starts with `runManifest`.

```ts
export interface RunManifest { readonly runId: string; readonly createdAt: string; readonly gitCommit: string; readonly wsrVersion: string;
  readonly venue: VenueId; readonly symbol: string; readonly span: { from: string; to: string }; readonly seed: number;
  readonly config: RunConfig; readonly configHash: string; readonly dataChecksums: ReadonlyArray<{ day: string; sha256Merged: string }>;
  readonly feesVerifiedAt: string | null; readonly warnings: readonly string[]; }

export interface TradeRecord {                     // trades.parquet + trades.jsonl
  readonly tradeId: number; readonly levelId: number; readonly Side: Side; readonly foldId: number; readonly cellId: string;
  readonly WickLevel: Ticks; readonly SweepExtreme: Ticks; readonly SweepDepth: Ticks; readonly VolUnit_created: Ticks; readonly VolUnit_now: Ticks;
  readonly WickStrength: number; readonly WickStrength_0: number; readonly WickStrength_B: number | null; readonly decile: number; readonly WickStrength_sweep: number | null;
  readonly TriggerTime: Ms; readonly FillTime: Ms; readonly EntryFill: Ticks; readonly Qty: Lots; readonly FilledQty: Lots;
  readonly touchAndReverse: boolean; readonly touchAndFly: boolean; readonly burst: boolean; readonly noPrintFallback: boolean;
  readonly StopLoss: Ticks; readonly Target: Ticks; readonly exit: ExitRecord; readonly exitOpt: ExitRecord;      // conservative / optimistic Target
  readonly MFE: number; readonly MAE: number; readonly firstPassage: { T: Record<string, Buckets | null>; S: Record<string, Buckets | null> };
  readonly holdBuckets: Buckets; readonly RoundTripCost_bps: number; readonly fundingAccrued_bps: number;
  readonly pnl_bps: number; readonly pnl_R: number; readonly BreakevenHitRate: number;
  readonly regime: 'trend_aligned' | 'trend_counter' | 'neutral' | 'range'; readonly TrendEfficiency: number;
  readonly hourOfDay: number; readonly SweepCount: number; readonly PriorTouches: number; readonly ReturnSpeed: number; readonly ReturnImbalance: number;
  readonly postEntryImbalance2: number;            // −Side·Σ s q / Σ q over the 2 completed buckets after entry (§9.4 mechanism check)
  readonly caps: { g: number; counterTrendHalved: boolean; liquidityCap: boolean; minQty: boolean };
}
export interface ExitRecord { readonly kind: 'stop'|'target'|'time'|'kill'|'none'; readonly t: Ms | null; readonly price: Ticks | null; readonly pnl_bps: number | null; }

export interface FoldMetrics {                     // one per fold (train and test separately) and one pooled
  readonly foldId: number | 'pooled'; readonly window: 'train'|'test'; readonly from: string; readonly to: string; readonly volumeDays: number;
  readonly trades: number; readonly HitRate: number; readonly HitRate_0: number; readonly BreakevenHitRate: number; readonly HitRateMinusBreakeven: number;
  readonly expectancy_bps: number; readonly expectancy_R: number; readonly profitFactor: number;
  readonly sharpeTrade: number; readonly sharpeDaily: number; readonly maxDrawdown_R: number; readonly meanHoldBuckets: number;
  readonly touchAndReverseShare: number; readonly targetFill: { conservative: number; optimistic: number };     // expectancy_bps under each
  readonly latencyCurve: ReadonlyArray<{ latencyMs: number; expectancy_bps: number; trades: number }>;
  readonly slippageCurve: ReadonlyArray<{ slipCoefMult: 1|2|4; expectancy_bps: number }>;
  readonly byDecile: ReadonlyArray<Breakdown>; readonly bySweepDepthBin: ReadonlyArray<Breakdown>; readonly byRegime: ReadonlyArray<Breakdown>;
  readonly byHour: ReadonlyArray<Breakdown>; readonly bySweepCount: ReadonlyArray<Breakdown>; readonly byPriorTouches: ReadonlyArray<Breakdown>;
  readonly byReturnSpeed: ReadonlyArray<Breakdown>;
  readonly mechanism: { winnersMeanImb: number; losersMeanImb: number; diff: number; ci95: [number, number] };
  readonly ruleBinding: RuleBindingStats; readonly costFloor: { minSweepSetByCost: number; shareOfSpikes: number };
  readonly blacklistedBucketShare: number; readonly killSwitchTrips: number;
}
export interface Breakdown { readonly key: string; readonly trades: number; readonly HitRate: number; readonly HitRate_0: number; readonly expectancy_bps: number; readonly expectancy_R: number; }
export interface RuleBindingStats { readonly [counter: string]: number; }
export interface TransitionRecord { readonly t: Ms; readonly seq: number; readonly levelId: number; readonly from: LevelState; readonly to: LevelState; readonly reason: string; }
```

Output files per run: `run.json` (manifest), `reaction.json`, `trades.parquet`, `transitions.parquet`, `levels.parquet` (one row per level incl. terminal outcome), `pivots.parquet` (full `PivotStore`), `folds.json` (`FoldMetrics[]`), `target_grid.json`, `grid.json` (all cells), `sensitivity.json`, `stageB.json` (per fold model + calibration), `report.md`.

### 7.2 Markdown report layout (`report.md`)

```
# WSR backtest — {venue} {symbol} {from}…{to}
[banner: REACTION TEST FAILED — P&L backtest not run | P&L run despite failed reaction test | fees unverified]
0. Run manifest (config hash, seed, git commit, data checksums count, warnings)
1. Data coverage & hygiene (days, suspect partitions, blacklisted buckets, feedKind, tick changes)
2. Reaction test (§9.2): table per set [n, approached, E[Disp] (CI), P(Hit) (CI)]; decile table for WickLevels; contrasts (1)−(4), (1)−(2), (1)−(3); monotonicity; GATE VERDICT
3. Cost floor diagnostic (§7.4, §12.1): RoundTripCost estimate, share of Spikes where the cost floor set MinSweepDepth, BreakevenHitRate distribution
4. Target validation (§6.5): (TargetMult × StopMult) HitRate | HitRate_0 | Expectancy tables (train plateau, OOS at plateau); VolUnit-scaled table; SweepDepth/VolUnit conditional table; two-stage exit
5. Walk-forward (§9.3): per-fold table (chosen cell, train/test trades, HitRate vs HitRate_0 vs Breakeven, expectancy bps/R, PF, Sharpe, MaxDD_R, hold); pooled row
6. Latency curve (§7.1) with the 50→150 ms sentence when it applies; slippage curve (§9.4)
7. Execution realism: touch-and-reverse share, touch-and-fly, burst fills, no-print fallbacks, partial fills; conservative vs optimistic Target expectancy
8. Breakdowns (§9.4): WickStrength decile (with monotonicity verdict, §4.3), SweepDepth/VolUnit bin, regime, hour-of-day, SweepCount, PriorTouches (sign verdict, §8.3), ReturnSpeed bin, ArmMode variant
9. Mechanism check (§1, §9.4): post-entry aggressor imbalance (2 buckets) winners vs losers, CI
10. Rule/cap binding (§5, §11) and level survivorship (transition counts by reason; share of WickLevels that were INVALIDATED)
11. Parameter search: N_configs, plateau cells per fold, sensitivity tables, DSR, reality-check p-value
12. Open questions (§12) — Appendix B table with the verdict per question and the section that answers it
```

Every table that shows a `HitRate` shows `HitRate_0` in the adjacent column (§6.5). Every expectancy is net of §7.4 costs; gross values are not shown (they would soften §12's cost warning).

---

## 8. Configuration schema (§10)

### 8.1 File format and validation

`RunConfig` is a JSON (or JSON5) file validated by a `zod` schema in `@wsr/core/src/config.ts`. Validation rules: every key must exist in the table below (no unknown keys); values in range; **exactly** the six §9.3 parameters may carry `class: 'grid'`; `MaxAge = 3·AgeScale` is derived, not settable; `MinSweepMult` values are floored at run time by `2·RoundTripCost` (§6.1) and the report shows both the configured and the effective value. The canonical serialisation (sorted keys, no whitespace) is hashed (sha256 → `configHash`) and embedded, together with `seed`, in `run.json` and in the Parquet key-value metadata of every output file.

### 8.2 Parameter table

Class ∈ `grid | fixed | sensitivity | measured | variant | policy` (§10 "Set by"; `construction` in §10 is `measured` here: the value is computed from data).

| Key | Meaning (§10) | Default | Range | Class | Source |
|---|---|---|---|---|---|
| `BucketVolume` | volume per bucket | computed daily | — | measured (construction) | §2.2 |
| `UnitWindow` | buckets for VolUnit | 60 | 30–120 | fixed | §2.3 |
| `PivotMult` | zigzag reversal, VolUnits | 1.2 | 0.8–2.0 | grid | §3.1 |
| `BandWidthMult` | rejection band, VolUnits | 0.5 | 0.3–0.8 | grid | §3.2 |
| `MinSpikeSize` | min excursion, VolUnits | 1.5 | 1.0–3.0 | grid | §3.3 |
| `MaxSpikeDuration` | max excursion, buckets | 3 | 1–6 | sensitivity | §3.3 |
| `MinRejectSpeed` | VolUnit/bucket | 0.5 | 0.3–1.0 | sensitivity | §3.3 |
| `MinRejectImbalance` | sell share on rejection | 0.2 | 0.1–0.4 | sensitivity | §3.3 |
| `MinRetrace` | retrace gate | 0.6 | 0.5–0.8 | sensitivity | §3.3 |
| `RetraceWindow` | buckets | 5 | 3–10 | sensitivity | §3.2 |
| `MaxTopDwell` | buckets | 0.5 | 0.25–1 | sensitivity | §3.3 |
| `TopBandMult` | top band, VolUnits | 0.15 | fixed | fixed | §3.2 |
| `AnchorWindow` | buckets | 20 | fixed | fixed | §3.2 |
| `MergeTolerance` | VolUnits | 0.25 | 0.15–0.4 | fixed | §3.1 |
| `RankWindow` | pivots for rank normalisation | 500 | 300–1000 | fixed | §4.1 |
| `minStrengthPassRate` | MinStrength as pass rate | 0.40 | 0.30–0.60 | grid | §4.3 |
| `strengthModel` | `stageA` / `stageB` | `stageA` | — | variant | §4.2 |
| `stageB.lambda` | L2 penalty | 1.0 | fixed | fixed | §4.2 (A-21) |
| `AgeScale` | buckets | 240 | 100–600 | sensitivity | §5 |
| `MaxAge` | derived `3·AgeScale` | 720 | — | derived | §5 |
| `ageClock` | `volume` / `wall` | `volume` | — | variant | §5 |
| `DistanceScale` | VolUnits | 5 | 3–10 | fixed | §5 |
| `MinSweepMult` | MinSweepDepth, VolUnits | 0.5 | 0.3–1.0 | grid | §6.1 |
| `BreakoutMult` | BreakoutDepth, VolUnits | 2.5 | 1.5–4.0 | grid | §6.1 |
| `ArmMode` | `RestEarly` / `ArmOnApproach` | `RestEarly` | — | variant | §6.3 |
| `ArmDistance` | VolUnits | 0.5 | 0.3–1.0 | variant | §6.3 |
| `MinReturnSpeed` | VolUnit/bucket | 0.3 | fixed | fixed | §8.6 (A-27) |
| `TriggerOffset` | ticks | 0 | 0–2 | fixed | §6.3 |
| `StopOffset` | ticks | 1 | fixed | fixed | §6.4 |
| `TargetMult` | × SweepDepth | 2 | grid §6.5 | §6.5 (target grid, not the six) | §6.4 |
| `StopMult` | × SweepDepth | 1 | grid §6.5 | §6.5 | §6.5 |
| `targetMode` | `sweepDepth` / `volUnit` / `market` / `twoStage` | `sweepDepth` | — | variant | §6.5, §7.3 |
| `TargetUnits` | VolUnits (when `volUnit`) | 2 | 0.5–3 | variant | §6.5 |
| `timeStop` | on/off | off | — | variant | §6.4 |
| `MaxHold` | × sweep-leg duration | 4 | 2–8 | variant | §6.4 |
| `MaxUses` | reuse | 1 | 1–3 | fixed | §5 |
| `MaxSweeps` | re-sweeps | 3 | fixed | fixed | §8.2 |
| `MaxPending` | queue | 4 | fixed | fixed | §7.5 |
| `latencyMs` | ms | 150 (sweep {0,50,150,500}) | 0–500 | measured | §7.1 |
| `stopMode` | `client` / `exchangeNative` | `client` | — | variant | §7.1 |
| `exchangeLatencyMs` | ms | 30 | 10–50 | measured | §7.1 |
| `SlipTicks` | ticks | 1 | 1–2 | measured (live-calibrated) | §7.2 |
| `SlipCoef` | — | 0.05 (curve ×{1,2,4}) | — | measured (live-calibrated) | §7.2 |
| `FillWindow` | ms | 100 (300 in burst) | fixed | measured | §7.2 |
| `RiskFraction` | equity risk per trade | 0.0025 | 0.001–0.005 | policy | §11 |
| `equity` | USDT, constant | 100000 | > 0 | policy | A-40 |
| `DailyLossLimit` | × per-trade risk | 3 | fixed | policy | §11 |
| `counterTrendBlock` | block counter-trend | false | — | variant | §8.1 |
| `minExtremePrintQtyPct` | extreme-print size filter | off | 0.10 | variant | §3.1 |
| `blacklistMacroReleases`, `blacklistFunding` | ±2 min blacklists | false | — | variant | §8.7 |
| `fees.{venue}.TakerFee/MakerFee` | fractions | Spec §2.2 placeholders | — | measured (`verifiedAt` required) | §7.4 |
| `data.lowCapSymbol` | third symbol | — (required) | — | policy | §9.3 |
| `seed` | PRNG seed | 1 | uint32 | policy | Spec §9.2 |

Grid and target-grid value lists (Spec §6.4, §6.2) are part of the config under `search.grid` and `search.targetGrid`; changing them is allowed but the six-parameter cap is enforced.

### 8.3 Embedding in outputs

`run.json` contains the full validated config (after defaults), `configHash`, `seed`, `gitCommit`, `wsrVersion`, the list of data partition checksums, fee `verifiedAt`, and `warnings`. Every Parquet output stores `wsr.configHash`, `wsr.seed`, `wsr.runId` in its key-value metadata; `report.md` prints them in section 0.

---

## 9. Look-ahead and determinism invariants

### 9.1 Look-ahead boundaries

| # | Boundary | Source | Where enforced in code | Test that detects regression |
|---|---|---|---|---|
| L1 | `LegExtreme` is invisible before `confirmed_at`; a pivot exists only from `confirmed_at` | §3.1, §9.5 | `Zigzag` fields are `private`; the only output is the `Pivot` value emitted on the confirming print (Spec §3.4) | `pivotNotVisibleBeforeConfirmedAt` (property: for random paths, replay truncated at every `t` yields a `PivotStore` that is a prefix of the full replay's store filtered by `confirmed_at ≤ t`) |
| L2 | `ExitTime` is waited for, never peeked | §3.2, §9.1 | `ExcursionFeatures.iOut` is set only by `firstAfter` over prints already pushed to the ring (Spec §3.5.1) | `exitTimeCausal` (truncation property as L1 on `ExitTime`) |
| L3 | `RetraceFraction` is final only after `RetraceWindow` buckets of volume past `ExitTime`; G5 evaluated only then | §3.2, §3.3, §9.5 | `retraceAvailableAt` guard in `applyGates`; `classifiedAt ≥ retraceAvailableAt` asserted for `WickLevel` | `retraceCausal` (assert `classifiedAt − ExitTime ≥ RetraceWindow` in volume; truncation property) |
| L4 | `SweepExtreme` fixed only at the reversal print (`P ≤ R − PivotReversal`) | §6.2, §9.1 | `SWEEPING` row of Spec §3.9.6; `SweepExtreme = −1` while `SWEEPING` and reads of `−1` throw | `sweepExtremeCausal` (truncation property; assert `sweepExtremeConfirmedAt > time of SweepRunningMax`) |
| L5 | Bucket statistics change only on bucket close; `VolUnit_now`, `SpreadEst`, `RVol`, `TrendEfficiency`, `BurstFlag`, `LiquidityGuard`, `PivotReversal`, `eventSizeP99` never mid-bucket | §2.2, §9.1, §9.5 | Spec §3.10 step 2 is the only writer; consumers hold read-only views; a `frozenStats` object is replaced atomically on close | `bucketStatsFrozenMidBucket` (instrumented replay: hash of the stats object is constant between closes) |
| L6 | Fills use prints strictly after `TriggerTime + Latency` (never the trigger print) | §7.1, §9.1, §9.5 | Spec §4.2.1 window definition `(t > FillTime) ∨ (t == FillTime ∧ seq > triggerSeq)`; Spec §3.10 step 5 before step 9 | `fillNeverOnTriggerPrint` (assert `fillSeq > triggerSeq` for every fill; with `latencyMs=0` and a path where the trigger print is the best price, fill ≠ trigger price) |
| L7 | No "optimistic no-fill" on instant reversal | §7.2, §9.5 | No cancellation path after trigger (Spec §4.2.2) | `touchAndReverseMustFill`; fuzz `#triggers == #entries` |
| L8 | Limit `Target` is not filled on touch (conservative rule requires a print strictly beyond by > 1 tick; optimistic rule requires printed volume > `QueueProxy`) | §7.3, §9.5 | Spec §4.3 rules; `targetMode=market` is the only touch-fill and pays taker fee | `targetNotFilledOnTouch` (path touching `Target` exactly and reversing ⇒ no target exit; volume at `Target` ≤ `QueueProxy` ⇒ no optimistic exit) |
| L9 | INVALIDATED / EXPIRED / RETIRED levels are in the reaction test's set (1) | §9.5 | `RefLevel` set (1) is built from `PivotStore` by `cls`, never from `LevelBook` (Spec §6.1.1) | `reactionSetIncludesInvalidated` (synthetic: a WickLevel that breaks out must appear in set (1)) |
| L10 | Fold-fitted quantities (Stage B, `MinStrength`, plateau, chosen cell) use only `t < trainEnd` | §4.2, §9.3 | Fitting functions take a `trainEnd` argument and filter inputs by `t < trainEnd`; the engine receives models keyed by fold and switches them at `testStart` | `foldFitCausal` (fit on train, perturb test data, assert identical model bytes) |
| L11 | `Anchor`, `EnterTime` use only prints before `PivotTime`; `PriorTouches` uses only pivots with `confirmed_at ≤ now` | §3.2, §4.1 | ring index bounds; `PivotStore.countNear(minVol)` | covered by L1/L2 truncation property |
| L12 | Random/placebo levels do not use future data: the random level's time is drawn **earlier** than the approach event (Spec §6.1.1) | §9.2 | `t_r ≤ t_a` asserted | `randomLevelCausal` |

The **truncation property** (L1–L4) is the master test: for a synthetic path and any cut time `t_c`, running the engine on the prefix `[0, t_c]` must produce a state that the full run also had at `t_c` (compared via deterministic `snapshot()` hashes at `t_c`). Any use of future data breaks this. It runs in CI on 200 random paths × 20 cut points. Runtime assertions for L3, L4, L6, L12 are compiled in (`assert()` from `@wsr/core/src/invariant.ts`) and abort the run with exit code 5.

### 9.2 Determinism

- **Same data + config + seed → byte-identical outputs** (`trades.parquet`, `folds.json`, `report.md`, everything). CI runs the end-to-end fixture twice and diffs.
- All randomness flows from one `seed` (uint32) through `splitmix32` → per-purpose `xoshiro128**` streams: `bootstrap(foldId)`, `randomLevels`, `realityCheck`, `workerShard(cellId)`. Streams are derived by hashing the purpose string and ids, never by call order.
- No `Math.random`, `Date.now`, `crypto.randomUUID`, `Object` key-order dependence, `Map` iteration over unsorted keys, or floating-point reductions whose order depends on thread scheduling. Parallel results are merged in a fixed order (`cellId`, `foldId`). Sums over trades use pairwise (Kahan) summation in a fixed order.
- `parquet-wasm` writer configured with deterministic row-group boundaries and no created-by timestamp variance **[VERIFY]**; if the library injects a timestamp, the harness rewrites the footer metadata or the determinism test compares a canonical re-serialisation (documented in `docs/determinism.md`).
- Worker threads receive `(cellId, foldId, seed)`; each worker is stateless across tasks.

---

## 10. Performance and operational requirements

| Requirement | Specification |
|---|---|
| Streaming replay | Merged partitions are read day by day as Arrow record batches (≤ 1 M rows each) and fed to the engine; no day is held after it is consumed except through the `TradeRing`. Memory per engine: `TradeRing` (≈ 40 B/event × capacity; 2^21 events ≈ 84 MB worst case) + `PivotStore` (unbounded, ≈ 200 B/pivot) + level book + bucket history. Target: < 1.5 GB per worker for a 13-month ETHUSDT replay. |
| Typed arrays on the hot path | `TradeRing`, `BucketBuilder` accumulators, `Zigzag`, `SpreadEst` ring, rank rings, level scan arrays are all typed arrays or scalar fields; no per-print object allocation (`MergedEventView` is a reused cursor). Verified by `--cpu-prof` in `wsr bench`: allocation rate < 1 MB/s at steady state. |
| Parallelism | `worker_threads` pool of `os.availableParallelism() − 1` workers; task = `(venue, symbol, cellId, latencyPoint, variant)` full-span replay, or `(foldId)` fitting task; results streamed to the parent as Arrow IPC buffers (transferable). Fold statistics are computed after replay by partitioning trades, so folds do not multiply replays (Spec §6.3). |
| Throughput target | ≥ 3 M merged events/s per worker for the core loop with the default level count (measured on the `wsr bench` synthetic path), and ≥ 1 M events/s end-to-end including Parquet decode. A 13-month ETHUSDT span (~1.5–3 × 10⁸ merged events **[VERIFY from data]**) ⇒ ≤ 5 min per cell per worker; the 1 296-cell grid on 16 workers ≈ 7 h. `wsr bench` prints events/s, allocation rate, and p99 per-print latency; CI fails if throughput drops > 20 % vs the checked-in baseline. |
| Logging | `pino` JSON logs; levels `error/warn/info/debug`; every log line carries `runId`, `venue`, `symbol`, `cellId?`, `foldId?`. Engine invariant violations log at `error` with the offending `levelId`, `t`, `seq` before exit code 5. |
| Progress | Per worker: `{ eventsProcessed, days, pivots, levels, trades, eventsPerSec }` every 5 s to the parent; the CLI renders one line per task; `--json` emits NDJSON progress. |
| Resumable runs | Grid/latency/variant tasks write `runs/{runId}/cells/{cellId}.done` with results; rerunning `wsr grid --run-id …` skips completed cells. Reaction test and fitting are cheap and rerun. |
| Output directory layout | `runs/{runId}/run.json`, `reaction.json`, `trades.parquet`, `transitions.parquet`, `levels.parquet`, `pivots.parquet`, `folds.json`, `target_grid.json`, `grid.json`, `cells/{cellId}.json`, `sensitivity.json`, `stageB.json`, `report.md`, `logs/*.jsonl`. |

---

## 11. Test plan

Test runner: `vitest` (workspace-aware). Property tests with `fast-check` (seeded). Golden files under `fixtures/`.

### 11.1 Unit tests per module (`@wsr/core`)

| Module | Required cases |
|---|---|
| `merge` (in `@wsr/data`) | monotone buy run merges into one event with last price; non-monotone same-`(t,s)` splits; equal prices merge; midnight boundary; sort stability with unordered input |
| `TradeRing` | wrap-around, `indexAtVol`/`indexAtTime` binary search edges, eviction error, capacity growth on underflow |
| `BucketBuilder` | bucket closes on `SumQ ≥ BucketVolume` with the whole event; `BucketVolume_next` applies at next open; `Vwap` overflow-safe accumulation equals exact rational; daily median 60-s computation with empty windows; warm-up gating |
| `SpreadEst` | median over sign-change gaps; floor at `Tick`; publication only on close |
| `VolUnit` | median of last 60 ranges; floors `4·Tick`, `3·SpreadEst` |
| `Zigzag` | matches Appendix A reference implementation on random paths (differential test); at most one pivot per print; `PivotReversal` change mid-leg handled |
| `ExcursionFeatures` | every feature against a hand-computed fixture (10-print excursion); `iIn = −1` → Unresolved; `PendingLimit` → SlowExtreme(featuresAvailable=false); early G2 verdict time |
| `SpikeGates` | each gate individually failing; burst overlap → `BurstPivot` |
| `WickStrength` | rank with ties; `MinRankPivots`; Stage A weights sum to 1; Stage B logistic fit recovers known coefficients on synthetic data; IPW weights |
| `PivotStore` | `countNear` window in volume; never evicts |
| `LevelBook` | every row of the Spec §3.9.6 table as a scripted path (one test per row, named by from/to/reason); merge outward; nested retire/suppress; §8.5 sweep-leg registration; conflict (g); `MaxPending`; kill switch |
| `ExecutionModel` | worst-print selection; half-spread; slippage rounding up; burst ×3 and 300 ms; no-print fallback; touch-and-fly; partial fill; `touchAndReverseMustFill`; `fillNeverOnTriggerPrint`; `targetNotFilledOnTouch`; optimistic queue proxy; OCO; funding accrual sign **[VERIFY]** |
| `Sizing` | each cap binds and is recorded; `g` clip; halving |
| Side symmetry | mirrored path ⇒ mirrored outputs (Spec §3.12) |
| Numerics | decimal parsing exactness; `ceil/floorTicksConservative` directions; `Σq` bound check |

### 11.2 Property tests for the §9 invariants

L1–L12 of Spec §9.1 as listed, plus: `bucketStatsFrozenMidBucket`; `onePositionPerSymbol` (assert ≤ 1 open trade on every print of random paths); `stateMachineClosed` (every transition taken appears in the table; unknown `(from,to)` fails); `determinism` (two runs, same seed ⇒ identical snapshot hashes at 100 checkpoints); `blacklistNoLevels` (no `WickLevel` whose excursion overlaps a blacklist interval).

### 11.3 Synthetic-path tests (§1)

- **Driftless random walk ⇒ `HitRate(2,1) ≈ 1/3`.** Generate a symmetric ±1-tick random walk with i.i.d. aggressor signs and constant size; run the full engine with costs = 0, `Latency = 0`, all gates disabled except geometry (`MinSpikeSize=0`, `MaxSpikeDuration=∞`, `MinRejectSpeed=0`, `MinRejectImbalance=−1`, `MinRetrace=0`, `MaxTopDwell=∞`, `minStrengthPassRate=1`), `targetMode=sweepDepth`, conservative Target rule relaxed to touch for this test only (flag `test.targetOnTouch`, unavailable outside tests). Over ≥ 20 000 trades, `HitRate(2,1) ∈ [0.333 − 3σ, 0.333 + 3σ]` with `σ = sqrt(1/3·2/3/n)`; the `HitRate_0` column must equal 1/3; `E[ReactionDisplacement]` for all four level sets must be ≈ 0 with overlapping CIs, and the gate must **fail** (a correct system finds no edge in noise).
- **Drift test:** the same walk with drift must show the counter-trend asymmetry (§12 weakness 3) in the `byRegime` table.
- **Cost test:** with §7.4 default costs and `SweepDepth` forced small, `BreakevenHitRate → 1` and `MinSweepDepth` is set by the cost floor for > 90 % of Spikes (§12 weakness 1 reproduced).

### 11.4 End-to-end fixture with golden outputs

`fixtures/e2e/binance-ETHUSDT-2025-03-01/` (one venue-day, 24 h of recorded merged trades ≈ 1–2 M events plus a synthetic 8-day warm-up generated from the day's own statistics) → `wsr backtest --fixture` produces `trades.parquet`, `transitions.parquet`, `folds.json`, `report.md` compared byte-for-byte with the checked-in goldens. Goldens are regenerated only by an explicit `pnpm goldens:update` with a commit message citing the Appendix A change that justified it.

### 11.5 Data-pipeline tests with recorded venue responses

For each of the six adapters: recorded raw archive files / REST pages / WS frames under `fixtures/venues/{venue}/` (a few thousand records each) → `normalise` output compared with golden `CanonicalTrade` JSON; assertions: `s` derived from the documented explicit field only (a fixture with the field removed must throw `MissingAggressorField`); `p`,`q` exactness; `seq` order; contract multiplier applied (OKX, Gate, KuCoin); pagination cursor logic with a 3-page fixture; rate limiter timing with a fake clock; retry/backoff with injected 429/5xx; checksum verification (Binance) success and failure; `.done` idempotency; hygiene report on a fixture with planted duplicates, a 5-minute gap, a bad print and a tick-size change.

---

## 12. Build order and acceptance criteria

### 12.1 Build order (follow the per-print loop of §9.1; synthetic before real; reaction before P&L)

| Step | Deliverable | Verify with |
|---|---|---|
| 1 | Workspace, `tsconfig`, lint rules (`wsr/reserved-identifiers`, `wsr/no-float-price`, `wsr/no-venue-literal`, dependency direction), `@wsr/core` types, numeric helpers, config schema + validation | Spec §11.1 numerics; config rejects a 7th `grid` parameter |
| 2 | `merge` (Spec §2.4) + Parquet writer/reader + `.done` markers | Spec §11.1 merge; determinism of Parquet bytes |
| 3 | `TradeRing`, `BucketBuilder`, `SpreadEst`, `VolUnit`, regime stats | unit tests; `bucketStatsFrozenMidBucket` |
| 4 | `Zigzag` | differential test vs Appendix A |
| 5 | `ExcursionFeatures`, `SpikeGates`, `PivotStore`, rank normalisation, Stage A | fixtures; truncation property L1–L3 |
| 6 | `LevelBook` state machine, side symmetry | one test per table row; mirror test |
| 7 | `ExecutionModel`, sizing, kill switch, funding | L6–L8, `touchAndReverseMustFill` |
| 8 | `Engine.onPrint` loop, snapshots, invariant assertions | truncation property on full engine; determinism test |
| 9 | Synthetic tests (Spec §11.3) — **must pass before any real data is replayed** | `HitRate(2,1) ≈ 1/3`; gate fails on noise |
| 10 | Venue adapters (Binance first — archive + checksums; then Bybit, OKX, Gate; then Bitget REST; KuCoin recorder last), hygiene report, `wsr data` CLI | recorded fixtures; a 1-day live fetch per venue |
| 11 | Replay driver, blacklist consumption, reaction test + bootstrap + gate, `wsr reaction` | L9, L12; e2e fixture reaction goldens |
| 12 | Target validation, MFE/MAE, Stage B fitting + IPW, walk-forward schedule, `wsr backtest` (refuses without a passing `reaction.json`) | L10; e2e goldens |
| 13 | Grid, plateau selection, sensitivity, DSR, reality check, worker pool, resumability, `wsr grid` | cell-count report = 1 296 × variants; resume test |
| 14 | Reports (JSON + Markdown), `wsr report`, `wsr bench` | report sections 0–12 present; throughput baseline |

### 12.2 Definition of done (checklist)

```
[ ] pnpm install && pnpm build && pnpm lint && pnpm test        → 0 failures; coverage of @wsr/core ≥ 90 % lines
[ ] pnpm test:property                                          → L1–L12 + Spec §11.2 pass on 200 seeds
[ ] wsr bench --synthetic                                       → ≥ 3 M events/s core loop; alloc < 1 MB/s
[ ] wsr backtest --synthetic driftless --trades 20000           → HitRate(2,1) within 3σ of 1/3; gate FAIL; exit 3
[ ] wsr data fetch --venue binance --symbol ETHUSDT --from <run−13mo> --to <yesterday>   → exit 0; all .done present; hygiene summary printed
[ ] wsr data verify --venue binance --symbol ETHUSDT           → exit 0
[ ] wsr data fetch --venue bybit,okx,gate,bitget --symbol ETHUSDT,BTCUSDT,<lowcap>       → exit 0 or 2 with coverage gaps listed (Bitget/KuCoin gaps documented)
[ ] wsr reaction --venue binance --symbol ETHUSDT --config configs/default.json --seed 1 → reaction.json with 4 sets, deciles, 3 contrasts, monotonicity, gate verdict
[ ] wsr backtest --venue binance --symbol ETHUSDT --config configs/default.json          → exit 3 and banner if gate failed; else trades/folds/target_grid/report with every §9.4 metric
[ ] wsr backtest ... --latency-sweep                             → latencyCurve with 4 points
[ ] wsr backtest ... --variants armMode,targetMode,timeStop,counterTrendBlock,ageClock   → one FoldMetrics set per variant
[ ] wsr grid --venue binance --symbol ETHUSDT                    → 1 296 cells, plateau per fold, sensitivity.json, DSR + reality-check p in report §11
[ ] wsr backtest --venue binance,bybit --symbol ETHUSDT          → two independent reports + comparison table (never a mixed run)
[ ] Run the e2e fixture twice                                   → byte-identical outputs
[ ] report.md section 12 answers all nine §12 questions with the table reference of Appendix B
```

---

## Appendix A — Resolved ambiguities

Each entry: **Id · section · the choice left open · options · conservative choice taken · why.**

| Id | § | Ambiguity | Options | Choice | Rationale |
|---|---|---|---|---|---|
| A-1 | §2.1 | Price of a merged event | first / VWAP / last (extreme) | **last** | §3.1: the extreme fill is where stops were placed; last of a monotone run = extreme |
| A-2 | §2.1 | Same `(t,s)` but non-monotone prices | merge anyway / split | **split** into separate events | "monotone" is a condition of the rule |
| A-3 | §2.1 | Same `(t,s,p)` repeated | merge / keep separate | **merge** | equal prices are monotone |
| A-4 | §2.2 | Event straddling the bucket boundary | split event / assign whole | **assign whole**, overshoot recorded | events are atomic in the spec's counts |
| A-5 | §2.2 | When the daily `BucketVolume` takes effect | mid-bucket / next bucket | **next bucket open** | no mid-bucket parameter change |
| A-6 | §2.2 | `BucketVolume` on the first day | none / same-day bootstrap | **same-day first-hour median, warm-up only** | warm-up produces no outputs |
| A-7 | §8.8 | "last 5 buckets took > 5× their median wall-clock duration" | per-bucket / sum | **sum of last 5 vs 5 × median (1440-bucket median)** | literal reading of "took" |
| A-8 | §2.1 vs §9.1 | `SpreadEst` refresh: every 100 events vs on bucket close | either | **published on bucket close**; 100-event candidate | §9.5 forbids mid-bucket refresh of bucket statistics; prompt requires close-only |
| A-9 | §2.3 | Moment `VolUnit_created` freezes | pivot time / confirmation / classification | **confirmation (`confirmed_at`)** | earliest time the level exists; features need it |
| A-10 | §3.1 | On merge, recompute `VolUnit_created`, `WickStrength`, `ExitTime`? | yes / no | **no** | level is an artefact of its formation conditions |
| A-11 | §3.2 | No `EnterTime` within the ring | SlowExtreme / drop | **`Unresolved`, stored, no set** | features undefined; not a decisive extremum either |
| A-12 | §3.2 | `ExitTime` never observed within ring bounds | drop / SlowExtreme | **SlowExtreme(featuresAvailable=false)**, in set (2), not in `RankWindow` | it is an un-rejected extremum (control), but unrankable |
| A-13 | §3.3 | When G2 can be decided | at `RetraceWindow` / as soon as impossible | **early verdict** for class; features finish later | availability time for the reaction test should be the earliest honest time |
| A-14 | §3.2 | Zero-length rejection duration | ε / one-event floor | **floor at the pivot event's own volume** | App. A uses `max(·,1e-9)`; one event is the physical minimum |
| A-15 | §3.2 | `ExpectedVolume(wall duration, hour-of-day)` | median-per-minute / mean per ms | **mean lots per ms for the hour over the previous 7 days** × wall duration | defined, positive, uses the same 7-day profile as `Vol100ms` |
| A-16 | §3.2 vs App. A | `MaxPrintGap` over excursion vs rejection | either | **whole excursion** | the feature table is normative; App. A is illustrative |
| A-17 | §8.7 | Burst pivots in `RankWindow` / level sets | include / exclude | **exclude** from both | "features unrepresentative" |
| A-18 | §4.1 | Units of `RVol` in `SpikeSize/RVol` | log-return units / ticks | **ticks (`RVol_60·Vwap`)** as of last close before `confirmed_at` | makes the ratio dimensionless like `SpikeSize` |
| A-19 | §4.1 | `WickStrength` before `RankWindow` fills | rank on few / undefined | **undefined below 50 pivots; level untradable** | avoids degenerate ranks |
| A-20 | §4.2 | Weights of `MaxPrintGap`, `SpikeSize/RVol` in Stage A | — | **0** | absent from the weight list |
| A-21 | §4.2 | L2 penalty value; gradient boosting | free | **λ = 1.0 fixed; boosting not implemented, calibration reported** | λ is not one of the six DoF; boosting only if the stated condition holds |
| A-22 | §5 vs §9.1 | `RETIRED` is in §5 but not in §9.1's terminal list | fold into INVALIDATED / add | **add `RETIRED` as a terminal state** | keeps §9.5 survivorship reasons distinct |
| A-23 | §8.4 | "within `BreakoutDepth`" — whose? | inner / outer / max | **`BreakoutMult · max(VolUnit_created)` of the two** | conservative (wider net ⇒ fewer parallel orders) |
| A-24 | §8.4 vs §8.5 | Outer Spike registered while inner is swept | retire inner / keep | **keep inner if already `SWEEPING`+** | §8.5 requires the current trade to proceed |
| A-25 | §8.5 | `WickStrength(sweep)` as Stage B feature | add / report only | **report dimension only in v1** | keeps the 13-feature vector of §4.1 |
| A-26 | §3.1 vs §8.3 | Two definitions of touches | separate / unify | **unified: same-side pivot within `MergeTolerance` not exceeding `MinSweepDepth`** | both describe an approach that respected the level |
| A-27 | §6.3, §8.6 | `MinReturnSpeed` has no value | — | **0.3 VolUnit/bucket** | §8.6 calls `< 0.3` "slow drift" |
| A-28 | §6.2 | Confirmation "when the zigzag emits a PivotHigh for this leg" | rely on `Zigzag` object / same test inline | **inline `P ≤ R − PivotReversal`** | identical criterion; independent of zigzag leg phase |
| A-29 | §6.3 | Reclaim happens while the level is suppressed (no order) | wait forever / cancel | **`CANCELLED(missedReclaim)` after `RetraceWindow` buckets below `W` unless re-swept** | a reclaimed level without a fill is a consumed setup |
| A-30 | §8.2, §7.5 | Entry triggers during a re-sweep leg | block / allow with old stop | **allow; old `SweepExtreme` governs the stop** | §7.5: entry stop unchanged; stop cancel–replace only after re-confirmation |
| A-31 | §8.10 | `EXPIRED`/regime `INVALIDATED` while `IN_TRADE` | close at market / keep exits | **keep exits; retire after close** | §8.8 precedent: open positions keep their exits |
| A-32 | §2.1 | Sub-ms timestamps (KuCoin ns) | use / truncate | **truncate to ms, keep remainder in raw** | one clock resolution for all venues |
| A-33 | §7.2 vs §9.1 | Window `[FillTime, …]` vs "strictly after" | either | **strictly after** by `(t, seq)`; same-ms prints after the trigger print included | §9.5 forbids the trigger print; excluding same-ms later prints would be optimistic |
| A-34 | §7.2 | `Vol100ms` median over all slots (mostly zero) or non-empty | either | **non-empty slots, floored at 1 lot** | defined and positive; slippage curve ×{1,2,4} covers the uncertainty |
| A-35 | §7.3 | Optimistic Target and position occupancy | second full run / alternate outcome | **alternate outcome per trade; occupancy from the conservative path** | it is a bound, not a strategy |
| A-36 | §7.5 | Latency on OCO placement | apply / none | **none (exchange-side)** | §7.5 "exchange-side if supported"; stop *triggers* still carry latency |
| A-37 | §7.4 | Breakeven for non-(2,1) grid cells | (2,1) only / general | **general form** | needed by the §6.5 table |
| A-38 | §7.4 | Missing funding records | ignore / charge | **charge 1 bp/8 h against the position** | conservative |
| A-39 | §11 | `E[Slippage]` depends on `Qty` | ignore / iterate | **one fixed-point iteration** | closes the circularity deterministically |
| A-40 | §11 | Equity compounding | compound / constant | **constant equity** | comparable R and bps across folds |
| A-41 | §8.1 | Regime for `0.2 ≤ TE < 0.4` | trend / range | **`neutral`, allowed** | §8.1 defines only the two ends |
| A-42 | §9.2 | Random level construction | random price / random time | **uniform earlier time within one volume-day, same distance, same side** | "at each approach time … same distance … drawn uniformly" |
| A-43 | §9.2 | How long a level can wait for an approach | forever / MaxAge | **`MaxAge` buckets** | consistent with §5 ageing |
| A-44 | §9.2 | `ReactionHit` unresolved within the window | 0 / drop | **0**, share reported | conservative for the hypothesis |
| A-45 | §9.2 | "monotone in WickStrength" | strict order / slope test | **positive decile slope with bootstrap CI excluding 0; Spearman reported** | strict order of 10 noisy means is unattainable |
| A-46 | §6.5 | How long to track MFE/MAE | until actual exit / virtual | **virtual until 1.5 SweepDepth adverse, 4 favourable, or 8× sweep-leg duration** | the grid needs paths beyond the actual exit |
| A-47 | §9.3 | Fold boundaries | volume-days / calendar | **calendar** (8 w / 2 w) | Spec §6.3 |
| A-48 | §9.3 | Score used during the grid | Stage A / Stage B per cell | **Stage A** in the grid; Stage B fitted at the plateau cell | keeps DoF at 6 and cost tractable |

## Appendix B — Open questions the data must answer (§12)

| # | Open question (§12) | Answered by (report section, table) | Verdict rule |
|---|---|---|---|
| 1 | Is `E[ReactionDisplacement]` for WickLevels significantly above random and placebo levels, and monotone in WickStrength? (If not, stop.) | Report §2: sets table, contrasts `(1)−(4)`, `(1)−(3)`, monotonicity line; `reaction.json.gate` | `gate.pass`; failure stops the pipeline (exit 3) |
| 2 | Does "fast" matter: WickLevels vs SlowExtremes? | Report §2: contrast `(1)−(2)` | CI excludes 0 ⇒ yes; else "only extremum matters" |
| 3 | Sign of `PriorTouches` | Report §8 `byPriorTouches`; Report §11 / `stageB.json` coefficient for feature 11 with per-fold sign | consistent sign across ≥ 75 % of folds |
| 4 | Is `HitRate(2,1)` above `BreakevenHitRate`, and is the optimal `(TargetMult, StopMult)` stable across folds? | Report §4 target tables; Report §5 `HitRateMinusBreakeven`; plateau per fold | pooled OOS `HitRate − BreakevenHitRate > 0` with CI; same plateau pair in ≥ 75 % of folds |
| 5 | Should the Target scale with SweepDepth or with VolUnit? | Report §4 VolUnit-scaled table vs SweepDepth table; `SweepDepth/VolUnit` conditional table | higher OOS expectancy at plateau, consistent across folds |
| 6 | RestEarly vs ArmOnApproach: does requiring a violent Reclaim pay for the lost trades? | Report §8 ArmMode variant rows; `byReturnSpeed`; `skippedSlowReclaim` | total OOS P&L (not per-trade expectancy) comparison |
| 7 | Does post-entry aggressor imbalance separate winners from losers? | Report §9 mechanism check | `diff` CI excludes 0 and sign = reclaim direction |
| 8 | Latency curve: where does the edge vanish? | Report §6 `latencyCurve` | first latency point with expectancy ≤ 0; the 50→150 ms sentence |
| 9 | Transfer across venues and symbols? | Report §5 per `(venue, symbol)` + cross-venue comparison table (Spec §6.5) | sign and plateau agreement across venues/symbols |

*End of specification.*