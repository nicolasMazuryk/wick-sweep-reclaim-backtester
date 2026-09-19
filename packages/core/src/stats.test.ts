import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BucketBuilder, MS_PER_DAY } from './buckets.js';
import { ceilTicksConservative } from './numerics.js';
import { TradeRing } from './ring.js';
import { SpreadEst } from './spread.js';
import { BucketStats } from './stats.js';
import { percentileNearestRank } from './stats-util.js';
import type { MergedEvent, Side } from './types.js';

const MIN = 60_000;

// Spec §3.10 steps 2–4 for the modules built so far: BucketBuilder, then the
// bucket-close refresh, then TradeRing.push and SpreadEst.onPrint.
class Harness {
  readonly builder = new BucketBuilder();
  readonly spread = new SpreadEst();
  readonly ring: TradeRing;
  readonly stats: BucketStats;
  events = 0;
  private seq = 0;

  constructor(Tick = 1, PivotMult = 1.2, ringCapacity = 1 << 14) {
    this.ring = new TradeRing(ringCapacity);
    this.stats = new BucketStats({ Tick, PivotMult }, this.builder, this.spread);
  }

  print(t: number, p: number, q: number, s: Side): number {
    const e: MergedEvent = { t, seq: this.seq++, p, q, s, n: 1 };
    const closedK = this.builder.onPrint(e);
    if (closedK >= 0) {
      this.stats.onBucketClose(closedK, this.ring);
    }
    this.ring.push(e, this.builder.Vol, this.builder.lastEventBucketK);
    this.spread.onPrint(e.p, e.s);
    this.events++;
    return closedK;
  }
}

describe('BucketStats refresh order (Spec §3.2.6)', () => {
  // Prints every 10 s alternating 1000/1020 with alternating sides: every
  // side change has a 20-tick gap, bucket ranges are 20 ticks.
  function oscillating(h: Harness, until: number): number {
    let firstClose = -1;
    for (let i = 0; i * 10_000 < until; i++) {
      const k = h.print(i * 10_000, i % 2 === 0 ? 1000 : 1020, 1, i % 2 === 0 ? 1 : -1);
      if (k >= 0 && firstClose < 0) firstClose = k;
    }
    return firstClose;
  }

  it('VolUnit uses the fresh SpreadEst, BurstFlag the fresh VolUnit, PivotReversal both', () => {
    const h = new Harness(1, 1.2);
    expect(oscillating(h, 62 * MIN)).toBe(0);
    const f = h.stats.frozen;
    expect(f.SpreadEst_t).toBe(20);
    expect(f.VolUnit_now).toBe(60);                        // 3 · SpreadEst_t (stale Tick would give 20)
    expect(f.BurstFlag).toBe(false);                       // gap 20 > 3 · 4 (stale VolUnit) but ≤ 3 · 60
    expect(f.PivotReversal).toBe(72);                      // ceil(max(1.2 · 60, 3, 40))
  });

  it('every close satisfies the #6 and #8 formulas with same-close inputs', () => {
    const h = new Harness(2, 1.5);
    let prev = h.stats.frozen;
    let p = 5000;
    for (let i = 0; i < 20_000; i++) {
      p += ((i * 7919) % 13) - 6;
      const k = h.print(i * 1_000, p, 1 + ((i * 31) % 7), ((i * 17) % 3 === 0 ? 1 : -1));
      if (k < 0) continue;
      const f = h.stats.frozen;
      expect(f).not.toBe(prev);
      expect(f.PivotReversal).toBe(ceilTicksConservative(Math.max(1.5 * f.VolUnit_now, 3 * 2, 2 * f.SpreadEst_t)));
      expect(f.BurstFlag).toBe(f.VolRatio > 3 || h.builder.history.maxPrintGap_k(k) > 3 * f.VolUnit_now);
      expect(f.VolUnit_now).toBeGreaterThanOrEqual(Math.max(4 * 2, 3 * f.SpreadEst_t));
      prev = f;
    }
    expect(h.builder.completedCount).toBeGreaterThan(100);
  });

  it('eventSizeP99 / P10 are nearest-rank percentiles over every 16th ring event', () => {
    const h = new Harness(1, 1.2, 1 << 10);
    for (let i = 0; i < 5_000; i++) {
      const k = h.print(i * 1_000, 1000 + (i % 5), 1 + ((i * 37) % 101), i % 2 === 0 ? 1 : -1);
      if (k < 0) continue;
      const ring = h.ring;
      const sample: number[] = [];
      for (let j = Math.ceil(ring.oldestIndex / 16) * 16; j <= ring.newestIndex; j += 16) sample.push(ring.at(j).q);
      const arr = Float64Array.from(sample);
      expect(h.stats.frozen.eventSizeP99).toBe(percentileNearestRank(arr.slice(), arr.length, 0.99));
      expect(h.stats.frozen.eventSizeP10).toBe(percentileNearestRank(arr.slice(), arr.length, 0.1));
    }
  });

  it('eventSizeP99 / P10 stay exact across TradeRing.grow() and reset()', () => {
    const h = new Harness(1, 1.2, 1 << 8);
    // The close runs before the closing print is pushed: reference = ring as it was before the print.
    const print = (i: number, q: number, s: Side): void => {
      const sample: number[] = [];
      if (h.ring.size > 0) {
        for (let j = Math.ceil(h.ring.oldestIndex / 16) * 16; j <= h.ring.newestIndex; j += 16) sample.push(h.ring.at(j).q);
      }
      if (h.print(i * 1_000, 1000, q, s) < 0) return;
      const arr = Float64Array.from(sample);
      expect(h.stats.frozen.eventSizeP99).toBe(arr.length === 0 ? 0 : percentileNearestRank(arr.slice(), arr.length, 0.99));
      expect(h.stats.frozen.eventSizeP10).toBe(arr.length === 0 ? 0 : percentileNearestRank(arr.slice(), arr.length, 0.1));
    };
    for (let i = 0; i < 6_000; i++) {
      if (i === 1_500 || i === 3_000) h.ring.grow();
      print(i, 1 + ((i * 53) % 97), i % 2 === 0 ? 1 : -1);
    }
    h.stats.reset();
    h.ring.reset();
    for (let i = 6_000; i < 9_000; i++) print(i, 1 + ((i * 29) % 13), 1);
  });
});

describe('BucketStats warm-up (Spec §3.2.4) and volumeDay (Spec §3.2.5)', () => {
  it('gates on 7 consumed days and 1440 buckets, then counts volume-days from the next bucket', () => {
    const h = new Harness(1, 1.2);
    // One 1-lot print per minute → BucketVolume 1 → one bucket per print after the first hour.
    let t = 0;
    for (; t < 7 * MS_PER_DAY; t += MIN) {
      h.print(t, 1000 + ((t / MIN) % 7), 1, (t / MIN) % 2 === 0 ? 1 : -1);
      expect(h.stats.warmupConditionsMet(h.events)).toBe(false);
    }
    expect(h.builder.daysConsumed).toBe(6);
    expect(h.builder.completedCount).toBeGreaterThan(1440);
    const k = h.print(t, 1000, 1, 1);
    t += MIN;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(h.stats.warmupConditionsMet(h.events)).toBe(true);
    expect(h.stats.frozen.volumeDay).toBe(-1);
    h.stats.markWarmupEnd(k);
    for (let i = 1; i <= 1441; i++, t += MIN) {
      const closedK = h.print(t, 1000, 1, 1);
      expect(closedK).toBe(k + i);
      expect(h.stats.frozen.volumeDay).toBe(i <= 1440 ? 0 : 1);
    }
  });

  it('reset restores the initial frozen stats', () => {
    const h = new Harness(1, 1.2);
    for (let t = 0; t < 2 * 3_600_000; t += 1_000) h.print(t, 1000 + ((t / 1000) % 9), 1, 1);
    expect(h.stats.frozen.k).toBeGreaterThanOrEqual(0);
    h.stats.reset();
    expect(h.stats.frozen).toMatchObject({ k: -1, SpreadEst_t: 1, VolUnit_now: 4, PivotReversal: 5, volumeDay: -1 });
  });
});

interface Step { readonly dt: number; readonly dp: number; readonly q: number; readonly flip: boolean }

describe('Spec §9.1 L5', () => {
  it('property: bucketStatsFrozenMidBucket — frozen stats change only (and always) on bucket close', () => {
    let totalCloses = 0;
    const step = fc.record({
      dt: fc.integer({ min: 0, max: 30_000 }),
      dp: fc.integer({ min: -6, max: 6 }),
      q: fc.integer({ min: 1, max: 25 }),
      flip: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MS_PER_DAY - 1 }),
        fc.array(step, { minLength: 400, maxLength: 1_500 }),
        (startOffset: number, steps: Step[]) => {
          const h = new Harness(1, 1.2, 1 << 9);
          let t = 20_000 * MS_PER_DAY + startOffset;
          let p = 50_000;
          let s: Side = 1;
          for (const st of steps) {
            t += st.dt;
            p += st.dp;
            if (st.flip) s = s === 1 ? -1 : 1;
            const before = h.stats.frozen;
            const hashBefore = JSON.stringify(before);
            const spreadBefore = h.spread.value;
            const closedK = h.print(t, p, st.q, s);
            if (closedK < 0) {
              expect(h.stats.frozen).toBe(before);
              expect(JSON.stringify(h.stats.frozen)).toBe(hashBefore);
              expect(Object.is(h.spread.value, spreadBefore)).toBe(true);
            } else {
              totalCloses++;
              expect(h.stats.frozen).not.toBe(before);
              expect(h.stats.frozen.k).toBe(closedK);
              expect(Object.isFrozen(h.stats.frozen)).toBe(true);
            }
          }
        },
      ),
      { seed: 20260918, numRuns: 60 },
    );
    expect(totalCloses).toBeGreaterThan(1_000);
  });
});
