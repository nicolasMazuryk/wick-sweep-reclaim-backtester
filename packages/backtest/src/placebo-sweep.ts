import {
  type Engine, type EngineObserver, levelGeometry, type Lots, type MergedEvent, type Ms, type RunConfig, type Side, type Ticks,
} from '@wsr/core';
import { BlockIndex, blockBootstrap, BlockSums, excludesZero, percentileCI } from './bootstrap.js';
import { KeyedHeap } from './heap.js';
import { DEFAULT_MAX_SWEEP_LEGS } from './mfe-mae.js';
import type { Xoshiro128ss } from './rng.js';

// Spec §6.1.4 second, trade-specific test (strategy §9.2 last ¶): HitRate(2,1)
// of the actual setups vs 1/3 vs placebo levels "swept by construction" —
// every set-(3) level (each WickLevel shifted ±1, ±2 VolUnit_created, same
// Side and availableAt) put through the LevelBook sweep geometry: crossed by an
// excursion of depth in [MinSweepDepth, BreakoutDepth] whose extreme is
// confirmed (PivotReversal retreat) and re-crossed at −TriggerOffset (A-131).

export const PLACEBO_SHIFTS = [-2, -1, 1, 2] as const;
export const PLACEBO_TARGET_MULT = 2;
export const PLACEBO_STOP_MULT = 1;

export type PlaceboOutcome = 'hit' | 'miss' | 'unresolved';

// One reclaimed placebo level: the hypothetical entry is the reclaim print's price.
export interface PlaceboSetup {
  readonly srcPivotId: number;
  readonly shift: (typeof PLACEBO_SHIFTS)[number];
  readonly Side: Side;
  readonly price: Ticks;
  readonly SweepDepth: Ticks;
  readonly reclaimT: Ms;
  readonly volumeDay: number;               // at the reclaim print (bootstrap block)
  readonly outcome: PlaceboOutcome;         // (2, 1) first passage; unresolved ⇒ not a hit
}

export interface PlaceboSweepConfig {
  readonly MinSweepMult: number;
  readonly BreakoutMult: number;
  readonly TriggerOffset: Ticks;
  readonly MaxSweeps: number;
  readonly MaxAge: number;                  // buckets after availableVol (volume clock, as A-43)
  readonly spanStart: Ms;                   // rows classified before it (warm-up) are in no set
  readonly maxSweepLegs?: number;           // path horizon, × sweep-leg duration (A-46: 8)
}

export function placeboSweepConfigFrom(cfg: RunConfig, spanStart: Ms): PlaceboSweepConfig {
  return {
    MinSweepMult: cfg.MinSweepMult, BreakoutMult: cfg.BreakoutMult, TriggerOffset: cfg.TriggerOffset, MaxSweeps: cfg.MaxSweeps,
    MaxAge: cfg.MaxAge, spanStart,
  };
}

type Phase = 'near' | 'wick' | 'sweeping' | 'confirmed' | 'path' | 'done';

interface Placebo {
  readonly srcPivotId: number;
  readonly shift: (typeof PLACEBO_SHIFTS)[number];
  readonly Side: Side;
  readonly price: Ticks;
  readonly availableVol: Lots;
  readonly MinSweepDepth: Ticks;
  readonly BreakoutDepth: Ticks;
  phase: Phase;
  R: Ticks;                                 // SweepRunningMax
  sweepStartVol: Lots;
  sweeps: number;
  SweepExtreme: Ticks;
  SweepDepth: Ticks;
  entry: Ticks;
  horizonBuckets: number;
  horizonVol: Lots;
  reclaimT: Ms;
  volumeDay: number;
}

// Read-only engine observer (Spec §3.10 step 11), one per trading replay.
// Dormant placebo levels wait in price-keyed heaps (per side, side-normalised
// keys): 'near' until price is at or behind the level (a crossing needs a
// start on the near side), then 'wick' until Side·p ≥ Side·ℓ + MinSweepDepth.
export class PlaceboSweepObserver implements EngineObserver {
  private readonly maxSweepLegs: number;
  private nextRow = 0;
  private tickChanges = -1;
  private levels = 0;
  private readonly near = [new KeyedHeap<Placebo>(), new KeyedHeap<Placebo>()];     // key −Side·ℓ, pop when ≤ −Side·p
  private readonly wick = [new KeyedHeap<Placebo>(), new KeyedHeap<Placebo>()];     // key Side·ℓ + MinSweepDepth, pop when ≤ Side·p
  private active: Placebo[] = [];
  private readonly setups: PlaceboSetup[] = [];

  constructor(private readonly cfg: PlaceboSweepConfig) {
    this.maxSweepLegs = cfg.maxSweepLegs ?? DEFAULT_MAX_SWEEP_LEGS;
  }

  onPrint(e: MergedEvent, engine: Engine): void {
    const store = engine.store;
    if (this.tickChanges < 0) this.tickChanges = engine.counters.tickChanges;
    if (e.t < this.cfg.spanStart) {
      this.nextRow = store.size;                                                // warm-up-span pivots: no set
      return;
    }
    const Vol = engine.builder.Vol;
    const BucketVolume = engine.builder.BucketVolume;
    const f = engine.stats.frozen;
    if (engine.counters.tickChanges !== this.tickChanges) {                     // Spec §3.11: every live level is invalidated
      this.tickChanges = engine.counters.tickChanges;
      for (const h of [...this.near, ...this.wick]) while (h.size > 0) h.pop()!.phase = 'done';
      for (const pl of this.active) if (pl.phase === 'path') this.finish(pl, 'unresolved');
      this.active = [];
    }
    // Existing setups first: a level entering 'sweeping' on this print is not stepped on it (as LevelBook).
    const aged = (pl: Placebo): boolean => Vol - pl.availableVol > this.cfg.MaxAge * BucketVolume;
    const still: Placebo[] = [];
    for (const pl of this.active) {
      this.step(pl, e, Vol, BucketVolume, f.PivotReversal, f.volumeDay, aged(pl));
      if (pl.phase !== 'done') still.push(pl);
    }
    this.active = still;
    while (this.nextRow < store.size) {
      const row = store.at(this.nextRow++);
      if (row.cls !== 'WickLevel') continue;
      for (const shift of PLACEBO_SHIFTS) {
        const price = row.pivot.price + shift * row.VolUnit_created;
        const g = levelGeometry(this.cfg, row.VolUnit_created, f.SpreadEst_t, engine.exec?.roundTripCostTicks(price) ?? 0);
        const pl: Placebo = {
          srcPivotId: row.pivot.pivotId, shift, Side: row.pivot.side, price, availableVol: row.availableVol,
          MinSweepDepth: g.MinSweepDepth, BreakoutDepth: g.BreakoutDepth, phase: 'near', R: NaN, sweepStartVol: NaN, sweeps: 0,
          SweepExtreme: NaN, SweepDepth: NaN, entry: NaN, horizonBuckets: NaN, horizonVol: NaN, reclaimT: NaN, volumeDay: -1,
        };
        this.levels++;
        this.near[sideIndex(pl.Side)]!.push(-pl.Side * price, pl);
      }
    }
    for (const side of [1, -1] as const) {
      const near = this.near[sideIndex(side)]!;
      const wick = this.wick[sideIndex(side)]!;
      while (near.peekKey() <= -side * e.p) {
        const pl = near.pop()!;
        if (aged(pl)) pl.phase = 'done';
        else {
          pl.phase = 'wick';
          wick.push(side * pl.price + pl.MinSweepDepth, pl);
        }
      }
      while (wick.peekKey() <= side * e.p) {
        const pl = wick.pop()!;
        if (aged(pl) || side * e.p >= side * pl.price + pl.BreakoutDepth) pl.phase = 'done';     // expired / breakout
        else {
          this.startSweep(pl, e.p, Vol);
          this.active.push(pl);
        }
      }
    }
  }

  private startSweep(pl: Placebo, p: Ticks, Vol: Lots): void {
    pl.phase = 'sweeping';
    pl.R = p;
    pl.sweepStartVol = Vol;
  }

  private step(pl: Placebo, e: MergedEvent, Vol: Lots, BucketVolume: Lots, PivotReversal: Ticks, volumeDay: number, aged: boolean): void {
    const s = pl.Side;
    const pN = s * e.p;
    const wN = s * pl.price;
    if (pl.phase !== 'path' && aged) {
      pl.phase = 'done';
      return;
    }
    switch (pl.phase) {
      case 'sweeping': {
        if (pN > s * pl.R) pl.R = e.p;
        const rN = s * pl.R;
        if (rN > wN + pl.BreakoutDepth) pl.phase = 'done';
        else if (pN <= rN - PivotReversal) {
          pl.phase = 'confirmed';
          pl.SweepExtreme = pl.R;
          pl.SweepDepth = s * (pl.SweepExtreme - pl.price);
          pl.horizonBuckets = (this.maxSweepLegs * (Vol - pl.sweepStartVol)) / BucketVolume;   // A-46
        }
        return;
      }
      case 'confirmed':
        if (pN > wN + pl.BreakoutDepth) pl.phase = 'done';
        else if (pN > s * pl.SweepExtreme) {
          if (++pl.sweeps + 1 >= this.cfg.MaxSweeps) pl.phase = 'done';        // SweepCount starts at 1
          else this.startSweep(pl, e.p, Vol);
        } else if (pN <= wN - this.cfg.TriggerOffset) {
          pl.phase = 'path';
          pl.entry = e.p;
          pl.horizonVol = Vol + pl.horizonBuckets * BucketVolume;
          pl.reclaimT = e.t;
          pl.volumeDay = volumeDay;
        }
        return;
      case 'path': {
        const m = (s * (pl.entry - e.p)) / pl.SweepDepth;
        if (m >= PLACEBO_TARGET_MULT) this.finish(pl, 'hit');
        else if (-m >= PLACEBO_STOP_MULT) this.finish(pl, 'miss');
        else if (Vol >= pl.horizonVol) this.finish(pl, 'unresolved');
        return;
      }
      default:
        return;
    }
  }

  private finish(pl: Placebo, outcome: PlaceboOutcome): void {
    pl.phase = 'done';
    this.setups.push({
      srcPivotId: pl.srcPivotId, shift: pl.shift, Side: pl.Side, price: pl.price, SweepDepth: pl.SweepDepth, reclaimT: pl.reclaimT,
      volumeDay: pl.volumeDay, outcome,
    });
  }

  // Placebo levels registered, and every reclaimed one (paths still open at
  // the end of the data are unresolved), by reclaim time.
  results(): { readonly levels: number; readonly setups: PlaceboSetup[] } {
    for (const pl of this.active) if (pl.phase === 'path') this.finish(pl, 'unresolved');
    this.active = this.active.filter((pl) => pl.phase !== 'done');
    const setups = [...this.setups].sort((a, b) => a.reclaimT - b.reclaimT || a.srcPivotId - b.srcPivotId || a.shift - b.shift);
    return { levels: this.levels, setups };
  }
}

function sideIndex(side: Side): number {
  return side === 1 ? 0 : 1;
}

// ---------------------------------------------------------------- statistics

export interface HitRateCI {
  readonly n: number;
  readonly HitRate: number;
  readonly ci95: [number, number];
}

// target_grid.json `placeboSwept` (pooled test windows).
export interface PlaceboSweptStats {
  readonly TargetMult: number;              // 2
  readonly StopMult: number;                // 1
  readonly HitRate_0: number;               // 1/3
  readonly B: number;
  readonly blocks: number;                  // volume-days holding an actual or placebo setup
  readonly actual: HitRateCI;               // filled trades, path outcome at (2, 1)
  readonly placebo: HitRateCI & { readonly levels: number; readonly unresolvedShare: number };
  readonly diff: { readonly value: number; readonly ci95: [number, number]; readonly significant: boolean };   // actual − placebo, paired
  readonly configured: HitRateCI & { readonly TargetMult: number; readonly StopMult: number };               // Appendix B Q4
}

export interface ActualSetup {
  readonly volumeDay: number;
  readonly hit: boolean;                    // (2, 1)
  readonly hitConfigured: boolean;          // (TargetMult, StopMult) of the run
}

// Volume-day block bootstrap (Spec §6.1.4): both groups resampled with the
// same block counts, so actual − placebo is a paired contrast.
export function placeboSweptStats(
  actual: ReadonlyArray<ActualSetup>, placebo: ReadonlyArray<PlaceboSetup>, levels: number,
  opts: { readonly B: number; readonly rng: Xoshiro128ss; readonly TargetMult: number; readonly StopMult: number },
): PlaceboSweptStats {
  const blocks = new BlockIndex([...actual.map((a) => a.volumeDay), ...placebo.map((p) => p.volumeDay)]);
  const sums = new BlockSums(2, blocks.size, 3);                                // rows actual / placebo; channels n, hit, hit (configured) | unresolved
  for (const a of actual) {
    const b = blocks.of(a.volumeDay);
    sums.add(0, b, 0, 1);
    if (a.hit) sums.add(0, b, 1, 1);
    if (a.hitConfigured) sums.add(0, b, 2, 1);
  }
  for (const p of placebo) {
    const b = blocks.of(p.volumeDay);
    sums.add(1, b, 0, 1);
    if (p.outcome === 'hit') sums.add(1, b, 1, 1);
    if (p.outcome === 'unresolved') sums.add(1, b, 2, 1);
  }
  const vector = (c: ArrayLike<number> | null): number[] => {
    const a = sums.ratio(0, 1, 0, c);
    const p = sums.ratio(1, 1, 0, c);
    return [a, p, a - p, sums.ratio(0, 2, 0, c)];
  };
  const point = vector(null);
  const boot = blocks.size === 0 ? [] : blockBootstrap(blocks.size, opts.B, opts.rng, vector);
  const ciOf = (j: number): [number, number] => (boot.length === 0 ? [NaN, NaN] : percentileCI(boot[j]!, 0.95));
  const diffCI = ciOf(2);
  return {
    TargetMult: PLACEBO_TARGET_MULT, StopMult: PLACEBO_STOP_MULT, HitRate_0: PLACEBO_STOP_MULT / (PLACEBO_TARGET_MULT + PLACEBO_STOP_MULT),
    B: opts.B, blocks: blocks.size,
    actual: { n: actual.length, HitRate: point[0]!, ci95: ciOf(0) },
    placebo: {
      n: placebo.length, HitRate: point[1]!, ci95: ciOf(1), levels,
      unresolvedShare: placebo.length === 0 ? NaN : placebo.filter((p) => p.outcome === 'unresolved').length / placebo.length,
    },
    diff: { value: point[2]!, ci95: diffCI, significant: Number.isFinite(diffCI[0]) && excludesZero(diffCI) },
    configured: { TargetMult: opts.TargetMult, StopMult: opts.StopMult, n: actual.length, HitRate: point[3]!, ci95: ciOf(3) },
  };
}
