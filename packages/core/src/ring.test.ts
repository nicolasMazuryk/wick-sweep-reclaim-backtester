import { describe, expect, it } from 'vitest';
import { RingEvicted, TradeRing } from './ring.js';
import type { MergedEvent, Side } from './types.js';

function ev(i: number): MergedEvent {
  return { t: 1000 + i * 10, seq: i, p: 100 + i, q: 1 + (i % 3), s: (i % 2 === 0 ? 1 : -1) as Side, n: 1 };
}

// Pushes events 0..count-1 with cumulative Vol and bucketK = floor(i / perBucket).
function filled(capacity: number, count: number, perBucket = 4): TradeRing {
  const ring = new TradeRing(capacity);
  let Vol = 0;
  for (let i = 0; i < count; i++) {
    const e = ev(i);
    Vol += e.q;
    ring.push(e, Vol, Math.floor(i / perBucket));
  }
  return ring;
}

describe('TradeRing', () => {
  it('rejects a capacity that is not a power of two', () => {
    expect(() => new TradeRing(12)).toThrow(/power of two/);
  });

  it('wraps around, keeping absolute indices monotone', () => {
    const ring = filled(8, 20);
    expect(ring.size).toBe(8);
    expect(ring.oldestIndex).toBe(12);
    expect(ring.newestIndex).toBe(19);
    expect(ring.at(12).p).toBe(112);
    expect(ring.at(19).seq).toBe(19);
    expect(ring.at(15).s).toBe(-1);
    expect(ring.at(15).bucketK).toBe(3);
  });

  it('throws RingEvicted below the oldest index and RangeError past the newest', () => {
    const ring = filled(8, 20);
    expect(() => ring.at(11)).toThrow(RingEvicted);
    expect(() => ring.at(20)).toThrow(RangeError);
  });

  it('indexAtVol: before oldest, exact hit, between values, past newest', () => {
    const ring = filled(8, 20);
    const vols = Array.from({ length: 8 }, (_, j) => ring.at(12 + j).Vol);
    expect(ring.indexAtVol(0)).toBe(12);
    expect(ring.indexAtVol(vols[3]!)).toBe(15);
    expect(ring.indexAtVol(vols[3]! + 0.5)).toBe(16);
    expect(ring.indexAtVol(vols[7]! + 1)).toBe(20);
  });

  it('indexAtTime: before oldest, exact hit, between values, past newest', () => {
    const ring = filled(8, 20);
    expect(ring.indexAtTime(0)).toBe(12);
    expect(ring.indexAtTime(1000 + 14 * 10)).toBe(14);
    expect(ring.indexAtTime(1000 + 14 * 10 + 1)).toBe(15);
    expect(ring.indexAtTime(1000 + 19 * 10 + 1)).toBe(20);
  });

  it('lastBefore / firstAfter are strict and return -1 when nothing matches', () => {
    const ring = filled(8, 20);
    expect(ring.lastBefore(16, (e) => e.p <= 113)).toBe(13);
    expect(ring.lastBefore(16, (e) => e.p < 100)).toBe(-1);
    expect(ring.lastBefore(13, (e) => e.p === 113)).toBe(-1);
    expect(ring.firstAfter(14, (e) => e.p >= 117)).toBe(17);
    expect(ring.firstAfter(14, (e) => e.p > 1000)).toBe(-1);
    expect(ring.firstAfter(17, (e) => e.p === 117)).toBe(-1);
  });

  it('window returns subarray views when contiguous', () => {
    const ring = filled(8, 5);
    const w = ring.window(1, 4);
    expect(w.length).toBe(3);
    expect(Array.from(w.p)).toEqual([101, 102, 103]);
    expect(w.p.buffer).toBe(ring.pCol.buffer);
  });

  it('window copies when the range wraps', () => {
    const ring = filled(8, 12);
    const w = ring.window(6, 11);
    expect(w.length).toBe(5);
    expect(Array.from(w.p)).toEqual([106, 107, 108, 109, 110]);
    expect(Array.from(w.seq)).toEqual([6, 7, 8, 9, 10]);
    expect(w.p.buffer).not.toBe(ring.pCol.buffer);
  });

  it('window rejects evicted ranges', () => {
    const ring = filled(8, 12);
    expect(() => ring.window(2, 6)).toThrow(RingEvicted);
    expect(ring.window(5, 5).length).toBe(0);
  });

  it('grow() doubles capacity, preserves indices and data, and keeps evicted indices evicted', () => {
    const ring = filled(8, 12);
    ring.grow();
    expect(ring.capacity).toBe(16);
    expect(ring.oldestIndex).toBe(4);
    expect(ring.newestIndex).toBe(11);
    for (let i = 4; i < 12; i++) {
      expect(ring.at(i).p).toBe(100 + i);
    }
    expect(() => ring.at(3)).toThrow(RingEvicted);
    let Vol = ring.at(11).Vol;
    for (let i = 12; i < 20; i++) {
      Vol += ev(i).q;
      ring.push(ev(i), Vol, 0);
    }
    expect(ring.oldestIndex).toBe(4);
    expect(ring.at(4).p).toBe(104);
    expect(ring.at(19).p).toBe(119);
  });

  it('completedBucketsHeld excludes a partially evicted oldest bucket', () => {
    const whole = filled(16, 12, 4);   // buckets 0,1,2 all held
    expect(whole.completedBucketsHeld(3)).toBe(3);
    const partial = filled(8, 14, 4);  // oldest index 6 is mid-bucket 1
    expect(partial.completedBucketsHeld(3)).toBe(1);
    expect(new TradeRing(8).completedBucketsHeld(5)).toBe(0);
  });

  it('capacityFor is at least 2^21 and a power of two covering 2·UnitWindow buckets twice', () => {
    expect(TradeRing.capacityFor(60, 1000, 1)).toBe(2 ** 21);
    expect(TradeRing.capacityFor(60, 1_000_000, 1)).toBe(2 ** 28);
  });

  it('reset empties the ring', () => {
    const ring = filled(8, 12);
    ring.reset();
    expect(ring.size).toBe(0);
    expect(ring.newestIndex).toBe(-1);
  });
});
