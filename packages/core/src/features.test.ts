import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ExcursionFeaturesTracker, type FeatureConfig, type FeatureContext, type PivotResolution } from './features.js';
import { TradeRing } from './ring.js';
import type { FrozenStats } from './stats.js';
import type { Lots, MergedEvent, Pivot, Side } from './types.js';

const cfg: FeatureConfig = {
  MinSpikeSize: 1.5, MaxSpikeDuration: 3, MinRejectSpeed: 0.5, MinRejectImbalance: 0.2, MinRetrace: 0.6, MaxTopDwell: 0.5,
  BandWidthMult: 0.5, AnchorWindow: 20, RetraceWindow: 5, TopBandMult: 0.15, UnitWindow: 60,
};

// VolUnit 10 ⇒ BandEdge = price − 5, TopDwell band 2 ticks; BucketVolume 10
// ⇒ RetraceWindow = 50 lots, MaxSpikeDuration = 30 lots, PendingLimit = 950 lots.
function frozen(BurstFlag = false): FrozenStats {
  return {
    k: 0, SpreadEst_t: 1, VolUnit_now: 10, RVol_5: 0.001, RVol_60: 0.001, VolRatio: 1, TrendEfficiency: 0, TrendSign: 0,
    BurstFlag, LiquidityGuard: false, PivotReversal: 12, eventSizeP99: 2, eventSizeP10: 1, volumeDay: 0,
  };
}

interface Row { p: number; q: number; s: Side }

// Minimal engine loop (Spec §3.10 steps 2k, 3, 7, 8) over a stub context.
class Driver {
  readonly ring = new TradeRing(256);
  readonly ctx: { Vol: Lots; BucketVolume: Lots; ExpectedVolPerMs: Float64Array; frozen: FrozenStats; lastVwap: number } = {
    Vol: 0, BucketVolume: 10, ExpectedVolPerMs: new Float64Array(24).fill(0.001), frozen: frozen(), lastVwap: 100,
  };
  readonly out: PivotResolution[] = [];
  readonly tracker: ExcursionFeaturesTracker;
  readonly events: MergedEvent[] = [];
  private k = 0;

  constructor(readonly side: Side = 1, config: FeatureConfig = cfg, private readonly mirror = 0) {
    this.tracker = new ExcursionFeaturesTracker(config, this.ring, this.ctx as FeatureContext, (r) => this.out.push(r));
  }

  // `close`: this print closes the open bucket (with `BurstFlag`).
  print(row: Row, opts: { close?: boolean; BurstFlag?: boolean; confirm?: number } = {}): MergedEvent {
    const i = this.events.length;
    const e: MergedEvent = {
      t: 1000 * i, seq: i, p: this.mirror ? this.mirror - row.p : row.p, q: row.q, s: this.mirror ? (-row.s as Side) : row.s, n: 1,
    };
    this.events.push(e);
    this.ctx.Vol += e.q;
    const k = this.k;
    if (opts.close) {
      this.ctx.frozen = frozen(opts.BurstFlag ?? false);
      this.tracker.onBucketClose(k);
      this.k++;
    }
    this.ring.push(e, this.ctx.Vol, k);
    if (opts.confirm !== undefined) this.tracker.open(this.pivotAt(opts.confirm));
    this.tracker.onPrint(e);
    return e;
  }

  pivotAt(iPiv: number): Pivot {
    const pe = this.events[iPiv]!;
    const conf = this.events[this.events.length - 1]!;
    return {
      kind: this.side === 1 ? 'PivotHigh' : 'PivotLow', side: this.side, price: pe.p, time: pe.t, seq: pe.seq,
      confirmed_at: conf.t, confirmedSeq: conf.seq, confirmedVol: this.ctx.Vol, pivotId: iPiv,
    };
  }
}

// The 10-print excursion (Side = +1). Vol after each print: 2 3 5 8 10 11 13 14 17 19.
const EXCURSION: Row[] = [
  { p: 100, q: 2, s: -1 },   // 0  Anchor window
  { p: 98, q: 1, s: -1 },    // 1  Anchor = 98
  { p: 110, q: 2, s: 1 },    // 2
  { p: 114, q: 3, s: 1 },    // 3  iIn (last p ≤ BandEdge 115 before the pivot)
  { p: 117, q: 2, s: 1 },    // 4
  { p: 120, q: 1, s: 1 },    // 5  iPiv, pivot price 120
  { p: 118, q: 2, s: -1 },   // 6
  { p: 116, q: 1, s: -1 },   // 7
  { p: 113, q: 3, s: -1 },   // 8  iOut, vol[iOut] = 17 ⇒ retrace limit 67
  { p: 108, q: 2, s: -1 },   // 9  confirming print
];
// Retrace tail: Vol 24, 34, 54, then print 13.
const TAIL: Row[] = [{ p: 105, q: 5, s: -1 }, { p: 110, q: 10, s: 1 }, { p: 104, q: 20, s: -1 }];

// Prints 0–13 (print 13 = `last`); bucket 0 closes on print `closeAt`, the
// pivot (print 5) is confirmed on print `confirmAt`.
function runFixture(d: Driver, last: Row = { p: 106, q: 13, s: 1 }, closeAt = 10, confirmAt = 9): void {
  [...EXCURSION, ...TAIL, last].forEach((row, i) => d.print(row, { close: i === closeAt, confirm: i === confirmAt ? 5 : undefined }));
}

describe('ExcursionFeatures hand-computed fixture (Spec §3.5)', () => {
  it('every feature of the 10-print excursion, WickLevel at retrace finality', () => {
    const d = new Driver();
    runFixture(d);
    expect(d.out).toHaveLength(1);
    const r = d.out[0]!;
    expect(r.gate).toEqual({ cls: 'WickLevel', failed: [], classifiedAt: 13_000 });
    expect(r.phase).toBe('complete');
    expect(r.featuresAvailable).toBe(true);
    expect(r.exitVol).toBe(17);
    expect(r.resolvedVol).toBe(67);
    const f = r.features!;
    expect({ BandEdge: f.BandEdge, Anchor: f.Anchor, EnterTime: f.EnterTime, ExitTime: f.ExitTime, retraceAvailableAt: f.retraceAvailableAt })
      .toEqual({ BandEdge: 115, Anchor: 98, EnterTime: 3000, ExitTime: 8000, retraceAvailableAt: 13_000 });
    expect(f.SpikeSize).toBeCloseTo(2.2, 12);                       // (120 − 98) / 10
    expect(f.ApproachVolume).toBe(6);                               // q[3..5]
    expect(f.RejectVolume).toBe(7);                                 // q[5..8]
    expect(f.ApproachDuration).toBeCloseTo(0.3, 12);                // (11 − 8) / 10
    expect(f.RejectDuration).toBeCloseTo(0.6, 12);                  // (17 − 11) / 10
    expect(f.ApproachSpeed).toBeCloseTo(5 / 3, 12);                 // 5 / (10 · 0.3)
    expect(f.RejectSpeed).toBeCloseTo(5 / 6, 12);                   // 5 / (10 · 0.6)
    expect(f.SpeedAsymmetry).toBeCloseTo(Math.log(0.5), 12);
    expect(f.ApproachImbalance).toBeCloseTo(1, 12);                 // +(3 + 2 + 1) / 6
    expect(f.RejectImbalance).toBeCloseTo(5 / 7, 12);               // −(1 − 2 − 1 − 3) / 7
    expect(f.VolumeBurst).toBeCloseTo(13 / 5, 12);                  // 13 / (5000 ms · 0.001)
    expect(f.TopDwell).toBeCloseTo(0.3, 12);                        // q at 120 and 118 / 10
    expect(f.RetraceFraction).toBeCloseTo(16 / 22, 12);             // (120 − 104) / (120 − 98)
    expect(f.MaxTradeSize).toBeCloseTo(1.5, 12);                    // 3 / eventSizeP99 2
    expect(f.MaxAggressorRun).toBe(3);                              // s over [5..8]: + − − −
    expect(f.MaxPrintGap).toBeCloseTo(0.3, 12);                     // 3 / 10
    expect(r.VolUnit_created).toBe(10);
    expect(r.rvolTicks).toBeCloseTo(0.1, 15);
  });

  it('retrace finality boundary: a print landing exactly on the limit is included', () => {
    const d = new Driver();
    runFixture(d, { p: 100, q: 13, s: -1 });                        // Vol 67 = limit
    expect(d.out[0]!.features!.RetraceFraction).toBeCloseTo(20 / 22, 12);
    expect(d.out[0]!.gate.classifiedAt).toBe(13_000);
  });

  it('retrace finality boundary: a print overshooting the limit is excluded but finalises', () => {
    const d = new Driver();
    runFixture(d, { p: 100, q: 14, s: -1 });                        // Vol 68 > limit
    expect(d.out[0]!.features!.RetraceFraction).toBeCloseTo(16 / 22, 12);
    expect(d.out[0]!.gate.classifiedAt).toBe(13_000);
  });

  it('waits for the confirmation bucket to close before a gate verdict', () => {
    const d = new Driver();
    runFixture(d, undefined, 99);                                   // no close through print 13
    expect(d.out).toHaveLength(0);
    d.print({ p: 106, q: 1, s: 1 });
    expect(d.out).toHaveLength(0);
    d.print({ p: 106, q: 1, s: 1 }, { close: true });
    expect(d.out[0]!.gate).toMatchObject({ cls: 'WickLevel', classifiedAt: 15_000 });
    expect(d.out[0]!.features!.retraceAvailableAt).toBe(13_000);
  });

  it('catch-up: ExitTime and retrace before confirmation ⇒ classified at confirmed_at, not earlier', () => {
    const d = new Driver();
    runFixture(d, undefined, 13, 13);                               // confirmed on print 13, which closes its bucket
    expect(d.out[0]!.gate).toMatchObject({ cls: 'WickLevel', classifiedAt: 13_000 });
    expect(d.out[0]!.features!.ExitTime).toBe(8000);
    const late = new Driver();
    EXCURSION.forEach((row) => late.print(row));
    [...TAIL, { p: 106, q: 13, s: 1 } as Row].forEach((row) => late.print(row));
    late.print({ p: 107, q: 1, s: 1 }, { confirm: 5, close: true }); // retrace final on 13, confirmed on 14
    expect(late.out[0]!.gate).toMatchObject({ cls: 'WickLevel', classifiedAt: 14_000 });
    expect(late.out[0]!.features!.retraceAvailableAt).toBe(14_000);
  });

  it('iIn = −1 ⇒ Unresolved(noEnter) at confirmed_at', () => {
    const d = new Driver();
    [118, 119, 120, 117, 110].forEach((p, i) => d.print({ p, q: 1, s: 1 }, { confirm: i === 4 ? 2 : undefined }));
    expect(d.out).toEqual([expect.objectContaining({
      gate: { cls: 'Unresolved', failed: [], classifiedAt: 4000 }, note: 'noEnter', features: null, featuresAvailable: false,
    })]);
    expect(d.tracker.pendingCount).toBe(0);
  });

  it('early G2 verdict at the first print where ApproachDuration + (Vol − vol[iPiv])/BV > MaxSpikeDuration', () => {
    const d = new Driver();
    EXCURSION.slice(0, 6).forEach((row) => d.print(row));
    d.print({ p: 118, q: 10, s: -1 }, { confirm: 5 });              // Vol 21: 0.3 + 1.0
    d.print({ p: 119, q: 10, s: 1 });                               // Vol 31: 0.3 + 2.0
    expect(d.out).toHaveLength(0);
    d.print({ p: 117, q: 8, s: -1 });                               // Vol 39: 0.3 + 2.8 > 3
    expect(d.out).toEqual([expect.objectContaining({
      gate: { cls: 'SlowExtreme', failed: ['G2'], classifiedAt: 8000 }, phase: 'classified', features: null,
    })]);
    d.print({ p: 113, q: 1, s: -1 }, { close: true });              // iOut, Vol 40 ⇒ limit 90
    d.print({ p: 112, q: 50, s: -1 });                              // Vol 90: final
    expect(d.out).toHaveLength(2);
    const r = d.out[1]!;
    expect(r.phase).toBe('featuresFinal');
    expect(r.gate.classifiedAt).toBe(8000);
    expect(r.gate.cls).toBe('SlowExtreme');
    expect(r.gate.failed).toContain('G2');
    expect(r.features!.RejectDuration).toBeCloseTo(2.9, 12);        // (40 − 11) / 10
    expect(r.features!.retraceAvailableAt).toBe(10_000);
  });

  it('PendingLimit without iOut ⇒ SlowExtreme(featuresAvailable=false)', () => {
    const d = new Driver(1, { ...cfg, MaxSpikeDuration: 1e9 });
    EXCURSION.slice(0, 6).forEach((row) => d.print(row));
    d.print({ p: 118, q: 1, s: -1 }, { confirm: 5, close: true });  // confirmedVol 12
    d.print({ p: 118, q: 950, s: -1 });                             // Vol − confirmedVol = 950: not yet
    expect(d.out).toHaveLength(0);
    d.print({ p: 119, q: 1, s: 1 });
    expect(d.out).toEqual([expect.objectContaining({
      gate: { cls: 'SlowExtreme', failed: [], classifiedAt: 8000 }, note: 'pendingLimit', featuresAvailable: false, features: null,
    })]);
  });

  it('PendingLimit after an early G2 verdict completes the record without features', () => {
    const d = new Driver();
    EXCURSION.slice(0, 6).forEach((row) => d.print(row));
    d.print({ p: 118, q: 1, s: -1 }, { confirm: 5, close: true });
    d.print({ p: 118, q: 100, s: -1 });
    expect(d.out.map((r) => r.phase)).toEqual(['classified']);
    d.print({ p: 118, q: 900, s: -1 });
    expect(d.out.map((r) => [r.phase, r.note, r.gate.classifiedAt])).toEqual([['classified', null, 7000], ['featuresFinal', 'pendingLimit', 7000]]);
  });

  it('burst close inside the excursion ⇒ BurstPivot at confirmed_at', () => {
    const d = new Driver();
    EXCURSION.forEach((row, i) => d.print(row, { close: i === 6, BurstFlag: i === 6, confirm: i === 9 ? 5 : undefined }));
    expect(d.out).toEqual([expect.objectContaining({ gate: { cls: 'BurstPivot', failed: [], classifiedAt: 9000 } })]);
  });

  it('burst close before EnterTime is ignored', () => {
    const d = new Driver();
    EXCURSION.forEach((row, i) => d.print(row, { close: i === 2 || i === 9, BurstFlag: i === 2, confirm: i === 9 ? 5 : undefined }));
    TAIL.forEach((row) => d.print(row));
    d.print({ p: 106, q: 13, s: 1 });
    expect(d.out[0]!.gate.cls).toBe('WickLevel');
  });

  it('burst on the bucket containing confirmed_at ⇒ BurstPivot when that bucket closes', () => {
    const d = new Driver();
    EXCURSION.forEach((row, i) => d.print(row, { confirm: i === 9 ? 5 : undefined }));
    d.print(TAIL[0]!);
    expect(d.out).toHaveLength(0);
    d.print(TAIL[1]!, { close: true, BurstFlag: true });
    expect(d.out).toEqual([expect.objectContaining({ gate: { cls: 'BurstPivot', failed: [], classifiedAt: 11_000 }, features: null })]);
  });

  it('burst after the confirmation bucket (beyond vol[iOut]) is ignored', () => {
    const d = new Driver();
    runFixture(d, { p: 106, q: 3, s: 1 });                           // Vol 57 < limit: still pending
    d.print({ p: 106, q: 1, s: 1 }, { close: true, BurstFlag: true });
    d.print({ p: 106, q: 20, s: 1 });
    expect(d.out[0]!.gate.cls).toBe('WickLevel');
  });

  it('side −1 mirror (p → 2c − p, s → −s) gives identical features', () => {
    const up = new Driver();
    runFixture(up);
    const down = new Driver(-1, cfg, 1000);
    runFixture(down);
    const fu = up.out[0]!.features!;
    const fd = down.out[0]!.features!;
    expect({ ...fd, Anchor: 1000 - fd.Anchor, BandEdge: 1000 - fd.BandEdge }).toEqual(fu);
    expect(down.out[0]!.gate).toEqual(up.out[0]!.gate);
  });
});

describe('ExcursionFeatures properties', () => {
  // Random excursion around a pivot: an up leg to the pivot, then a random
  // walk down; pivots opened at a random confirmation print. The mirrored path
  // with side −1 must give identical features, classes and times.
  const pathArb = fc.record({
    up: fc.array(fc.record({ dp: fc.integer({ min: 0, max: 4 }), q: fc.integer({ min: 1, max: 5 }) }), { minLength: 3, maxLength: 20 }),
    down: fc.array(fc.record({ dp: fc.integer({ min: -4, max: 2 }), q: fc.integer({ min: 1, max: 12 }), s: fc.constantFrom<Side>(1, -1) }), { minLength: 1, maxLength: 60 }),
    confirmAfter: fc.nat(40),
    closeEvery: fc.integer({ min: 2, max: 9 }),
    burstAt: fc.option(fc.nat(80), { nil: undefined }),
  });

  it('property: mirrored excursion ⇒ identical features and classes', () => {
    fc.assert(fc.property(pathArb, ({ up, down, confirmAfter, closeEvery, burstAt }) => {
      const run = (side: Side): PivotResolution[] => {
        const d = new Driver(side, cfg, side === 1 ? 0 : 10_000);
        let p = 1000;
        const rows: Row[] = up.map((u) => ({ p: (p += u.dp), q: u.q, s: 1 as Side }));
        const iPiv = rows.reduce((best, r, i) => (r.p >= rows[best]!.p ? i : best), 0);
        p = rows[iPiv]!.p;
        rows.push(...down.map((x) => ({ p: (p += x.dp), q: x.q, s: x.s })));
        const confirm = Math.min(rows.length - 1, iPiv + 1 + confirmAfter);
        rows.forEach((row, i) => d.print(row, {
          close: i % closeEvery === closeEvery - 1 || i === burstAt, BurstFlag: i === burstAt, confirm: i === confirm ? iPiv : undefined,
        }));
        return d.out;
      };
      const a = run(1);
      const b = run(-1);
      expect(b.map((r) => r.gate)).toEqual(a.map((r) => r.gate));
      expect(b.map((r) => r.features && { ...r.features, Anchor: 10_000 - r.features.Anchor, BandEdge: 10_000 - r.features.BandEdge }))
        .toEqual(a.map((r) => r.features));
      for (const r of a) {
        expect(r.gate.classifiedAt).toBeGreaterThanOrEqual(r.pivot.confirmed_at);
        if (r.gate.cls === 'WickLevel') {
          expect(r.gate.classifiedAt).toBeGreaterThanOrEqual(r.features!.retraceAvailableAt);
          expect(r.resolvedVol - r.exitVol).toBeGreaterThanOrEqual(cfg.RetraceWindow * 10);
        }
      }
    }), { seed: 5, numRuns: 300 });
  });
});
