import type { BucketHistory } from './buckets.js';
import { ceilTicksConservative } from './numerics.js';
import { medianOf, SortedWindow } from './stats-util.js';
import type { Ticks } from './types.js';

// Spec §3.3, §2.3:
// VolUnit_now = ceil(max(median(High_j − Low_j : j ∈ [k−UnitWindow+1, k]), 4·Tick, 3·SpreadEst_t)),
// the median taken over the buckets available when fewer than UnitWindow exist (A-53).
export class VolUnit {
  private readonly scratch: Float64Array;
  // Ranges of buckets [lastK − UnitWindow + 1, lastK] of `source`, sorted:
  // consecutive closes push one range instead of re-selecting the median.
  private readonly ranges: SortedWindow;
  private source: BucketHistory | null = null;
  private lastK = -1;
  private current: Ticks = NaN;

  constructor(readonly UnitWindow = 60) {
    this.scratch = new Float64Array(UnitWindow);
    this.ranges = new SortedWindow(UnitWindow);
  }

  get VolUnit_now(): Ticks { return this.current; }

  refresh(buckets: BucketHistory, k: number, Tick: Ticks, SpreadEst_t: Ticks): Ticks {
    const from = Math.max(buckets.oldestK, k - this.UnitWindow + 1);
    let medianRange: number;
    if (buckets === this.source && k === this.lastK + 1 && from === Math.max(0, k - this.UnitWindow + 1)) {
      this.ranges.push(buckets.High_k(k) - buckets.Low_k(k));
      medianRange = this.ranges.median();                  // same value as medianOf over the window
    } else {
      let len = 0;
      this.ranges.reset();
      for (let j = from; j <= k; j++) {
        const range = buckets.High_k(j) - buckets.Low_k(j);
        this.scratch[len++] = range;
        this.ranges.push(range);
      }
      medianRange = len === 0 ? 0 : medianOf(this.scratch, len);
      // The window is exact only when it starts at k − UnitWindow + 1 (or 0); otherwise rebuild next time.
      this.source = from === Math.max(0, k - this.UnitWindow + 1) ? buckets : null;
    }
    this.lastK = k;
    this.current = ceilTicksConservative(Math.max(medianRange, 4 * Tick, 3 * SpreadEst_t));
    return this.current;
  }

  snapshot(): { VolUnit_now: Ticks } {
    return { VolUnit_now: this.current };
  }

  reset(): void {
    this.current = NaN;
    this.source = null;
    this.lastK = -1;
    this.ranges.reset();
  }
}
