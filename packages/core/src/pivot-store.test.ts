import { describe, expect, it } from 'vitest';
import type { ExcursionFeatures } from './features.js';
import type { GateResult, PivotClass } from './gates.js';
import { PivotStore } from './pivot-store.js';
import type { Pivot, Side } from './types.js';

function pivot(pivotId: number, side: Side, price: number, confirmedVol = pivotId * 10): Pivot {
  return {
    kind: side === 1 ? 'PivotHigh' : 'PivotLow', side, price, time: pivotId * 1000, seq: pivotId,
    confirmed_at: pivotId * 1000 + 500, confirmedSeq: pivotId, confirmedVol, pivotId,
  };
}

function gate(cls: PivotClass, classifiedAt: number): GateResult {
  return { cls, failed: cls === 'SlowExtreme' ? ['G2'] : [], classifiedAt };
}

const f = {
  SpikeSize: 2, ApproachVolume: 10, RejectVolume: 11, ApproachDuration: 0.5, RejectDuration: 0.6, ApproachSpeed: 1,
  RejectSpeed: 1.2, SpeedAsymmetry: 0.18, ApproachImbalance: 0.3, RejectImbalance: 0.4, VolumeBurst: 1.1, TopDwell: 0.2,
  RetraceFraction: 0.7, MaxTradeSize: 2, MaxAggressorRun: 5, MaxPrintGap: 0.1, EnterTime: 100, ExitTime: 200, Anchor: 90,
  BandEdge: 95, retraceAvailableAt: 300,
} satisfies ExcursionFeatures;

describe('PivotStore (Spec §3.8)', () => {
  it('countNear: tolerance edges inclusive, same side only, Unresolved excluded', () => {
    const s = new PivotStore();
    s.add(pivot(0, 1, 100), f, gate('WickLevel', 1), null, NaN, NaN);
    s.add(pivot(1, 1, 105), null, gate('SlowExtreme', 2), null, NaN, NaN);
    s.add(pivot(2, 1, 106), null, gate('BurstPivot', 3), null, NaN, NaN);
    s.add(pivot(3, 1, 104), null, gate('Unresolved', 4), null, NaN, NaN, -1, 'noEnter');
    s.add(pivot(4, -1, 103), f, gate('WickLevel', 5), null, NaN, NaN);
    expect(s.countNear(1, 103, 3, 0, 99)).toBe(3);        // 100, 106 (edges) and 105; 104 is Unresolved
    expect(s.countNear(1, 103, 2, 0, 99)).toBe(1);        // 105 only
    expect(s.countNear(-1, 103, 0, 0, 99)).toBe(1);
    expect(s.countNear(-1, 104, 0, 0, 99)).toBe(0);
  });

  it('countNear: minVol window and beforePivotId', () => {
    const s = new PivotStore();
    for (let id = 0; id < 5; id++) s.add(pivot(id, 1, 100, id * 10), f, gate('WickLevel', id), null, NaN, NaN);
    expect(s.countNear(1, 100, 0, 0, 99)).toBe(5);
    expect(s.countNear(1, 100, 0, 20, 99)).toBe(3);       // confirmedVol 20, 30, 40
    expect(s.countNear(1, 100, 0, 20, 3)).toBe(1);        // …and pivotId < 3
  });

  it('rows follow resolution order; byId / iterate by classifiedAt', () => {
    const s = new PivotStore();
    s.add(pivot(2, 1, 100), null, gate('Unresolved', 10), null, NaN, NaN, -1, 'noEnter');
    s.add(pivot(0, 1, 101), f, gate('WickLevel', 20), new Float64Array(13).fill(0.5), 0.5, NaN, 7);
    s.add(pivot(1, -1, 99), f, gate('WickLevel', 30), null, NaN, NaN);
    expect(s.byId(0)).toMatchObject({ cls: 'WickLevel', levelId: 7, WickStrength_0: 0.5, features: f });
    expect(s.byId(0)!.ranks).toHaveLength(13);
    expect(s.byId(2)).toMatchObject({ cls: 'Unresolved', note: 'noEnter', features: null, featuresAvailable: false });
    expect(s.byId(5)).toBeUndefined();
    expect([...s.iterate('WickLevel', 0, 100)].map((r) => r.pivot.pivotId)).toEqual([0, 1]);
    expect([...s.iterate('WickLevel', 21, 30)].map((r) => r.pivot.pivotId)).toEqual([]);
    expect(() => s.add(pivot(0, 1, 1), null, gate('SlowExtreme', 40), null, NaN, NaN)).toThrow();
  });

  it('updateFeatures completes an early-G2 SlowExtreme, keeping class and classifiedAt', () => {
    const s = new PivotStore();
    s.add(pivot(0, 1, 100), null, gate('SlowExtreme', 10), null, NaN, NaN);
    s.updateFeatures(0, f, ['G2', 'G5'], null, NaN, NaN);
    expect(s.byId(0)).toMatchObject({ cls: 'SlowExtreme', classifiedAt: 10, failed: ['G2', 'G5'], features: f, featuresAvailable: true });
  });

  it('setLevelOutcome records survivorship state', () => {
    const s = new PivotStore();
    s.add(pivot(0, 1, 100), f, gate('WickLevel', 1), null, NaN, NaN);
    s.setLevelOutcome(0, 'INVALIDATED', 'breakout');
    expect(s.byId(0)).toMatchObject({ finalState: 'INVALIDATED', reason: 'breakout' });
  });

  it('setLevelId links a registered level; Merged pivots are stored, counted as touches and iterable by class', () => {
    const s = new PivotStore();
    s.add(pivot(0, 1, 100), f, gate('WickLevel', 1), null, 0.7, NaN);
    s.setLevelId(0, 4);
    s.add(pivot(1, 1, 102), null, gate('Merged', 2), null, NaN, NaN, 4);
    expect(s.byId(0)!.levelId).toBe(4);
    expect(s.byId(1)).toMatchObject({ cls: 'Merged', levelId: 4, featuresAvailable: false });
    expect(s.countNear(1, 101, 1, 0, 99)).toBe(2);
    expect([...s.iterate('Merged', 0, 10)].map((r) => r.pivot.pivotId)).toEqual([1]);
  });

  it('VolUnit_created / availableVol columns; at(row) in classification order', () => {
    const s = new PivotStore();
    s.add(pivot(1, 1, 100), f, gate('WickLevel', 20), null, NaN, NaN, -1, null, 12, 345);
    s.add(pivot(0, -1, 90), null, gate('SlowExtreme', 10), null, NaN, NaN);
    expect(s.at(0)).toMatchObject({ pivot: { pivotId: 1 }, VolUnit_created: 12, availableVol: 345 });
    expect(s.at(1).pivot.pivotId).toBe(0);
    expect([s.at(1).VolUnit_created, s.at(1).availableVol]).toEqual([NaN, NaN]);
    expect(s.snapshot()[0]).toMatchObject({ VolUnit_created: 12, availableVol: 345 });
    expect(() => s.at(2)).toThrow();
    expect(() => s.at(-1)).toThrow();
  });

  it('never evicts; grows past its initial capacity', () => {
    const s = new PivotStore();
    for (let id = 0; id < 5000; id++) s.add(pivot(id, id % 2 === 0 ? 1 : -1, 1000 + (id % 7)), f, gate('WickLevel', id), null, NaN, NaN);
    expect(s.size).toBe(5000);
    expect(s.byId(0)!.pivot.price).toBe(1000);
    expect(s.byId(4999)!.features).toEqual(f);
    let expected = 0;
    for (let id = 0; id < 5000; id++) if (id % 2 === 0 && id % 7 === 3) expected++;
    expect(s.countNear(1, 1003, 0, 0, 5000)).toBe(expected);
  });
});
