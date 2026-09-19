import type { Trade } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import type { TargetGridCell, TradePath } from './mfe-mae.js';
import { conditionalHitRate, plateauOf, snapToGrid, sweepDepthBinLabel, targetValidation, twoStageExpectancy } from './target-validation.js';
import type { Fold } from './walk-forward.js';

function cell(TargetMult: number, StopMult: number, Expectancy: number, n = 10): TargetGridCell {
  return { TargetMult, StopMult, Expectancy, n, HitRate: 0.5, HitRate_0: StopMult / (TargetMult + StopMult), unresolvedShare: 0 };
}

// Grid TargetMults [1, 2, 3], StopMults [1]; first-passage print indices.
function path(firstT: number[], firstS: number[], back = -1, extra: Partial<TradePath> = {}, TriggerTime = 0): TradePath {
  return {
    TargetMults: [1, 2, 3], StopMults: [1], TargetUnits: [1], firstTIdx: Int32Array.from(firstT), firstSIdx: Int32Array.from(firstS),
    firstTUIdx: Int32Array.of(-1), firstBackToEntryAfter1Idx: back, EntryFill: 1000, SweepDepth: 10, VolUnit_created: 10,
    trade: { RoundTripCost_bps: 0, TriggerTime } as Trade, ...extra,
  } as unknown as TradePath;
}

describe('plateau (Spec §6.2, §6.5 "plateau, not the peak")', () => {
  it('snapToGrid: nearest value, a tie goes to the lower one', () => {
    expect(snapToGrid(1.7, [0.5, 1, 1.5, 2])).toBe(1.5);
    expect(snapToGrid(1.75, [2, 1.5, 1])).toBe(1.5);
    expect(snapToGrid(9, [1, 2])).toBe(2);
  });

  it('median (T, S) of the top 20 % of admissible cells, snapped; not the argmax', () => {
    const Ts = [0.5, 1, 1.5, 2, 2.5];
    const cells = Ts.flatMap((T) => [0.75, 1].map((S) => cell(T, S, -Math.abs(T - 1.5) - Math.abs(S - 1) + (T === 0.5 && S === 0.75 ? 5 : 0))));
    // 10 cells ⇒ top 2: (0.5, 0.75) [the isolated peak] and (1.5, 1) ⇒ median T = 1 ⇒ 1, median S = 0.875 ⇒ tie ⇒ 0.75.
    expect(plateauOf(cells)).toEqual({ TargetMult: 1, StopMult: 0.75, cells: 2, admissible: 10 });
    const ignored = [...cells, cell(4, 1.5, 100, 0), cell(4, 1.25, NaN)];
    expect(plateauOf(ignored)).toMatchObject({ TargetMult: 1, StopMult: 0.75, admissible: 10 });
    expect(plateauOf([cell(1, 1, NaN)])).toBeNull();
  });
});

describe('two-stage exit and the conditional table (§6.5)', () => {
  it('half at 1·SweepDepth, stop to EntryFill, half at TargetMult; stop first ⇒ full stop', () => {
    const paths = [
      path([2, 5, -1], [-1], 3),     // 1 at idx 2, back at 3 before T=2 (5): +5 ticks for T ≥ 2; T = 1: +10
      path([2, 4, 8], [9], -1),      // T = 2 at 4, T = 3 at 8 (no return to entry): +15 / +20 ticks
      path([-1, -1, -1], [3]),       // stop before 1: −10
      path([6, -1, -1], [4]),        // stop (idx 4) before 1 (idx 6): −10
      path([1, -1, -1], [-1], -1),   // 1 reached, second half unresolved ⇒ closes at entry: +5
    ];
    const rows = twoStageExpectancy(paths, 1);
    const bps = (ticks: number[]) => ticks.reduce((a, b) => a + b, 0) / ticks.length * 10;  // 1 tick = 10 bps at 1000
    expect(rows.map((r) => r.TargetMult)).toEqual([1, 2, 3]);
    expect(rows[0]!.Expectancy).toBeCloseTo(bps([10, 10, -10, -10, 10]), 12);
    expect(rows[1]!.Expectancy).toBeCloseTo(bps([5, 15, -10, -10, 5]), 12);
    expect(rows[2]!.Expectancy).toBeCloseTo(bps([5, 20, -10, -10, 5]), 12);
    expect([rows[1]!.firstHalfHitRate, rows[1]!.secondHalfHitRate, rows[1]!.unresolvedShare]).toEqual([3 / 5, 1 / 3, 1 / 3]);
    expect(twoStageExpectancy([], 1)).toEqual([]);
  });

  it('HitRate(2, 1) by SweepDepth/VolUnit_created bin; the last bin is closed', () => {
    expect(sweepDepthBinLabel(4, 10)).toBe('[0.3,0.5)');
    expect(sweepDepthBinLabel(25, 10)).toBe('[1.5,2.5]');
    expect(sweepDepthBinLabel(26, 10)).toBe('outside');
    expect(sweepDepthBinLabel(2, 10)).toBe('outside');
    const paths = [
      path([1, 2, -1], [5], -1, { SweepDepth: 10, VolUnit_created: 12 }),   // 0.83: hit
      path([1, -1, -1], [3], -1, { SweepDepth: 9, VolUnit_created: 10 }),   // 0.9: miss
      path([1, 2, -1], [-1], -1, { SweepDepth: 20, VolUnit_created: 10 }),  // 2.0: hit
    ];
    const rows = conditionalHitRate(paths);
    expect(rows.map((r) => [r.bin, r.n])).toEqual([['[0.3,0.5)', 0], ['[0.5,0.75)', 0], ['[0.75,1)', 2], ['[1,1.5)', 0], ['[1.5,2.5]', 1]]);
    expect([rows[2]!.HitRate, rows[4]!.HitRate, rows[2]!.HitRate_0]).toEqual([0.5, 1, 1 / 3]);
  });
});

describe('targetValidation per fold (Spec §6.2)', () => {
  it('train plateau per fold, OOS cell at that pair, pooled test table, stability share', () => {
    const folds: Fold[] = [
      { foldId: 0, trainStart: 0, trainEnd: 10, testStart: 10, testEnd: 15 },
      { foldId: 1, trainStart: 5, trainEnd: 15, testStart: 15, testEnd: 20 },
    ];
    const paths = [
      path([1, 2, 3], [-1], -1, {}, 1), path([1, 2, -1], [4], -1, {}, 6), path([1, -1, -1], [2], -1, {}, 12),
      path([-1, -1, -1], [1], -1, {}, 16), path([1, 2, 3], [-1], -1, {}, 30),
    ];
    const tv = targetValidation(paths, folds, { TargetMults: [1, 2, 3], StopMults: [1], TargetUnits: [1] }, 1);
    expect(tv.folds.map((f) => [f.trainTrades, f.testTrades])).toEqual([[2, 1], [2, 1]]);
    expect(tv.folds[0]!.plateau).toMatchObject({ TargetMult: 2, StopMult: 1, cells: 1 });  // train Expectancy: 2 best
    expect(tv.folds[0]!.oos).toMatchObject({ TargetMult: 2, StopMult: 1, n: 1, HitRate: 0 });
    expect(tv.pooledTest.find((c) => c.TargetMult === 1)!.n).toBe(2);                    // the trade at 30 is in no test window
    expect(tv.stability).toMatchObject({ folds: 2 });
    expect(tv.twoStage).toHaveLength(3);
    expect(tv.conditional).toHaveLength(5);
    expect(tv.byTargetUnits).toHaveLength(1);
  });
});

describe('VolUnit-scaled table (A-137)', () => {
  it('HitRate_0 = mean S_u/(TargetUnits + S_u) with S_u = StopMult·SweepDepth/VolUnit_created; per-fold VolUnit plateau and stability', () => {
    const folds: Fold[] = [{ foldId: 0, trainStart: 0, trainEnd: 10, testStart: 10, testEnd: 20 }];
    const p = (TriggerTime: number, SweepDepth: number, firstTU: number, firstS: number) => path([-1, -1, -1], [firstS], -1,
      { TargetUnits: [1], firstTUIdx: Int32Array.of(firstTU), SweepDepth, VolUnit_created: 10 }, TriggerTime);
    const paths = [p(1, 10, 2, -1), p(2, 5, -1, 3), p(12, 20, 1, 4)];
    const tv = targetValidation(paths, folds, { TargetMults: [1, 2, 3], StopMults: [1], TargetUnits: [1] }, 1);
    const [cell] = tv.byTargetUnits;
    expect(cell!.n).toBe(1);                                                            // pooled test = the trade at 12
    expect(cell!.HitRate_0).toBeCloseTo(2 / 3, 12);                                     // S_u = 2 ⇒ 2/(1 + 2)
    expect(tv.folds[0]!.unitsPlateau).toMatchObject({ TargetUnits: 1, StopMult: 1 });
    expect(tv.folds[0]!.unitsOos).toMatchObject({ TargetUnits: 1, StopMult: 1, n: 1, HitRate: 1 });
    expect(tv.unitsStability).toEqual({ TargetUnits: 1, StopMult: 1, share: 1, folds: 1 });
  });
});
