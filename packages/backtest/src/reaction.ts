import {
  assert, BUCKETS_PER_VOLUME_DAY, ceilTicksConservative, type Engine, type EngineObserver, floorTicksConservative, type Lots,
  type MergedEvent, type Ms, type RunConfig, type Side, type StoredPivot, type Ticks,
} from '@wsr/core';
import { BlockIndex, blockBootstrap, BlockSums, excludesZero, percentileCI } from './bootstrap.js';
import { KeyedHeap } from './heap.js';
import { olsSlope, spearman } from './numeric.js';
import { rngStream, type Xoshiro128ss } from './rng.js';

// ---------------------------------------------------------------- types (Spec §6.1.1, §6.1.5)

export type LevelSetId = 'wick' | 'slow' | 'placebo' | 'random';
export const LEVEL_SET_IDS: ReadonlyArray<LevelSetId> = ['wick', 'slow', 'placebo', 'random'];

export interface RefLevel {
  readonly setId: LevelSetId; readonly srcPivotId: number; readonly Side: Side; readonly price: Ticks;
  readonly VolUnit: Ticks; readonly availableAt: Ms; readonly availableVol: Lots;
  readonly WickStrength: number; readonly decile: number | -1; readonly shift: -2 | -1 | 0 | 1 | 2;
}

export type ApproachStatus = 'approached' | 'notApproached' | 'pending';   // pending = still waiting at the end of the data

// One level of any set and its §6.1.2 approach / §6.1.3 outcome.
export interface ReactionObservation {
  readonly level: RefLevel;
  readonly status: ApproachStatus;
  readonly approachT: Ms | -1;
  readonly approachVol: Lots | -1;
  readonly block: number | -1;              // volumeDay of the approach print (bootstrap block)
  readonly complete: boolean;               // the ReactionWindow elapsed before the data ended
  readonly ReactionDisplacement: number;    // NaN unless complete
  readonly ReactionHit: 0 | 1;
  readonly unresolved: boolean;             // neither ±1 VolUnit within the window (A-44)
  // When the observation's fate was known (Stage B causality, Spec §6.3, L10):
  // approached ⇒ the print ending the ReactionWindow (NaN if incomplete);
  // notApproached ⇒ the print on which the level became older than MaxAge;
  // pending ⇒ NaN. Not part of reaction.json.
  readonly decidedAt: Ms;
}

export interface ReactionConfig {
  readonly seed: number;
  readonly RetraceWindow: number;           // approach condition (a), buckets
  readonly MaxAge: number;                  // notApproached after MaxAge buckets (A-43)
  readonly ApproachTol?: number;            // VolUnits, default 0.2
  readonly ReactionWindow?: number;         // buckets, default 10
  // Spec §3.2.4: prints before spanStart (the warm-up span) only feed the
  // print history; pivots classified before it are in no set. Default: the
  // first observed print.
  readonly spanStart?: Ms;
}

export function reactionConfigFrom(cfg: RunConfig): ReactionConfig {
  return { seed: cfg.seed, RetraceWindow: cfg.RetraceWindow, MaxAge: cfg.MaxAge };
}

const PLACEBO_SHIFTS = [-2, -1, 1, 2] as const;
const FAR_MULT = 3;                         // "after the level has been ≥ 3 VolUnits away"
const HIT_MULT = 1;                         // ±1 VolUnit (§9.2)
const HISTORY_KEEP = 2;                     // keep 2 volume-days of prints (random draws reach back 1)

// ---------------------------------------------------------------- print history

// Prints covering ≥ one volume-day (random-level draws, Spec §6.1.1 set 4),
// addressed by absolute index; struct of typed arrays, compacted in place.
class PrintHistory {
  private offset = 0;                       // absolute index of array slot 0
  private start = 0;                        // first retained slot
  private len = 0;
  private tCol = new Float64Array(1024);
  private volCol = new Float64Array(1024);
  private pCol = new Int32Array(1024);
  private unitCol = new Float64Array(1024);
  private bvCol = new Float64Array(1024);
  private dayCol = new Int32Array(1024);

  get newest(): number { return this.offset + this.len - 1; }
  get oldest(): number { return this.offset + this.start; }

  push(t: Ms, Vol: Lots, p: Ticks, VolUnit_now: Ticks, BucketVolume: Lots, volumeDay: number): void {
    if (this.len === this.tCol.length) this.makeRoom();
    const i = this.len++;
    this.tCol[i] = t;
    this.volCol[i] = Vol;
    this.pCol[i] = p;
    this.unitCol[i] = VolUnit_now;
    this.bvCol[i] = BucketVolume;
    this.dayCol[i] = volumeDay;
  }

  private makeRoom(): void {
    if (this.start > 0) {
      for (const col of [this.tCol, this.volCol, this.pCol, this.unitCol, this.bvCol, this.dayCol]) col.copyWithin(0, this.start, this.len);
      this.offset += this.start;
      this.len -= this.start;
      this.start = 0;
    }
    if (this.len < this.tCol.length * 0.75) return;
    const grow = <A extends Float64Array | Int32Array>(a: A): A => {
      const next = new (a.constructor as new (n: number) => A)(a.length * 2);
      next.set(a);
      return next;
    };
    this.tCol = grow(this.tCol);
    this.volCol = grow(this.volCol);
    this.pCol = grow(this.pCol);
    this.unitCol = grow(this.unitCol);
    this.bvCol = grow(this.bvCol);
    this.dayCol = grow(this.dayCol);
  }

  // Drops prints with Vol < fromVol (never the newest).
  trim(fromVol: Lots): void {
    while (this.start < this.len - 1 && this.volCol[this.start]! < fromVol) this.start++;
  }

  // First retained absolute index with Vol ≥ v (the newest if none).
  indexAtVol(v: Lots): number {
    let lo = this.start;
    let hi = this.len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.volCol[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return this.offset + lo;
  }

  private slot(i: number): number {
    const j = i - this.offset;
    assert(j >= this.start && j < this.len, `PrintHistory: index ${i} not retained`);
    return j;
  }

  t(i: number): Ms { return this.tCol[this.slot(i)]!; }
  Vol(i: number): Lots { return this.volCol[this.slot(i)]!; }
  p(i: number): Ticks { return this.pCol[this.slot(i)]!; }
  VolUnit_now(i: number): Ticks { return this.unitCol[this.slot(i)]!; }
  BucketVolume(i: number): Lots { return this.bvCol[this.slot(i)]!; }
  volumeDay(i: number): number { return this.dayCol[this.slot(i)]!; }
}

// ---------------------------------------------------------------- observer

interface MutableObservation {
  level: RefLevel;
  status: ApproachStatus;
  approachT: Ms | -1;
  approachVol: Lots | -1;
  block: number | -1;
  complete: boolean;
  ReactionDisplacement: number;
  ReactionHit: 0 | 1;
  unresolved: boolean;
  decidedAt: Ms;
  expiredAt: Ms;                            // first print with Vol − availableVol > MaxAge·BucketVolume
}

type Phase = 'far' | 'band' | 'inBand' | 'done';

interface Tracked {
  readonly o: MutableObservation;
  readonly tol: Ticks;                      // ApproachTol·VolUnit in whole ticks (|p − ℓ| is an integer)
  readonly far: Ticks;                      // 3·VolUnit in whole ticks
  phase: Phase;
}

interface Outcome {
  readonly o: MutableObservation;
  readonly endVol: Lots;
  resolved: boolean;
}

// Spec §3.10 step 11 / §6.1: builds the four level sets from PivotStore rows
// as they are classified (set 1 from the store, never from LevelBook — L9),
// detects approach events (§6.1.2) and records outcomes (§6.1.3). Read-only
// on the engine. Approach detection is event-driven: a level waits in a heap
// keyed by the price that would change its phase, so dormant levels cost
// nothing per print.
export class ReactionObserver implements EngineObserver {
  private readonly ApproachTol: number;
  private readonly ReactionWindow: number;
  private readonly obs: MutableObservation[] = [];
  private readonly history = new PrintHistory();
  private historyIndex = -1;                // absolute index of the current print
  private nextRow = 0;
  private spanStartVol = NaN;
  private lastVol = NaN;
  private lastBucketVolume = NaN;
  // 'far' phase: pop when p ≥ ℓ + far (min-heap) or p ≤ ℓ − far (min-heap on −key).
  private readonly farUp = new KeyedHeap<Tracked>();
  private readonly farDown = new KeyedHeap<Tracked>();
  // 'band' phase: from above pop when p ≤ ℓ + tol (min-heap on −key); from below when p ≥ ℓ − tol.
  private readonly fromAbove = new KeyedHeap<Tracked>();
  private readonly fromBelow = new KeyedHeap<Tracked>();
  private inBand: Tracked[] = [];           // in the band, condition (a) not yet met
  private outcomes: Outcome[] = [];
  private randomClipped = 0;
  // Levels by availableVol, to stamp expiredAt (min-heap).
  private readonly expiry = new KeyedHeap<MutableObservation>();
  private firstSpanT: Ms = NaN;
  private preSpanPrints = 0;

  constructor(private readonly cfg: ReactionConfig) {
    this.ApproachTol = cfg.ApproachTol ?? 0.2;
    this.ReactionWindow = cfg.ReactionWindow ?? 10;
  }

  // firstSpanT: first observed print at/after spanStart (NaN if none);
  // preSpanPrints = 0 with a finite firstSpanT ⇒ warm-up ran into the span.
  get counters(): { readonly randomClipped: number; readonly firstSpanT: Ms; readonly preSpanPrints: number } {
    return { randomClipped: this.randomClipped, firstSpanT: this.firstSpanT, preSpanPrints: this.preSpanPrints };
  }

  onPrint(e: MergedEvent, engine: Engine): void {
    const f = engine.stats.frozen;
    const Vol = engine.builder.Vol;
    const BucketVolume = engine.builder.BucketVolume;
    this.lastVol = Vol;
    this.lastBucketVolume = BucketVolume;
    this.history.push(e.t, Vol, e.p, f.VolUnit_now, BucketVolume, f.volumeDay);
    this.historyIndex = this.history.newest;
    this.history.trim(Vol - HISTORY_KEEP * BUCKETS_PER_VOLUME_DAY * BucketVolume);
    const store = engine.store;
    if (e.t < (this.cfg.spanStart ?? -Infinity)) {
      this.nextRow = store.size;                                                // warm-up-span pivots: no set
      this.preSpanPrints++;
      return;
    }
    if (Number.isNaN(this.spanStartVol)) {
      this.spanStartVol = Vol;
      this.firstSpanT = e.t;
    }

    this.outcomes = this.outcomes.filter((oc) => !this.feed(oc, e.p, Vol, e.t));
    while (this.nextRow < store.size) this.register(store.at(this.nextRow++), f.VolUnit_now, e);
    this.scanInBand(e, Vol, BucketVolume, f.volumeDay);
    this.scanFar(e.p);
    this.scanBand(e, Vol, BucketVolume, f.volumeDay);
    // Same test as the MaxAge check of onBand / observations() (A-43).
    while (this.expiry.size > 0 && Vol - this.expiry.peekKey() > this.cfg.MaxAge * BucketVolume) {
      const o = this.expiry.pop()!;
      if (Number.isNaN(o.expiredAt)) o.expiredAt = e.t;
    }
  }

  // ------------------------------------------------ level sets (Spec §6.1.1)

  private register(row: StoredPivot, VolUnit_now: Ticks, e: MergedEvent): void {
    const piv = row.pivot;
    const base = {
      srcPivotId: piv.pivotId, Side: piv.side, availableAt: row.classifiedAt, availableVol: row.availableVol, decile: -1 as const,
    };
    // WickStrength = the Stage A score (Stage B is fitted per fold, build step 12).
    if (row.cls === 'WickLevel') {
      const VolUnit = row.VolUnit_created;
      this.add({ ...base, setId: 'wick', price: piv.price, VolUnit, WickStrength: row.WickStrength_0, shift: 0 });
      for (const shift of PLACEBO_SHIFTS) {
        this.add({ ...base, setId: 'placebo', price: piv.price + shift * VolUnit, VolUnit, WickStrength: row.WickStrength_0, shift });
      }
    } else if (row.cls === 'SlowExtreme') {
      // VolUnit_now at classifiedAt: the row is consumed on its classification print.
      assert(row.classifiedAt === e.t, `ReactionObserver: SlowExtreme ${piv.pivotId} consumed after its classification print`);
      this.add({ ...base, setId: 'slow', price: piv.price, VolUnit: VolUnit_now, WickStrength: row.WickStrength_0, shift: 0 });
    }
    // BurstPivot, Unresolved and Merged rows are in no set (A-17).
  }

  private add(level: RefLevel): void {
    const o: MutableObservation = {
      level, status: 'pending', approachT: -1, approachVol: -1, block: -1, complete: false, ReactionDisplacement: NaN,
      ReactionHit: 0, unresolved: false, decidedAt: NaN, expiredAt: NaN,
    };
    this.obs.push(o);
    this.expiry.push(level.availableVol, o);
    const tr: Tracked = {
      o, tol: floorTicksConservative(this.ApproachTol * level.VolUnit), far: ceilTicksConservative(FAR_MULT * level.VolUnit), phase: 'far',
    };
    this.farUp.push(level.price + tr.far, tr);
    this.farDown.push(-(level.price - tr.far), tr);
  }

  // ------------------------------------------------ approach events (Spec §6.1.2)

  // Condition (b): some print at/after availableAt ≥ 3 VolUnits from ℓ.
  private scanFar(p: Ticks): void {
    while (this.farUp.peekKey() <= p) this.toBand(this.farUp.pop()!, p);
    while (this.farDown.peekKey() <= -p) this.toBand(this.farDown.pop()!, p);
  }

  private toBand(tr: Tracked, p: Ticks): void {
    if (tr.phase !== 'far') return;                                             // the other heap's copy
    tr.phase = 'band';
    this.place(tr, p);
  }

  // Outside the band: wait for the price to come back within tol.
  private place(tr: Tracked, p: Ticks): void {
    const price = tr.o.level.price;
    tr.phase = 'band';
    if (p > price + tr.tol) this.fromAbove.push(-(price + tr.tol), tr);
    else this.fromBelow.push(price - tr.tol, tr);
  }

  private scanBand(e: MergedEvent, Vol: Lots, BucketVolume: Lots, volumeDay: number): void {
    while (this.fromAbove.peekKey() <= -e.p) this.onBand(this.fromAbove.pop()!, e, Vol, BucketVolume, volumeDay);
    while (this.fromBelow.peekKey() <= e.p) this.onBand(this.fromBelow.pop()!, e, Vol, BucketVolume, volumeDay);
  }

  private scanInBand(e: MergedEvent, Vol: Lots, BucketVolume: Lots, volumeDay: number): void {
    if (this.inBand.length === 0) return;
    const waiting = this.inBand;
    this.inBand = [];
    for (const tr of waiting) this.onBand(tr, e, Vol, BucketVolume, volumeDay);
  }

  private onBand(tr: Tracked, e: MergedEvent, Vol: Lots, BucketVolume: Lots, volumeDay: number): void {
    const level = tr.o.level;
    const sinceAvailable = Vol - level.availableVol;
    if (sinceAvailable > this.cfg.MaxAge * BucketVolume) {                                // A-43
      tr.phase = 'done';
      tr.o.status = 'notApproached';
      return;
    }
    if (Math.abs(e.p - level.price) > tr.tol) {                                // jumped over the band
      this.place(tr, e.p);
      return;
    }
    if (sinceAvailable < this.cfg.RetraceWindow * BucketVolume) {                         // (a) not yet
      tr.phase = 'inBand';
      this.inBand.push(tr);
      return;
    }
    tr.phase = 'done';
    this.approach(tr.o, e.t, Vol, BucketVolume, volumeDay);
    if (level.setId === 'wick') this.randomLevel(tr.o, e, Vol, BucketVolume);
  }

  private approach(o: MutableObservation, t: Ms, Vol: Lots, BucketVolume: Lots, volumeDay: number): Outcome {
    o.status = 'approached';
    o.approachT = t;
    o.approachVol = Vol;
    o.block = volumeDay;
    const oc: Outcome = { o, endVol: Vol + this.ReactionWindow * BucketVolume, resolved: false };
    this.outcomes.push(oc);
    return oc;
  }

  // Set (4), A-42: a uniformly drawn earlier print within one volume-day, same
  // signed distance, same Side; its approach event is t_r by construction.
  private randomLevel(src: MutableObservation, e: MergedEvent, Vol: Lots, BucketVolume: Lots): void {
    const h = this.history;
    const lvl = src.level;
    const u = rngStream(this.cfg.seed, 'randomLevels', lvl.srcPivotId).nextFloat();
    let targetVol = Vol - u * BUCKETS_PER_VOLUME_DAY * BucketVolume;
    const floor = Math.max(this.spanStartVol, h.Vol(h.oldest));
    if (targetVol < floor) {
      if (targetVol < h.Vol(h.oldest) && h.Vol(h.oldest) > this.spanStartVol) this.randomClipped++;
      targetVol = floor;
    }
    const r = h.indexAtVol(targetVol);
    assert(r <= this.historyIndex && h.t(r) <= e.t, `ReactionObserver: random level for pivot ${lvl.srcPivotId} drawn after its approach (L12)`);
    const Side = lvl.Side;
    const d = Side * (lvl.price - e.p);
    const level: RefLevel = {
      setId: 'random', srcPivotId: lvl.srcPivotId, Side, price: h.p(r) + Side * d, VolUnit: h.VolUnit_now(r),
      availableAt: h.t(r), availableVol: h.Vol(r), WickStrength: lvl.WickStrength, decile: -1, shift: 0,
    };
    const o: MutableObservation = {
      level, status: 'pending', approachT: -1, approachVol: -1, block: -1, complete: false, ReactionDisplacement: NaN,
      ReactionHit: 0, unresolved: false, decidedAt: NaN, expiredAt: NaN,
    };
    this.obs.push(o);
    const oc = this.approach(o, h.t(r), h.Vol(r), h.BucketVolume(r), h.volumeDay(r));
    for (let i = r + 1; i <= this.historyIndex; i++) {
      if (this.feed(oc, h.p(i), h.Vol(i), h.t(i))) {
        this.outcomes.splice(this.outcomes.indexOf(oc), 1);
        return;
      }
    }
  }

  // ------------------------------------------------ outcomes (Spec §6.1.3)

  // One print after the approach print; true once the window has elapsed.
  private feed(oc: Outcome, p: Ticks, Vol: Lots, t: Ms): boolean {
    const o = oc.o;
    const { Side, price, VolUnit } = o.level;
    if (!oc.resolved && Vol <= oc.endVol) {
      if (Side * (price - p) >= HIT_MULT * VolUnit) {
        oc.resolved = true;
        o.ReactionHit = 1;
      } else if (Side * (p - price) >= HIT_MULT * VolUnit) {
        oc.resolved = true;
      }
    }
    if (Vol < oc.endVol) return false;
    o.ReactionDisplacement = (Side * (price - p)) / VolUnit;                     // p_end: first print with Vol ≥ Vol_a + ReactionWindow·BucketVolume
    o.unresolved = !oc.resolved;
    o.complete = true;
    o.decidedAt = t;
    return true;
  }

  // ------------------------------------------------ results

  // Every level of the four sets in creation order, with set-(1) deciles of
  // WickStrength over the span. A level still waiting at the end is
  // `notApproached` once older than MaxAge, else `pending`.
  observations(): ReactionObservation[] {
    const wickScores = this.obs.filter((o) => o.level.setId === 'wick' && Number.isFinite(o.level.WickStrength))
      .map((o) => o.level.WickStrength).sort((a, b) => a - b);
    const decileOf = (x: number): number => {
      if (!Number.isFinite(x)) return -1;
      let lo = 0;
      let hi = wickScores.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (wickScores[mid]! < x) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(10, Math.floor((10 * lo) / wickScores.length) + 1);
    };
    return this.obs.map((o) => {
      let status = o.status;
      if (status === 'pending' && this.lastVol - o.level.availableVol > this.cfg.MaxAge * this.lastBucketVolume) status = 'notApproached';
      const level = o.level.setId === 'wick' ? { ...o.level, decile: decileOf(o.level.WickStrength) } : { ...o.level };
      const decidedAt = status === 'approached' ? o.decidedAt : status === 'notApproached' ? o.expiredAt : NaN;
      return {
        level, status, approachT: o.approachT, approachVol: o.approachVol, block: o.block, complete: o.complete,
        ReactionDisplacement: o.ReactionDisplacement, ReactionHit: o.ReactionHit, unresolved: o.unresolved, decidedAt,
      };
    });
  }
}

// ---------------------------------------------------------------- statistics (Spec §6.1.4, §6.1.6)

export interface SetStats {
  readonly n: number;                       // levels in the set
  readonly approached: number;
  readonly complete: number;                // approached with a full ReactionWindow (the sample)
  readonly unresolvedShare: number;
  readonly meanDisp: number;
  readonly ci95Disp: [number, number];
  readonly pHit: number;
  readonly ci95Hit: [number, number];
}

export interface ContrastStats {
  readonly diffDisp: number;
  readonly ci95: [number, number];
  readonly diffHit: number;
  readonly ci95Hit: [number, number];
  readonly significant: boolean;            // ci95 (ReactionDisplacement) excludes 0
}

export interface ReactionStats {
  readonly sets: Record<LevelSetId, SetStats>;
  readonly wickByDecile: ReadonlyArray<SetStats & { readonly decile: number }>;
  readonly contrasts: { readonly '1-4': ContrastStats; readonly '1-2': ContrastStats; readonly '1-3': ContrastStats };
  readonly monotone: { readonly slope: number; readonly ci95: [number, number]; readonly spearman: number; readonly pass: boolean };
  readonly gate: { readonly pass: boolean; readonly reasons: readonly string[] };
  readonly B: number;
  readonly blocks: number;
}

const DECILES = 10;
const ROWS = LEVEL_SET_IDS.length + DECILES;     // 4 sets, then wick deciles 1..10
const CH_N = 0;
const CH_DISP = 1;
const CH_HIT = 2;
const CONTRASTS = [['1-4', 'random'], ['1-2', 'slow'], ['1-3', 'placebo']] as const;

function decileSlope(means: ArrayLike<number>): number {
  const x: number[] = [];
  const y: number[] = [];
  for (let d = 0; d < DECILES; d++) {
    if (Number.isFinite(means[d]!)) {
      x.push(d + 1);
      y.push(means[d]!);
    }
  }
  return olsSlope(x, y);
}

// §6.1.4 statistics with a volume-day block bootstrap (B resamples, paired
// contrasts within each resample) and the §6.1.6 gate. `rng` is the
// bootstrap stream (e.g. rngStream(seed, 'bootstrap', foldId)).
export function reactionStats(
  observations: ReadonlyArray<ReactionObservation>, options: { readonly B?: number; readonly rng: Xoshiro128ss },
): ReactionStats {
  const B = options.B ?? 2000;
  const sample = observations.filter((o) => o.status === 'approached' && o.complete);
  const blocks = new BlockIndex(sample.map((o) => o.block));
  const sums = new BlockSums(ROWS, blocks.size, 3);
  for (const o of sample) {
    const b = blocks.of(o.block);
    const rows = [LEVEL_SET_IDS.indexOf(o.level.setId)];
    if (o.level.setId === 'wick' && o.level.decile > 0) rows.push(LEVEL_SET_IDS.length + o.level.decile - 1);
    for (const row of rows) {
      sums.add(row, b, CH_N, 1);
      sums.add(row, b, CH_DISP, o.ReactionDisplacement);
      sums.add(row, b, CH_HIT, o.ReactionHit);
    }
  }
  const dispOf = (row: number, c: ArrayLike<number> | null): number => sums.ratio(row, CH_DISP, CH_N, c);
  const hitOf = (row: number, c: ArrayLike<number> | null): number => sums.ratio(row, CH_HIT, CH_N, c);
  const decileMeans = (c: ArrayLike<number> | null): number[] =>
    Array.from({ length: DECILES }, (_, d) => dispOf(LEVEL_SET_IDS.length + d, c));
  // Per resample: disp and hit per row, contrast diffs, decile slope.
  const vector = (c: ArrayLike<number> | null): number[] => {
    const disp = Array.from({ length: ROWS }, (_, r) => dispOf(r, c));
    const hit = Array.from({ length: ROWS }, (_, r) => hitOf(r, c));
    const diffs = CONTRASTS.flatMap(([, other]) => {
      const j = LEVEL_SET_IDS.indexOf(other);
      return [disp[0]! - disp[j]!, hit[0]! - hit[j]!];
    });
    return [...disp, ...hit, ...diffs, decileSlope(disp.slice(LEVEL_SET_IDS.length))];
  };
  const point = vector(null);
  const boot = blocks.size === 0 ? [] : blockBootstrap(blocks.size, B, options.rng, vector);
  const ci = (j: number): [number, number] => (boot.length === 0 ? [NaN, NaN] : percentileCI(boot[j]!, 0.95));

  const statsFor = (row: number, members: ReadonlyArray<ReactionObservation>): SetStats => {
    const used = members.filter((o) => o.status === 'approached' && o.complete);
    return {
      n: members.length, approached: members.filter((o) => o.status === 'approached').length, complete: used.length,
      unresolvedShare: used.length === 0 ? NaN : used.filter((o) => o.unresolved).length / used.length,
      meanDisp: point[row]!, ci95Disp: ci(row), pHit: point[ROWS + row]!, ci95Hit: ci(ROWS + row),
    };
  };
  const sets = Object.fromEntries(LEVEL_SET_IDS.map((id, row) => [id, statsFor(row, observations.filter((o) => o.level.setId === id))])) as Record<LevelSetId, SetStats>;
  const wick = observations.filter((o) => o.level.setId === 'wick');
  const wickByDecile = Array.from({ length: DECILES }, (_, d) => ({
    decile: d + 1, ...statsFor(LEVEL_SET_IDS.length + d, wick.filter((o) => o.level.decile === d + 1)),
  }));
  const base = 2 * ROWS;
  const contrast = (k: number): ContrastStats => {
    const ci95 = ci(base + 2 * k);
    return { diffDisp: point[base + 2 * k]!, ci95, diffHit: point[base + 2 * k + 1]!, ci95Hit: ci(base + 2 * k + 1), significant: excludesZero(ci95) };
  };
  const contrasts = { '1-4': contrast(0), '1-2': contrast(1), '1-3': contrast(2) };
  const slopeJ = base + 2 * CONTRASTS.length;
  const means = decileMeans(null);
  const idx: number[] = [];
  const ys: number[] = [];
  means.forEach((m, d) => { if (Number.isFinite(m)) { idx.push(d + 1); ys.push(m); } });
  const slopeCi = ci(slopeJ);
  const monotone = { slope: point[slopeJ]!, ci95: slopeCi, spearman: spearman(idx, ys), pass: point[slopeJ]! > 0 && slopeCi[0] > 0 };

  const reasons: string[] = [];
  const c14 = contrasts['1-4'];
  if (!(c14.diffDisp > 0)) reasons.push('(1)−(4): E[ReactionDisplacement] of WickLevels not above random levels');
  if (!c14.significant) reasons.push('(1)−(4): 95 % block-bootstrap CI contains 0');
  if (!monotone.pass) reasons.push('ReactionDisplacement not monotone in WickStrength (decile slope ≤ 0 or CI contains 0)');
  return { sets, wickByDecile, contrasts, monotone, gate: { pass: reasons.length === 0, reasons }, B, blocks: blocks.size };
}
