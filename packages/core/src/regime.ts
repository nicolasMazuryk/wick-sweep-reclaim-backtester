import type { BucketHistory } from './buckets.js';
import { Ewma, SortedWindow } from './stats-util.js';
import type { Ticks } from './types.js';

const SHORT_SPAN = 5;
const LONG_SPAN = 60;
const BURST_VOL_RATIO = 3;
const BURST_GAP_UNITS = 3;
const LIQUIDITY_SPREAD_MULT = 2;
const LIQUIDITY_RECENT_BUCKETS = 5;
const LIQUIDITY_DURATION_MULT = 5;

export interface RegimeOptions {
  readonly RegimeWindow?: number;         // default 60 (§8.1)
  readonly liquidityWindow?: number;      // default 1440 bucket closes (§8.8)
}

// Spec §3.2.6 #3–#7, evaluated once per bucket close in that order.
export class RegimeStats {
  readonly RegimeWindow: number;
  private readonly rvolShort = new Ewma(SHORT_SPAN);
  private readonly rvolLong = new Ewma(LONG_SPAN);
  private readonly spreadCloses: SortedWindow;
  private readonly wallDurations: SortedWindow;
  private closes = 0;
  private vwapPrev = NaN;
  // Σ (High_j − Low_j) over [rangeSumK − RegimeWindow, rangeSumK] of rangeSource; −1 = none.
  // Integer ticks, so the rolling update is exact (Spec §10: no 61-bucket loop per close).
  private rangeSum = 0;
  private rangeSumK = -1;
  private rangeSource: BucketHistory | null = null;

  RVol_5 = NaN;
  RVol_60 = NaN;
  VolRatio = 1;
  TrendEfficiency = 0;
  TrendSign = 0;
  BurstFlag = false;
  LiquidityGuard = false;

  constructor(options: RegimeOptions = {}) {
    this.RegimeWindow = options.RegimeWindow ?? 60;
    const liquidityWindow = options.liquidityWindow ?? 1440;
    this.spreadCloses = new SortedWindow(liquidityWindow);
    this.wallDurations = new SortedWindow(liquidityWindow);
  }

  onBucketClose(buckets: BucketHistory, k: number, VolUnit_now: Ticks, SpreadEst_t: Ticks): void {
    this.closes++;
    const vwap = buckets.Vwap_k(k);

    // #3 RVol_N = sqrt(EWMA_N((log Vwap_k − log Vwap_{k−1})²))
    if (!Number.isNaN(this.vwapPrev)) {
      const r = Math.log(vwap) - Math.log(this.vwapPrev);
      this.RVol_5 = Math.sqrt(this.rvolShort.update(r * r));
      this.RVol_60 = Math.sqrt(this.rvolLong.update(r * r));
    }
    this.vwapPrev = vwap;

    // #4 VolRatio: undefined (→ 1) until 60 buckets or while RVol_60 = 0.
    this.VolRatio = this.closes >= LONG_SPAN && this.RVol_60 > 0 ? this.RVol_5 / this.RVol_60 : 1;

    // #5 TrendEfficiency over RegimeWindow (RegimeWindow + 1 buckets j = k−RegimeWindow … k).
    const kBack = k - this.RegimeWindow;
    if (kBack >= buckets.oldestK && kBack >= 0) {
      let rangeSum = 0;
      if (buckets === this.rangeSource && this.rangeSumK === k - 1 && kBack - 1 >= buckets.oldestK) {
        rangeSum = this.rangeSum + (buckets.High_k(k) - buckets.Low_k(k)) - (buckets.High_k(kBack - 1) - buckets.Low_k(kBack - 1));
      } else {
        for (let j = kBack; j <= k; j++) rangeSum += buckets.High_k(j) - buckets.Low_k(j);
      }
      this.rangeSum = rangeSum;
      this.rangeSumK = k;
      this.rangeSource = buckets;
      const move = vwap - buckets.Vwap_k(kBack);
      this.TrendEfficiency = rangeSum === 0 ? 0 : Math.abs(move) / rangeSum;
      this.TrendSign = Math.sign(move);
    } else {
      this.rangeSumK = -1;
      this.TrendEfficiency = 0;
      this.TrendSign = 0;
    }

    // #6 BurstFlag with the fresh VolUnit_now.
    this.BurstFlag = this.VolRatio > BURST_VOL_RATIO || buckets.maxPrintGap_k(k) > BURST_GAP_UNITS * VolUnit_now;

    // #7 LiquidityGuard (A-7): sum of the last n ≤ 5 durations vs 5·n·median.
    this.spreadCloses.push(SpreadEst_t);
    this.wallDurations.push(buckets.WallDuration_k(k));
    const recent = Math.min(LIQUIDITY_RECENT_BUCKETS, k - buckets.oldestK + 1);
    let recentDuration = 0;
    for (let j = k - recent + 1; j <= k; j++) recentDuration += buckets.WallDuration_k(j);
    this.LiquidityGuard =
      SpreadEst_t > LIQUIDITY_SPREAD_MULT * this.spreadCloses.median() ||
      recentDuration > LIQUIDITY_DURATION_MULT * recent * this.wallDurations.median();
  }

  snapshot(): {
    RVol_5: number; RVol_60: number; VolRatio: number; TrendEfficiency: number; TrendSign: number;
    BurstFlag: boolean; LiquidityGuard: boolean; closes: number;
  } {
    return {
      RVol_5: this.RVol_5, RVol_60: this.RVol_60, VolRatio: this.VolRatio, TrendEfficiency: this.TrendEfficiency,
      TrendSign: this.TrendSign, BurstFlag: this.BurstFlag, LiquidityGuard: this.LiquidityGuard, closes: this.closes,
    };
  }

  reset(): void {
    this.rvolShort.reset();
    this.rvolLong.reset();
    this.spreadCloses.reset();
    this.wallDurations.reset();
    this.closes = 0;
    this.vwapPrev = NaN;
    this.rangeSumK = -1;
    this.rangeSource = null;
    this.RVol_5 = NaN;
    this.RVol_60 = NaN;
    this.VolRatio = 1;
    this.TrendEfficiency = 0;
    this.TrendSign = 0;
    this.BurstFlag = false;
    this.LiquidityGuard = false;
  }
}
