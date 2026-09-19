import { describe, expect, it } from 'vitest';
import { BucketHistory } from './buckets.js';
import { VolUnit } from './volunit.js';

function historyWithRanges(ranges: readonly number[]): BucketHistory {
  const h = new BucketHistory();
  for (const r of ranges) {
    h.append({
      dayIndex: 0, tOpen: 0, tClose: 1, volOpen: 0, volClose: 1, High_k: 1000 + r, Low_k: 1000, Imbalance_k: 0,
      Vwap_k: 1000, Count_k: 1, targetVolume: 1, maxPrintGap_k: 0,
    });
  }
  return h;
}

describe('VolUnit', () => {
  it('takes the median of the last UnitWindow bucket ranges, rounded up', () => {
    const ranges = [...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 60 }, (_, i) => i + 1)];
    const h = historyWithRanges(ranges);
    const vu = new VolUnit(60);
    // median of 1..60 = 30.5 → 31; the 10 older ranges of 1000 are outside the window.
    expect(vu.refresh(h, 69, 1, 1)).toBe(31);
    expect(vu.VolUnit_now).toBe(31);
  });

  it('floors at 4·Tick', () => {
    const h = historyWithRanges(Array.from({ length: 60 }, () => 2));
    expect(new VolUnit().refresh(h, 59, 3, 1)).toBe(12);
  });

  it('floors at 3·SpreadEst_t', () => {
    const h = historyWithRanges(Array.from({ length: 60 }, () => 2));
    expect(new VolUnit().refresh(h, 59, 1, 7)).toBe(21);
  });

  it('uses the available buckets before UnitWindow have closed', () => {
    const h = historyWithRanges([10, 20, 30]);
    expect(new VolUnit().refresh(h, 2, 1, 1)).toBe(20);
  });
});
