import type { ExcursionFeatures } from './features.js';
import { SortedWindow } from './stats-util.js';

// Spec §3.7.1: the 13-feature vector, indices 0..12 in this order.
export const FEATURE_NAMES = [
  'SpikeSize', 'logRejectSpeed', 'SpeedAsymmetry', 'RejectImbalance', 'ApproachImbalance', 'VolumeBurst', 'TopDwell',
  'RetraceFraction', 'MaxTradeSize', 'MaxAggressorRun', 'MaxPrintGap', 'PriorTouches', 'SpikeSizeOverRVol',
] as const;
export const FEATURE_COUNT = FEATURE_NAMES.length;

// A-19: WickStrength is undefined until every window holds this many pivots.
export const MinRankPivots = 50;

// `rvolTicks` = RVol_60 · Vwap_k at confirmed_at (A-18); a non-positive or
// undefined RVol gives SpikeSize/RVol = 0 (weight 0 in Stage A, A-20) so the
// rank windows never hold NaN.
export function featureVector(f: ExcursionFeatures, PriorTouches: number, rvolTicks: number, out: Float64Array): Float64Array {
  out[0] = f.SpikeSize;
  out[1] = Math.log(f.RejectSpeed);
  out[2] = f.SpeedAsymmetry;
  out[3] = f.RejectImbalance;
  out[4] = f.ApproachImbalance;
  out[5] = f.VolumeBurst;
  out[6] = f.TopDwell;
  out[7] = f.RetraceFraction;
  out[8] = f.MaxTradeSize;
  out[9] = f.MaxAggressorRun;
  out[10] = f.MaxPrintGap;
  out[11] = PriorTouches;
  out[12] = rvolTicks > 0 ? f.SpikeSize / rvolTicks : 0;
  return out;
}

// Spec §3.7.2. One sorted window of the last RankWindow values per feature,
// fed only with rankable pivots (featuresAvailable, WickLevel/SlowExtreme)
// after they have been scored.
export class RankWindows {
  private readonly windows: SortedWindow[];

  constructor(readonly RankWindow = 500) {
    this.windows = Array.from({ length: FEATURE_COUNT }, () => new SortedWindow(RankWindow));
  }

  get size(): number { return this.windows[0]!.size; }

  // rank_j = (#{y < x_j} + ½·#{y = x_j} + ½) / (|W_j| + 1) ∈ (0, 1). Returns
  // false (out untouched) while |W| < MinRankPivots.
  ranks(x: Float64Array, out: Float64Array): boolean {
    if (this.size < MinRankPivots) return false;
    const n = this.size;
    for (let j = 0; j < FEATURE_COUNT; j++) {
      const w = this.windows[j]!;
      const less = w.countLess(x[j]!);
      const equal = w.countLessOrEqual(x[j]!) - less;
      out[j] = (less + 0.5 * equal + 0.5) / (n + 1);
    }
    return true;
  }

  insert(x: Float64Array): void {
    for (let j = 0; j < FEATURE_COUNT; j++) this.windows[j]!.push(x[j]!);
  }

  snapshot(): number[][] {
    return this.windows.map((w) => w.toArray());
  }

  reset(): void {
    for (const w of this.windows) w.reset();
  }
}

// Spec §3.7.3 Stage A prior weights by feature index; TopDwell (6) enters as
// 1 − rank. ApproachImbalance, MaxPrintGap, PriorTouches, SpikeSize/RVol: 0 (A-20).
export const STAGE_A_WEIGHTS: ReadonlyArray<number> = [0.15, 0.2, 0.1, 0.2, 0, 0.1, 0.1, 0.05, 0.05, 0.05, 0, 0, 0];
const TOP_DWELL = 6;

export function stageAScore(ranks: Float64Array): number {
  let score = 0;
  for (let j = 0; j < FEATURE_COUNT; j++) {
    const r = j === TOP_DWELL ? 1 - ranks[j]! : ranks[j]!;
    score += STAGE_A_WEIGHTS[j]! * r;
  }
  return score;
}

// Spec §3.7.4 Stage B model, fitted per fold on train only (fitting lives in
// @wsr/backtest, Spec §6.3). Coefficients act on z_j = 2·rank_j − 1.
export interface StageBModel {
  readonly foldId: number;
  readonly beta0: number;
  readonly beta: Float64Array;                            // length FEATURE_COUNT
  readonly lambda: number;                                // L2 penalty (A-21)
  readonly ipwModel: { readonly gamma0: number; readonly gamma: Float64Array };   // P(approached | z)
  readonly minStrengthQuantile: number;                   // MinStrength realised on train (§4.3)
  readonly calibration: ReadonlyArray<{ readonly bin: number; readonly meanP: number; readonly meanY: number; readonly n: number }>;
}

// Logistic σ(x), written so neither branch overflows.
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// β0 + Σ_j β_j·(2·rank_j − 1).
export function linearPredictor(beta0: number, beta: ArrayLike<number>, ranks: ArrayLike<number>): number {
  let z = beta0;
  for (let j = 0; j < FEATURE_COUNT; j++) z += beta[j]! * (2 * ranks[j]! - 1);
  return z;
}

// WickStrength_B = σ(β0 + β·z), z_j = 2·rank_j − 1 (Spec §3.7.4).
export function stageBScore(m: StageBModel, ranks: ArrayLike<number>): number {
  return sigmoid(linearPredictor(m.beta0, m.beta, ranks));
}
