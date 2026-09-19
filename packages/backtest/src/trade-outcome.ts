import type { Level, Side, Ticks, Trade } from '@wsr/core';
import { hitRate0, pathOutcome, type TradePath } from './mfe-mae.js';
import { type BreakdownRow, type RegimeLabel, regimeLabel } from './regime.js';

// One trade joined with its level and its tracked path: the row consumed by
// the breakdowns (Spec §7.1) and the cost-floor diagnostic.
export interface TradeOutcomeRow extends BreakdownRow {
  readonly tradeId: number;
  readonly levelId: number;
  readonly Side: Side;
  readonly SweepDepth: Ticks;
  readonly VolUnit_created: Ticks;
  readonly WickStrength: number;
  readonly regime: RegimeLabel;
  readonly TrendEfficiency: number;
  readonly exitKind: Trade['exitKind'];
  readonly unresolved: boolean;             // path reached neither TargetMult nor StopMult
  readonly MFE: number;
  readonly MAE: number;
  readonly RoundTripCost_bps: number;
  readonly BreakevenHitRate: number;
}

// `hit` = MFE ≥ TargetMult strictly before MAE ≥ StopMult on the tracked path
// (unresolved ⇒ not a hit); trades without a path (entry never filled) are skipped.
export function joinTradeOutcomes(
  trades: ReadonlyArray<Readonly<Trade>>, levelById: (levelId: number) => Readonly<Level> | undefined,
  paths: ReadonlyArray<TradePath>, grid: { readonly TargetMult: number; readonly StopMult: number },
): TradeOutcomeRow[] {
  const pathOf = new Map(paths.map((x) => [x.tradeId, x]));
  const rows: TradeOutcomeRow[] = [];
  for (const tr of trades) {
    const path = pathOf.get(tr.tradeId);
    const level = levelById(tr.levelId);
    if (path === undefined || level === undefined) continue;
    const { regime } = tr;
    const o = pathOutcome(path, grid.TargetMult, grid.StopMult);
    rows.push({
      tradeId: tr.tradeId, levelId: tr.levelId, Side: tr.Side, SweepDepth: tr.SweepDepth, VolUnit_created: level.VolUnit_created,
      WickStrength: level.WickStrength, regime: regime === null ? 'neutral' : regimeLabel(regime.TrendEfficiency, regime.TrendSign, tr.Side),
      TrendEfficiency: regime?.TrendEfficiency ?? NaN, exitKind: tr.exitKind, hit: o === 'hit', unresolved: o === 'unresolved',
      HitRate_0: hitRate0(grid.TargetMult, grid.StopMult), MFE: path.MFE, MAE: path.MAE, pnl_bps: tr.pnl_bps, pnl_R: tr.pnl_R,
      RoundTripCost_bps: tr.RoundTripCost_bps, BreakevenHitRate: tr.BreakevenHitRate,
    });
  }
  return rows;
}
