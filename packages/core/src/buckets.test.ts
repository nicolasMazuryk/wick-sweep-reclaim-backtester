import { describe, expect, it } from 'vitest';
import { BucketBuilder, BucketHistory, MS_PER_DAY, utcDay, volumeDay } from './buckets.js';
import type { MergedEvent, Side } from './types.js';

const MIN = 60_000;
const HOUR = 3_600_000;

let seq = 0;
function ev(t: number, p: number, q: number, s: Side = 1): MergedEvent {
  return { t, seq: seq++, p, q, s, n: 1 };
}

// One print per minute for minutes [0, 60) of the stream (first print at t0)
// with size q → first-day BucketVolume = q, first bucket opens at t0 + 60 min.
function bootstrapped(q: number, t0 = 0, p = 100): BucketBuilder {
  const b = new BucketBuilder();
  for (let m = 0; m < 60; m++) {
    expect(b.onPrint(ev(t0 + m * MIN, p, q))).toBe(-1);
  }
  return b;
}

describe('BucketBuilder bootstrap (A-6)', () => {
  it('closes no bucket in the first 60 minutes, whatever the volume', () => {
    const b = new BucketBuilder();
    for (let i = 0; i < 600; i++) {
      expect(b.onPrint(ev(i * 5_999, 100, 1_000_000))).toBe(-1);
    }
    expect(b.completedCount).toBe(0);
    expect(b.inBootstrap).toBe(true);
  });

  it('sets BucketVolume from the first-hour 60-s median and opens the first bucket at minute 61', () => {
    const b = bootstrapped(10);
    expect(b.BucketVolume_next).toBeNaN();
    expect(b.onPrint(ev(60 * MIN, 100, 4))).toBe(-1);
    expect(b.inBootstrap).toBe(false);
    expect(b.BucketVolume).toBe(10);
  });

  it('counts empty first-hour windows as 0 and floors BucketVolume at 1 lot', () => {
    const b = new BucketBuilder();
    b.onPrint(ev(0, 100, 50));
    b.onPrint(ev(60 * MIN, 100, 1));
    expect(b.BucketVolume).toBe(1);
  });
});

describe('BucketBuilder update rule (Spec §3.2.1)', () => {
  it('closes on SumQ ≥ BucketVolume with the whole event (overshoot allowed)', () => {
    const b = bootstrapped(10);
    const volBefore = b.Vol;
    expect(b.onPrint(ev(60 * MIN, 100, 4, 1))).toBe(-1);
    expect(b.onPrint(ev(60 * MIN + 10, 102, 4, -1))).toBe(-1);
    expect(b.onPrint(ev(60 * MIN + 250, 99, 5, 1))).toBe(0);
    const k0 = b.history.completed(0);
    expect(k0).toMatchObject({
      k: 0, dayIndex: 0, tOpen: 60 * MIN, tClose: 60 * MIN + 250, volOpen: volBefore, volClose: volBefore + 13,
      High_k: 102, Low_k: 99, Imbalance_k: 4 - 4 + 5, Count_k: 3, WallDuration_k: 250, targetVolume: 10,
    });
    expect(k0.Vwap_k).toBeCloseTo((100 * 4 + 102 * 4 + 99 * 5) / 13, 12);
    // The next print opens bucket 1.
    expect(b.onPrint(ev(60 * MIN + 300, 100, 10))).toBe(1);
    expect(b.history.volOpen(1)).toBe(volBefore + 13);
  });

  it('closes exactly at SumQ == BucketVolume', () => {
    const b = bootstrapped(10);
    expect(b.onPrint(ev(60 * MIN, 100, 6))).toBe(-1);
    expect(b.onPrint(ev(60 * MIN + 1, 100, 4))).toBe(0);
  });

  it('maxPrintGap_k is the largest |p_i − p_{i−1}|, including the gap into the bucket\'s first print', () => {
    const b = bootstrapped(10, 0, 100);
    b.onPrint(ev(60 * MIN, 105, 3));
    b.onPrint(ev(60 * MIN + 1, 103, 3));
    b.onPrint(ev(60 * MIN + 2, 104, 4));
    expect(b.history.maxPrintGap_k(0)).toBe(5);
  });

  it('exposes no open-bucket statistics', () => {
    const b = bootstrapped(10);
    b.onPrint(ev(60 * MIN, 100, 4));
    expect(() => b.history.High_k(0)).toThrow(/not closed/);
    expect('current' in b).toBe(false);
  });

  it('Vwap accumulation is overflow-safe: equals the exact rational for p·q near 2^61', () => {
    const b = bootstrapped(3_000_000_000, 0, 1_073_741_000);
    const prints: Array<[number, number]> = [
      [1_073_741_000, 1_500_000_001],
      [1_073_741_003, 1_400_000_003],
      [1_073_740_999, 1_600_000_007],
    ];
    let closedK = -1;
    prints.forEach(([p, q], i) => { closedK = b.onPrint(ev(60 * MIN + i, p, q)); });
    expect(closedK).toBe(0);
    let num = 0n;
    let den = 0n;
    for (const [p, q] of prints) {
      num += BigInt(p) * BigInt(q);
      den += BigInt(q);
    }
    const exact = Number(num / den) + Number(num % den) / Number(den);
    expect(Math.abs(b.history.Vwap_k(0) - exact)).toBeLessThan(1e-6);
  });

  it('BucketVolume_next applies at the next bucket open, not mid-bucket (A-5)', () => {
    const b = bootstrapped(10);
    b.onPrint(ev(60 * MIN, 100, 4));
    // Day 1: day 0's 60-s median is 0 (only the first hour traded) → floor 1.
    expect(b.onPrint(ev(MS_PER_DAY + 1, 100, 4))).toBe(-1);
    expect(b.BucketVolume_next).toBe(1);
    expect(b.BucketVolume).toBe(10);
    expect(b.onPrint(ev(MS_PER_DAY + 2, 100, 3))).toBe(0);
    expect(b.history.targetVolume(0)).toBe(10);
    expect(b.history.dayIndex(0)).toBe(1);
    expect(b.onPrint(ev(MS_PER_DAY + 3, 100, 1))).toBe(1);
    expect(b.history.targetVolume(1)).toBe(1);
  });
});

describe('BucketBuilder daily BucketVolume (Spec §3.2.2)', () => {
  it('is the median over every 60-s window of the prior day, empty windows counting as 0', () => {
    const b = new BucketBuilder();
    for (let m = 0; m < 720; m++) b.onPrint(ev(m * MIN, 100, 6));
    b.onPrint(ev(MS_PER_DAY, 100, 1));
    // 720 windows of 6, 720 empty → (0 + 6) / 2.
    expect(b.BucketVolume_next).toBe(3);
    expect(b.daysConsumed).toBe(1);
  });

  it('skips a day without prints instead of counting it as zero volume', () => {
    const b = new BucketBuilder();
    for (let m = 0; m < 720; m++) b.onPrint(ev(m * MIN, 100, 6));
    b.onPrint(ev(2 * MS_PER_DAY, 100, 1));
    expect(b.BucketVolume_next).toBe(3);
  });

  it('uses only the previous 7 UTC days', () => {
    const b = new BucketBuilder();
    for (let m = 0; m < 1440; m++) b.onPrint(ev(m * MIN, 100, 50));
    for (let d = 1; d <= 7; d++) {
      for (let m = 0; m < 1440; m++) b.onPrint(ev(d * MS_PER_DAY + m * MIN, 100, 2));
    }
    b.onPrint(ev(8 * MS_PER_DAY, 100, 1));
    expect(b.BucketVolume_next).toBe(2);
    expect(b.daysConsumed).toBe(8);
  });

  it('excludes the stream\'s first-day minutes before its first print', () => {
    const b = new BucketBuilder();
    for (let m = 600; m < 1440; m++) b.onPrint(ev(m * MIN, 100, 4));
    b.onPrint(ev(MS_PER_DAY, 100, 1));
    expect(b.BucketVolume_next).toBe(4);
  });
});

describe('BucketBuilder hour-of-day profiles (Spec §4.2.3, A-15, A-34)', () => {
  it('Vol100ms[h] is the median of non-empty 100-ms slots, floored at 1; ExpectedVolPerMs is mean lots per ms', () => {
    const b = new BucketBuilder();
    // Hour 0: slots [0,100) → 1+1+1, [1000,1100) → 5, [2000,2100) → 8.
    b.onPrint(ev(0, 100, 1));
    b.onPrint(ev(10, 100, 1));
    b.onPrint(ev(20, 100, 1));
    b.onPrint(ev(1000, 100, 5));
    b.onPrint(ev(2000, 100, 8));
    // Hour 1: one slot of 2.
    b.onPrint(ev(HOUR + 50, 100, 2));
    b.onPrint(ev(MS_PER_DAY, 100, 1));
    expect(b.Vol100ms[0]).toBe(5);
    expect(b.Vol100ms[1]).toBe(2);
    expect(b.Vol100ms[2]).toBe(1);
    expect(b.ExpectedVolPerMs[0]).toBeCloseTo(16 / HOUR, 15);
    expect(b.ExpectedVolPerMs[2]).toBe(0);
  });
});

describe('BucketHistory', () => {
  it('evicts beyond capacity and refuses reads of evicted or open buckets', () => {
    const h = new BucketHistory(4);
    for (let i = 0; i < 6; i++) {
      h.append({
        dayIndex: 0, tOpen: i, tClose: i + 1, volOpen: i, volClose: i + 1, High_k: i, Low_k: i, Imbalance_k: 0,
        Vwap_k: i, Count_k: 1, targetVolume: 1, maxPrintGap_k: 0,
      });
    }
    expect(h.oldestK).toBe(2);
    expect(h.High_k(5)).toBe(5);
    expect(() => h.High_k(1)).toThrow(/evicted/);
    expect(() => h.High_k(6)).toThrow(/not closed/);
  });
});

describe('volumeDay (Spec §3.2.5)', () => {
  it('counts 1440-bucket days from the first post-warm-up bucket', () => {
    expect(volumeDay(10, -1)).toBe(-1);
    expect(volumeDay(99, 100)).toBe(-1);
    expect(volumeDay(100, 100)).toBe(0);
    expect(volumeDay(1539, 100)).toBe(0);
    expect(volumeDay(1540, 100)).toBe(1);
    expect(utcDay(MS_PER_DAY - 1)).toBe(0);
  });
});

describe('BucketBuilder reset', () => {
  it('returns to the pre-stream state', () => {
    const b = bootstrapped(10);
    b.onPrint(ev(60 * MIN, 100, 20));
    b.reset();
    expect(b.snapshot()).toMatchObject({ Vol: 0, completedCount: 0, dayIndex: -1, daysConsumed: 0 });
    expect(b.onPrint(ev(0, 100, 1))).toBe(-1);
    expect(b.inBootstrap).toBe(true);
  });
});
