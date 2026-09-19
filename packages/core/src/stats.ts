import { BUCKETS_PER_VOLUME_DAY, type BucketBuilder, volumeDay } from './buckets.js';
import { ceilTicksConservative } from './numerics.js';
import { RegimeStats } from './regime.js';
import type { TradeRing } from './ring.js';
import type { SpreadEst } from './spread.js';
import { SlidingOrderStats } from './stats-util.js';
import type { Lots, Ticks } from './types.js';
import { VolUnit } from './volunit.js';

const WARMUP_DAYS = 7;
const WARMUP_EVENTS = 500;
const EVENT_SIZE_SAMPLE_STRIDE = 16;

// Every bucket-derived statistic consumers may read (Spec §3.2.6). One
// immutable object per bucket close, replaced atomically (Spec §9.1 L5).
export interface FrozenStats {
  readonly k: number;                     // bucket whose close produced these values; −1 before the first close
  readonly SpreadEst_t: Ticks;
  readonly VolUnit_now: Ticks;
  readonly RVol_5: number;
  readonly RVol_60: number;
  readonly VolRatio: number;
  readonly TrendEfficiency: number;
  readonly TrendSign: number;
  readonly BurstFlag: boolean;
  readonly LiquidityGuard: boolean;
  readonly PivotReversal: Ticks;
  readonly eventSizeP99: Lots;
  readonly eventSizeP10: Lots;
  readonly volumeDay: number;             // −1 during warm-up
}

export interface BucketStatsOptions {
  readonly Tick: Ticks;
  readonly PivotMult: number;
  readonly UnitWindow?: number;           // default 60
  readonly RegimeWindow?: number;         // default 60
}

function pivotReversalFor(PivotMult: number, VolUnit_now: Ticks, Tick: Ticks, SpreadEst_t: Ticks): Ticks {
  return ceilTicksConservative(Math.max(PivotMult * VolUnit_now, 3 * Tick, 2 * SpreadEst_t));
}

// Spec §3.2.6: runs the bucket-close refresh #1–#10 in order. The engine
// (Spec §3.10 step 2) is the only caller of `onBucketClose`; consumers read
// `frozen`, which never changes between closes.
export class BucketStats {
  readonly Tick: Ticks;
  readonly PivotMult: number;
  readonly UnitWindow: number;
  readonly RegimeWindow: number;
  readonly volUnitEst: VolUnit;
  readonly regime: RegimeStats;
  private warmupEndK = -1;
  private readonly sizeSample = new SlidingOrderStats();   // q of every 16th held ring event, oldest first
  private sampleFront = 0;                                  // ring index of sizeSample's oldest value
  private nextSampleIdx = 0;                                // next ring index ≡ 0 mod 16 to sample
  private current: FrozenStats;

  constructor(
    options: BucketStatsOptions,
    private readonly buckets: BucketBuilder,
    private readonly spread: SpreadEst,
  ) {
    this.Tick = options.Tick;
    this.PivotMult = options.PivotMult;
    this.UnitWindow = options.UnitWindow ?? 60;
    this.RegimeWindow = options.RegimeWindow ?? 60;
    this.volUnitEst = new VolUnit(this.UnitWindow);
    this.regime = new RegimeStats({ RegimeWindow: this.RegimeWindow });
    this.current = this.initial();
  }

  private initial(): FrozenStats {
    const VolUnit_now = 4 * this.Tick;
    return Object.freeze({
      k: -1, SpreadEst_t: this.Tick, VolUnit_now, RVol_5: NaN, RVol_60: NaN, VolRatio: 1, TrendEfficiency: 0,
      TrendSign: 0, BurstFlag: false, LiquidityGuard: false,
      PivotReversal: pivotReversalFor(this.PivotMult, VolUnit_now, this.Tick, this.Tick),
      eventSizeP99: 0, eventSizeP10: 0, volumeDay: -1,
    });
  }

  get frozen(): FrozenStats { return this.current; }

  onBucketClose(closedK: number, ring: TradeRing): FrozenStats {
    const history = this.buckets.history;
    const SpreadEst_t = this.spread.refresh(this.Tick);                                              // #1
    const VolUnit_now = this.volUnitEst.refresh(history, closedK, this.Tick, SpreadEst_t);          // #2
    this.regime.onBucketClose(history, closedK, VolUnit_now, SpreadEst_t);                           // #3–#7
    const PivotReversal = pivotReversalFor(this.PivotMult, VolUnit_now, this.Tick, SpreadEst_t);    // #8
    this.sampleEventSizes(ring);                                                                     // #9
    const sampled = this.sizeSample.size;
    const eventSizeP99 = sampled === 0 ? 0 : this.sizeSample.nearestRank(0.99);
    const eventSizeP10 = sampled === 0 ? 0 : this.sizeSample.nearestRank(0.1);
    const r = this.regime;
    this.current = Object.freeze({
      k: closedK, SpreadEst_t, VolUnit_now, RVol_5: r.RVol_5, RVol_60: r.RVol_60, VolRatio: r.VolRatio,
      TrendEfficiency: r.TrendEfficiency, TrendSign: r.TrendSign, BurstFlag: r.BurstFlag,
      LiquidityGuard: r.LiquidityGuard, PivotReversal, eventSizeP99, eventSizeP10,
      volumeDay: volumeDay(closedK, this.warmupEndK),                                                // #10
    });
    return this.current;
  }

  // Keeps sizeSample = q of every held ring event with absolute index ≡ 0 mod
  // 16, incrementally: drop samples the ring evicted, append the new ones.
  private sampleEventSizes(ring: TradeRing): void {
    if (ring.size === 0) {
      return;
    }
    const oldest = ring.oldestIndex;
    while (this.sizeSample.size > 0 && this.sampleFront < oldest) {
      this.sizeSample.shift();
      this.sampleFront += EVENT_SIZE_SAMPLE_STRIDE;
    }
    let i = Math.max(this.nextSampleIdx, Math.ceil(oldest / EVENT_SIZE_SAMPLE_STRIDE) * EVENT_SIZE_SAMPLE_STRIDE);
    if (this.sizeSample.size === 0) {
      this.sampleFront = i;
    }
    for (; i <= ring.newestIndex; i += EVENT_SIZE_SAMPLE_STRIDE) {
      this.sizeSample.push(ring.at(i).q);
    }
    this.nextSampleIdx = i;
  }

  // Spec §3.2.4: every warm-up condition, checked by the engine after a close.
  warmupConditionsMet(eventsSeen: number): boolean {
    const completed = this.buckets.completedCount;
    return (
      this.buckets.daysConsumed >= WARMUP_DAYS &&
      completed >= this.UnitWindow &&
      eventsSeen >= WARMUP_EVENTS &&
      completed >= this.RegimeWindow &&
      completed >= BUCKETS_PER_VOLUME_DAY
    );
  }

  // Warm-up ended on the close of bucket k: volume-day 0 starts at bucket k+1.
  markWarmupEnd(k: number): void {
    this.warmupEndK = k + 1;
  }

  snapshot(): FrozenStats & { warmupEndK: number } {
    return { ...this.current, warmupEndK: this.warmupEndK };
  }

  reset(): void {
    this.volUnitEst.reset();
    this.regime.reset();
    this.warmupEndK = -1;
    this.sizeSample.clear();
    this.sampleFront = 0;
    this.nextSampleIdx = 0;
    this.current = this.initial();
  }
}
