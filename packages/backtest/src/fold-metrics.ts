import type { Ms } from '@wsr/core';
import { BlockIndex, blockBootstrap, BlockSums, percentileCI } from './bootstrap.js';
import { KahanSum, mean } from './numeric.js';
import { type Breakdown, breakdownBy, type BreakdownRow } from './regime.js';
import { rngStream } from './rng.js';
import { sweepDepthBinLabel } from './target-validation.js';
import type { TradeRecord } from './trade-record.js';
import type { FoldWindow } from './walk-forward.js';

export type RuleBindingStats = Readonly<Record<string, number>>;

// Spec §7.1, one per fold × {train, test} plus the pooled test set.
export interface FoldMetrics {
  readonly foldId: number | 'pooled'; readonly window: FoldWindow; readonly from: string; readonly to: string; readonly volumeDays: number;
  readonly trades: number; readonly realised: number;       // realised: trades with a finite pnl (expectancies, total P&L)
  readonly HitRate: number; readonly HitRate_0: number; readonly BreakevenHitRate: number; readonly HitRateMinusBreakeven: number;
  readonly expectancy_bps: number; readonly expectancy_R: number; readonly profitFactor: number;
  readonly sharpeTrade: number; readonly sharpeDaily: number; readonly maxDrawdown_R: number; readonly meanHoldBuckets: number;
  readonly touchAndReverseShare: number; readonly targetFill: { readonly conservative: number; readonly optimistic: number };
  readonly latencyCurve: ReadonlyArray<{ readonly latencyMs: number; readonly expectancy_bps: number; readonly trades: number }>;
  readonly slippageCurve: ReadonlyArray<{ readonly slipCoefMult: 1 | 2 | 4; readonly expectancy_bps: number }>;
  readonly byDecile: ReadonlyArray<Breakdown>; readonly bySweepDepthBin: ReadonlyArray<Breakdown>; readonly byRegime: ReadonlyArray<Breakdown>;
  readonly byHour: ReadonlyArray<Breakdown>; readonly bySweepCount: ReadonlyArray<Breakdown>; readonly byPriorTouches: ReadonlyArray<Breakdown>;
  readonly byReturnSpeed: ReadonlyArray<Breakdown>;
  readonly mechanism: { readonly winnersMeanImb: number; readonly losersMeanImb: number; readonly diff: number; readonly ci95: [number, number] };
  readonly ruleBinding: RuleBindingStats; readonly costFloor: { readonly minSweepSetByCost: number; readonly shareOfSpikes: number };
  readonly blacklistedBucketShare: number; readonly killSwitchTrips: number;
  readonly ringUnderflow: number;           // TradeRing underflows in the window (Spec §3.1 "underflow during a fold is reported")
}

// One sweep replay's statistics over the same window (Spec §4.1, §9.4).
export interface SweepPoint {
  readonly trades: number;
  readonly expectancy_bps: number;
}

export interface FoldMetricsContext {
  readonly foldId: number | 'pooled';
  readonly window: FoldWindow;
  readonly from: Ms;                        // window start (pooled: first test start)
  readonly to: Ms;                          // window end, exclusive
  readonly TargetMult: number;              // configured (HitRate, HitRate_0)
  readonly StopMult: number;
  readonly hit: (r: TradeRecord) => boolean;          // path outcome at (TargetMult, StopMult)
  // Per-trade S/(T+S) when the trades' pairs differ (`--from-grid` composite, A-134); HitRate_0 = its mean.
  readonly hitRate0?: (r: TradeRecord) => number;
  readonly decile: (r: TradeRecord) => number;         // vs the fold's train WickLevels
  readonly volumeDayOf: (r: TradeRecord) => number;    // bootstrap block
  readonly volumeDays: number;
  readonly blacklistedBucketShare: number;
  readonly killSwitchTrips: number;
  readonly ringUnderflow: number;
  readonly ruleBinding: RuleBindingStats;
  readonly costFloor: { readonly minSweepSetByCost: number; readonly shareOfSpikes: number };
  readonly latencyMs: number;
  readonly seed: number;
  readonly B: number;
  // Latency / slippage curve points; `point: null` = these records (the configured point).
  readonly sweep?: {
    readonly latencyPoints: ReadonlyArray<{ readonly latencyMs: number; readonly point: SweepPoint | null }>;
    readonly slippagePoints: ReadonlyArray<{ readonly slipCoefMult: 1 | 2 | 4; readonly point: SweepPoint | null }>;
  };
}

const DAY_MS = 86_400_000;
// ReturnSpeed bins, VolUnit per bucket (MinReturnSpeed default 0.3).
const RETURN_SPEED_EDGES = [0.3, 0.5, 1, 2];
// Stream id of the pooled set's bootstrap (fold ids are small integers).
export const POOLED_FOLD_ID = 0xfffffffe;

function returnSpeedBin(x: number): string {
  if (!Number.isFinite(x)) return 'undefined';
  let lo = 0;
  for (const e of RETURN_SPEED_EDGES) {
    if (x < e) return `[${lo},${e})`;
    lo = e;
  }
  return `[${lo},inf)`;
}

function isoDay(t: Ms): string {
  return new Date(t).toISOString().slice(0, 10);
}

function sampleSharpe(xs: ReadonlyArray<number>): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const k = new KahanSum();
  for (const x of xs) k.add((x - m) ** 2);
  const sd = Math.sqrt(k.value / (xs.length - 1));
  return sd > 0 ? m / sd : NaN;
}

// Records in tradeId order. Expectancies use trades with a realised P&L;
// `profitFactor` = Σ winning pnl_R / |Σ losing pnl_R|; `sharpeDaily` over
// every UTC day of the window (0 R on days without an exit); `maxDrawdown_R`
// on cumulative pnl_R in trade order (positive number). None is annualised.
export function foldMetrics(records: ReadonlyArray<TradeRecord>, ctx: FoldMetricsContext): FoldMetrics {
  const rows = [...records].sort((a, b) => a.tradeId - b.tradeId);
  const realised = rows.filter((r) => Number.isFinite(r.pnl_bps) && Number.isFinite(r.pnl_R));
  const n = rows.length;
  const hitRate0 = ctx.hitRate0 ?? ((): number => ctx.StopMult / (ctx.TargetMult + ctx.StopMult));
  const HitRate_0 = ctx.hitRate0 === undefined ? ctx.StopMult / (ctx.TargetMult + ctx.StopMult) : mean(rows.map(ctx.hitRate0));
  const HitRate = n === 0 ? NaN : rows.filter(ctx.hit).length / n;
  const be = rows.map((r) => r.BreakevenHitRate).filter(Number.isFinite);
  const BreakevenHitRate = mean(be);
  const expectancy_bps = mean(realised.map((r) => r.pnl_bps));
  const expectancy_R = mean(realised.map((r) => r.pnl_R));
  const wins = new KahanSum();
  const losses = new KahanSum();
  for (const r of realised) (r.pnl_R > 0 ? wins : losses).add(r.pnl_R);
  const profitFactor = realised.length === 0 ? NaN : losses.value < 0 ? wins.value / -losses.value : NaN;
  // Daily sums by the exit's UTC day.
  const firstDay = Math.floor(ctx.from / DAY_MS);
  const dailySums = Array.from({ length: Math.max(0, Math.ceil(ctx.to / DAY_MS) - firstDay) }, () => new KahanSum());
  for (const r of realised) {
    const d = Math.floor((r.exit.t ?? r.TriggerTime) / DAY_MS) - firstDay;
    if (d >= 0 && d < dailySums.length) dailySums[d]!.add(r.pnl_R);
  }
  const daily = dailySums.map((k) => k.value);
  let peak = 0;
  const cum = new KahanSum();                                                  // Spec §9.2
  let maxDrawdown_R = 0;
  for (const r of realised) {
    const c = cum.add(r.pnl_R).value;
    peak = Math.max(peak, c);
    maxDrawdown_R = Math.max(maxDrawdown_R, peak - c);
  }
  const optimistic = mean(realised.map((r) => r.exitOpt.pnl_bps).filter((x): x is number => x !== null));
  const bRows = rows.map((r): BreakdownRow & { r: TradeRecord } => ({ r, hit: ctx.hit(r), HitRate_0: hitRate0(r), pnl_bps: r.pnl_bps, pnl_R: r.pnl_R }));
  const by = (key: (r: TradeRecord) => string): Breakdown[] => breakdownBy(bRows, (x) => key(x.r));
  return {
    foldId: ctx.foldId, window: ctx.window, from: isoDay(ctx.from), to: isoDay(ctx.to - 1), volumeDays: ctx.volumeDays,
    trades: n, realised: realised.length, HitRate, HitRate_0, BreakevenHitRate, HitRateMinusBreakeven: HitRate - BreakevenHitRate,
    expectancy_bps, expectancy_R, profitFactor, sharpeTrade: sampleSharpe(realised.map((r) => r.pnl_R)), sharpeDaily: sampleSharpe(daily),
    maxDrawdown_R: realised.length === 0 ? NaN : maxDrawdown_R,
    meanHoldBuckets: mean(rows.map((r) => r.holdBuckets).filter(Number.isFinite)),
    touchAndReverseShare: n === 0 ? NaN : rows.filter((r) => r.touchAndReverse).length / n,
    targetFill: { conservative: expectancy_bps, optimistic },
    // The configured point unless the sweeps ran (A-130).
    latencyCurve: (ctx.sweep?.latencyPoints ?? [{ latencyMs: ctx.latencyMs, point: null }])
      .map((x) => ({ latencyMs: x.latencyMs, expectancy_bps: x.point?.expectancy_bps ?? expectancy_bps, trades: x.point?.trades ?? n })),
    slippageCurve: (ctx.sweep?.slippagePoints ?? [{ slipCoefMult: 1, point: null }])
      .map((x) => ({ slipCoefMult: x.slipCoefMult, expectancy_bps: x.point === null ? expectancy_bps : x.point.expectancy_bps })),
    byDecile: by((r) => String(ctx.decile(r)).padStart(2, '0')),
    bySweepDepthBin: by((r) => sweepDepthBinLabel(r.SweepDepth, r.VolUnit_created)),
    byRegime: by((r) => r.regime),
    byHour: by((r) => String(r.hourOfDay).padStart(2, '0')),
    bySweepCount: by((r) => String(r.SweepCount)),
    byPriorTouches: by((r) => String(r.PriorTouches)),
    byReturnSpeed: by((r) => returnSpeedBin(r.ReturnSpeed)),
    mechanism: mechanism(realised, ctx),
    ruleBinding: ctx.ruleBinding, costFloor: ctx.costFloor, blacklistedBucketShare: ctx.blacklistedBucketShare,
    killSwitchTrips: ctx.killSwitchTrips, ringUnderflow: ctx.ringUnderflow,
  };
}

// §9.4 mechanism check: mean postEntryImbalance2 of winners (pnl_R > 0) vs
// losers, difference with a volume-day block-bootstrap CI (Spec §6.1.4).
function mechanism(realised: ReadonlyArray<TradeRecord>, ctx: FoldMetricsContext): FoldMetrics['mechanism'] {
  const sample = realised.filter((r) => Number.isFinite(r.postEntryImbalance2));
  const blocks = new BlockIndex(sample.map(ctx.volumeDayOf));
  const sums = new BlockSums(2, blocks.size, 2);
  for (const r of sample) {
    const row = r.pnl_R > 0 ? 0 : 1;
    const b = blocks.of(ctx.volumeDayOf(r));
    sums.add(row, b, 0, 1);
    sums.add(row, b, 1, r.postEntryImbalance2);
  }
  const vector = (c: ArrayLike<number> | null): number[] => {
    const w = sums.ratio(0, 1, 0, c);
    const l = sums.ratio(1, 1, 0, c);
    return [w, l, w - l];
  };
  const point = vector(null);
  const id = ctx.foldId === 'pooled' ? POOLED_FOLD_ID : ctx.foldId;
  const rng = rngStream(ctx.seed, 'bootstrap', id, ctx.window === 'train' ? 0 : 1);
  const boot = blocks.size === 0 ? [] : blockBootstrap(blocks.size, ctx.B, rng, vector);
  return {
    winnersMeanImb: point[0]!, losersMeanImb: point[1]!, diff: point[2]!, ci95: boot.length === 0 ? [NaN, NaN] : percentileCI(boot[2]!, 0.95),
  };
}
