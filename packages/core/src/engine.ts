import { createHash } from 'node:crypto';
import type { Blacklist } from './blacklist.js';
import { BucketBuilder } from './buckets.js';
import type { RunConfig, VenueId } from './config.js';
import {
  type ExecutionContext, executionConfigFrom, type ExecutionInstrument, ExecutionModel, type FundingSchedule,
} from './execution.js';
import type { FeatureContext } from './features.js';
import { assert, invariantFailed } from './invariant.js';
import { LevelBook, levelBookConfigFrom, type LevelContext } from './level-book.js';
import { type PipelineConfig, pipelineConfigFrom, PivotPipeline, type ScoredResolution } from './pivot-pipeline.js';
import { PivotStore } from './pivot-store.js';
import { TradeRing } from './ring.js';
import { SpreadEst } from './spread.js';
import { BucketStats, type FrozenStats } from './stats.js';
import type { MergedEvent, Ms } from './types.js';
import type { StageBModel } from './wickstrength.js';
import { Zigzag } from './zigzag.js';

const DEFAULT_RING_CAPACITY = 2 ** 21;      // Spec §3.1 floor
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

// Read-only hooks for Spec §3.10 steps 10–11 (MFE/MAE tracker, ReactionTest,
// build steps 10–11). Called after LevelBook on every post-warm-up print and
// after step 2l on every post-warm-up bucket close; they must not write engine state.
// `e` is valid during the call only (drivers reuse one event object, Spec §10): copy what is kept.
export interface EngineObserver {
  onPrint(e: MergedEvent, engine: Engine): void;
  onBucketClose?(k: number, engine: Engine): void;
}

// Low-level wiring; `Engine.fromConfig` builds one from a RunConfig. Tests use
// it directly to swap in a shorter warm-up, a recording port or a stub book.
export interface EngineSetup {
  readonly pipeline: PipelineConfig;
  readonly PivotMult: number;
  readonly RegimeWindow?: number;
  // minExtremePrintQtyPct variant (Spec §3.4): Zigzag gets frozen.eventSizeP10.
  readonly minExtremePrintQty?: boolean;
  // Fixed initial capacity (tests); default: 2^21, raised to TradeRing.capacityFor at the end of the first UTC day (Spec §3.1).
  readonly ringCapacity?: number;
  // Default: every Spec §3.2.4 condition (BucketStats.warmupConditionsMet).
  readonly warmupDone?: (engine: Engine) => boolean;
  readonly blacklist?: Blacklist | null;
  // Spec §3.10 steps 2l, 7, 8 (→ onPendingResolved), 9.
  readonly book?: (store: PivotStore, ctx: LevelContext) => LevelBook;
  // Spec §3.10 step 5; LevelContext.killSwitchActive then reads its kill switch.
  readonly exec?: (ctx: ExecutionContext) => ExecutionModel;
  readonly observers?: ReadonlyArray<EngineObserver>;
  readonly foldSchedule?: FoldSchedule;
}

// Spec §6.3: fold-fitted quantities, applied from the first print with
// t ≥ at (entry k: at = testStart_k; entry 0: at = −∞). Sorted by `at`.
export interface FoldScheduleEntry {
  readonly at: Ms;
  readonly MinStrength: number;
  readonly stageB: StageBModel | null;
}
export type FoldSchedule = ReadonlyArray<FoldScheduleEntry>;

// Spec §11.3 synthetic-path switches: tests / `--synthetic` only; never set
// from a RunConfig (the schema has no such keys). Default off.
export interface EngineTestOptions {
  // Target exits on touch (`test.targetOnTouch`), still a maker limit fill at Target.
  readonly targetOnTouch?: boolean;
  // Fees, half-spread, Slippage and funding = 0; the cost floor never binds.
  readonly zeroCosts?: boolean;
}

export interface EngineOptions {
  readonly funding?: FundingSchedule | null;
  readonly blacklist?: Blacklist | null;
  readonly MinStrength?: number;
  readonly ringCapacity?: number;
  readonly observers?: ReadonlyArray<EngineObserver>;
  readonly warmupDone?: (engine: Engine) => boolean;
  readonly test?: EngineTestOptions;
  readonly foldSchedule?: FoldSchedule;
}

// LevelContext as the engine writes it: t / seq / inBlacklist per print; the
// kill switch reads the ExecutionModel when attached, else a manual flag.
export type EngineContext = LevelContext & { t: Ms; seq: number; inBlacklist: boolean; killSwitchActive: boolean };

export interface EngineSnapshot {
  readonly events: number;
  readonly warmup: boolean;
  readonly foldIndex?: number;
  readonly counters: Record<EngineCounter, number>;
  readonly builder: ReturnType<BucketBuilder['snapshot']>;
  readonly spread: ReturnType<SpreadEst['snapshot']>;
  readonly ring: ReturnType<TradeRing['snapshot']>;
  readonly stats: ReturnType<BucketStats['snapshot']>;
  readonly zigzagDetector: ReturnType<Zigzag['snapshot']>;
  readonly pipeline: ReturnType<PivotPipeline['snapshot']>;
  readonly book?: ReturnType<LevelBook['snapshot']>;
  readonly exec?: ReturnType<ExecutionModel['snapshot']>;
}

// Post-warm-up engine counters (Spec §5: burstPivots, liquidityGuardBuckets).
export type EngineCounter = 'blacklistedBuckets' | 'burstPivots' | 'liquidityGuardBuckets' | 'ringUnderflow' | 'tickChanges' | 'totalBuckets';

// Spec §3.10: the per-print loop. One `onPrint` per merged event in (t, seq)
// order drives every module in the fixed order below; bucket statistics are
// written only in step 2 (L5). Runtime invariants abort with InvariantViolation
// (CLI exit code 5, Spec §2.7.2).
export class Engine {
  readonly builder = new BucketBuilder();
  readonly spread = new SpreadEst();
  readonly ring: TradeRing;
  readonly stats: BucketStats;
  readonly zigzagDetector = new Zigzag();
  readonly store = new PivotStore();
  readonly pipeline: PivotPipeline;
  readonly book: LevelBook | null;
  readonly exec: ExecutionModel | null;
  readonly cfg: PipelineConfig;
  readonly blacklist: Blacklist | null;
  protected readonly ctx: EngineContext;
  warmup = true;
  events = 0;                               // prints consumed since construction
  warmupEvents = 0;                         // prints consumed since the last (re)start of warm-up
  lastT: Ms = -Infinity;
  lastSeq = -Infinity;
  private lastEvent: MergedEvent | null = null;
  private frozenRef: FrozenStats;
  private readonly warmupDone: (engine: Engine) => boolean;
  private readonly minExtremePrintQty: boolean;
  private readonly observers: ReadonlyArray<EngineObserver>;
  private readonly foldSchedule: FoldSchedule | null;
  private nextFold = 0;                     // next foldSchedule entry to apply
  private ringSized: boolean;               // Spec §3.1 capacity from the warm-up day applied (or fixed by setup)
  private readonly counterValues: Record<EngineCounter, number> = {
    blacklistedBuckets: 0, burstPivots: 0, liquidityGuardBuckets: 0, ringUnderflow: 0, tickChanges: 0, totalBuckets: 0,
  };

  constructor(setup: EngineSetup) {
    this.cfg = setup.pipeline;
    this.blacklist = setup.blacklist ?? null;
    this.observers = setup.observers ?? [];
    this.foldSchedule = setup.foldSchedule ?? null;
    for (let i = 1; i < (this.foldSchedule?.length ?? 0); i++) {
      assert(this.foldSchedule![i]!.at >= this.foldSchedule![i - 1]!.at, 'Engine: foldSchedule not sorted by `at`');
    }
    this.minExtremePrintQty = setup.minExtremePrintQty ?? false;
    this.warmupDone = setup.warmupDone ?? ((engine) => engine.stats.warmupConditionsMet(engine.warmupEvents));
    this.ring = new TradeRing(setup.ringCapacity ?? DEFAULT_RING_CAPACITY);
    this.ringSized = setup.ringCapacity !== undefined;
    // Tick = 1: the engine works in integer ticks; the real tick size only
    // reaches ExecutionModel (prices → quote currency).
    this.stats = new BucketStats(
      { Tick: 1, PivotMult: setup.PivotMult, UnitWindow: this.cfg.UnitWindow, RegimeWindow: setup.RegimeWindow },
      this.builder, this.spread,
    );
    this.frozenRef = this.stats.frozen;
    const builder = this.builder;
    const stats = this.stats;
    const featureCtx: FeatureContext = {
      get Vol() { return builder.Vol; },
      get BucketVolume() { return builder.BucketVolume; },
      ExpectedVolPerMs: builder.ExpectedVolPerMs,
      get frozen() { return stats.frozen; },
      get lastVwap() { return stats.frozen.k >= 0 ? builder.history.Vwap_k(stats.frozen.k) : NaN; },
    };
    let killSwitchManual = false;
    let exec: ExecutionModel | null = null;
    const ctx: EngineContext = {
      t: 0, seq: 0, inBlacklist: false,
      get Vol() { return builder.Vol; },
      get BucketVolume() { return builder.BucketVolume; },
      get frozen() { return stats.frozen; },
      get killSwitchActive() { return exec ? exec.killSwitch.active : killSwitchManual; },
      set killSwitchActive(v: boolean) { killSwitchManual = v; },
      rejectSpeedOf: (pivotId) => this.pipeline.rejectSpeedOf(pivotId),
    };
    this.ctx = ctx;
    exec = setup.exec?.({
      get t() { return ctx.t; },
      get frozen() { return stats.frozen; },
      Vol100ms: builder.Vol100ms,
    }) ?? null;
    this.exec = exec;
    this.book = setup.book?.(this.store, ctx) ?? null;
    this.pipeline = new PivotPipeline(this.cfg, this.ring, featureCtx, this.store, (r) => this.onResolved(r), this.blacklist);
  }

  // Production wiring from a validated RunConfig: ExecutionModel is the
  // LevelBook's ExecutionPort; `instrument.Tick` / `LotSize` convert ticks and
  // lots to quote currency inside ExecutionModel only.
  static fromConfig(cfg: RunConfig, venue: VenueId, instrument: ExecutionInstrument, opts: EngineOptions = {}): Engine {
    let execModel: ExecutionModel | null = null;
    const test = opts.test ?? {};
    const execCfg = { ...executionConfigFrom(cfg, venue), zeroCosts: test.zeroCosts ?? false };
    const levelCfg = { ...levelBookConfigFrom(cfg), targetOnTouch: test.targetOnTouch ?? false };
    return new Engine({
      pipeline: pipelineConfigFrom(cfg),
      PivotMult: cfg.PivotMult,
      minExtremePrintQty: cfg.minExtremePrintQtyPct === 0.1,                     // the schema admits only off or P10 (§3.1)
      ringCapacity: opts.ringCapacity,
      warmupDone: opts.warmupDone,
      blacklist: opts.blacklist,
      observers: opts.observers,
      foldSchedule: opts.foldSchedule,
      exec: (ctx) => (execModel = new ExecutionModel(execCfg, instrument, opts.funding ?? null, ctx)),
      book: (store, ctx) => new LevelBook(levelCfg, store, execModel!, ctx, { MinStrength: opts.MinStrength }),
    });
  }

  // Scored resolution → LevelBook (Spec §3.10 step 8). L3: a WickLevel is
  // classified only once RetraceFraction is final.
  protected onResolved(r: ScoredResolution): void {
    if (r.gate.cls === 'BurstPivot') this.counterValues.burstPivots++;
    if (r.gate.cls === 'WickLevel') {
      assert(
        r.features !== null && r.gate.classifiedAt >= r.features.retraceAvailableAt,
        `Engine: WickLevel pivot ${r.pivot.pivotId} classified before retraceAvailableAt (L3)`,
      );
    }
    this.book?.onPendingResolved(r);
  }

  // Spec §3.10 steps 1–11. The engine copies what it keeps of `e`, except
  // `lastEvent` (the last print, for resetOnTickChange): callers may reuse one
  // event object as long as a tick-size reset comes before it is overwritten.
  onPrint(e: MergedEvent): void {
    this.checkInput(e);
    if (this.stats.frozen !== this.frozenRef) invariantFailed(`Engine: bucket statistics replaced between closes at t=${e.t} (L5)`);
    if (this.foldSchedule !== null) this.applyFolds(e.t);
    const ctx = this.ctx;
    ctx.t = e.t;
    ctx.seq = e.seq;
    ctx.inBlacklist = this.blacklist !== null && this.blacklist.contains(e.t);        // 1
    const closedK = this.builder.onPrint(e);                                          // 2
    if (!this.ringSized && this.builder.daysConsumed >= 1) this.sizeRing();
    if (closedK >= 0) this.onBucketClose(closedK, e);
    this.ring.push(e, this.builder.Vol, this.builder.lastEventBucketK);               // 3
    this.spread.onPrint(e.p, e.s);                                                    // 4: candidate only
    this.events++;
    this.warmupEvents++;
    this.lastT = e.t;
    this.lastSeq = e.seq;
    this.lastEvent = e;
    if (this.warmup) return;
    this.exec?.onPrint(e);                                                            // 5: fills before triggers
    const f = this.stats.frozen;
    const piv = this.zigzagDetector.update(
      e.t, e.seq, e.p, e.q, this.builder.Vol, f.PivotReversal, this.minExtremePrintQty ? f.eventSizeP10 : 0,
    );                                                                                // 6
    if (piv && !this.book?.onPivot(piv)) this.pipeline.open(piv);                     // 7: merged pivots are not opened
    this.pipeline.onPrint(e);                                                         // 8
    if (this.book) {
      this.book.onPrint(e);                                                           // 9
      if (this.exec) {
        assert(this.book.openTrade() === null || !this.exec.flat(), 'Engine: LevelBook holds a trade the ExecutionModel does not (#openTrades ≤ 1)');
      }
    }
    for (const o of this.observers) o.onPrint(e, this);                               // 10–11
  }

  // Spec §6.3: the fold values in force from the first print with t ≥ at,
  // before any step of this print can score a pivot or arm a level.
  private applyFolds(t: Ms): void {
    const schedule = this.foldSchedule!;
    let entry: FoldScheduleEntry | null = null;
    while (this.nextFold < schedule.length && t >= schedule[this.nextFold]!.at) entry = schedule[this.nextFold++]!;
    if (entry === null) return;
    this.setMinStrength(entry.MinStrength);
    this.pipeline.setStageBModel(entry.stageB);
  }

  // Index of the foldSchedule entry in force (−1 before the first print / without a schedule).
  get foldIndex(): number { return this.nextFold - 1; }

  // Spec §3.10 steps 2a–2l for bucket k, closed by print e. The bucket whose
  // close ends warm-up is the last warm-up bucket (volume-day 0 starts at k+1).
  private onBucketClose(k: number, e: MergedEvent): void {
    const postWarmup = !this.warmup;
    if (postWarmup) {
      this.checkRing(k);
      this.counterValues.totalBuckets++;
      const h = this.builder.history;
      if (this.blacklist?.overlaps(h.tOpen(k), h.tClose(k))) this.counterValues.blacklistedBuckets++;   // Spec §2.6.3 rule 5
    }
    this.stats.onBucketClose(k, this.ring);                                           // 2a–2i
    this.frozenRef = this.stats.frozen;
    if (postWarmup && this.stats.frozen.LiquidityGuard) this.counterValues.liquidityGuardBuckets++;   // §8.8
    if (this.warmup && this.warmupDone(this)) {                                       // 2j
      this.warmup = false;
      this.stats.markWarmupEnd(k);
      this.zigzagDetector.init(e.t, e.seq, e.p, this.builder.Vol);
    }
    this.pipeline.onBucketClose(k);                                                   // 2k
    this.book?.onBucketClose(k);                                                      // 2l
    if (postWarmup) for (const o of this.observers) o.onBucketClose?.(k, this);
  }

  // Spec §3.1 capacity = max(2^21, 2·ceil(2·UnitWindow·BucketVolume_0 / medianEventSize_0)),
  // power of two, from the warm-up day: on the first print of the second UTC
  // day, BucketVolume_0 = the day's median 60-s volume (BucketVolume_next) and
  // medianEventSize_0 = median q of the day's events still held (A-49 median).
  private sizeRing(): void {
    this.ringSized = true;
    const ring = this.ring;
    if (ring.size === 0) return;
    const q = Float64Array.from(ring.window(ring.oldestIndex, ring.newestIndex + 1).q).sort();
    const n = q.length;
    const median = n % 2 === 1 ? q[(n - 1) / 2]! : (q[n / 2 - 1]! + q[n / 2]!) / 2;
    const wanted = TradeRing.capacityFor(this.cfg.UnitWindow, this.builder.BucketVolume_next, median);
    while (ring.capacity < wanted) ring.grow();
  }

  // Spec §3.1: once the ring has evicted, it must still hold 2·UnitWindow
  // completed buckets; otherwise double the capacity and count the underflow.
  private checkRing(k: number): void {
    const ring = this.ring;
    if (ring.size === ring.capacity && ring.completedBucketsHeld(k) < 2 * this.cfg.UnitWindow) {
      ring.grow();
      this.counterValues.ringUnderflow++;
    }
  }

  private checkInput(e: MergedEvent): void {
    if (!(e.t > this.lastT || (e.t === this.lastT && e.seq > this.lastSeq))) invariantFailed(`Engine: event (t=${e.t}, seq=${e.seq}) not after (t=${this.lastT}, seq=${this.lastSeq})`);
    if (!(Number.isInteger(e.p) && e.p >= INT32_MIN && e.p <= INT32_MAX)) invariantFailed(`Engine: price ${e.p} at seq ${e.seq} is not an int32 tick count (Spec §3.11)`);
    if (!(e.q > 0 && Number.isFinite(e.q))) invariantFailed(`Engine: size ${e.q} at seq ${e.seq} is not positive`);
    if (!(e.s === 1 || e.s === -1)) invariantFailed(`Engine: aggressor side ${e.s} at seq ${e.seq} is not ±1`);
  }

  run(events: ReadonlyArray<MergedEvent>, upto = events.length): this {
    for (let i = this.events; i < upto; i++) this.onPrint(events[i]!);
    return this;
  }

  // End of stream: resolves fills still waiting for their window.
  finish(): this {
    this.exec?.finish();
    return this;
  }

  // Fold switch at testStart (Spec §3.7.5).
  setMinStrength(x: number): void {
    this.book?.setMinStrength(x);
  }

  // Spec §3.11 tick-size change, between the last old-unit print and the
  // first new-unit one: live levels → INVALIDATED(tickChange) (an open trade
  // exits at the last print), fills in flight resolve, every rolling state is
  // cleared and warm-up restarts. PivotStore, transitions, trades and
  // counters are kept.
  resetOnTickChange(instrument: ExecutionInstrument): void {
    if (this.lastEvent !== null) this.book?.invalidateAll(this.lastEvent);
    this.exec?.finish();
    this.exec?.reset(instrument);
    this.book?.reset();
    this.pipeline.reset();
    this.builder.reset();
    this.stats.reset();
    this.spread.reset();
    this.ring.reset();
    this.zigzagDetector.reset();
    this.frozenRef = this.stats.frozen;
    this.warmup = true;
    this.warmupEvents = 0;
    this.counterValues.tickChanges++;
  }

  // Engine-level counters (the book and the execution model keep their own).
  get counters(): Record<EngineCounter, number> {
    return { ...this.counterValues };
  }

  snapshot(): EngineSnapshot {
    return {
      events: this.events, warmup: this.warmup, ...(this.foldSchedule !== null ? { foldIndex: this.foldIndex } : {}), counters: this.counters, builder: this.builder.snapshot(),
      spread: this.spread.snapshot(), ring: this.ring.snapshot(), stats: this.stats.snapshot(), zigzagDetector: this.zigzagDetector.snapshot(),
      pipeline: this.pipeline.snapshot(),
      ...(this.book ? { book: this.book.snapshot() } : {}), ...(this.exec ? { exec: this.exec.snapshot() } : {}),
    };
  }

  // sha256 of the canonical serialisation of `snapshot()` (Spec §9.1 truncation property, §9.2).
  snapshotHash(): string {
    return createHash('sha256').update(canonicalJson(this.snapshot())).digest('hex');
  }
}

// Deterministic JSON: sorted keys, typed arrays as arrays, NaN / ±Infinity as
// strings, −0 as 0, undefined members dropped.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return value + 0;
  }
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, canonical);
  if (Array.isArray(value)) return value.map(canonical);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) out[key] = canonical(obj[key]);
  }
  return out;
}
