import type { Blacklist } from './blacklist.js';
import { BUCKETS_PER_VOLUME_DAY } from './buckets.js';
import type { RunConfig } from './config.js';
import {
  ExcursionFeaturesTracker, type FeatureConfig, type FeatureContext, featureConfigFrom, type PivotResolution,
} from './features.js';
import { ceilTicksConservative } from './numerics.js';
import type { PivotStore } from './pivot-store.js';
import type { TradeRing } from './ring.js';
import type { MergedEvent, Pivot } from './types.js';
import { FEATURE_COUNT, featureVector, RankWindows, stageAScore, type StageBModel, stageBScore } from './wickstrength.js';

export interface PipelineConfig extends FeatureConfig {
  readonly MergeTolerance: number;
  readonly RankWindow: number;
}

export function pipelineConfigFrom(cfg: RunConfig): PipelineConfig {
  return { ...featureConfigFrom(cfg), MergeTolerance: cfg.MergeTolerance, RankWindow: cfg.RankWindow };
}

// A resolution after scoring, as handed to downstream consumers (LevelBook, step 6).
export interface ScoredResolution extends PivotResolution {
  readonly PriorTouches: number;            // NaN when not scored
  readonly ranks: Float64Array | null;
  readonly WickStrength_0: number;          // NaN below MinRankPivots or when not rankable
  readonly WickStrength_B: number;          // NaN without a Stage B model (fitted per fold in @wsr/backtest)
}

// Pivot → classified, scored, stored pivot (Spec §3.5–§3.8). Owns the
// ExcursionFeaturesTracker and the rank windows; the Engine calls it at
// Spec §3.10 steps 2k (`onBucketClose`), 7 (`open`) and 8 (`onPrint`).
// With a blacklist (Spec §2.6.3 rule 2), a pivot confirmed inside an interval
// or whose [EnterTime, retraceAvailableAt] overlaps one is stored
// `Unresolved(blacklist)`: never scored, ranked or handed on as a WickLevel.
export class PivotPipeline {
  readonly tracker: ExcursionFeaturesTracker;
  readonly rankWindows: RankWindows;
  // volClose of the last 1441 completed buckets: PriorTouches looks back 1440 (Spec §3.2.5).
  private readonly volCloses = new Float64Array(BUCKETS_PER_VOLUME_DAY + 1);
  private lastClosedK = -1;
  private readonly x = new Float64Array(FEATURE_COUNT);
  // First pivotId opened since the last reset: PriorTouches never counts
  // pivots from before a tick-size change (other tick unit, other Vol clock).
  private minPivotId = 0;
  private awaitingFirstPivot = false;
  // Fold-scoped Stage B model (Spec §6.3), switched by the engine's fold schedule.
  private stageB: StageBModel | null = null;

  constructor(
    private readonly cfg: PipelineConfig,
    ring: TradeRing,
    private readonly ctx: FeatureContext,
    readonly store: PivotStore,
    private readonly listener?: (r: ScoredResolution) => void,
    private readonly blacklist: Blacklist | null = null,
  ) {
    this.rankWindows = new RankWindows(cfg.RankWindow);
    this.tracker = new ExcursionFeaturesTracker(cfg, ring, ctx, (r) => this.onResolved(r));
  }

  onBucketClose(k: number): void {
    this.lastClosedK = k;
    this.volCloses[k % this.volCloses.length] = this.ctx.Vol;
    this.tracker.onBucketClose(k);
  }

  setStageBModel(m: StageBModel | null): void { this.stageB = m; }

  open(piv: Pivot): void {
    if (this.awaitingFirstPivot) {
      this.minPivotId = piv.pivotId;
      this.awaitingFirstPivot = false;
    }
    this.tracker.open(piv);
  }
  onPrint(e: MergedEvent): void { this.tracker.onPrint(e); }

  // RejectSpeed known so far for a pivot (§8.6 violent test): pending pivots
  // from ExitTime on, resolved ones from the store; NaN when unknown.
  rejectSpeedOf(pivotId: number): number {
    const stored = this.store.byId(pivotId);
    return stored !== undefined ? stored.features?.RejectSpeed ?? NaN : this.tracker.pendingRejectSpeed(pivotId);
  }

  // Earliest confirmedVol counted by PriorTouches: volClose of bucket k − 1440.
  private priorTouchesMinVol(): number {
    const kBack = this.lastClosedK - BUCKETS_PER_VOLUME_DAY;
    return kBack < 0 ? 0 : this.volCloses[kBack % this.volCloses.length]!;
  }

  // Spec §2.6.3 rule 2: confirmed inside an interval, or [EnterTime, ExitTime +
  // RetraceWindow] overlaps one. With final features that window is [EnterTime,
  // retraceAvailableAt]; a class fixed before it is complete (early G2 at its
  // verdict, PendingLimit, burst) is checked over the part observed so far,
  // [EnterTime, resolvedAt] (A-86). An early-G2 row found blacklisted only at
  // `featuresFinal` keeps its class (classes never change) but loses its ranks.
  private blacklisted(r: PivotResolution): boolean {
    const bl = this.blacklist;
    if (bl === null) return false;
    const t = r.pivot.confirmed_at;
    if (bl.overlaps(t, t)) return true;
    if (Number.isNaN(r.EnterTime)) return false;
    return bl.overlaps(r.EnterTime, r.features?.retraceAvailableAt ?? r.resolvedAt);
  }

  private onResolved(r: PivotResolution): void {
    if (this.blacklisted(r)) {
      this.onBlacklisted(r);
      return;
    }
    const rankable = r.featuresAvailable && (r.gate.cls === 'WickLevel' || r.gate.cls === 'SlowExtreme');
    let PriorTouches = NaN;
    let ranks: Float64Array | null = null;
    let WickStrength_0 = NaN;
    if (rankable) {
      const f = r.features!;
      const piv = r.pivot;
      const tol = ceilTicksConservative(this.cfg.MergeTolerance * r.VolUnit_created);
      // Every earlier confirmed pivot (§4.1): stored ones plus those still PIVOT_PENDING.
      const minVol = this.priorTouchesMinVol();
      PriorTouches = this.store.countNear(piv.side, piv.price, tol, minVol, piv.pivotId, this.minPivotId) +
        this.tracker.countPendingNear(piv.side, piv.price, tol, minVol, piv.pivotId, this.minPivotId);
      featureVector(f, PriorTouches, r.rvolTicks, this.x);
      const out = new Float64Array(FEATURE_COUNT);
      // Scored against earlier pivots only, then inserted (Spec §3.7.2).
      if (this.rankWindows.ranks(this.x, out)) {
        ranks = out;
        WickStrength_0 = stageAScore(out);
      }
      this.rankWindows.insert(this.x);
    }
    const WickStrength_B = ranks !== null && this.stageB !== null ? stageBScore(this.stageB, ranks) : NaN;
    if (r.phase === 'featuresFinal') {
      this.store.updateFeatures(r.pivot.pivotId, r.features, r.gate.failed, ranks, WickStrength_0, WickStrength_B, r.note);
    } else {
      this.store.add(r.pivot, r.features, r.gate, ranks, WickStrength_0, WickStrength_B, -1, r.note, r.VolUnit_created, r.resolvedVol);
    }
    this.listener?.({ ...r, PriorTouches, ranks, WickStrength_0, WickStrength_B });
  }

  // Not scored and not inserted into RankWindow. A `featuresFinal` event
  // completes a row already stored at its early-G2 verdict: its class stays,
  // the note records the exclusion.
  private onBlacklisted(r: PivotResolution): void {
    const scored = { PriorTouches: NaN, ranks: null, WickStrength_0: NaN, WickStrength_B: NaN };
    if (r.phase === 'featuresFinal') {
      this.store.updateFeatures(r.pivot.pivotId, r.features, r.gate.failed, null, NaN, NaN, 'blacklist');
      const cls = this.store.byId(r.pivot.pivotId)!.cls;                     // Unresolved if already blacklisted at the verdict
      this.listener?.({ ...r, gate: { ...r.gate, cls }, note: 'blacklist', ...scored });
      return;
    }
    const gate = { cls: 'Unresolved' as const, failed: r.gate.failed, classifiedAt: r.gate.classifiedAt };
    this.store.add(r.pivot, r.features, gate, null, NaN, NaN, -1, 'blacklist', r.VolUnit_created, r.resolvedVol);
    this.listener?.({ ...r, gate, note: 'blacklist', ...scored });
  }

  snapshot(): {
    store: ReturnType<PivotStore['snapshot']>; tracker: ReturnType<ExcursionFeaturesTracker['snapshot']>;
    rankWindows: number[][]; lastClosedK: number; minPivotId: number; stageBFoldId: number;
  } {
    return {
      store: this.store.snapshot(), tracker: this.tracker.snapshot(), rankWindows: this.rankWindows.snapshot(),
      lastClosedK: this.lastClosedK, minPivotId: this.minPivotId, stageBFoldId: this.stageB?.foldId ?? -1,
    };
  }

  // Tick-size re-basing (Spec §3.11): pending pivots and rank windows are
  // dropped; the PivotStore is kept (never evicts, §3.8).
  reset(): void {
    this.tracker.reset();
    this.rankWindows.reset();
    this.volCloses.fill(0);
    this.lastClosedK = -1;
    this.awaitingFirstPivot = true;
  }
}
