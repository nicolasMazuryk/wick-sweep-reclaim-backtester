import { describe, expect, it } from 'vitest';
import { foldMetrics, type FoldMetricsContext } from './fold-metrics.js';
import type { TradeRecord } from './trade-record.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 9);

// tradeId, pnl_R, exit day offset, hit, postEntryImbalance2, volumeDay.
function rec(tradeId: number, pnl_R: number, day: number, extra: Partial<TradeRecord> = {}): TradeRecord {
  return {
    tradeId, pnl_R, pnl_bps: 10 * pnl_R, TriggerTime: T0 + day * DAY, exit: { kind: 'stop', t: T0 + day * DAY + 1000, price: 0, pnl_bps: 10 * pnl_R },
    exitOpt: { kind: 'target', t: 0, price: 0, pnl_bps: 10 * pnl_R + 1 }, BreakevenHitRate: 0.4, holdBuckets: tradeId + 1,
    touchAndReverse: tradeId === 0, WickStrength: 0.5, SweepDepth: 10, VolUnit_created: 10, regime: 'range', hourOfDay: 3, SweepCount: 1,
    PriorTouches: 0, ReturnSpeed: 0.4, postEntryImbalance2: pnl_R > 0 ? 0.3 : -0.1, ...extra,
  } as unknown as TradeRecord;
}

function ctx(over: Partial<FoldMetricsContext> = {}): FoldMetricsContext {
  return {
    foldId: 2, window: 'test', from: T0, to: T0 + 4 * DAY, TargetMult: 2, StopMult: 1, hit: (r) => r.pnl_R > 0, decile: () => 7,
    volumeDayOf: (r) => Math.floor((r.TriggerTime - T0) / DAY), volumeDays: 3.5, blacklistedBucketShare: 0.1, killSwitchTrips: 1, ringUnderflow: 2,
    ruleBinding: { 'book.bound.position': 3 }, costFloor: { minSweepSetByCost: 4, shareOfSpikes: 0.5 }, latencyMs: 150, seed: 1, B: 200, ...over,
  };
}

describe('foldMetrics (Spec §7.1)', () => {
  // Cumulative R: 2, 1, −1, 2, 1.5 ⇒ max drawdown 3 (2 → −1).
  const records = [rec(3, 3, 2), rec(0, 2, 0), rec(1, -1, 0), rec(2, -2, 1), rec(4, -0.5, 3)];

  it('HitRate vs HitRate_0 vs Breakeven, expectancies, profit factor, drawdown, Sharpes', () => {
    const m = foldMetrics(records, ctx());
    expect([m.foldId, m.window, m.from, m.to, m.volumeDays, m.trades]).toEqual([2, 'test', '2025-01-09', '2025-01-12', 3.5, 5]);
    expect([m.HitRate, m.HitRate_0, m.BreakevenHitRate]).toEqual([2 / 5, 1 / 3, 0.4]);
    expect(m.HitRateMinusBreakeven).toBeCloseTo(0, 12);
    expect(m.expectancy_R).toBeCloseTo(1.5 / 5, 12);
    expect(m.expectancy_bps).toBeCloseTo(15 / 5, 12);
    expect(m.profitFactor).toBeCloseTo(5 / 3.5, 12);
    expect(m.maxDrawdown_R).toBe(3);
    const rs = [2, -1, -2, 3, -0.5];
    const mean = 0.3;
    const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / 4);
    expect(m.sharpeTrade).toBeCloseTo(mean / sd, 12);
    const daily = [1, -2, 3, -0.5];                                       // 4 UTC days in the window
    const dm = 0.375;
    expect(m.sharpeDaily).toBeCloseTo(dm / Math.sqrt(daily.reduce((s, x) => s + (x - dm) ** 2, 0) / 3), 12);
    expect(m.meanHoldBuckets).toBe(3);
    expect(m.touchAndReverseShare).toBe(1 / 5);
    expect(m.targetFill.conservative).toBeCloseTo(3, 12);
    expect(m.targetFill.optimistic).toBeCloseTo(4, 12);
    expect(m.latencyCurve).toEqual([{ latencyMs: 150, expectancy_bps: m.expectancy_bps, trades: 5 }]);
    expect(m.slippageCurve).toEqual([{ slipCoefMult: 1, expectancy_bps: m.expectancy_bps }]);
    expect([m.blacklistedBucketShare, m.killSwitchTrips, m.ringUnderflow, m.ruleBinding, m.costFloor]).toEqual([0.1, 1, 2, { 'book.bound.position': 3 }, { minSweepSetByCost: 4, shareOfSpikes: 0.5 }]);
  });

  it('breakdowns via breakdownBy; mechanism winners − losers with a volume-day bootstrap CI', () => {
    const m = foldMetrics(records, ctx());
    expect(m.byDecile).toEqual([{ key: '07', trades: 5, HitRate: 0.4, HitRate_0: 1 / 3, expectancy_bps: 3, expectancy_R: 0.3 }]);
    expect(m.bySweepDepthBin.map((b) => b.key)).toEqual(['[1,1.5)']);
    expect(m.byReturnSpeed.map((b) => b.key)).toEqual(['[0.3,0.5)']);
    expect(m.byHour.map((b) => b.key)).toEqual(['03']);
    expect(m.mechanism.winnersMeanImb).toBeCloseTo(0.3, 12);
    expect(m.mechanism.losersMeanImb).toBeCloseTo(-0.1, 12);
    expect(m.mechanism.diff).toBeCloseTo(0.4, 12);
    expect(m.mechanism.ci95[0]).toBeLessThanOrEqual(m.mechanism.ci95[1]);
    const again = foldMetrics(records, ctx());
    expect(again.mechanism).toEqual(m.mechanism);                            // seeded stream
  });

  it('no trades ⇒ NaN statistics, zero counts', () => {
    const m = foldMetrics([], ctx());
    expect(m.trades).toBe(0);
    for (const x of [m.HitRate, m.expectancy_bps, m.profitFactor, m.sharpeTrade, m.maxDrawdown_R, m.mechanism.diff]) expect(x).toBeNaN();
    expect(m.byDecile).toEqual([]);
  });
});
