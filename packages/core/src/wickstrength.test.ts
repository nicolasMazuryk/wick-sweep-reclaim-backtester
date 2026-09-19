import { describe, expect, it } from 'vitest';
import type { ExcursionFeatures } from './features.js';
import { SortedWindow } from './stats-util.js';
import {
  FEATURE_COUNT, featureVector, MinRankPivots, RankWindows, sigmoid, STAGE_A_WEIGHTS, stageAScore, type StageBModel, stageBScore,
} from './wickstrength.js';

function vec(v: number): Float64Array {
  return new Float64Array(FEATURE_COUNT).fill(v);
}

describe('SortedWindow rank counts', () => {
  it('countLess / countLessOrEqual with ties and eviction', () => {
    const w = new SortedWindow(4);
    for (const x of [3, 1, 3, 2]) w.push(x);
    expect([w.countLess(3), w.countLessOrEqual(3)]).toEqual([2, 4]);
    expect([w.countLess(0), w.countLessOrEqual(9)]).toEqual([0, 4]);
    w.push(5);                                  // evicts the first 3
    expect(w.toArray()).toEqual([1, 3, 2, 5]);
    expect([w.countLess(3), w.countLessOrEqual(3)]).toEqual([2, 3]);
  });
});

describe('RankWindows (Spec §3.7.2)', () => {
  it('rank = (#< + ½#= + ½)/(n+1) with ties (hand values)', () => {
    const rw = new RankWindows(500);
    // 50 values: 0 ×10, 1 ×20, 2 ×20.
    for (let i = 0; i < 50; i++) rw.insert(vec(i < 10 ? 0 : i < 30 ? 1 : 2));
    const out = new Float64Array(FEATURE_COUNT);
    expect(rw.ranks(vec(1), out)).toBe(true);
    expect(out[0]).toBeCloseTo((10 + 0.5 * 20 + 0.5) / 51, 15);
    expect(rw.ranks(vec(-1), out)).toBe(true);
    expect(out[5]).toBeCloseTo(0.5 / 51, 15);
    expect(rw.ranks(vec(3), out)).toBe(true);
    expect(out[12]).toBeCloseTo(50.5 / 51, 15);
  });

  it(`undefined below MinRankPivots = ${MinRankPivots}`, () => {
    const rw = new RankWindows(500);
    const out = new Float64Array(FEATURE_COUNT).fill(-7);
    for (let i = 0; i < MinRankPivots - 1; i++) rw.insert(vec(i));
    expect(rw.ranks(vec(1), out)).toBe(false);
    expect(out[0]).toBe(-7);
    rw.insert(vec(0));
    expect(rw.ranks(vec(1), out)).toBe(true);
  });

  it('evicts beyond RankWindow (oldest first)', () => {
    const rw = new RankWindows(60);
    for (let i = 0; i < 100; i++) rw.insert(vec(i));
    expect(rw.size).toBe(60);
    expect(rw.snapshot()[0]).toEqual(Array.from({ length: 60 }, (_, i) => 40 + i));
    const out = new Float64Array(FEATURE_COUNT);
    rw.ranks(vec(40), out);
    expect(out[0]).toBeCloseTo(1 / 61, 15);    // 0 below, 1 equal
  });
});

describe('Stage A (Spec §3.7.3)', () => {
  it('weights sum to 1.00; zero on ApproachImbalance, MaxPrintGap, PriorTouches, SpikeSize/RVol', () => {
    expect(STAGE_A_WEIGHTS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
    expect([4, 10, 11, 12].map((j) => STAGE_A_WEIGHTS[j])).toEqual([0, 0, 0, 0]);
  });

  it('all-0.5 ranks → 0.5; TopDwell enters as 1 − rank', () => {
    expect(stageAScore(vec(0.5))).toBeCloseTo(0.5, 15);
    const high = vec(0.5);
    high[6] = 0.9;
    expect(stageAScore(high)).toBeCloseTo(0.5 - 0.1 * 0.4, 15);
    const top = vec(1);
    top[6] = 0;
    expect(stageAScore(top)).toBeCloseTo(1, 15);
  });
});

describe('featureVector (Spec §3.7.1)', () => {
  const f = {
    SpikeSize: 2, RejectSpeed: Math.E, SpeedAsymmetry: 0.3, RejectImbalance: 0.4, ApproachImbalance: 0.5,
    VolumeBurst: 1.5, TopDwell: 0.2, RetraceFraction: 0.7, MaxTradeSize: 3, MaxAggressorRun: 4, MaxPrintGap: 0.25,
  } as ExcursionFeatures;

  it('13 features in spec order', () => {
    const out = featureVector(f, 2, 4, new Float64Array(FEATURE_COUNT));
    expect(Array.from(out)).toEqual([2, 1, 0.3, 0.4, 0.5, 1.5, 0.2, 0.7, 3, 4, 0.25, 2, 0.5]);
  });

  it('undefined / zero RVol → SpikeSize/RVol = 0 (never NaN in a rank window)', () => {
    expect(featureVector(f, 0, NaN, new Float64Array(FEATURE_COUNT))[12]).toBe(0);
    expect(featureVector(f, 0, 0, new Float64Array(FEATURE_COUNT))[12]).toBe(0);
  });
});

describe('Stage B score (Spec §3.7.4)', () => {
  it('σ(β0 + Σ β_j (2·rank_j − 1)) against a hand computation', () => {
    const beta = new Float64Array(FEATURE_COUNT);
    beta[0] = 2;
    beta[3] = -1;
    beta[12] = 0.5;
    const m: StageBModel = {
      foldId: 0, beta0: -0.25, beta, lambda: 1, ipwModel: { gamma0: 0, gamma: new Float64Array(FEATURE_COUNT) }, minStrengthQuantile: NaN,
      calibration: [],
    };
    const ranks = vec(0.5);
    ranks[0] = 0.75;                            // z = 0.5
    ranks[3] = 0.25;                            // z = −0.5
    ranks[12] = 1;                              // z = 1
    const eta = -0.25 + 2 * 0.5 - 1 * -0.5 + 0.5 * 1;
    expect(stageBScore(m, ranks)).toBeCloseTo(1 / (1 + Math.exp(-eta)), 15);
    expect(stageBScore({ ...m, beta: new Float64Array(FEATURE_COUNT), beta0: 0 }, ranks)).toBe(0.5);
  });

  it('sigmoid does not overflow at the tails', () => {
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-30) + sigmoid(30)).toBeCloseTo(1, 15);
  });
});
