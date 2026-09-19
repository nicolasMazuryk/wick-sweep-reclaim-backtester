import type { Lots, MergedEvent, Ms, Side, Ticks } from './types.js';

// A merged event as stored in the ring, plus the two ring-only columns. The
// object handed out by `TradeRing.at` is a reused cursor (no per-print
// allocation, Spec §10): it is valid only until the next `at`/`push` call.
export interface MergedEventView extends MergedEvent {
  readonly index: number;               // absolute ring index
  readonly Vol: Lots;                   // cumulative Vol after this event
  readonly bucketK: number;             // bucket the event was assigned to
}

// Typed-array columns over the half-open absolute index range [iFrom, iTo).
// Subarrays of the ring when contiguous, copies into scratch when wrapped;
// valid until the next push.
export interface RingWindow {
  readonly t: Float64Array; readonly seq: Float64Array; readonly p: Int32Array; readonly q: Float64Array;
  readonly s: Int8Array; readonly n: Int32Array; readonly Vol: Float64Array; readonly bucketK: Int32Array;
  readonly length: number;
}

export class RingEvicted extends Error {
  constructor(index: number, oldestIndex: number) {
    super(`TradeRing: index ${index} evicted (oldest held ${oldestIndex})`);
    this.name = 'RingEvicted';
  }
}

const MIN_CAPACITY = 2 ** 21;

function nextPowerOfTwo(x: number): number {
  let result = 1;
  while (result < x) {
    result *= 2;
  }
  return result;
}

class RingCursor implements MergedEventView {
  slot = 0;
  index = 0;
  constructor(private readonly ring: TradeRing) {}
  get t(): Ms { return this.ring.tCol[this.slot]!; }
  get seq(): number { return this.ring.seqCol[this.slot]!; }
  get p(): Ticks { return this.ring.pCol[this.slot]!; }
  get q(): Lots { return this.ring.qCol[this.slot]!; }
  get s(): Side { return this.ring.sCol[this.slot] as Side; }
  get n(): number { return this.ring.nCol[this.slot]!; }
  get Vol(): Lots { return this.ring.volCol[this.slot]!; }
  get bucketK(): number { return this.ring.bucketKCol[this.slot]!; }
}

// Spec §3.1. Bounded history of merged events; absolute indices are monotone
// and never wrap, slot = index & mask.
export class TradeRing {
  /** @internal */ tCol!: Float64Array;
  /** @internal */ seqCol!: Float64Array;
  /** @internal */ pCol!: Int32Array;
  /** @internal */ qCol!: Float64Array;
  /** @internal */ sCol!: Int8Array;
  /** @internal */ nCol!: Int32Array;
  /** @internal */ volCol!: Float64Array;
  /** @internal */ bucketKCol!: Int32Array;
  private mask = 0;
  private pushed = 0;
  private evictedBelow = 0;               // indices below this were evicted before a grow()
  private readonly cursor = new RingCursor(this);

  constructor(capacity: number) {
    if (capacity < 1 || nextPowerOfTwo(capacity) !== capacity) {
      throw new Error(`TradeRing: capacity ${capacity} must be a power of two`);
    }
    this.allocate(capacity);
  }

  // Spec §3.1: holds ≥ 2·UnitWindow buckets of volume, at least 2^21 events.
  static capacityFor(UnitWindow: number, BucketVolume_0: Lots, medianEventSize_0: Lots): number {
    const needed = 2 * Math.ceil((2 * UnitWindow * BucketVolume_0) / Math.max(medianEventSize_0, 1));
    return nextPowerOfTwo(Math.max(MIN_CAPACITY, needed));
  }

  private allocate(capacity: number): void {
    this.tCol = new Float64Array(capacity);
    this.seqCol = new Float64Array(capacity);
    this.pCol = new Int32Array(capacity);
    this.qCol = new Float64Array(capacity);
    this.sCol = new Int8Array(capacity);
    this.nCol = new Int32Array(capacity);
    this.volCol = new Float64Array(capacity);
    this.bucketKCol = new Int32Array(capacity);
    this.mask = capacity - 1;
  }

  get capacity(): number { return this.mask + 1; }
  get size(): number { return this.pushed - this.oldestIndex; }        // events held (fewer than capacity after grow())
  get oldestIndex(): number { return Math.max(this.evictedBelow, this.pushed - this.capacity); }
  get newestIndex(): number { return this.pushed - 1; }

  push(e: MergedEvent, volAfter: Lots, bucketK: number): number {
    const index = this.pushed;
    const slot = index & this.mask;
    this.tCol[slot] = e.t;
    this.seqCol[slot] = e.seq;
    this.pCol[slot] = e.p;
    this.qCol[slot] = e.q;
    this.sCol[slot] = e.s;
    this.nCol[slot] = e.n;
    this.volCol[slot] = volAfter;
    this.bucketKCol[slot] = bucketK;
    this.pushed = index + 1;
    return index;
  }

  private checkIndex(i: number): void {
    if (i < this.oldestIndex) {
      throw new RingEvicted(i, this.oldestIndex);
    }
    if (i > this.newestIndex) {
      throw new RangeError(`TradeRing: index ${i} not yet pushed (newest ${this.newestIndex})`);
    }
  }

  at(i: number): MergedEventView {
    this.checkIndex(i);
    this.cursor.slot = i & this.mask;
    this.cursor.index = i;
    return this.cursor;
  }

  // First live index whose column value is ≥ x; newestIndex+1 if none.
  private lowerBound(col: Float64Array, x: number): number {
    let lo = this.oldestIndex;
    let hi = this.pushed;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (col[mid & this.mask]! < x) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  indexAtVol(Vol: Lots): number { return this.lowerBound(this.volCol, Vol); }
  indexAtTime(t: Ms): number { return this.lowerBound(this.tCol, t); }

  // Last index strictly before i (within the live span) satisfying pred; -1 if none.
  lastBefore(i: number, pred: (view: MergedEventView) => boolean): number {
    const stop = this.oldestIndex;
    for (let j = Math.min(i - 1, this.newestIndex); j >= stop; j--) {
      if (pred(this.at(j))) {
        return j;
      }
    }
    return -1;
  }

  // First index strictly after i satisfying pred; -1 = not yet observed.
  firstAfter(i: number, pred: (view: MergedEventView) => boolean): number {
    for (let j = Math.max(i + 1, this.oldestIndex); j <= this.newestIndex; j++) {
      if (pred(this.at(j))) {
        return j;
      }
    }
    return -1;
  }

  // Last index strictly before i (within the live span) with sign·p ≤ boundN;
  // -1 if none. `lastBefore` without a predicate closure (Spec §10).
  lastAtOrBelow(i: number, sign: Side, boundN: Ticks): number {
    const stop = this.oldestIndex;
    for (let j = Math.min(i - 1, this.newestIndex); j >= stop; j--) {
      if (sign * this.pCol[j & this.mask]! <= boundN) {
        return j;
      }
    }
    return -1;
  }

  // Column reads by absolute index for hot loops, without the per-call
  // subarrays of `window` (Spec §10). Unchecked: validate the span once with
  // `checkSpan`; valid until the next push.
  checkSpan(iFrom: number, iTo: number): void {
    if (iTo < iFrom) {
      throw new RangeError(`TradeRing.checkSpan: iTo ${iTo} < iFrom ${iFrom}`);
    }
    if (iTo > iFrom) {
      this.checkIndex(iFrom);
      this.checkIndex(iTo - 1);
    }
  }

  tAt(i: number): Ms { return this.tCol[i & this.mask]!; }
  pAt(i: number): Ticks { return this.pCol[i & this.mask]!; }
  qAt(i: number): Lots { return this.qCol[i & this.mask]!; }
  sAt(i: number): Side { return this.sCol[i & this.mask] as Side; }
  volAt(i: number): Lots { return this.volCol[i & this.mask]!; }

  window(iFrom: number, iTo: number): RingWindow {
    if (iTo < iFrom) {
      throw new RangeError(`TradeRing.window: iTo ${iTo} < iFrom ${iFrom}`);
    }
    if (iTo === iFrom) {
      return this.sliceColumns(0, 0);
    }
    this.checkIndex(iFrom);
    this.checkIndex(iTo - 1);
    const slotFrom = iFrom & this.mask;
    const length = iTo - iFrom;
    if (slotFrom + length <= this.capacity) {
      return this.sliceColumns(slotFrom, length);
    }
    return this.copyWrapped(slotFrom, length);
  }

  private sliceColumns(slotFrom: number, length: number): RingWindow {
    const end = slotFrom + length;
    return {
      t: this.tCol.subarray(slotFrom, end), seq: this.seqCol.subarray(slotFrom, end),
      p: this.pCol.subarray(slotFrom, end), q: this.qCol.subarray(slotFrom, end),
      s: this.sCol.subarray(slotFrom, end), n: this.nCol.subarray(slotFrom, end),
      Vol: this.volCol.subarray(slotFrom, end), bucketK: this.bucketKCol.subarray(slotFrom, end),
      length,
    };
  }

  private copyWrapped(slotFrom: number, length: number): RingWindow {
    const headLength = this.capacity - slotFrom;
    const tailLength = length - headLength;
    function join<T extends Float64Array | Int32Array | Int8Array>(col: T, out: T): T {
      out.set(col.subarray(slotFrom), 0);
      out.set(col.subarray(0, tailLength), headLength);
      return out;
    }
    return {
      t: join(this.tCol, new Float64Array(length)), seq: join(this.seqCol, new Float64Array(length)),
      p: join(this.pCol, new Int32Array(length)), q: join(this.qCol, new Float64Array(length)),
      s: join(this.sCol, new Int8Array(length)), n: join(this.nCol, new Int32Array(length)),
      Vol: join(this.volCol, new Float64Array(length)), bucketK: join(this.bucketKCol, new Int32Array(length)),
      length,
    };
  }

  // Number of completed buckets (k < currentK) whose events are all still held.
  // The oldest held bucket counts only if nothing has been evicted yet, since
  // otherwise its earliest events may be gone.
  completedBucketsHeld(currentK: number): number {
    if (this.pushed === 0) {
      return 0;
    }
    const oldestK = this.bucketKCol[this.oldestIndex & this.mask]!;
    const held = this.oldestIndex === 0 ? currentK - oldestK : currentK - oldestK - 1;
    return Math.max(0, held);
  }

  // Doubles capacity, preserving absolute indices and contents (Spec §3.1 underflow).
  grow(): void {
    const oldCols = [this.tCol, this.seqCol, this.pCol, this.qCol, this.sCol, this.nCol, this.volCol, this.bucketKCol];
    const oldMask = this.mask;
    const oldest = this.oldestIndex;
    this.evictedBelow = oldest;
    this.allocate(this.capacity * 2);
    const newCols = [this.tCol, this.seqCol, this.pCol, this.qCol, this.sCol, this.nCol, this.volCol, this.bucketKCol];
    for (let c = 0; c < oldCols.length; c++) {
      const from = oldCols[c]!;
      const to = newCols[c]!;
      for (let i = oldest; i < this.pushed; i++) {
        to[i & this.mask] = from[i & oldMask]!;
      }
    }
  }

  snapshot(): { capacity: number; pushed: number; oldestIndex: number; newestIndex: number } {
    return { capacity: this.capacity, pushed: this.pushed, oldestIndex: this.oldestIndex, newestIndex: this.newestIndex };
  }

  reset(): void {
    this.pushed = 0;
    this.evictedBelow = 0;
  }
}
