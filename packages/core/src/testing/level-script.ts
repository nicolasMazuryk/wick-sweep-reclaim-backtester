import type { ExcursionFeatures } from '../features.js';
import type { PivotClass } from '../gates.js';
import { type ExecutionPort, LevelBook, type LevelBookConfig, type LevelContext } from '../level-book.js';
import type { Level } from '../level.js';
import type { ScoredResolution } from '../pivot-pipeline.js';
import { PivotStore } from '../pivot-store.js';
import type { FrozenStats } from '../stats.js';
import type { MergedEvent, Pivot, Side, Ticks } from '../types.js';
import { RecordingPort } from './recording-port.js';

export const LEVEL_CFG: LevelBookConfig = {
  MergeTolerance: 0.25, MinSweepMult: 0.5, BreakoutMult: 2.5, AgeScale: 240, MaxAge: 720, ageClock: 'volume',
  DistanceScale: 5, ArmMode: 'RestEarly', ArmDistance: 0.5, MinReturnSpeed: 0.3, TriggerOffset: 0, StopOffset: 1,
  TargetMult: 2, targetMode: 'sweepDepth', TargetUnits: 2, timeStop: false, MaxHold: 4, MaxUses: 1, MaxSweeps: 3, MaxPending: 4,
  RetraceWindow: 5, counterTrendBlock: false, strengthModel: 'stageA',
};

// VolUnit 10 ⇒ MinSweepDepth 5, BreakoutDepth 25, merge tolerance 3; PivotReversal 12.
export function stubFrozen(over: Partial<FrozenStats> = {}): FrozenStats {
  return {
    k: 0, SpreadEst_t: 1, VolUnit_now: 10, RVol_5: 0.001, RVol_60: 0.001, VolRatio: 1, TrendEfficiency: 0, TrendSign: 0,
    BurstFlag: false, LiquidityGuard: false, PivotReversal: 12, eventSizeP99: 10, eventSizeP10: 1, volumeDay: 0, ...over,
  };
}

function stubFeatures(ExitTime: number): ExcursionFeatures {
  return {
    SpikeSize: 2, ApproachVolume: 10, RejectVolume: 10, ApproachDuration: 1, RejectDuration: 1, ApproachSpeed: 1,
    RejectSpeed: 1, SpeedAsymmetry: 0, ApproachImbalance: 0.5, RejectImbalance: 0.5, VolumeBurst: 1, TopDwell: 0.1,
    RetraceFraction: 0.8, MaxTradeSize: 1, MaxAggressorRun: 3, MaxPrintGap: 0.1, EnterTime: ExitTime - 2000,
    ExitTime, Anchor: 0, BandEdge: 0, retraceAvailableAt: ExitTime,
  };
}

export interface LevelOptions {
  readonly side?: Side;
  readonly WickStrength?: number;
  readonly VolUnit?: Ticks;
  readonly PriorTouches?: number;
  readonly pivotId?: number;
  readonly cls?: PivotClass;
  readonly phase?: ScoredResolution['phase'];
}

// Scripted LevelBook driver over a stub context. Prices, sides, aggressor
// signs and TrendSign are written for the canonical orientation; with
// `mirror = c` every input is mapped p → 2c − p, side → −side, s → −s,
// TrendSign → −TrendSign (Spec §3.12), so a script run twice checks symmetry.
// The port defaults to a RecordingPort; `options.port` plugs in the real
// ExecutionModel, which then sees every print first (Spec §3.10 step 5) and
// owns killSwitchActive.
export interface ScriptPort extends ExecutionPort {
  onPrint?(e: MergedEvent): void;
  readonly killSwitch?: { readonly active: boolean };
}

export interface ScriptOptions<P extends ScriptPort> {
  readonly MinStrength?: number;
  readonly mirror?: number;
  readonly port?: (ctx: LevelContext) => P;
}

export class LevelScript<P extends ScriptPort = RecordingPort> {
  readonly ctx: { -readonly [K in keyof LevelContext]: LevelContext[K] };
  readonly store = new PivotStore();
  readonly port: P;
  readonly book: LevelBook;
  readonly mirror: number | null;
  pendingPivot: Pivot | null = null;
  private nextPivotId = 0;
  private k = 0;
  private frozenOver: Partial<FrozenStats> = {};

  constructor(cfg: Partial<LevelBookConfig> = {}, options: ScriptOptions<P> = {}, readonly frozenBase: Partial<FrozenStats> = {}) {
    this.mirror = options.mirror ?? null;
    this.ctx = {
      t: 0, seq: -1, Vol: 0, BucketVolume: 10, frozen: this.frozenFor({}), inBlacklist: false, killSwitchActive: false,
    };
    this.port = options.port?.(this.ctx) ?? (new RecordingPort() as unknown as P);
    const ks = this.port.killSwitch;
    if (ks) Object.defineProperty(this.ctx, 'killSwitchActive', { get: () => ks.active });
    this.book = new LevelBook({ ...LEVEL_CFG, ...cfg }, this.store, this.port, this.ctx, { MinStrength: options.MinStrength ?? 0 });
  }

  px(p: Ticks): Ticks { return this.mirror === null ? p : 2 * this.mirror - p; }
  sd(side: Side): Side { return this.mirror === null ? side : (-side as Side); }

  private frozenFor(over: Partial<FrozenStats>): FrozenStats {
    const merged = { ...this.frozenBase, ...over };
    if (this.mirror !== null && merged.TrendSign !== undefined) merged.TrendSign = -merged.TrendSign + 0;
    return stubFrozen({ k: this.k - 1, ...merged });
  }

  private advance(dt = 1000): void {
    this.ctx.t += dt;
    this.ctx.seq += 1;
  }

  // Registers a WickLevel (or feeds another class) through onPendingResolved.
  level(price: Ticks, o: LevelOptions = {}): Level | null {
    this.advance();
    const pivotId = o.pivotId ?? this.nextPivotId++;
    this.nextPivotId = Math.max(this.nextPivotId, pivotId + 1);
    const piv = this.pivot(price, o.side ?? 1, pivotId);
    const WickStrength = o.WickStrength ?? 0.7;
    const cls = o.cls ?? 'WickLevel';
    const features = cls === 'Unresolved' ? null : stubFeatures(this.ctx.t);
    const gate = { cls, failed: [], classifiedAt: this.ctx.t };
    if (!this.store.has(pivotId)) this.store.add(piv, features, gate, null, WickStrength, NaN, -1, null, o.VolUnit ?? 10, this.ctx.Vol);
    const r: ScoredResolution = {
      pivot: piv, gate, features, featuresAvailable: features !== null, phase: o.phase ?? 'complete', note: null,
      VolUnit_created: o.VolUnit ?? 10, BucketVolume_c: 10, rvolTicks: 1, exitVol: this.ctx.Vol, resolvedVol: this.ctx.Vol,
      resolvedAt: this.ctx.t, EnterTime: features?.EnterTime ?? NaN,
      PriorTouches: o.PriorTouches ?? 0, ranks: null, WickStrength_0: WickStrength, WickStrength_B: NaN,
    };
    return this.book.onPendingResolved(r);
  }

  pivot(price: Ticks, side: Side = 1, pivotId = this.nextPivotId++): Pivot {
    const s = this.sd(side);
    return {
      kind: s === 1 ? 'PivotHigh' : 'PivotLow', side: s, price: this.px(price), time: this.ctx.t - 500, seq: this.ctx.seq,
      confirmed_at: this.ctx.t, confirmedSeq: this.ctx.seq, confirmedVol: this.ctx.Vol, pivotId,
    };
  }

  // A zigzag pivot arriving on the *next* print (Spec §3.10 step 7 precedes step 9).
  pivotNext(price: Ticks, side: Side = 1): Pivot {
    this.pendingPivot = this.pivot(price, side);
    return this.pendingPivot;
  }

  print(p: Ticks, q = 1, s: Side = 1): MergedEvent { return this.printAt(1000, p, q, s); }

  // A print `dt` ms after the previous one (0 = same millisecond, next seq).
  printAt(dt: number, p: Ticks, q = 1, s: Side = 1): MergedEvent {
    this.advance(dt);
    this.ctx.Vol += q;
    const e: MergedEvent = { t: this.ctx.t, seq: this.ctx.seq, p: this.px(p), q, s: this.sd(s), n: 1 };
    this.port.onPrint?.(e);
    if (this.pendingPivot) {
      const piv = { ...this.pendingPivot, confirmed_at: e.t, confirmedSeq: e.seq, confirmedVol: this.ctx.Vol };
      this.pendingPivot = null;
      this.book.onPivot(piv);
    }
    this.book.onPrint(e);
    return e;
  }

  prints(...ps: Ticks[]): void { for (const p of ps) this.print(p); }

  // Bucket close with new frozen stats (applies to this and later prints).
  close(over: Partial<FrozenStats> = {}): void {
    this.frozenOver = { ...this.frozenOver, ...over };
    this.k++;
    this.ctx.frozen = this.frozenFor(this.frozenOver);
    this.book.onBucketClose(this.k - 1);
  }

  get log(): string[] {
    return this.book.transitions.map((r) => `${r.levelId}: ${r.from} → ${r.to} (${r.reason})`);
  }

  state(levelId: number): string { return this.book.byId(levelId)!.State; }
}
