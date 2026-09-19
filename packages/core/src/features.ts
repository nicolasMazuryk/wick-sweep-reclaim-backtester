import { hourOfDay } from './buckets.js';
import type { RunConfig } from './config.js';
import { applyGates, evaluateGates, gateConfigFrom, GATE_IDS, type GateConfig, type GateResult } from './gates.js';
import { assert, invariantFailed } from './invariant.js';
import { ceilTicksConservative } from './numerics.js';
import type { TradeRing } from './ring.js';
import type { FrozenStats } from './stats.js';
import type { Buckets, Lots, MergedEvent, Ms, Pivot, Side, Ticks } from './types.js';

// Spec §3.5.2 feature record.
export interface ExcursionFeatures {
  readonly SpikeSize: number; readonly ApproachVolume: Lots; readonly RejectVolume: Lots;
  readonly ApproachDuration: Buckets; readonly RejectDuration: Buckets;
  readonly ApproachSpeed: number; readonly RejectSpeed: number; readonly SpeedAsymmetry: number;
  readonly ApproachImbalance: number; readonly RejectImbalance: number; readonly VolumeBurst: number;
  readonly TopDwell: number; readonly RetraceFraction: number; readonly MaxTradeSize: number;
  readonly MaxAggressorRun: number; readonly MaxPrintGap: number;
  readonly EnterTime: Ms; readonly ExitTime: Ms; readonly Anchor: Ticks; readonly BandEdge: Ticks;
  readonly retraceAvailableAt: Ms;          // t of the print at which RetraceFraction became final
}

export interface FeatureConfig extends GateConfig {
  readonly BandWidthMult: number;
  readonly AnchorWindow: number;
  readonly RetraceWindow: number;
  readonly TopBandMult: number;
  readonly UnitWindow: number;
}

export function featureConfigFrom(cfg: RunConfig): FeatureConfig {
  return {
    ...gateConfigFrom(cfg), BandWidthMult: cfg.BandWidthMult, AnchorWindow: cfg.AnchorWindow,
    RetraceWindow: cfg.RetraceWindow, TopBandMult: cfg.TopBandMult, UnitWindow: cfg.UnitWindow,
  };
}

// Read-only engine state the tracker needs; the engine passes BucketBuilder +
// BucketStats views, unit tests pass a stub. Only values as of the last bucket
// close (`frozen`, `lastVwap`) or the open bucket's fixed target are read.
export interface FeatureContext {
  readonly Vol: Lots;                       // cumulative Vol including the current print
  readonly BucketVolume: Lots;              // target of the bucket in force
  readonly ExpectedVolPerMs: Float64Array;  // by UTC hour (A-15)
  readonly frozen: FrozenStats;
  readonly lastVwap: number;                // Vwap_k of bucket `frozen.k` (A-18)
}

export type ResolutionNote = 'noEnter' | 'pendingLimit' | 'blacklist';

// One event per pivot, except early-G2 SlowExtremes: `classified` (features
// null) at the verdict print, then `featuresFinal` once iOut + RetraceWindow
// (or PendingLimit) is reached. Everything else is a single `complete` event.
export interface PivotResolution {
  readonly pivot: Pivot;
  readonly gate: GateResult;
  readonly features: ExcursionFeatures | null;
  readonly featuresAvailable: boolean;
  readonly phase: 'classified' | 'featuresFinal' | 'complete';
  readonly note: ResolutionNote | null;
  readonly VolUnit_created: Ticks;          // VolUnit_now at confirmed_at (A-9)
  readonly BucketVolume_c: Lots;            // BucketVolume at confirmed_at
  readonly rvolTicks: number;               // RVol_60 · Vwap_k at confirmed_at (A-18)
  readonly exitVol: Lots;                   // vol[iOut]; NaN if never observed
  readonly resolvedVol: Lots;               // Vol at the print that emitted this event
  readonly resolvedAt: Ms;                  // t of that print
  readonly EnterTime: Ms;                   // t[iIn] (also without features); NaN for noEnter
}

export type ResolutionListener = (r: PivotResolution) => void;

// Features known once iOut is observed (everything except RetraceFraction).
interface ExitFeatures {
  SpikeSize: number; RejectVolume: Lots; RejectDuration: Buckets; RejectSpeed: number; SpeedAsymmetry: number;
  RejectImbalance: number; VolumeBurst: number; TopDwell: number; MaxTradeSize: number; MaxAggressorRun: number;
  MaxPrintGap: number; ExitTime: Ms;
}

// PIVOT_PENDING record (Spec §3.5). Prices with an `N` suffix are
// side-normalised (P = Side·p, Spec §3.12). Every *_c value is frozen at
// confirmed_at (A-9, A-18, §3.5.2).
interface PendingPivot {
  readonly pivot: Pivot;
  readonly side: Side;
  readonly iPiv: number;
  readonly iIn: number;
  iOut: number;                             // −1 until observed (L2)
  readonly volIn: Lots;
  readonly volPiv: Lots;
  exitVol: Lots;
  readonly priceN: Ticks;
  readonly BandEdge: Ticks;
  readonly bandN: Ticks;
  readonly halfBand: Ticks;                 // ceil(BandWidthMult · VolUnit_created)
  readonly Anchor: Ticks;
  readonly EnterTime: Ms;
  readonly VolUnit_created: Ticks;
  readonly BucketVolume_c: Lots;
  readonly eventSizeP99_c: Lots;
  readonly rvolTicks_c: number;
  readonly expectedVolPerMs_c: number;      // ExpectedVolPerMs[hourOfDayUTC(t[iIn])]
  readonly confirmBucketK: number;
  readonly ApproachVolume: Lots;
  readonly ApproachDuration: Buckets;
  readonly ApproachSpeed: number;
  readonly ApproachImbalance: number;
  exit: ExitFeatures | null;
  retraceLimit: Lots;
  retraceMinN: Ticks;
  retraceFinal: boolean;
  retraceAvailableAt: Ms;
  earlyG2: boolean;
  pendingLimitHit: boolean;
  burstSeen: boolean;
  confirmClosed: boolean;
  classified: GateResult | null;            // set only by the early G2 verdict
  lastIndex: number;                        // last ring index stepped
}

// Side-signed imbalance without −0, so mirrored paths give identical records.
function sideImbalance(sign: number, sumSq: Lots, volume: Lots): number {
  return (sign * sumSq) / volume + 0;
}

interface BurstClose { readonly k: number; readonly volClose: Lots }

// Spec §3.5 ExcursionFeatures + the stream-dependent parts of §3.6 (burst
// exclusion, early G2, Unresolved). Driven by the engine loop (Spec §3.10):
// `onBucketClose` at step 2k, `open` at step 7, `onPrint` at step 8. Every
// verdict is timed at a print already pushed to the ring, never earlier than
// the confirming print (L1–L3).
export class ExcursionFeaturesTracker {
  readonly PendingLimit: Buckets;
  private pending: PendingPivot[] = [];
  private burstCloses: BurstClose[] = [];   // burst bucket closes still covered by the ring
  private lastClosedK = -1;

  constructor(
    private readonly cfg: FeatureConfig,
    private readonly ring: TradeRing,
    private readonly ctx: FeatureContext,
    private readonly onResolved: ResolutionListener,
  ) {
    this.PendingLimit = 2 * cfg.UnitWindow - cfg.AnchorWindow - cfg.RetraceWindow;
  }

  get pendingCount(): number { return this.pending.length; }

  // PriorTouches part of PIVOT_PENDING (Spec §3.7.1): pending pivots on `side`
  // with |price − p| ≤ tol, confirmedVol ≥ minVol, fromPivotId ≤ pivotId <
  // beforePivotId, not yet classified (an early-G2 SlowExtreme is already in the store).
  countPendingNear(side: Side, price: Ticks, tol: Ticks, minVol: Lots, beforePivotId: number, fromPivotId: number): number {
    let count = 0;
    for (const pp of this.pending) {
      const piv = pp.pivot;
      if (pp.classified === null && piv.side === side && Math.abs(piv.price - price) <= tol && piv.confirmedVol >= minVol &&
        piv.pivotId < beforePivotId && piv.pivotId >= fromPivotId) count++;
    }
    return count;
  }

  // RejectSpeed of a still-pending pivot once its ExitTime was observed (L2); NaN otherwise.
  pendingRejectSpeed(pivotId: number): number {
    for (const pp of this.pending) if (pp.pivot.pivotId === pivotId) return pp.exit?.RejectSpeed ?? NaN;
    return NaN;
  }

  // Step 2k: `ctx.frozen` already holds the stats of bucket k, `ctx.Vol` its volClose.
  onBucketClose(k: number): void {
    this.lastClosedK = k;
    const isBurst = this.ctx.frozen.BurstFlag;
    const volClose = this.ctx.Vol;
    if (isBurst) this.burstCloses.push({ k, volClose });
    if (this.ring.size > 0) {
      const oldestVol = this.ring.at(this.ring.oldestIndex).Vol;
      if (this.burstCloses.length > 0 && this.burstCloses[0]!.volClose < oldestVol) {
        this.burstCloses = this.burstCloses.filter((c) => c.volClose >= oldestVol);
      }
    }
    for (const pp of this.pending) {
      if (pp.classified !== null) continue;
      if (k === pp.confirmBucketK) pp.confirmClosed = true;
      // After iOut, only the confirmation bucket can still flag the pivot:
      // later closes lie beyond vol[iOut] (§8.7).
      if (isBurst && (pp.iOut < 0 || k === pp.confirmBucketK)) pp.burstSeen = true;
    }
  }

  // Step 7, on the confirming print (the ring's newest event).
  open(piv: Pivot): void {
    const ring = this.ring;
    const iConf = ring.newestIndex;
    const conf = ring.at(iConf);
    assert(conf.t === piv.confirmed_at && conf.seq === piv.confirmedSeq, 'ExcursionFeatures.open: not on the confirming print');
    const confirmBucketK = conf.bucketK;
    let iPiv = ring.indexAtTime(piv.time);
    while (iPiv < iConf && ring.at(iPiv).seq !== piv.seq) iPiv++;
    if (!(ring.at(iPiv).t === piv.time && ring.at(iPiv).seq === piv.seq)) invariantFailed(`ExcursionFeatures.open: pivot print of ${piv.pivotId} not in ring`);

    const side = piv.side;
    const frozen = this.ctx.frozen;
    const VolUnit_created = frozen.VolUnit_now;
    const BucketVolume_c = this.ctx.BucketVolume;
    const halfBand = ceilTicksConservative(this.cfg.BandWidthMult * VolUnit_created);
    const BandEdge = piv.price - side * halfBand;
    const bandN = side * BandEdge;
    const iIn = ring.lastAtOrBelow(iPiv, side, bandN);
    if (iIn < 0) {
      this.onResolved({
        pivot: piv, gate: { cls: 'Unresolved', failed: [], classifiedAt: piv.confirmed_at }, features: null,
        featuresAvailable: false, phase: 'complete', note: 'noEnter', VolUnit_created, BucketVolume_c,
        rvolTicks: frozen.RVol_60 * this.ctx.lastVwap, exitVol: NaN, resolvedVol: this.ctx.Vol, resolvedAt: piv.confirmed_at,
        EnterTime: NaN,
      });
      return;
    }

    // Anchor: side-normalised min over vol ∈ [vol[iIn] − AnchorWindow·BucketVolume, vol[iIn]).
    const volIn = ring.at(iIn).Vol;
    const EnterTime = ring.at(iIn).t;
    const iAnchorFrom = ring.indexAtVol(volIn - this.cfg.AnchorWindow * BucketVolume_c);
    let anchorN = side * ring.at(iIn).p;
    if (iAnchorFrom < iIn) {
      ring.checkSpan(iAnchorFrom, iIn);
      anchorN = Infinity;
      for (let j = iAnchorFrom; j < iIn; j++) anchorN = Math.min(anchorN, side * ring.pAt(j));
    }

    // Approach = [iIn, iPiv] inclusive (App. A).
    ring.checkSpan(iIn, iPiv + 1);
    let ApproachVolume = 0;
    let approachSq = 0;
    for (let j = iIn; j <= iPiv; j++) {
      ApproachVolume += ring.qAt(j);
      approachSq += ring.sAt(j) * ring.qAt(j);
    }
    const volPiv = ring.volAt(iPiv);
    const ApproachDuration = Math.max(volPiv - volIn, ring.qAt(iPiv)) / BucketVolume_c;

    const pp: PendingPivot = {
      pivot: piv, side, iPiv, iIn, iOut: -1, volIn, volPiv, exitVol: NaN, priceN: side * piv.price, BandEdge, bandN,
      halfBand, Anchor: side * anchorN, EnterTime, VolUnit_created, BucketVolume_c,
      eventSizeP99_c: frozen.eventSizeP99, rvolTicks_c: frozen.RVol_60 * this.ctx.lastVwap,
      expectedVolPerMs_c: this.ctx.ExpectedVolPerMs[hourOfDay(EnterTime)]!, confirmBucketK,
      ApproachVolume, ApproachDuration, ApproachSpeed: halfBand / (VolUnit_created * ApproachDuration),
      ApproachImbalance: sideImbalance(side, approachSq, ApproachVolume),
      exit: null, retraceLimit: NaN, retraceMinN: Infinity, retraceFinal: false, retraceAvailableAt: NaN,
      earlyG2: false, pendingLimitHit: false, burstSeen: false, confirmClosed: this.lastClosedK >= confirmBucketK,
      classified: null, lastIndex: iPiv,
    };

    // Catch-up over (iPiv, iConf]: ExitTime and part of the retrace window may
    // precede confirmation; any verdict reached here is timed at confirmed_at.
    for (let j = iPiv + 1; j <= iConf; j++) this.step(pp, j);
    pp.lastIndex = iConf;
    for (const c of this.burstCloses) {
      if (c.k === confirmBucketK || (c.volClose >= volIn && (pp.iOut < 0 || c.volClose <= pp.exitVol))) {
        pp.burstSeen = true;
      }
    }
    if (!this.tryResolve(pp, piv.confirmed_at, this.ctx.Vol)) this.pending.push(pp);
  }

  // Step 8: advance every pending pivot by the ring's newest event `e`.
  onPrint(e: MergedEvent): void {
    if (this.pending.length === 0) return;
    const i = this.ring.newestIndex;
    const view = this.ring.at(i);
    assert(view.t === e.t && view.seq === e.seq, 'ExcursionFeatures.onPrint: event is not the ring newest');
    let removed = false;
    for (const pp of this.pending) {
      if (pp.lastIndex < i) {
        this.step(pp, i);
        pp.lastIndex = i;
      }
      if (this.tryResolve(pp, e.t, this.ctx.Vol)) {
        pp.lastIndex = -1;                  // marks for removal
        removed = true;
      }
    }
    if (removed) {
      // In-place compaction (no per-resolution array, Spec §10).
      const pending = this.pending;
      let n = 0;
      for (const pp of pending) if (pp.lastIndex >= 0) pending[n++] = pp;
      pending.length = n;
    }
  }

  // Per-print state update (no emission).
  private step(pp: PendingPivot, j: number): void {
    const e = this.ring.at(j);
    const t = e.t;
    const Vol = e.Vol;
    const pN = pp.side * e.p;
    const BV = pp.BucketVolume_c;
    if (pp.iOut < 0) {
      // A-13: G2 already failed although iOut is still unseen.
      if (pp.ApproachDuration + (Vol - pp.volPiv) / BV > this.cfg.MaxSpikeDuration) pp.earlyG2 = true;
      if (pN <= pp.bandN) {
        pp.iOut = j;
        pp.exitVol = Vol;
        pp.exit = this.exitFeatures(pp);
        pp.retraceLimit = Vol + this.cfg.RetraceWindow * BV;
        pp.retraceMinN = pN;
      } else if (Vol - pp.pivot.confirmedVol > this.PendingLimit * BV) {
        pp.pendingLimitHit = true;
      }
      return;
    }
    if (pp.retraceFinal) return;
    if (Vol <= pp.retraceLimit) pp.retraceMinN = Math.min(pp.retraceMinN, pN);
    if (Vol >= pp.retraceLimit) {
      pp.retraceFinal = true;
      pp.retraceAvailableAt = Math.max(t, pp.pivot.confirmed_at);
    }
  }

  // All ExitTime features in one pass over [iIn, iOut] (Spec §3.5.2).
  private exitFeatures(pp: PendingPivot): ExitFeatures {
    const ring = this.ring;
    const iIn = pp.iIn;
    ring.checkSpan(iIn, pp.iOut + 1);
    const side = pp.side;
    const VU = pp.VolUnit_created;
    const last = pp.iOut - iIn;
    const offPiv = pp.iPiv - iIn;
    const topFloorN = pp.priceN - ceilTicksConservative(this.cfg.TopBandMult * VU);
    let RejectVolume = 0;
    let rejectSq = 0;
    let topVolume = 0;
    let maxQ = 0;
    let maxGap = 0;
    let run = 0;
    let MaxAggressorRun = 0;
    for (let j = 0; j <= last; j++) {
      const i = iIn + j;
      const q = ring.qAt(i);
      const pN = side * ring.pAt(i);
      if (pN >= topFloorN && pN <= pp.priceN) topVolume += q;
      if (q > maxQ) maxQ = q;
      if (j > 0) maxGap = Math.max(maxGap, Math.abs(ring.pAt(i) - ring.pAt(i - 1)));
      if (j >= offPiv) {
        RejectVolume += q;
        rejectSq += ring.sAt(i) * q;
        run = j > offPiv && ring.sAt(i) === ring.sAt(i - 1) ? run + 1 : 1;
        if (run > MaxAggressorRun) MaxAggressorRun = run;
      }
    }
    const BV = pp.BucketVolume_c;
    const RejectDuration = Math.max(ring.volAt(pp.iOut) - pp.volPiv, ring.qAt(pp.iOut)) / BV;
    const RejectSpeed = pp.halfBand / (VU * RejectDuration);
    const ExitTime = ring.tAt(pp.iOut);
    const ExpectedVolume = Math.max(1, (ExitTime - pp.EnterTime) * pp.expectedVolPerMs_c);
    return {
      SpikeSize: (pp.priceN - side * pp.Anchor) / VU, RejectVolume, RejectDuration, RejectSpeed,
      SpeedAsymmetry: Math.log(RejectSpeed / pp.ApproachSpeed), RejectImbalance: sideImbalance(-side, rejectSq, RejectVolume),
      VolumeBurst: (pp.ApproachVolume + RejectVolume) / ExpectedVolume, TopDwell: topVolume / BV,
      MaxTradeSize: maxQ / Math.max(pp.eventSizeP99_c, 1), MaxAggressorRun, MaxPrintGap: maxGap / VU, ExitTime,
    };
  }

  private features(pp: PendingPivot): ExcursionFeatures {
    const x = pp.exit!;
    const denom = pp.priceN - pp.side * pp.Anchor;
    return {
      SpikeSize: x.SpikeSize, ApproachVolume: pp.ApproachVolume, RejectVolume: x.RejectVolume,
      ApproachDuration: pp.ApproachDuration, RejectDuration: x.RejectDuration, ApproachSpeed: pp.ApproachSpeed,
      RejectSpeed: x.RejectSpeed, SpeedAsymmetry: x.SpeedAsymmetry, ApproachImbalance: pp.ApproachImbalance,
      RejectImbalance: x.RejectImbalance, VolumeBurst: x.VolumeBurst, TopDwell: x.TopDwell,
      RetraceFraction: denom <= 0 ? 0 : (pp.priceN - pp.retraceMinN) / denom, MaxTradeSize: x.MaxTradeSize,
      MaxAggressorRun: x.MaxAggressorRun, MaxPrintGap: x.MaxPrintGap, EnterTime: pp.EnterTime, ExitTime: x.ExitTime,
      Anchor: pp.Anchor, BandEdge: pp.BandEdge, retraceAvailableAt: pp.retraceAvailableAt,
    };
  }

  // Emits whatever became final at print time `t`; true when the pivot is done.
  // Once a class is fixed it never changes (burst after an early G2 verdict
  // is ignored).
  private tryResolve(pp: PendingPivot, t: Ms, Vol: Lots): boolean {
    let justClassified = false;
    if (pp.classified === null) {
      if (pp.burstSeen) {
        const features = pp.retraceFinal ? this.features(pp) : null;
        this.emit(pp, { cls: 'BurstPivot', failed: [], classifiedAt: t }, features, 'complete', null, t, Vol);
        return true;
      }
      if (pp.earlyG2) {
        pp.classified = { cls: 'SlowExtreme', failed: ['G2'], classifiedAt: t };
        justClassified = true;
      } else if (pp.pendingLimitHit) {
        this.emit(pp, { cls: 'SlowExtreme', failed: [], classifiedAt: t }, null, 'complete', 'pendingLimit', t, Vol);
        return true;
      } else if (pp.retraceFinal && pp.confirmClosed) {
        const f = this.features(pp);
        this.emit(pp, applyGates(f, this.cfg, t), f, 'complete', null, t, Vol);
        return true;
      } else {
        return false;
      }
    }
    const verdict = pp.classified;
    const phase = justClassified ? 'complete' : 'featuresFinal';
    if (pp.retraceFinal) {
      const f = this.features(pp);
      const failed = new Set(evaluateGates(f, this.cfg)).add('G2');
      const gate: GateResult = { cls: 'SlowExtreme', failed: GATE_IDS.filter((id) => failed.has(id)), classifiedAt: verdict.classifiedAt };
      this.emit(pp, gate, f, phase, null, t, Vol);
      return true;
    }
    if (pp.pendingLimitHit) {
      this.emit(pp, verdict, null, phase, 'pendingLimit', t, Vol);
      return true;
    }
    if (justClassified) this.emit(pp, verdict, null, 'classified', null, t, Vol);
    return false;
  }

  private emit(
    pp: PendingPivot, gate: GateResult, features: ExcursionFeatures | null, phase: PivotResolution['phase'],
    note: ResolutionNote | null, t: Ms, Vol: Lots,
  ): void {
    const featuresAvailable = phase === 'classified' ? false : features !== null;
    this.onResolved({
      pivot: pp.pivot, gate, features, featuresAvailable, phase, note, VolUnit_created: pp.VolUnit_created,
      BucketVolume_c: pp.BucketVolume_c, rvolTicks: pp.rvolTicks_c, exitVol: pp.exitVol, resolvedVol: Vol, resolvedAt: t,
      EnterTime: pp.EnterTime,
    });
  }

  snapshot(): { lastClosedK: number; burstCloses: BurstClose[]; pending: Record<string, unknown>[] } {
    return {
      lastClosedK: this.lastClosedK,
      burstCloses: this.burstCloses.map((c) => ({ ...c })),
      pending: this.pending.map((pp) => ({ ...pp, pivot: { ...pp.pivot }, exit: pp.exit && { ...pp.exit }, classified: pp.classified && { ...pp.classified } })),
    };
  }

  reset(): void {
    this.pending = [];
    this.burstCloses = [];
    this.lastClosedK = -1;
  }
}
