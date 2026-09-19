import type { Level, Trade } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { costFloorDiagnostic } from './cost-floor.js';
import type { TradePath } from './mfe-mae.js';
import { breakdownBy, type BreakdownRow, regimeLabel } from './regime.js';
import { joinTradeOutcomes } from './trade-outcome.js';

describe('regimeLabel (§8.1, A-41)', () => {
  it('TE ≥ 0.4: aligned when TrendSign ≠ Side, counter when = Side; < 0.2 range; else neutral', () => {
    expect(regimeLabel(0.5, -1, 1)).toBe('trend_aligned');     // short in a falling market
    expect(regimeLabel(0.5, 1, 1)).toBe('trend_counter');
    expect(regimeLabel(0.4, 1, -1)).toBe('trend_aligned');
    expect(regimeLabel(0.4, -1, -1)).toBe('trend_counter');
    expect(regimeLabel(0.19, 1, 1)).toBe('range');
    expect(regimeLabel(0.2, 1, 1)).toBe('neutral');
    expect(regimeLabel(0.39, -1, 1)).toBe('neutral');
  });
});

describe('breakdownBy (Spec §7.1)', () => {
  it('HitRate beside HitRate_0 and net expectancies per key; open trades count for HitRate only', () => {
    const row = (key: string, hit: boolean, pnl_bps: number, pnl_R: number): BreakdownRow & { key: string } =>
      ({ key, hit, HitRate_0: 1 / 3, pnl_bps, pnl_R });
    const rows = [row('b', true, 20, 2), row('a', false, -10, -1), row('b', false, -10, -1), row('b', true, NaN, NaN)];
    expect(breakdownBy(rows, (r) => r.key)).toEqual([
      { key: 'a', trades: 1, HitRate: 0, HitRate_0: 1 / 3, expectancy_bps: -10, expectancy_R: -1 },
      { key: 'b', trades: 3, HitRate: 2 / 3, HitRate_0: 1 / 3, expectancy_bps: 5, expectancy_R: 0.5 },
    ]);
  });
});

describe('joinTradeOutcomes + costFloorDiagnostic', () => {
  const level = (levelId: number, minSweepFloorBinding: Level['minSweepFloorBinding'], TrendEfficiency = 0.5, TrendSign = 1): Level => ({
    levelId, minSweepFloorBinding, VolUnit_created: 8, WickStrength: 0.6, regimeAtArm: { TrendEfficiency, TrendSign, counterTrend: false },
  }) as Level;
  // The regime is the Trade's copy of its level's regimeAtArm (taken at the trigger).
  const trade = (tradeId: number, levelId: number, BreakevenHitRate: number, TrendEfficiency = 0.5, TrendSign = 1): Trade => ({
    tradeId, levelId, Side: 1, SweepDepth: 10, exitKind: 'stop', pnl_bps: -5, pnl_R: -1, RoundTripCost_bps: 3, BreakevenHitRate,
    regime: { TrendEfficiency, TrendSign, counterTrend: false },
  }) as Trade;
  const path = (tradeId: number, firstT: number, firstS: number): TradePath => ({
    tradeId, TargetMults: [2], StopMults: [1], firstTIdx: Int32Array.of(firstT), firstSIdx: Int32Array.of(firstS), MFE: 0.5, MAE: 1,
  }) as unknown as TradePath;

  it('joins trade, level regime at arming and the path outcome at (TargetMult, StopMult)', () => {
    const levels = [level(0, 'mult', 0.5, 1), level(1, 'cost', 0.1, 1)];
    const trades = [trade(0, 0, 0.4), trade(1, 1, 0.9, 0.1, 1), trade(2, 1, NaN, 0.1, 1)];
    const rows = joinTradeOutcomes(trades, (id) => levels[id], [path(0, 3, 5), path(1, -1, -1)], { TargetMult: 2, StopMult: 1 });
    expect(rows.map((r) => [r.tradeId, r.regime, r.hit, r.unresolved, r.HitRate_0])).toEqual([
      [0, 'trend_counter', true, false, 1 / 3], [1, 'range', false, true, 1 / 3],
    ]);
    const d = costFloorDiagnostic(levels, trades);
    expect([d.minSweepSetByCost, d.shareOfSpikes, d.BreakevenHitRate.n, d.BreakevenHitRate.p50]).toEqual([1, 0.5, 2, 0.65]);
    expect(costFloorDiagnostic([], []).shareOfSpikes).toBeNaN();
    expect(d.BreakevenAtMultDepth).toBeUndefined();
  });

  it('BreakevenAtMultDepth: (S·d + c)/((T + S)·d) at d = ceil(MinSweepMult·VolUnit_created) per level', () => {
    const levels = [{ ...level(0, 'cost'), WickLevel: 1000 }, { ...level(1, 'cost'), WickLevel: 2000, VolUnit_created: 80 }] as Level[];
    const d = costFloorDiagnostic(levels, [], { MinSweepMult: 0.25, TargetMult: 2, StopMult: 1, roundTripCostTicks: (p) => p / 100 });
    // level 0: d = 2, c = 10 ⇒ 12/6 = 2; level 1: d = 20, c = 20 ⇒ 40/60.
    expect([d.BreakevenAtMultDepth!.n, d.BreakevenAtMultDepth!.p10, d.BreakevenAtMultDepth!.p90]).toEqual([2, 2 / 3 + 0.1 * (2 - 2 / 3), 2 / 3 + 0.9 * (2 - 2 / 3)]);
  });
});
