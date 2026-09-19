import { BUCKETS_PER_VOLUME_DAY, type Engine, type EngineObserver, type Lots, type MergedEvent, type Ms, type Ticks, type Trade } from '@wsr/core';

// Per-trade facts the TradeRecord (Spec §7.1) needs beyond the Trade itself.
export interface TradeObservation {
  readonly tradeId: number;
  readonly VolUnit_now: Ticks;              // at the trigger print
  readonly volumeDay: number;               // at the trigger print (bootstrap block)
  fillBucketK: number;                      // bucket of the entry fill print; −1 until known
  fillVol: Lots;
  sumSQ: Lots;                              // Σ s·q over the completed buckets after the fill bucket
  sumQ: Lots;
  nextK: number;                            // next bucket to add
  postEntryImbalance2: number;              // −Side·Σsq/Σq over 2 buckets; NaN until both closed
  exitVol: Lots;                            // Vol at the exit fill print; NaN until known
  holdBuckets: number;                      // (exitVol − fillVol)/BucketVolume
}

const POST_ENTRY_BUCKETS = 2;

// Spec §3.10 steps 10–11 observer (read-only): for each filled trade, the
// §9.4 mechanism check −Side·Σ s q / Σ q over the 2 completed buckets after
// the entry fill's bucket, the trigger-time VolUnit_now / volumeDay and the
// holding time in buckets; for the fold metrics, every bucket close with its
// volume-day and blacklist overlap (Spec §2.6.3 rule 5).
export class PostEntryImbalanceObserver implements EngineObserver {
  private readonly trades = new Map<number, TradeObservation>();
  private readonly waitingFill: TradeObservation[] = [];
  private readonly waitingBuckets: TradeObservation[] = [];
  private readonly waitingExit: TradeObservation[] = [];
  private nextTrade = 0;
  private closes = 0;
  private tClose = new Float64Array(1024);
  private blacklisted = new Uint8Array(1024);
  private readonly tripTimes: Ms[] = [];
  private readonly underflowTimes: Ms[] = [];     // bucket closes on which the TradeRing grew (Spec §3.1)

  onPrint(e: MergedEvent, engine: Engine): void {
    this.sync(engine);
    this.syncTrips(engine, e.t);
  }

  // Kill-switch trips (§11) by the print on which they happened.
  private syncTrips(engine: Engine, t: Ms): void {
    const trips = engine.exec?.killSwitch.trips ?? 0;
    while (this.tripTimes.length < trips) this.tripTimes.push(t);
  }

  killSwitchTripsIn(from: Ms, to: Ms): number {
    return this.tripTimes.filter((t) => t >= from && t < to).length;
  }

  // TradeRing underflows (Spec §3.1) at bucket closes with tClose ∈ [from, to).
  ringUnderflowIn(from: Ms, to: Ms): number {
    return this.underflowTimes.filter((t) => t >= from && t < to).length;
  }

  onBucketClose(k: number, engine: Engine): void {
    const h = engine.builder.history;
    while (this.underflowTimes.length < engine.counters.ringUnderflow) this.underflowTimes.push(h.tClose(k));
    if (this.closes === this.tClose.length) {
      const t = new Float64Array(this.closes * 2);
      t.set(this.tClose);
      this.tClose = t;
      const b = new Uint8Array(this.closes * 2);
      b.set(this.blacklisted);
      this.blacklisted = b;
    }
    this.tClose[this.closes] = h.tClose(k);
    this.blacklisted[this.closes] = engine.blacklist?.overlaps(h.tOpen(k), h.tClose(k)) ? 1 : 0;
    this.closes++;
    this.addBuckets(engine, k);
  }

  // After Engine.finish(): entries / exits resolved at the end of the stream.
  finalize(engine: Engine): void {
    this.sync(engine);
    this.syncTrips(engine, engine.lastT);
  }

  private sync(engine: Engine): void {
    const trades = engine.exec?.trades() ?? [];
    while (this.nextTrade < trades.length) {
      const tr = trades[this.nextTrade++]!;
      const o: TradeObservation = {
        tradeId: tr.tradeId, VolUnit_now: engine.stats.frozen.VolUnit_now, volumeDay: engine.stats.frozen.volumeDay, fillBucketK: -1,
        fillVol: NaN, sumSQ: 0, sumQ: 0, nextK: -1, postEntryImbalance2: NaN, exitVol: NaN, holdBuckets: NaN,
      };
      this.trades.set(tr.tradeId, o);
      this.waitingFill.push(o);
    }
    for (let i = 0; i < this.waitingFill.length;) {
      const o = this.waitingFill[i]!;
      const tr = trades[o.tradeId]!;
      if (tr.entry === null) { i++; continue; }
      this.waitingFill.splice(i, 1);
      const at = this.locate(engine, tr.entry.fillT, tr.entry.fillSeq);
      o.fillBucketK = at?.bucketK ?? engine.builder.lastEventBucketK;
      o.fillVol = at?.Vol ?? engine.builder.Vol;
      o.nextK = o.fillBucketK + 1;
      this.waitingBuckets.push(o);
      this.waitingExit.push(o);
      this.addBuckets(engine, engine.builder.completedCount - 1);
    }
    for (let i = 0; i < this.waitingExit.length;) {
      const o = this.waitingExit[i]!;
      const tr = trades[o.tradeId]!;
      if (tr.exit === null) { i++; continue; }
      this.waitingExit.splice(i, 1);
      o.exitVol = this.locate(engine, tr.exit.fillT, tr.exit.fillSeq)?.Vol ?? NaN;
      o.holdBuckets = (o.exitVol - o.fillVol) / engine.builder.BucketVolume;
    }
  }

  // Adds every closed bucket ≤ lastK still missing for a trade; a trade is
  // done once POST_ENTRY_BUCKETS buckets after its fill bucket are in.
  private addBuckets(engine: Engine, lastK: number): void {
    const h = engine.builder.history;
    const trades = engine.exec?.trades() ?? [];
    for (let i = 0; i < this.waitingBuckets.length;) {
      const o = this.waitingBuckets[i]!;
      while (o.nextK <= lastK && o.nextK <= o.fillBucketK + POST_ENTRY_BUCKETS && h.has(o.nextK)) {
        o.sumSQ += h.Imbalance_k(o.nextK);
        o.sumQ += h.volClose(o.nextK) - h.volOpen(o.nextK);
        o.nextK++;
      }
      if (o.nextK > o.fillBucketK + POST_ENTRY_BUCKETS) {
        const Side = (trades[o.tradeId] as Readonly<Trade>).Side;
        o.postEntryImbalance2 = o.sumQ > 0 ? (-Side * o.sumSQ) / o.sumQ : NaN;
        this.waitingBuckets.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  // The print (t, seq) in the TradeRing, if still held.
  private locate(engine: Engine, t: Ms, seq: number): { bucketK: number; Vol: Lots } | null {
    const ring = engine.ring;
    if (ring.size === 0) return null;
    for (let i = ring.indexAtTime(t); i <= ring.newestIndex; i++) {
      const v = ring.at(i);
      if (v.seq === seq) return { bucketK: v.bucketK, Vol: v.Vol };
      if (v.t > t) break;
    }
    return null;
  }

  trade(tradeId: number): Readonly<TradeObservation> | undefined {
    return this.trades.get(tradeId);
  }

  // Completed buckets with tClose ∈ [from, to), in volume-days (1440 buckets, Spec §3.2.5).
  volumeDaysIn(from: Ms, to: Ms): number {
    return this.closesIn(from, to).n / BUCKETS_PER_VOLUME_DAY;
  }

  // Share of those buckets overlapping a blacklist interval (Spec §2.6.3 rule 5).
  blacklistedBucketShare(from: Ms, to: Ms): number {
    const c = this.closesIn(from, to);
    return c.n === 0 ? NaN : c.blacklisted / c.n;
  }

  private closesIn(from: Ms, to: Ms): { n: number; blacklisted: number } {
    let n = 0;
    let blacklisted = 0;
    for (let i = 0; i < this.closes; i++) {
      const t = this.tClose[i]!;
      if (t < from || t >= to) continue;
      n++;
      blacklisted += this.blacklisted[i]!;
    }
    return { n, blacklisted };
  }
}
