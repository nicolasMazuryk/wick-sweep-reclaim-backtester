import { medianOf } from './stats-util.js';
import type { Bucket, Lots, MergedEvent, Ms, Ticks } from './types.js';

export const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const SLOT_MS = 100;
const MINUTES_PER_DAY = 1440;
const HOURS_PER_DAY = 24;
const PROFILE_DAYS = 7;
const BOOTSTRAP_MINUTES = 60;
export const BUCKETS_PER_VOLUME_DAY = 1440;

export function utcDay(t: Ms): number {
  return Math.floor(t / MS_PER_DAY);
}

// Spec §3.2.5: volume-day of completed bucket k, counted from the first
// post-warm-up bucket `warmupEndK`; -1 while still in warm-up.
export function volumeDay(k: number, warmupEndK: number): number {
  if (warmupEndK < 0 || k < warmupEndK) {
    return -1;
  }
  return Math.floor((k - warmupEndK) / BUCKETS_PER_VOLUME_DAY);
}

// Completed buckets as a struct of typed arrays (Spec §3.2), ring of
// `capacity` = BucketHistory = 2·1440 by default. Reads of an evicted or a
// not-yet-closed bucket throw: the open bucket has no readable statistics.
export class BucketHistory {
  private readonly dayIndexCol: Int32Array;
  private readonly tOpenCol: Float64Array;
  private readonly tCloseCol: Float64Array;
  private readonly volOpenCol: Float64Array;
  private readonly volCloseCol: Float64Array;
  private readonly highCol: Int32Array;
  private readonly lowCol: Int32Array;
  private readonly imbalanceCol: Float64Array;
  private readonly vwapCol: Float64Array;
  private readonly countCol: Float64Array;
  private readonly targetVolumeCol: Float64Array;
  private readonly maxPrintGapCol: Int32Array;
  private closedCount = 0;

  constructor(readonly capacity: number = 2 * BUCKETS_PER_VOLUME_DAY) {
    this.dayIndexCol = new Int32Array(capacity);
    this.tOpenCol = new Float64Array(capacity);
    this.tCloseCol = new Float64Array(capacity);
    this.volOpenCol = new Float64Array(capacity);
    this.volCloseCol = new Float64Array(capacity);
    this.highCol = new Int32Array(capacity);
    this.lowCol = new Int32Array(capacity);
    this.imbalanceCol = new Float64Array(capacity);
    this.vwapCol = new Float64Array(capacity);
    this.countCol = new Float64Array(capacity);
    this.targetVolumeCol = new Float64Array(capacity);
    this.maxPrintGapCol = new Int32Array(capacity);
  }

  get completedCount(): number { return this.closedCount; }
  get oldestK(): number { return Math.max(0, this.closedCount - this.capacity); }
  has(k: number): boolean { return k >= this.oldestK && k < this.closedCount; }

  private slot(k: number): number {
    if (!this.has(k)) {
      throw new RangeError(
        k >= this.closedCount
          ? `BucketHistory: bucket ${k} is not closed (completed ${this.closedCount})`
          : `BucketHistory: bucket ${k} evicted (oldest held ${this.oldestK})`,
      );
    }
    return k % this.capacity;
  }

  dayIndex(k: number): number { return this.dayIndexCol[this.slot(k)]!; }
  tOpen(k: number): Ms { return this.tOpenCol[this.slot(k)]!; }
  tClose(k: number): Ms { return this.tCloseCol[this.slot(k)]!; }
  volOpen(k: number): Lots { return this.volOpenCol[this.slot(k)]!; }
  volClose(k: number): Lots { return this.volCloseCol[this.slot(k)]!; }
  High_k(k: number): Ticks { return this.highCol[this.slot(k)]!; }
  Low_k(k: number): Ticks { return this.lowCol[this.slot(k)]!; }
  Imbalance_k(k: number): Lots { return this.imbalanceCol[this.slot(k)]!; }
  Vwap_k(k: number): number { return this.vwapCol[this.slot(k)]!; }
  Count_k(k: number): number { return this.countCol[this.slot(k)]!; }
  WallDuration_k(k: number): Ms { const i = this.slot(k); return this.tCloseCol[i]! - this.tOpenCol[i]!; }
  targetVolume(k: number): Lots { return this.targetVolumeCol[this.slot(k)]!; }
  maxPrintGap_k(k: number): Ticks { return this.maxPrintGapCol[this.slot(k)]!; }

  // Allocating read for tests and snapshots.
  completed(k: number): Bucket {
    return {
      k, dayIndex: this.dayIndex(k), tOpen: this.tOpen(k), tClose: this.tClose(k),
      volOpen: this.volOpen(k), volClose: this.volClose(k), High_k: this.High_k(k), Low_k: this.Low_k(k),
      Imbalance_k: this.Imbalance_k(k), Vwap_k: this.Vwap_k(k), Count_k: this.Count_k(k),
      WallDuration_k: this.WallDuration_k(k), targetVolume: this.targetVolume(k), maxPrintGap_k: this.maxPrintGap_k(k),
    };
  }

  /** @internal */
  append(b: Omit<Bucket, 'k' | 'WallDuration_k'>): number {
    const k = this.closedCount;
    const i = k % this.capacity;
    this.dayIndexCol[i] = b.dayIndex;
    this.tOpenCol[i] = b.tOpen;
    this.tCloseCol[i] = b.tClose;
    this.volOpenCol[i] = b.volOpen;
    this.volCloseCol[i] = b.volClose;
    this.highCol[i] = b.High_k;
    this.lowCol[i] = b.Low_k;
    this.imbalanceCol[i] = b.Imbalance_k;
    this.vwapCol[i] = b.Vwap_k;
    this.countCol[i] = b.Count_k;
    this.targetVolumeCol[i] = b.targetVolume;
    this.maxPrintGapCol[i] = b.maxPrintGap_k;
    this.closedCount = k + 1;
    return k;
  }

  reset(): void {
    this.closedCount = 0;
  }
}

// Per-UTC-day volume profile feeding the daily BucketVolume (Spec §3.2.2) and
// the hour-of-day Vol100ms / ExpectedVolPerMs profiles (Spec §4.2.3, A-15, A-34).
class DayProfile {
  readonly minuteVol = new Float64Array(MINUTES_PER_DAY);
  readonly hourVol = new Float64Array(HOURS_PER_DAY);
  slotVol = new Float64Array(4096);        // volume of each non-empty 100-ms slot
  slotHour = new Uint8Array(4096);
  slotCount = 0;
  // Set by `complete()`: the slot volumes grouped by hour, hour h at [hourStart[h], hourStart[h + 1]).
  bySlotHour: Float64Array | null = null;
  readonly hourStart = new Int32Array(HOURS_PER_DAY + 1);

  // firstMinute > 0 only on the stream's first day: minutes before the first
  // print are outside the data, not empty (A-51).
  constructor(readonly dayIndex: number, readonly firstMinute: number) {}

  addSlot(volume: Lots, hour: number): void {
    if (this.slotCount === this.slotVol.length) {
      const volumes = new Float64Array(this.slotVol.length * 2);
      volumes.set(this.slotVol);
      this.slotVol = volumes;
      const hours = new Uint8Array(this.slotHour.length * 2);
      hours.set(this.slotHour);
      this.slotHour = hours;
    }
    this.slotVol[this.slotCount] = volume;
    this.slotHour[this.slotCount] = hour;
    this.slotCount++;
  }

  // The day has ended: group its slots by hour once (counting sort), so the
  // daily recomputation over PROFILE_DAYS copies runs instead of regrouping every slot.
  complete(): void {
    const start = this.hourStart;
    for (let i = 0; i < this.slotCount; i++) start[this.slotHour[i]! + 1]! += 1;
    for (let h = 0; h < HOURS_PER_DAY; h++) start[h + 1]! += start[h]!;
    const grouped = new Float64Array(this.slotCount);
    const fill = start.slice(0, HOURS_PER_DAY);
    for (let i = 0; i < this.slotCount; i++) grouped[fill[this.slotHour[i]!]!++] = this.slotVol[i]!;
    this.bySlotHour = grouped;
  }
}

export function hourOfDay(t: Ms): number {
  return Math.floor((t - utcDay(t) * MS_PER_DAY) / MS_PER_HOUR);
}

// Spec §3.2. Partitions the merged stream into volume buckets and maintains
// the volume clock Vol. `onPrint` returns the closed bucket index or −1.
export class BucketBuilder {
  readonly history: BucketHistory;

  private volNow: Lots = 0;
  private bucketVolumeNow: Lots = NaN;    // target of the open bucket
  private bucketVolumeNext: Lots = NaN;   // applied at the next bucket open (A-5)
  readonly Vol100ms = new Float64Array(HOURS_PER_DAY).fill(1);
  readonly ExpectedVolPerMs = new Float64Array(HOURS_PER_DAY);
  private dayIndexNow = -1;
  private daysDone = 0;
  private lastK = -1;

  // First-day bootstrap (A-6, A-50).
  private bootstrapping = false;
  private bootstrapStart: Ms = 0;
  private readonly bootstrapVol = new Float64Array(BOOTSTRAP_MINUTES);

  // Day profiles: completed days with prints within the last PROFILE_DAYS, and today.
  private pastDays: DayProfile[] = [];
  private today: DayProfile | null = null;
  private slotNow = -1;
  private slotVolNow: Lots = 0;

  // Open-bucket accumulator; never exposed (Spec §3.2.1).
  private pPrev: Ticks = 0;
  private hasPrev = false;
  private accCount = 0;
  private accHigh: Ticks = 0;
  private accLow: Ticks = 0;
  private accImbalance: Lots = 0;
  private accPFirst: Ticks = 0;
  private accSumRelPQ = 0;                // Σ (p − p_first)·q, overflow-safe Vwap (Spec §3.11)
  private accSumQ: Lots = 0;
  private accMaxGap: Ticks = 0;
  private accTOpen: Ms = 0;
  private accVolOpen: Lots = 0;
  private readonly closing: { -readonly [K in Exclude<keyof Bucket, 'k' | 'WallDuration_k'>]: Bucket[K] } = {
    dayIndex: 0, tOpen: 0, tClose: 0, volOpen: 0, volClose: 0, High_k: 0, Low_k: 0, Imbalance_k: 0, Vwap_k: 0, Count_k: 0,
    targetVolume: 0, maxPrintGap_k: 0,
  };

  constructor(historyCapacity: number = 2 * BUCKETS_PER_VOLUME_DAY) {
    this.history = new BucketHistory(historyCapacity);
  }

  get Vol(): Lots { return this.volNow; }
  get BucketVolume(): Lots { return this.bucketVolumeNow; }
  get BucketVolume_next(): Lots { return this.bucketVolumeNext; }
  get dayIndex(): number { return this.dayIndexNow; }
  // Completed UTC days with prints (Spec §3.2.4 "7 UTC days consumed").
  get daysConsumed(): number { return this.daysDone; }
  get completedCount(): number { return this.history.completedCount; }
  get inBootstrap(): boolean { return this.bootstrapping; }
  // Bucket the most recent print was assigned to (for TradeRing.push).
  get lastEventBucketK(): number { return this.lastK; }

  onPrint(e: MergedEvent): number {
    const day = utcDay(e.t);
    if (this.today === null) {
      this.startStream(e.t, day);
    } else if (day > this.dayIndexNow) {
      this.onNewDay(day);
    }
    this.volNow += e.q;
    this.recordProfile(e.t, e.q);
    const gap = this.hasPrev ? Math.abs(e.p - this.pPrev) : 0;
    this.pPrev = e.p;
    this.hasPrev = true;

    if (this.bootstrapping) {
      const elapsed = e.t - this.bootstrapStart;
      if (elapsed < BOOTSTRAP_MINUTES * MS_PER_MINUTE) {
        this.bootstrapVol[Math.floor(elapsed / MS_PER_MINUTE)]! += e.q;
        this.lastK = this.history.completedCount;
        return -1;
      }
      this.bucketVolumeNext = Math.max(1, medianOf(this.bootstrapVol.slice(), BOOTSTRAP_MINUTES));
      this.bootstrapping = false;
    }

    if (this.accCount === 0) {
      this.bucketVolumeNow = this.bucketVolumeNext;
      this.accTOpen = e.t;
      this.accVolOpen = this.volNow - e.q;
      this.accPFirst = e.p;
      this.accHigh = e.p;
      this.accLow = e.p;
      this.accImbalance = 0;
      this.accSumRelPQ = 0;
      this.accSumQ = 0;
      this.accMaxGap = 0;
    }
    if (e.p > this.accHigh) this.accHigh = e.p;
    if (e.p < this.accLow) this.accLow = e.p;
    this.accImbalance += e.s * e.q;
    this.accSumRelPQ += (e.p - this.accPFirst) * e.q;
    this.accSumQ += e.q;
    this.accCount += 1;
    if (gap > this.accMaxGap) this.accMaxGap = gap;
    this.lastK = this.history.completedCount;

    if (this.accSumQ < this.BucketVolume) {
      return -1;
    }
    // Whole event assigned, overshoot allowed (A-4). `closing` is a reused record (Spec §10).
    const b = this.closing;
    b.dayIndex = this.dayIndexNow;
    b.tOpen = this.accTOpen;
    b.tClose = e.t;
    b.volOpen = this.accVolOpen;
    b.volClose = this.volNow;
    b.High_k = this.accHigh;
    b.Low_k = this.accLow;
    b.Imbalance_k = this.accImbalance;
    b.Vwap_k = this.accPFirst + this.accSumRelPQ / this.accSumQ;
    b.Count_k = this.accCount;
    b.targetVolume = this.BucketVolume;
    b.maxPrintGap_k = this.accMaxGap;
    const closedK = this.history.append(b);
    this.accCount = 0;
    return closedK;
  }

  private startStream(t: Ms, day: number): void {
    this.dayIndexNow = day;
    this.today = new DayProfile(day, Math.floor((t - day * MS_PER_DAY) / MS_PER_MINUTE));
    this.bootstrapping = true;
    this.bootstrapStart = t;
  }

  private recordProfile(t: Ms, q: Lots): void {
    const today = this.today!;
    const offset = t - this.dayIndexNow * MS_PER_DAY;
    today.minuteVol[Math.floor(offset / MS_PER_MINUTE)]! += q;
    today.hourVol[Math.floor(offset / MS_PER_HOUR)]! += q;
    const slot = Math.floor(t / SLOT_MS);
    if (slot !== this.slotNow) {
      this.flushSlot();
      this.slotNow = slot;
      this.slotVolNow = 0;
    }
    this.slotVolNow += q;
  }

  private flushSlot(): void {
    if (this.slotNow >= 0 && this.slotVolNow > 0) {
      this.today!.addSlot(this.slotVolNow, hourOfDay(this.slotNow * SLOT_MS));
    }
    this.slotNow = -1;
    this.slotVolNow = 0;
  }

  // Spec §3.2.3. Days without prints are skipped, not counted as zero (A-51).
  private onNewDay(day: number): void {
    this.flushSlot();
    this.today!.complete();
    this.pastDays.push(this.today!);
    this.daysDone += 1;
    this.pastDays = this.pastDays.filter((d) => d.dayIndex >= day - PROFILE_DAYS);
    // After a gap of more than 7 days no prior day is left; keep the last values.
    if (this.pastDays.length > 0) {
      this.bucketVolumeNext = Math.max(1, this.medianMinuteVolume());
      this.recomputeHourProfiles();
      this.bootstrapping = false;
    }
    this.today = new DayProfile(day, 0);
    this.dayIndexNow = day;
  }

  private medianMinuteVolume(): number {
    let total = 0;
    for (const d of this.pastDays) total += MINUTES_PER_DAY - d.firstMinute;
    const scratch = new Float64Array(total);
    let len = 0;
    for (const d of this.pastDays) {
      for (let m = d.firstMinute; m < MINUTES_PER_DAY; m++) scratch[len++] = d.minuteVol[m]!;
    }
    return medianOf(scratch, len);
  }

  private recomputeHourProfiles(): void {
    // Every non-empty slot grouped by hour (each day's slots were grouped
    // when it completed), then one median per hour.
    const start = new Int32Array(HOURS_PER_DAY + 1);
    const hourTotal = new Float64Array(HOURS_PER_DAY);
    for (const d of this.pastDays) {
      for (let h = 0; h < HOURS_PER_DAY; h++) {
        start[h + 1]! += d.hourStart[h + 1]! - d.hourStart[h]!;
        hourTotal[h]! += d.hourVol[h]!;
      }
    }
    for (let h = 0; h < HOURS_PER_DAY; h++) start[h + 1]! += start[h]!;
    const byHour = new Float64Array(start[HOURS_PER_DAY]!);
    const fill = start.slice(0, HOURS_PER_DAY);
    for (const d of this.pastDays) {
      const grouped = d.bySlotHour!;
      for (let h = 0; h < HOURS_PER_DAY; h++) {
        const from = d.hourStart[h]!;
        const to = d.hourStart[h + 1]!;
        byHour.set(grouped.subarray(from, to), fill[h]!);
        fill[h]! += to - from;
      }
    }
    for (let h = 0; h < HOURS_PER_DAY; h++) {
      const from = start[h]!;
      const len = start[h + 1]! - from;
      this.Vol100ms[h] = len === 0 ? 1 : Math.max(1, medianOf(byHour.subarray(from, from + len), len));
      this.ExpectedVolPerMs[h] = hourTotal[h]! / (this.pastDays.length * MS_PER_HOUR);
    }
  }

  snapshot(): {
    Vol: Lots; BucketVolume: Lots; BucketVolume_next: Lots; dayIndex: number; daysConsumed: number;
    completedCount: number; inBootstrap: boolean; Vol100ms: number[]; ExpectedVolPerMs: number[];
  } {
    return {
      Vol: this.Vol, BucketVolume: this.BucketVolume, BucketVolume_next: this.BucketVolume_next,
      dayIndex: this.dayIndexNow, daysConsumed: this.daysDone, completedCount: this.completedCount,
      inBootstrap: this.bootstrapping, Vol100ms: Array.from(this.Vol100ms),
      ExpectedVolPerMs: Array.from(this.ExpectedVolPerMs),
    };
  }

  reset(): void {
    this.history.reset();
    this.volNow = 0;
    this.bucketVolumeNow = NaN;
    this.bucketVolumeNext = NaN;
    this.Vol100ms.fill(1);
    this.ExpectedVolPerMs.fill(0);
    this.dayIndexNow = -1;
    this.daysDone = 0;
    this.lastK = -1;
    this.bootstrapping = false;
    this.bootstrapVol.fill(0);
    this.pastDays = [];
    this.today = null;
    this.slotNow = -1;
    this.slotVolNow = 0;
    this.hasPrev = false;
    this.pPrev = 0;
    this.accCount = 0;
  }
}
