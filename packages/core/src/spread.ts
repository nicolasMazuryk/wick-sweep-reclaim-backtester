import { ceilTicksConservative } from './numerics.js';
import { medianOf } from './stats-util.js';
import type { Side, Ticks } from './types.js';

const MIN_SAMPLES = 50;
const RECOMPUTE_EVERY = 100;
const HIST_SIZE = 1024;                   // gaps below this are also counted in a histogram

// Spec §3.3, A-8. Keeps the last `eventWindow` price gaps |p_i − p_{i−1}| at
// aggressor-side changes. The candidate median is recomputed at most every
// 100 events; the published `value` changes only in `refresh`, which the
// engine calls on bucket close.
export class SpreadEst {
  private readonly gaps: Int32Array;
  private readonly scratch: Float64Array;
  // Counts of the held gaps < HIST_SIZE and of the larger ones: the median is
  // read off the histogram unless a large gap is held (Spec §10).
  private readonly hist = new Int32Array(HIST_SIZE);
  private large = 0;
  private head = 0;
  private count = 0;
  private pPrev: Ticks = 0;
  private sPrev = 0;
  private sinceRecompute = 0;
  private candidate = NaN;
  private published: Ticks = NaN;

  constructor(readonly eventWindow = 500) {
    this.gaps = new Int32Array(eventWindow);
    this.scratch = new Float64Array(eventWindow);
  }

  get samples(): number { return this.count; }
  // Last refreshed value; NaN before the first refresh.
  get value(): Ticks { return this.published; }

  onPrint(p: Ticks, s: Side): void {
    if (this.sPrev !== 0 && s !== this.sPrev) {
      if (this.count === this.eventWindow) this.countGap(this.gaps[this.head]!, -1);
      this.gaps[this.head] = Math.abs(p - this.pPrev);
      this.countGap(this.gaps[this.head]!, 1);                              // the stored (Int32) value
      this.head = (this.head + 1) % this.eventWindow;
      if (this.count < this.eventWindow) this.count++;
    }
    this.pPrev = p;
    this.sPrev = s;
    this.sinceRecompute++;
    if (this.sinceRecompute >= RECOMPUTE_EVERY) {
      this.recompute();
    }
  }

  private recompute(): void {
    this.sinceRecompute = 0;
    if (this.count < MIN_SAMPLES) {
      this.candidate = NaN;
      return;
    }
    if (this.large === 0) {
      this.candidate = this.histMedian();
      return;
    }
    for (let i = 0; i < this.count; i++) this.scratch[i] = this.gaps[i]!;
    this.candidate = medianOf(this.scratch, this.count);
  }

  private countGap(gap: number, by: 1 | -1): void {
    if (gap >= 0 && gap < HIST_SIZE) this.hist[gap]! += by;
    else this.large += by;
  }

  // medianOf over the held gaps (all < HIST_SIZE): value of rank n>>1, or
  // the mean of ranks n/2 − 1 and n/2 for even n (A-49).
  private histMedian(): number {
    const n = this.count;
    const upper = n >> 1;
    let lowerValue = NaN;
    let seen = 0;
    for (let v = 0; v < HIST_SIZE; v++) {
      seen += this.hist[v]!;
      if (Number.isNaN(lowerValue) && seen >= upper) lowerValue = v;         // rank upper − 1
      if (seen > upper) return n % 2 === 1 ? v : (lowerValue + v) / 2;
    }
    return NaN;
  }

  // Publishes the latest candidate: ceil (A-49), floored at Tick; Tick below 50 samples.
  refresh(Tick: Ticks): Ticks {
    this.published = Number.isNaN(this.candidate) ? Tick : Math.max(Tick, ceilTicksConservative(this.candidate));
    return this.published;
  }

  snapshot(): { samples: number; candidate: number; value: Ticks } {
    return { samples: this.count, candidate: this.candidate, value: this.published };
  }

  reset(): void {
    this.hist.fill(0);
    this.large = 0;
    this.head = 0;
    this.count = 0;
    this.pPrev = 0;
    this.sPrev = 0;
    this.sinceRecompute = 0;
    this.candidate = NaN;
    this.published = NaN;
  }
}
