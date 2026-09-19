import type { Buckets, Engine, EngineObserver, Lots, MergedEvent, Ms, Side, Ticks, Trade } from '@wsr/core';
import { KahanSum } from './numeric.js';

// Spec §6.2 target grid (§6.5); used when `search.targetGrid` is empty.
export const DEFAULT_TARGET_MULTS: ReadonlyArray<number> = [0.5, 1, 1.5, 2, 2.5, 3, 4];
export const DEFAULT_STOP_MULTS: ReadonlyArray<number> = [0.75, 1, 1.25, 1.5];
// Spec §6.2 VolUnit-scaled variant (§6.5): Target = WickLevel − TargetUnits·VolUnit_created.
export const DEFAULT_TARGET_UNITS: ReadonlyArray<number> = [0.5, 1, 1.5, 2, 3];

// Virtual tracking stops after 8 × the sweep-leg duration (A-46).
export const DEFAULT_MAX_SWEEP_LEGS = 8;

export type PathEnd = 'MAE' | 'MFE' | 'time' | 'open';

// One filled trade's excursion path, from the entry fill print onward (Spec §6.2):
// m = Side·(EntryFill − p)/SweepDepth, MFE = max m, MAE = −min m. First
// passages are the print ordinal since the fill print (0 = the fill print,
// −1 = not reached) and the volume-clock buckets since the fill (NaN).
// VolUnit-scaled first passages use m_u = Side·(EntryFill − p)/VolUnit_created;
// `firstBackToEntryAfter1Idx` is the first print with m ≤ 0 after m ≥ 1
// (the §6.5 two-stage exit's stop moved to EntryFill).
export interface TradePath {
  readonly tradeId: number;
  readonly levelId: number;
  readonly Side: Side;
  readonly EntryFill: Ticks;
  readonly SweepDepth: Ticks;
  readonly VolUnit_created: Ticks;          // NaN when the level is unknown
  readonly fillSeq: number;
  readonly fillVol: Lots;
  readonly sweepLegDurationBuckets: Buckets;
  readonly TargetMults: ReadonlyArray<number>;
  readonly StopMults: ReadonlyArray<number>;
  readonly TargetUnits: ReadonlyArray<number>;
  readonly trade: Readonly<Trade>;          // live record: exit, P&L and RoundTripCost_bps once closed
  MFE: number;
  MAE: number;
  MFE_units: number;                        // max m_u
  prints: number;
  readonly firstTIdx: Int32Array;           // per TargetMult
  readonly firstSIdx: Int32Array;           // per StopMult
  readonly firstTBuckets: Float64Array;
  readonly firstSBuckets: Float64Array;
  readonly firstTUIdx: Int32Array;          // per TargetUnits
  // Print time t of each first passage (NaN = not reached): censoring at a fold boundary (A-134).
  readonly firstTTime: Float64Array;
  readonly firstSTime: Float64Array;
  readonly firstTUTime: Float64Array;
  firstBackToEntryAfter1Idx: number;        // −1 = none
  end: PathEnd;
}

interface BufferedPrint { readonly t: Ms; readonly seq: number; readonly p: Ticks; readonly Vol: Lots; readonly BucketVolume: Lots }

// Spec §3.10 step 10: MFE/MAE for open and virtual trades. The entry fill
// resolves on a print after its window has elapsed, so prints since the
// oldest unfilled entry's trigger are buffered and replayed from `fillSeq`.
// Tracking ignores position occupancy and continues past the actual exit
// until MAE ≥ max StopMult ∨ (MFE ≥ max TargetMult ∧ m_u ≥ max TargetUnits)
// ∨ maxSweepLegs·sweepLegDurationBuckets (A-46: 8; the §11.3 driftless test
// passes ∞ so every path resolves, A-54). Without a finite VolUnit_created
// the TargetUnits condition is void.
export class MfeMaeTracker implements EngineObserver {
  readonly TargetMults: ReadonlyArray<number>;
  readonly StopMults: ReadonlyArray<number>;
  readonly TargetUnits: ReadonlyArray<number>;
  readonly maxSweepLegs: number;
  private readonly maxTarget: number;
  private readonly maxStop: number;
  private readonly maxUnits: number;
  private readonly done: TradePath[] = [];
  private readonly live: TradePath[] = [];
  private readonly unfilled: Readonly<Trade>[] = [];    // triggered, entry fill not resolved yet
  private buffer: BufferedPrint[] = [];
  private nextTrade = 0;

  constructor(grid: {
    readonly TargetMults?: ReadonlyArray<number>; readonly StopMults?: ReadonlyArray<number>; readonly maxSweepLegs?: number;
    readonly TargetUnits?: ReadonlyArray<number>;
  } = {}) {
    this.TargetMults = grid.TargetMults?.length ? [...grid.TargetMults] : DEFAULT_TARGET_MULTS;
    this.StopMults = grid.StopMults?.length ? [...grid.StopMults] : DEFAULT_STOP_MULTS;
    this.TargetUnits = grid.TargetUnits?.length ? [...grid.TargetUnits] : DEFAULT_TARGET_UNITS;
    this.maxUnits = Math.max(...this.TargetUnits);
    this.maxSweepLegs = grid.maxSweepLegs ?? DEFAULT_MAX_SWEEP_LEGS;
    if (!(this.maxSweepLegs > 0)) throw new Error(`MfeMaeTracker: maxSweepLegs ${this.maxSweepLegs} must be > 0`);
    this.maxTarget = Math.max(...this.TargetMults);
    this.maxStop = Math.max(...this.StopMults);
  }

  onPrint(e: MergedEvent, engine: Engine): void {
    const bp: BufferedPrint = { t: e.t, seq: e.seq, p: e.p, Vol: engine.builder.Vol, BucketVolume: engine.builder.BucketVolume };
    for (const path of this.live) this.step(path, bp);
    this.sync(engine, bp);
    for (let i = 0; i < this.live.length;) {
      if (this.live[i]!.end === 'open') i++;
      else this.done.push(...this.live.splice(i, 1));
    }
  }

  // Picks up new trades and entry fills (also after Engine.finish()). Prints
  // after the oldest unfilled trigger are buffered (the trigger print itself is
  // never a fill print, L6) so a path starts at its fill print.
  private sync(engine: Engine, bp: BufferedPrint | null): void {
    const trades = engine.exec?.trades() ?? [];
    while (this.nextTrade < trades.length) this.unfilled.push(trades[this.nextTrade++]!);
    if (this.unfilled.length === 0) {
      this.buffer = [];
      return;
    }
    const oldestTrigger = (): number => Math.min(...this.unfilled.map((tr) => tr.triggerSeq));
    if (bp !== null && bp.seq > oldestTrigger()) this.buffer.push(bp);
    for (let i = 0; i < this.unfilled.length;) {
      const tr = this.unfilled[i]!;
      if (tr.entry === null) { i++; continue; }
      this.unfilled.splice(i, 1);
      this.start(tr, engine);
    }
    if (this.unfilled.length === 0) this.buffer = [];
    else if (this.buffer.length > 0 && this.buffer[0]!.seq <= oldestTrigger()) {
      const from = oldestTrigger();
      this.buffer = this.buffer.filter((b) => b.seq > from);
    }
  }

  private start(tr: Readonly<Trade>, engine: Engine): void {
    const level = engine.book?.byId(tr.levelId);
    const nT = this.TargetMults.length;
    const nS = this.StopMults.length;
    const entry = tr.entry!;
    const replay = this.buffer.filter((b) => b.seq >= entry.fillSeq);
    if (replay.length > 0 && replay[0]!.seq !== entry.fillSeq) {
      throw new Error(`MfeMaeTracker: fill print ${entry.fillSeq} of trade ${tr.tradeId} not buffered`);
    }
    const path: TradePath = {
      tradeId: tr.tradeId, levelId: tr.levelId, Side: tr.Side, EntryFill: entry.FillPrice, SweepDepth: tr.SweepDepth,
      VolUnit_created: level?.VolUnit_created ?? NaN,
      fillSeq: entry.fillSeq, fillVol: replay[0]?.Vol ?? NaN, sweepLegDurationBuckets: level?.sweepLegDurationBuckets ?? NaN,
      TargetMults: this.TargetMults, StopMults: this.StopMults, TargetUnits: this.TargetUnits, trade: tr, MFE: -Infinity,
      MAE: -Infinity, MFE_units: -Infinity, prints: 0,
      firstTIdx: new Int32Array(nT).fill(-1), firstSIdx: new Int32Array(nS).fill(-1),
      firstTBuckets: new Float64Array(nT).fill(NaN), firstSBuckets: new Float64Array(nS).fill(NaN),
      firstTUIdx: new Int32Array(this.TargetUnits.length).fill(-1), firstTTime: new Float64Array(nT).fill(NaN),
      firstSTime: new Float64Array(nS).fill(NaN), firstTUTime: new Float64Array(this.TargetUnits.length).fill(NaN),
      firstBackToEntryAfter1Idx: -1, end: 'open',
    };
    for (const b of replay) if (path.end === 'open') this.step(path, b);
    if (path.end === 'open') this.live.push(path);
    else this.done.push(path);
  }

  private step(path: TradePath, b: BufferedPrint): void {
    if (path.end !== 'open') return;
    const idx = path.prints++;
    const buckets = idx === 0 ? 0 : (b.Vol - path.fillVol) / b.BucketVolume;
    const m = (path.Side * (path.EntryFill - b.p)) / path.SweepDepth;
    if (path.MFE >= 1 && m <= 0 && path.firstBackToEntryAfter1Idx < 0) path.firstBackToEntryAfter1Idx = idx;   // MFE of earlier prints
    if (m > path.MFE) path.MFE = m;
    if (-m > path.MAE) path.MAE = -m;
    path.TargetMults.forEach((x, j) => {
      if (path.firstTIdx[j]! < 0 && path.MFE >= x) { path.firstTIdx[j] = idx; path.firstTBuckets[j] = buckets; path.firstTTime[j] = b.t; }
    });
    path.StopMults.forEach((x, j) => {
      if (path.firstSIdx[j]! < 0 && path.MAE >= x) { path.firstSIdx[j] = idx; path.firstSBuckets[j] = buckets; path.firstSTime[j] = b.t; }
    });
    const unitsKnown = path.VolUnit_created > 0;
    if (unitsKnown) {
      const mu = (path.Side * (path.EntryFill - b.p)) / path.VolUnit_created;
      if (mu > path.MFE_units) path.MFE_units = mu;
      path.TargetUnits.forEach((x, j) => {
        if (path.firstTUIdx[j]! < 0 && path.MFE_units >= x) { path.firstTUIdx[j] = idx; path.firstTUTime[j] = b.t; }
      });
    }
    if (path.MAE >= this.maxStop) path.end = 'MAE';
    else if (path.MFE >= this.maxTarget && (!unitsKnown || path.MFE_units >= this.maxUnits)) path.end = 'MFE';
    else if (buckets >= this.maxSweepLegs * path.sweepLegDurationBuckets) path.end = 'time';
  }

  // Every tracked path (finished first, then still open), by tradeId. Call
  // after Engine.finish() to include entries resolved at the end of the stream.
  paths(engine?: Engine): TradePath[] {
    if (engine !== undefined) this.sync(engine, null);
    return [...this.done, ...this.live].sort((a, b) => a.tradeId - b.tradeId);
  }
}

// The path as known before `tEnd` (A-134): first passages at or after it are
// "not reached" (so the outcome is unresolved unless decided earlier); the
// two-stage back-to-entry index, which carries no time, is dropped.
export function censorPath(path: TradePath, tEnd: Ms): TradePath {
  const mask = (idx: Int32Array, time: Float64Array): Int32Array => idx.map((i, j) => (i >= 0 && time[j]! < tEnd ? i : -1));
  return {
    ...path, firstTIdx: mask(path.firstTIdx, path.firstTTime), firstSIdx: mask(path.firstSIdx, path.firstSTime),
    firstTUIdx: mask(path.firstTUIdx, path.firstTUTime), firstBackToEntryAfter1Idx: -1,
  };
}

export interface HitRateResult {
  readonly HitRate: number;                 // NaN without trades
  readonly n: number;
  readonly hits: number;
  readonly unresolved: number;
  readonly unresolvedShare: number;
}

function gridIndex(grid: ReadonlyArray<number>, x: number, name: string): number {
  const j = grid.indexOf(x);
  if (j < 0) throw new Error(`${name} ${x} is not on the tracked grid [${grid.join(', ')}]`);
  return j;
}

// Path outcome for (TargetMult, StopMult): MFE ≥ TargetMult strictly before MAE ≥ StopMult.
// A same-print tie is not a hit; neither reached is unresolved (not a hit, Spec §6.2).
export function pathOutcome(path: TradePath, TargetMult: number, StopMult: number): 'hit' | 'miss' | 'unresolved' {
  const it = path.firstTIdx[gridIndex(path.TargetMults, TargetMult, 'TargetMult')]!;
  const is = path.firstSIdx[gridIndex(path.StopMults, StopMult, 'StopMult')]!;
  if (it < 0 && is < 0) return 'unresolved';
  return it >= 0 && (is < 0 || it < is) ? 'hit' : 'miss';
}

// HitRate(T, S) = P(MFE ≥ T before MAE ≥ S) over `paths` (Spec §6.2).
export function hitRateOf(paths: ReadonlyArray<TradePath>, TargetMult: number, StopMult: number): HitRateResult {
  let hits = 0;
  let unresolved = 0;
  for (const path of paths) {
    const o = pathOutcome(path, TargetMult, StopMult);
    if (o === 'hit') hits++;
    else if (o === 'unresolved') unresolved++;
  }
  const n = paths.length;
  return { HitRate: n === 0 ? NaN : hits / n, n, hits, unresolved, unresolvedShare: n === 0 ? NaN : unresolved / n };
}

// HitRate_0(T, S) = S/(T + S): the driftless-walk baseline (§6.5).
export function hitRate0(TargetMult: number, StopMult: number): number {
  return StopMult / (TargetMult + StopMult);
}

// Expectancy(T, S) in bps of EntryFill, per trade
// hit·(T·SweepDepth − RoundTripCost) − (1 − hit)·(S·SweepDepth + RoundTripCost)
// with the trade's ex-post RoundTripCost, averaged over trades (Spec §6.2).
// Trades still open at the end (no realised cost) are left out.
export function expectancyOf(paths: ReadonlyArray<TradePath>, TargetMult: number, StopMult: number): { readonly Expectancy: number; readonly n: number } {
  const k = new KahanSum();
  let n = 0;
  for (const path of paths) {
    const costBps = path.trade.RoundTripCost_bps;
    if (!Number.isFinite(costBps)) continue;
    const toBps = 1e4 / path.EntryFill;
    const cost = costBps / toBps;                                   // ticks
    const x = pathOutcome(path, TargetMult, StopMult) === 'hit'
      ? TargetMult * path.SweepDepth - cost
      : -(StopMult * path.SweepDepth + cost);
    k.add(x * toBps);
    n++;
  }
  return { Expectancy: n === 0 ? NaN : k.value / n, n };
}

export interface TargetGridCell {
  readonly TargetMult: number;
  readonly StopMult: number;
  readonly HitRate: number;
  readonly HitRate_0: number;               // printed beside every HitRate (§6.5)
  readonly Expectancy: number;              // bps
  readonly n: number;
  readonly unresolvedShare: number;
}

// Spec §6.2 (TargetMult × StopMult) table.
export function targetGridTable(
  paths: ReadonlyArray<TradePath>, TargetMults: ReadonlyArray<number>, StopMults: ReadonlyArray<number>,
): TargetGridCell[] {
  const out: TargetGridCell[] = [];
  for (const TargetMult of TargetMults) {
    for (const StopMult of StopMults) {
      const h = hitRateOf(paths, TargetMult, StopMult);
      out.push({
        TargetMult, StopMult, HitRate: h.HitRate, HitRate_0: hitRate0(TargetMult, StopMult),
        Expectancy: expectancyOf(paths, TargetMult, StopMult).Expectancy, n: h.n, unresolvedShare: h.unresolvedShare,
      });
    }
  }
  return out;
}

// VolUnit-scaled outcome (§6.5): m_u ≥ TargetUnits strictly before MAE ≥ StopMult.
export function pathOutcomeUnits(path: TradePath, TargetUnits: number, StopMult: number): 'hit' | 'miss' | 'unresolved' {
  const it = path.firstTUIdx[gridIndex(path.TargetUnits, TargetUnits, 'TargetUnits')]!;
  const is = path.firstSIdx[gridIndex(path.StopMults, StopMult, 'StopMult')]!;
  if (it < 0 && is < 0) return 'unresolved';
  return it >= 0 && (is < 0 || it < is) ? 'hit' : 'miss';
}

export function hitRateUnits(paths: ReadonlyArray<TradePath>, TargetUnits: number, StopMult: number): HitRateResult {
  let hits = 0;
  let unresolved = 0;
  for (const path of paths) {
    const o = pathOutcomeUnits(path, TargetUnits, StopMult);
    if (o === 'hit') hits++;
    else if (o === 'unresolved') unresolved++;
  }
  const n = paths.length;
  return { HitRate: n === 0 ? NaN : hits / n, n, hits, unresolved, unresolvedShare: n === 0 ? NaN : unresolved / n };
}

// Expectancy with the target at TargetUnits·VolUnit_created (same cost convention as expectancyOf).
export function expectancyUnitsOf(paths: ReadonlyArray<TradePath>, TargetUnits: number, StopMult: number): { readonly Expectancy: number; readonly n: number } {
  const k = new KahanSum();
  let n = 0;
  for (const path of paths) {
    const costBps = path.trade.RoundTripCost_bps;
    if (!Number.isFinite(costBps) || !(path.VolUnit_created > 0)) continue;
    const toBps = 1e4 / path.EntryFill;
    const cost = costBps / toBps;
    const x = pathOutcomeUnits(path, TargetUnits, StopMult) === 'hit'
      ? TargetUnits * path.VolUnit_created - cost
      : -(StopMult * path.SweepDepth + cost);
    k.add(x * toBps);
    n++;
  }
  return { Expectancy: n === 0 ? NaN : k.value / n, n };
}

export interface TargetUnitsCell {
  readonly TargetUnits: number;
  readonly StopMult: number;
  readonly HitRate: number;
  // Driftless baseline in VolUnits (A-137): mean over trades of S_u/(TargetUnits + S_u), S_u = StopMult·SweepDepth/VolUnit_created.
  readonly HitRate_0: number;
  readonly Expectancy: number;              // bps
  readonly n: number;
  readonly unresolvedShare: number;
}

// Spec §6.2 VolUnit-scaled (TargetUnits × StopMult) table. The stop is in
// SweepDepth units, so HitRate_0 is per trade with the stop in VolUnits (A-137).
export function targetUnitsTable(
  paths: ReadonlyArray<TradePath>, TargetUnits: ReadonlyArray<number>, StopMults: ReadonlyArray<number>,
): TargetUnitsCell[] {
  const usable = paths.filter((x) => x.VolUnit_created > 0);
  const out: TargetUnitsCell[] = [];
  for (const u of TargetUnits) {
    for (const StopMult of StopMults) {
      const h = hitRateUnits(usable, u, StopMult);
      const h0 = new KahanSum();
      for (const x of usable) {
        const su = (StopMult * x.SweepDepth) / x.VolUnit_created;
        h0.add(su / (u + su));
      }
      out.push({
        TargetUnits: u, StopMult, HitRate: h.HitRate, HitRate_0: usable.length === 0 ? NaN : h0.value / usable.length,
        Expectancy: expectancyUnitsOf(usable, u, StopMult).Expectancy, n: h.n,
        unresolvedShare: h.unresolvedShare,
      });
    }
  }
  return out;
}
