import type { Side } from '@wsr/core';
import { KahanSum, mean } from './numeric.js';

export type RegimeLabel = 'trend_aligned' | 'trend_counter' | 'neutral' | 'range';

const TREND_TE = 0.4;
const RANGE_TE = 0.2;

// §8.1 regime at arming (A-41): TrendEfficiency ≥ 0.4 is a trend — aligned
// when TrendSign ≠ Side (a short, Side = +1, trades with a falling Vwap),
// counter-trend when TrendSign = Side; < 0.2 is a range; in between neutral.
export function regimeLabel(TrendEfficiency: number, TrendSign: number, Side: Side): RegimeLabel {
  if (TrendEfficiency >= TREND_TE) return TrendSign === Side ? 'trend_counter' : 'trend_aligned';
  return TrendEfficiency < RANGE_TE ? 'range' : 'neutral';
}

// Spec §7.1 breakdown row.
export interface Breakdown {
  readonly key: string;
  readonly trades: number;
  readonly HitRate: number;
  readonly HitRate_0: number;
  readonly expectancy_bps: number;
  readonly expectancy_R: number;
}

// What a breakdown needs per trade: the path outcome at the configured
// (TargetMult, StopMult) and the realised net P&L.
export interface BreakdownRow {
  readonly hit: boolean;
  readonly HitRate_0: number;
  readonly pnl_bps: number;
  readonly pnl_R: number;
}

// One Breakdown per distinct key (ascending), trades in input order.
// Trades without a realised P&L (still open at the end) count for HitRate
// but not for the expectancies.
export function breakdownBy<R extends BreakdownRow>(rows: ReadonlyArray<R>, key: (row: R) => string): Breakdown[] {
  const groups = new Map<string, R[]>();
  for (const row of rows) {
    const k = key(row);
    const g = groups.get(k);
    if (g) g.push(row);
    else groups.set(k, [row]);
  }
  return [...groups.keys()].sort().map((k) => {
    const g = groups.get(k)!;
    const bps = new KahanSum();
    const r = new KahanSum();
    let nRealised = 0;
    for (const row of g) {
      if (!Number.isFinite(row.pnl_bps) || !Number.isFinite(row.pnl_R)) continue;
      bps.add(row.pnl_bps);
      r.add(row.pnl_R);
      nRealised++;
    }
    return {
      key: k, trades: g.length, HitRate: g.filter((row) => row.hit).length / g.length, HitRate_0: g.every((row) => row.HitRate_0 === g[0]!.HitRate_0) ? g[0]!.HitRate_0 : mean(g.map((row) => row.HitRate_0)),   // mixed pairs: A-134
      expectancy_bps: nRealised === 0 ? NaN : bps.value / nRealised, expectancy_R: nRealised === 0 ? NaN : r.value / nRealised,
    };
  });
}
