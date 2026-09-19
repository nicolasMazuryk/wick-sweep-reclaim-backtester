import type { RunConfig } from './config.js';
import { assert, invariantFailed } from './invariant.js';
import {
  type AgeClock, isActiveState, isTerminalState, type Level, levelAge, levelGeometry, levelRelevance, type LevelState,
  SUPPRESS_REASONS, type SuppressReason, transitionAllowed, type TransitionRecord, transitionKey,
} from './level.js';
import { ceilTicksConservative, floorTicksConservative } from './numerics.js';
import type { ScoredResolution } from './pivot-pipeline.js';
import type { PivotStore } from './pivot-store.js';
import type { FrozenStats } from './stats.js';
import type { Lots, MergedEvent, Ms, Pivot, Side, Ticks } from './types.js';

export interface LevelBookConfig {
  readonly MergeTolerance: number;
  readonly MinSweepMult: number;
  readonly BreakoutMult: number;
  readonly AgeScale: number;
  readonly MaxAge: number;
  readonly ageClock: AgeClock;
  readonly DistanceScale: number;
  readonly ArmMode: 'RestEarly' | 'ArmOnApproach';
  readonly ArmDistance: number;
  readonly MinReturnSpeed: number;
  readonly TriggerOffset: number;
  readonly StopOffset: number;
  readonly TargetMult: number;
  readonly targetMode: 'sweepDepth' | 'volUnit' | 'market' | 'twoStage';
  readonly TargetUnits: number;             // targetMode volUnit (§6.5)
  readonly timeStop: boolean;
  readonly MaxHold: number;
  readonly MaxUses: number;
  readonly MaxSweeps: number;
  readonly MaxPending: number;
  readonly RetraceWindow: number;
  readonly counterTrendBlock: boolean;
  readonly strengthModel: 'stageA' | 'stageB';
  // Spec §11.3 `test.targetOnTouch`: tests / `--synthetic` only (EngineTestOptions); never set from RunConfig.
  readonly targetOnTouch?: boolean;
}

export function levelBookConfigFrom(cfg: RunConfig): LevelBookConfig {
  return {
    MergeTolerance: cfg.MergeTolerance, MinSweepMult: cfg.MinSweepMult, BreakoutMult: cfg.BreakoutMult,
    AgeScale: cfg.AgeScale, MaxAge: cfg.MaxAge, ageClock: cfg.ageClock, DistanceScale: cfg.DistanceScale,
    ArmMode: cfg.ArmMode, ArmDistance: cfg.ArmDistance, MinReturnSpeed: cfg.MinReturnSpeed,
    TriggerOffset: cfg.TriggerOffset, StopOffset: cfg.StopOffset, TargetMult: cfg.TargetMult, targetMode: cfg.targetMode,
    TargetUnits: cfg.TargetUnits,
    timeStop: cfg.timeStop, MaxHold: cfg.MaxHold, MaxUses: cfg.MaxUses, MaxSweeps: cfg.MaxSweeps,
    MaxPending: cfg.MaxPending, RetraceWindow: cfg.RetraceWindow, counterTrendBlock: cfg.counterTrendBlock,
    strengthModel: cfg.strengthModel, targetOnTouch: false,
  };
}

// Read-only engine state (same pattern as FeatureContext). `t`/`seq` are the
// print being processed; `frozen` is as of the last bucket close (L5).
export interface LevelContext {
  readonly t: Ms;
  readonly seq: number;
  readonly Vol: Lots;
  readonly BucketVolume: Lots;
  readonly frozen: FrozenStats;
  readonly inBlacklist: boolean;            // Spec §2.6.3
  readonly killSwitchActive: boolean;       // Spec §4.6, for the current volumeDay
  // RejectSpeed of a pivot, known from its ExitTime on (pending or stored); NaN
  // when unknown (merged / unresolved / not yet rejected). Default: PivotStore features.
  readonly rejectSpeedOf?: (pivotId: number) => number;
}

export type ExitKind = 'stop' | 'target' | 'time' | 'killSwitch' | 'tickChange';

// LevelBook decides every Spec §3.9.6 transition (including trigger and exit
// detection); prices, sizes and fills live behind this port (ExecutionModel +
// Sizing, build step 7).
export interface ExecutionPort {
  // Spec §4.4 ex-ante RoundTripCost in ticks at price p (MinSweepDepth floor).
  roundTripCostTicks(p: Ticks): Ticks;
  // Entry stop-market at TriggerPrice (raw), sized at the fold's MinStrength.
  // Returns the order id, or −1 when sizing yields Qty < 1 lot (suppressed
  // `minQty`, Spec §4.7).
  arm(level: Readonly<Level>, TriggerPrice: Ticks, MinStrength: number): number;
  cancelEntry(level: Readonly<Level>): void;
  // StopLoss cancel–replace after a re-sweep re-confirmation (Spec §4.3.3).
  replaceStop(level: Readonly<Level>): void;
  // Trigger print (never a fill print, §9.5). Returns the tradeId.
  enter(level: Readonly<Level>, e: MergedEvent): number;
  exit(level: Readonly<Level>, kind: ExitKind, e: MergedEvent): void;
  // targetMode twoStage (§6.5): the first half exits at Target1 on print e.
  // Returns the new StopLoss (EntryFill), or −1 when the position is too small
  // to split (A-87: it then runs as one leg with the stop unchanged).
  partialExit(level: Readonly<Level>, e: MergedEvent): Ticks | -1;
  // StopLoss / Target exist once the entry fill has resolved (OCO placed on
  // the entry fill print, A-36); before that no exit can trigger.
  exitsLive(level: Readonly<Level>): boolean;
  // Prints of the entry fill window after the fill print that were seen
  // before the fill resolved; StopLoss / Target were already live on them
  // (A-36). Returned once, on the first check after the entry resolves.
  takePrintsAfterEntryFill(level: Readonly<Level>): ReadonlyArray<MergedEvent>;
  // No position and no entry or exit fill in flight (one position per symbol).
  flat(): boolean;
}

const COUNTER_TREND_TE = 0.4;
const COUNTER_TREND_MARGIN = 0.15;
const VIOLENT_RETURN_IMBALANCE = 0.2;   // §8.6
const TWO_STAGE_FIRST_MULT = 1;         // §6.5 two-stage exit: first half at 1·SweepDepth
const REGIME_MIN = 0.4;
const REGIME_MAX = 2.5;

type CheckReason = (typeof SUPPRESS_REASONS)[number];
// Counter keys are built once per reason, never per print (Spec §10).
const perReason = <T>(f: (r: CheckReason, j: number) => T): Record<CheckReason, T> =>
  Object.fromEntries(SUPPRESS_REASONS.map((r, j) => [r, f(r, j)])) as Record<CheckReason, T>;
const BIT = perReason((_, j) => 1 << j);
const bit = (r: SuppressReason): number => BIT[r as CheckReason];
const firstReason = (mask: number): SuppressReason => SUPPRESS_REASONS[31 - Math.clz32(mask & -mask)]!;
// Checks evaluated only while SWEEP_CONFIRMED (a live entry is not pulled by them).
const ARM_ONLY = bit('costFloor') | bit('approach');
// Spec §5 names for the first-reason counters of §8.4 / §8.9; the rest stay `suppress.<reason>`.
const SUPPRESS_COUNTER: Record<CheckReason, string> = { ...perReason((r) => `suppress.${r}`), conflict: 'conflictSuppressed', nested: 'suppressedNested' };
const BOUND_COUNTER = perReason((r) => `bound.${r}`);
const UNARMED_IN_RESWEEP_COUNTER = perReason((r) => `unarmedInResweep.${r}`);
const MISSED_RECLAIM_COUNTER: Record<SuppressReason, string> = { ...perReason((r) => `missedReclaim.${r}`), none: 'missedReclaim.none' };
const PRIOR_TOUCHES_COUNTER = ['priorTouchesHist.0', 'priorTouchesHist.1', 'priorTouchesHist.2', 'priorTouchesHist.3+'] as const;

// Reused list of levels (no per-print allocation, Spec §10): `clear()` keeps
// the backing store, whereas `length = 0` releases it and the next push reallocates.
class LevelList {
  readonly items: Level[] = [];
  size = 0;

  clear(): void { this.size = 0; }
  push(l: Level): void { this.items[this.size++] = l; }

  includes(l: Level): boolean {
    for (let i = 0; i < this.size; i++) if (this.items[i] === l) return true;
    return false;
  }

  // In-place insertion sort (stable): the lists hold a few dozen levels and
  // Array.prototype.sort allocates a work array per call.
  sort(cmp: (x: Level, y: Level) => number): void {
    const a = this.items;
    for (let i = 1; i < this.size; i++) {
      const x = a[i]!;
      let j = i - 1;
      while (j >= 0 && cmp(a[j]!, x) > 0) {
        a[j + 1] = a[j]!;
        j--;
      }
      a[j + 1] = x;
    }
  }
}

const byLevelId = (x: Level, y: Level): number => x.levelId - y.levelId;

// splice(i, 1) / splice(i, 0, l) without the removed-elements array splice allocates.
function removeAt(a: Level[], i: number): void {
  for (let j = i + 1; j < a.length; j++) a[j - 1] = a[j]!;
  a.length--;
}

function insertAt(a: Level[], i: number, l: Level): void {
  a.push(l);
  for (let j = a.length - 1; j > i; j--) a[j] = a[j - 1]!;
  a[i] = l;
}

function sideIndex(side: Side): 0 | 1 { return side === 1 ? 0 : 1; }

export interface LevelBookSnapshot {
  readonly levels: Level[];
  readonly transitions: TransitionRecord[];
  readonly counters: Record<string, number>;
  readonly MinStrength: number;
  readonly openTradeLevelId: number;
  readonly lastClosedK: number;
}

// Spec §3.9: registration, merge, nested / sweep-leg rules, arming checks a–i
// and the §3.9.6 transition table, written once in side-normalised space
// (Spec §3.12: pN = Side·p, wN = Side·WickLevel, sN = Side·SweepExtreme,
// rN = Side·SweepRunningMax). Levels on one print are processed in levelId
// order and armed in rank order, so a mirrored path yields the same log.
export class LevelBook {
  private readonly levels: Level[] = [];                  // every level ever created, by levelId
  private readonly bySide: [Level[], Level[]] = [[], []]; // live, sorted by Side·WickLevel ascending
  private readonly active: Level[] = [];                  // live levels in ACTIVE_STATES, by levelId
  // Reused scratch lists, one user each.
  private readonly scan = new LevelList();
  private readonly candidates = new LevelList();
  private readonly armedScratch = new LevelList();        // enter, reevaluateArmed
  private readonly armedTry = new LevelList();            // tryArm
  private readonly losers = new LevelList();              // tryArm; reasons in loserReasons
  private readonly loserReasons: SuppressReason[] = [];
  private readonly innerScratch = new LevelList();        // onPendingResolved
  private readonly liveScratch = new LevelList();         // liveById
  private rankPrint: MergedEvent | null = null;           // print of the running armCandidates sort
  private readonly rankCmp = (a: Level, b: Level): number => this.compareRank(a, b, this.rankPrint!);
  private readonly pivotThisPrint: [number, number] = [-1, -1];
  private trade: Level | null = null;
  private readonly log: TransitionRecord[] = [];
  private readonly counterMap = new Map<string, number>();
  private MinStrength: number;
  private lastClosedK = -1;
  private readonly lostToKillSwitch = new Set<number>();   // levels counted in tradesLostToKillSwitch

  constructor(
    private readonly cfg: LevelBookConfig,
    private readonly store: PivotStore,
    private readonly exec: ExecutionPort,
    private readonly ctx: LevelContext,
    options: { readonly MinStrength?: number } = {},
  ) {
    this.MinStrength = options.MinStrength ?? 0;
  }

  // Fold-scoped (Spec §3.7.5): the engine / backtest sets it at testStart.
  setMinStrength(x: number): void { this.MinStrength = x; }

  get transitions(): ReadonlyArray<TransitionRecord> { return this.log; }

  get counters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of [...this.counterMap.keys()].sort()) out[key] = this.counterMap.get(key)!;
    return out;
  }

  byId(levelId: number): Level | undefined { return this.levels[levelId]; }
  live(side: Side): ReadonlyArray<Level> { return this.bySide[sideIndex(side)]; }
  armed(): ReadonlyArray<Level> { return this.levels.filter((l) => l.OrderIds.entry >= 0); }
  openTrade(): Level | null { return this.trade; }

  // ---------------------------------------------------------------- pivots

  // Spec §3.9.4 merge check. Returns true when `piv` merged into a WICK_ACTIVE
  // level (the engine then skips ExcursionFeatures.open). Every pivot is also
  // remembered for this print as the candidate `sweepPivotId` of its side.
  onPivot(piv: Pivot): boolean {
    const side = piv.side;
    this.pivotThisPrint[sideIndex(side)] = piv.pivotId;
    let best: Level | null = null;
    let bestGap = Infinity;
    for (const l of this.bySide[sideIndex(side)]) {
      if (l.State !== 'WICK_ACTIVE') continue;
      const gap = Math.abs(piv.price - l.WickLevel);
      if (gap <= ceilTicksConservative(this.cfg.MergeTolerance * l.VolUnit_created) && (gap < bestGap || (gap === bestGap && l.levelId < best!.levelId))) {
        best = l;
        bestGap = gap;
      }
    }
    if (best === null) return false;
    best.PriorTouches += 1;                                                     // A-26
    if (side * piv.price > side * best.WickLevel) {
      this.removeLive(best);
      best.WickLevel = piv.price;                                               // outward only (§3.1)
      this.insertLive(best);
    }
    this.store.add(piv, null, { cls: 'Merged', failed: [], classifiedAt: piv.confirmed_at }, null, NaN, NaN, best.levelId, null, NaN, piv.confirmedVol);
    this.move(best, 'WICK_ACTIVE', 'merge');
    return true;
  }

  // Spec §3.9.4 `register` on cls == WickLevel; other classes create no level.
  onPendingResolved(r: ScoredResolution): Level | null {
    if (r.gate.cls !== 'WickLevel' || r.phase === 'featuresFinal') return null;
    const piv = r.pivot;
    const side = piv.side;
    const geometry = levelGeometry(
      this.cfg, r.VolUnit_created, this.ctx.frozen.SpreadEst_t, this.exec.roundTripCostTicks(piv.price),
    );
    const level: Level = {
      levelId: this.levels.length, pivotId: piv.pivotId, Side: side, WickLevel: piv.price,
      VolUnit_created: r.VolUnit_created,
      WickStrength: this.cfg.strengthModel === 'stageA' ? r.WickStrength_0 : r.WickStrength_B,
      WickStrength_0: r.WickStrength_0, WickStrength_B: r.WickStrength_B,
      State: 'PIVOT_PENDING', stateSince: this.ctx.t, stateReason: 'pending',
      createdAt: r.gate.classifiedAt, ExitTime: r.features!.ExitTime, exitVol: r.exitVol,
      SweepExtreme: -1, SweepDepth: -1, SweepRunningMax: -1, sweepStartVol: -1, sweepExtremeVol: -1,
      sweepLegDurationBuckets: NaN, sweepPivotId: -1, WickStrength_sweep: NaN,
      PriorTouches: r.PriorTouches, SweepCount: 0, UseCount: 0,
      MinSweepDepth: geometry.MinSweepDepth, BreakoutDepth: geometry.BreakoutDepth,
      minSweepFloorBinding: geometry.minSweepFloorBinding,
      OrderIds: { entry: -1, stop: -1, limit: -1 }, suppressed: 'none', suppressedMask: 0,
      regimeAtArm: null, sizeHalved: false, ReturnSpeed: NaN, ReturnImbalance: NaN, RejectSpeed_sweep: NaN, returnSq: 0, returnQ: 0,
      StopLoss: -1, Target: -1, Target1: -1, target1Done: false, entryVol: -1, tradeId: -1, trades: [], retireAfterClose: false, reclaimVol: -1, reclaimBelowQ: 0,
    };
    this.levels.push(level);
    this.bump(`minSweepFloor.${geometry.minSweepFloorBinding}`);
    const wN = side * level.WickLevel;
    // Rule 2 (§8.4, A-23, A-24): a new outer level retires WICK_ACTIVE inner ones.
    const inner = this.innerScratch;
    inner.clear();
    for (const m of this.bySide[sideIndex(side)]) inner.push(m);
    for (let i = 0; i < inner.size; i++) {
      const m = inner.items[i]!;
      if (m.State !== 'WICK_ACTIVE' || !this.nested(level, m)) continue;
      if (wN > side * m.WickLevel) {
        this.move(m, 'RETIRED', 'nestedInner');
        this.bump('retiredNestedInner');
      }
    }
    // Rule 3 (§8.5, A-25): the pivot is an open setup's sweep extreme.
    for (const m of this.active) {
      if (m.sweepPivotId === piv.pivotId && m.State !== 'SWEEPING' && level.WickStrength > m.WickStrength) {
        m.WickStrength_sweep = level.WickStrength;
        this.bump('sweepLegStrongerSpike');
      }
    }
    this.store.setLevelId(piv.pivotId, level.levelId);
    this.move(level, 'WICK_ACTIVE', 'register');
    return level;
  }

  // ---------------------------------------------------------------- per print

  // Spec §3.10 step 9: IN_TRADE exits, then per-level rows in levelId order,
  // then re-evaluation of armed levels and arming of SWEEP_CONFIRMED ones.
  onPrint(e: MergedEvent): void {
    // Set.clear allocates a fresh table even when empty.
    if (this.lostToKillSwitch.size > 0 && !this.ctx.killSwitchActive) this.lostToKillSwitch.clear();
    if (this.trade !== null) this.checkExits(this.trade, e);
    this.collectScan(e.p);
    const scan = this.scan;
    for (let i = 0; i < scan.size; i++) {
      const l = scan.items[i]!;
      if (l.State !== 'IN_TRADE' && !isTerminalState(l.State)) this.step(l, e);
    }
    this.reevaluateArmed(e);
    this.armCandidates(e);
    this.pivotThisPrint[0] = -1;
    this.pivotThisPrint[1] = -1;
    let open = 0;
    for (const l of this.active) if (l.State === 'IN_TRADE') open++;
    assert(open === (this.trade === null ? 0 : 1), 'LevelBook: #openTrades ≤ 1 (onePositionPerSymbol)');
  }

  // Spec §3.9.2: WICK_ACTIVE levels within DistanceScale plus every active
  // level; sorted by levelId. A WICK_ACTIVE transition needs pN ≥ wN +
  // min(MinSweepDepth, BreakoutDepth) with both depths ≥ 0, so levels with
  // wN > pN are dormant on this print and skipping them changes nothing.
  private collectScan(p: Ticks): void {
    const scan = this.scan;
    scan.clear();
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const bound = side * p;
      const levels = this.bySide[s]!;
      for (let i = 0; i < levels.length; i++) {
        const l = levels[i]!;
        if (side * l.WickLevel > bound) break;
        if (l.State === 'WICK_ACTIVE') scan.push(l);
      }
    }
    const active = this.active;
    for (let i = 0; i < active.length; i++) scan.push(active[i]!);
    scan.sort(byLevelId);
  }

  private step(l: Level, e: MergedEvent): void {
    const side = l.Side;
    const pN = side * e.p;
    const wN = side * l.WickLevel;
    const cfg = this.cfg;
    switch (l.State) {
      case 'WICK_ACTIVE':
        if (l.UseCount >= 1 && pN > wN + l.BreakoutDepth) this.move(l, 'RETIRED', 'breakoutAfterUse');
        else if (pN >= wN + l.BreakoutDepth) this.move(l, 'INVALIDATED', 'breakout');
        else if (pN >= wN + l.MinSweepDepth) {
          l.SweepCount = 1;
          this.startSweep(l, e);
          this.move(l, 'SWEEPING', 'sweep');
        }
        return;
      case 'SWEEPING': {
        this.trackReturn(l, e);
        const rN = side * l.SweepRunningMax;
        if (rN > wN + l.BreakoutDepth) this.terminate(l, 'INVALIDATED', 'breakout');
        else if (l.OrderIds.entry >= 0 && this.canEnter() && pN <= wN - cfg.TriggerOffset) this.enter(l, e);     // A-30
        else if (pN <= rN - this.ctx.frozen.PivotReversal) this.confirm(l);                                      // A-28
        return;
      }
      case 'SWEEP_CONFIRMED':
        this.trackReturn(l, e);
        if (pN > wN + l.BreakoutDepth) this.move(l, 'INVALIDATED', 'breakout');
        else if (pN > side * l.SweepExtreme) this.resweep(l, e);
        else {
          if (l.suppressed === 'killSwitch' && pN <= wN - cfg.TriggerOffset && !this.lostToKillSwitch.has(l.levelId)) {
            this.lostToKillSwitch.add(l.levelId);                                // would have triggered (Spec §5)
            this.bump('tradesLostToKillSwitch');
          }
          if (pN <= wN && l.reclaimVol < 0) {                                  // reclaimed without an order (A-29)
            l.reclaimVol = this.ctx.Vol;
            l.reclaimBelowQ = 0;
            this.bump(MISSED_RECLAIM_COUNTER[l.suppressed]);
            // §8.6: a slow drift is skipped under ArmOnApproach (only the speed test held it back).
            if (cfg.ArmMode === 'ArmOnApproach' && (l.suppressedMask & ~bit('approach')) === 0 && !(this.returnSpeed(l, e) >= cfg.MinReturnSpeed)) {
              this.bump('skippedSlowReclaim');
            }
            this.move(l, 'SWEEP_CONFIRMED', 'missedReclaim');
          }
          // A-29: the cancel timer runs on RetraceWindow buckets traded at or below W.
          if (l.reclaimVol >= 0 && pN <= wN) l.reclaimBelowQ += e.q;
          if (l.reclaimVol >= 0 && l.reclaimBelowQ >= cfg.RetraceWindow * this.ctx.BucketVolume) {
            this.move(l, 'CANCELLED', 'missedReclaim');
          }
        }
        return;
      case 'ORDER_ARMED':
        this.trackReturn(l, e);
        if (pN > wN + l.BreakoutDepth) this.terminate(l, 'INVALIDATED', 'breakout');
        else if (pN > side * l.SweepExtreme) this.resweep(l, e);              // entry stop unchanged (§7.5)
        else if (this.canEnter() && pN <= wN - cfg.TriggerOffset) this.enter(l, e);
        return;
      default:
        return;
    }
  }

  private startSweep(l: Level, e: MergedEvent): void {
    l.SweepRunningMax = e.p;
    l.sweepStartVol = this.ctx.Vol;
    l.sweepExtremeVol = this.ctx.Vol;
    l.returnSq = 0;
    l.returnQ = 0;
    l.reclaimVol = -1;
    l.reclaimBelowQ = 0;
  }

  // R = max(R, P) with sweepExtremeVol; otherwise accumulate the return leg (§8.6).
  private trackReturn(l: Level, e: MergedEvent): void {
    if (l.State === 'SWEEPING' && l.Side * e.p > l.Side * l.SweepRunningMax) {
      l.SweepRunningMax = e.p;
      l.sweepExtremeVol = this.ctx.Vol;
      l.returnSq = 0;
      l.returnQ = 0;
    } else {
      l.returnSq += e.s * e.q;
      l.returnQ += e.q;
    }
  }

  private confirm(l: Level): void {
    const side = l.Side;
    if (!(this.ctx.Vol > l.sweepExtremeVol)) invariantFailed(`LevelBook: level ${l.levelId} confirmed SweepExtreme on the SweepRunningMax print (L4)`);
    l.SweepExtreme = l.SweepRunningMax;
    l.SweepDepth = side * (l.SweepExtreme - l.WickLevel);
    l.sweepLegDurationBuckets = (this.ctx.Vol - l.sweepStartVol) / this.ctx.BucketVolume;
    l.sweepPivotId = this.pivotThisPrint[sideIndex(side)];
    if (l.OrderIds.entry >= 0) {                                                // re-confirmed with the entry live (A-30)
      this.setExits(l);
      this.exec.replaceStop(l);
      this.move(l, 'ORDER_ARMED', 'reconfirm');
    } else {
      this.move(l, 'SWEEP_CONFIRMED', 'confirm');
    }
  }

  private resweep(l: Level, e: MergedEvent): void {
    l.SweepCount += 1;
    this.bump('resweeps');
    if (l.SweepCount >= this.cfg.MaxSweeps) {
      this.bump('invalidatedMaxSweeps');
      this.terminate(l, 'INVALIDATED', 'maxSweeps');
      return;
    }
    this.startSweep(l, e);
    this.move(l, 'SWEEPING', 'resweep');
  }

  // StopLoss = S + StopOffset (§6.4). Target = W − floor(TargetMult·SweepDepth)
  // (sweepDepth / market / twoStage final leg) or W − floor(TargetUnits·VolUnit_created)
  // (volUnit, §6.5); twoStage adds Target1 = W − floor(1·SweepDepth) (§6.5).
  private setExits(l: Level): void {
    if (l.SweepExtreme === -1) invariantFailed(`LevelBook: level ${l.levelId} read SweepExtreme before confirmation (L4)`);
    const cfg = this.cfg;
    const side = l.Side;
    const wN = side * l.WickLevel;
    l.StopLoss = side * (side * l.SweepExtreme + cfg.StopOffset);
    const dist = cfg.targetMode === 'volUnit' ? cfg.TargetUnits * l.VolUnit_created : cfg.TargetMult * l.SweepDepth;
    l.Target = side * (wN - floorTicksConservative(dist));
    l.Target1 = cfg.targetMode === 'twoStage' ? side * (wN - floorTicksConservative(TWO_STAGE_FIRST_MULT * l.SweepDepth)) : -1;
  }

  private enter(l: Level, e: MergedEvent): void {
    this.recordReturn(l, e);
    this.recordReclaim(l);
    l.tradeId = this.exec.enter(l, e);
    l.trades.push(l.tradeId);
    l.OrderIds.entry = -1;
    l.entryVol = this.ctx.Vol;
    this.trade = l;
    this.move(l, 'IN_TRADE', 'trigger');
    // §8.9 / Spec §4.6 corridor cancellation, then check (e) un-arms the rest.
    const lo = Math.min(l.Target, l.StopLoss);
    const hi = Math.max(l.Target, l.StopLoss);
    const armed = this.armedById(this.armedScratch);
    for (let i = 0; i < armed.size; i++) {
      const k = armed.items[i]!;
      if (k.Side !== l.Side && k.State === 'ORDER_ARMED' && k.WickLevel >= lo && k.WickLevel <= hi) {
        this.bump('cancelledConflictFilled');
        this.terminate(k, 'CANCELLED', 'conflictFilled');
      } else {
        this.unarm(k, this.staticChecks(k, e) & ~ARM_ONLY);                  // includes `position`
      }
    }
  }

  private canEnter(): boolean {
    return this.trade === null && this.exec.flat();
  }

  private checkExits(l: Level, e: MergedEvent): void {
    if (!this.exec.exitsLive(l)) return;
    // Prints inside the entry fill window after the fill: stop / target only,
    // in Spec §4.3.2 priority; the first crossing print is the exit trigger.
    const after = this.exec.takePrintsAfterEntryFill(l);
    for (let i = 0; i < after.length; i++) {                                    // index loop: no iterator per print
      const b = after[i]!;
      const kind = this.priceExit(l, b);
      if (kind !== null) {
        this.closeTrade(l, kind, b);
        return;
      }
    }
    const cfg = this.cfg;
    const timeStop = cfg.timeStop && (this.ctx.Vol - l.entryVol) / this.ctx.BucketVolume >= cfg.MaxHold * l.sweepLegDurationBuckets;
    const kind: ExitKind | null = this.priceExit(l, e) ?? (timeStop ? 'time' : this.ctx.killSwitchActive ? 'killSwitch' : null);
    if (kind === null) return;
    this.closeTrade(l, kind, e);
  }

  // StopLoss trigger, then the Target touch / conservative rule (§7.3, §4.3.2).
  // twoStage: the first leg (Target1, same limit rule) is taken in between and
  // the rest re-checked on the same print against the moved stop.
  private priceExit(l: Level, e: MergedEvent): 'stop' | 'target' | null {
    const side = l.Side;
    const pN = side * e.p;
    if (pN >= side * l.StopLoss) return 'stop';
    if (l.Target1 !== -1 && !l.target1Done && this.limitReached(pN, side * l.Target1)) {
      const stop = this.exec.partialExit(l, e);
      l.target1Done = true;
      if (stop !== -1) l.StopLoss = stop;
      this.move(l, 'IN_TRADE', 'partialTarget');
      return this.priceExit(l, e);
    }
    if (this.cfg.targetMode === 'market' ? pN <= side * l.Target : this.limitReached(pN, side * l.Target)) return 'target';
    return null;
  }

  // Limit Target, conservative rule: a print strictly beyond by more than one tick (§7.3; touch under test.targetOnTouch).
  private limitReached(pN: Ticks, tN: Ticks): boolean {
    return this.cfg.targetOnTouch ? pN <= tN : pN < tN - 1;
  }

  private closeTrade(l: Level, kind: ExitKind, e: MergedEvent): void {
    const cfg = this.cfg;
    this.exec.exit(l, kind, e);
    this.trade = null;
    l.UseCount += 1;
    this.move(l, 'CLOSED', kind);
    if (l.UseCount >= cfg.MaxUses || l.retireAfterClose) {
      this.move(l, 'RETIRED', 'usesExhausted');
      return;
    }
    l.SweepExtreme = -1;
    l.SweepDepth = -1;
    l.SweepRunningMax = -1;
    l.SweepCount = 0;
    l.OrderIds.entry = -1;
    l.OrderIds.stop = -1;
    l.OrderIds.limit = -1;
    l.StopLoss = -1;
    l.Target = -1;
    l.Target1 = -1;
    l.target1Done = false;
    l.suppressed = 'none';
    l.suppressedMask = 0;
    l.reclaimVol = -1;
    l.reclaimBelowQ = 0;
    this.move(l, 'WICK_ACTIVE', 'reuse');
  }

  // ---------------------------------------------------------------- arming (Spec §3.9.5)

  // Armed live levels by levelId, written into `out`: a snapshot the caller may iterate while un-arming.
  private armedById(out: LevelList): LevelList {
    out.clear();
    for (const l of this.active) if (l.OrderIds.entry >= 0) out.push(l);
    return out;
  }

  // Price-independent checks that can un-arm a live entry (a, c, d, e, f).
  private reevaluateArmed(e: MergedEvent): void {
    const armed = this.armedById(this.armedScratch);
    for (let i = 0; i < armed.size; i++) {
      const l = armed.items[i]!;
      const mask = this.staticChecks(l, e) & ~ARM_ONLY;
      if (mask !== 0) this.unarm(l, mask);
    }
  }

  // Pulls a live entry; the first check of `mask` is the reason, every bit counts (Spec §5).
  private unarm(l: Level, mask: number): void {
    const reason = firstReason(mask);
    this.exec.cancelEntry(l);
    l.OrderIds.entry = -1;
    this.setSuppressed(l, reason, mask, true);
    if (l.State === 'ORDER_ARMED') this.move(l, 'SWEEP_CONFIRMED', reason);
    else this.bump(UNARMED_IN_RESWEEP_COUNTER[reason as CheckReason]);                               // SWEEPING with a live entry (A-30)
  }

  private armCandidates(e: MergedEvent): void {
    const c = this.candidates;
    c.clear();
    for (const l of this.active) if (l.State === 'SWEEP_CONFIRMED') c.push(l);
    if (c.size === 0) return;
    this.rankPrint = e;
    c.sort(this.rankCmp);
    this.rankPrint = null;
    for (let i = 0; i < c.size; i++) {
      const l = c.items[i]!;
      if (l.State === 'SWEEP_CONFIRMED') this.tryArm(l, e);
    }
  }

  // Checks costFloor, a–f (no relational side effects). Bitmask of failures.
  private staticChecks(l: Level, e: MergedEvent): number {
    const cfg = this.cfg;
    const f = this.ctx.frozen;
    const side = l.Side;
    let mask = 0;
    if (l.SweepDepth < l.MinSweepDepth) mask |= bit('costFloor');
    if (!(l.WickStrength >= this.MinStrength)) mask |= bit('minStrength');                                        // a
    if (cfg.ArmMode === 'ArmOnApproach') {                                                                         // b
      const near = side * e.p <= side * l.WickLevel + ceilTicksConservative(cfg.ArmDistance * l.VolUnit_created);
      if (!near || !(this.returnSpeed(l, e) >= cfg.MinReturnSpeed)) mask |= bit('approach');
    }
    if (f.LiquidityGuard) mask |= bit('liquidity');                                                                 // c
    if (this.ctx.inBlacklist) mask |= bit('blacklist');
    if (this.ctx.killSwitchActive) mask |= bit('killSwitch');                                                       // d
    if (this.trade !== null || !this.exec.flat()) mask |= bit('position');                                         // e
    if (this.counterTrend(l) && (cfg.counterTrendBlock || !(l.WickStrength >= this.MinStrength + COUNTER_TREND_MARGIN))) {
      mask |= bit('counterTrendBlocked');                                                                           // f
    }
    return mask;
  }

  private counterTrend(l: Level): boolean {
    const f = this.ctx.frozen;
    return f.TrendEfficiency >= COUNTER_TREND_TE && f.TrendSign === l.Side;
  }

  private tryArm(l: Level, e: MergedEvent): void {
    const cfg = this.cfg;
    const side = l.Side;
    // Re-floor MinSweepDepth by the cost at the current price (Spec §3.9.1).
    const costFloor = 2 * this.exec.roundTripCostTicks(e.p);
    if (costFloor > l.MinSweepDepth) {
      l.MinSweepDepth = costFloor;
      l.minSweepFloorBinding = 'cost';
    }
    let mask = this.staticChecks(l, e);
    // g: conflict with armed opposite-side levels (§8.9).
    const armed = this.armedById(this.armedTry);
    const losers = this.losers;
    const loserReasons = this.loserReasons;
    losers.clear();
    for (let i = 0; i < armed.size; i++) {
      const k = armed.items[i]!;
      if (k.Side === side) continue;
      if (Math.abs(l.WickLevel - k.WickLevel) < 2 * Math.max(l.SweepDepth, k.SweepDepth)) {
        if (this.compareRank(l, k, e) < 0) {
          loserReasons[losers.size] = 'conflict';
          losers.push(k);
        } else mask |= bit('conflict');
      }
    }
    // h: nested armed same-side levels (§8.4).
    for (let i = 0; i < armed.size; i++) {
      const k = armed.items[i]!;
      if (k.Side !== side || !this.nested(l, k)) continue;
      if (this.compareRank(l, k, e) < 0) {
        loserReasons[losers.size] = 'nested';
        losers.push(k);
      } else mask |= bit('nested');
    }
    // i: MaxPending (§7.5) over the armed levels not already losing; `lowest` ranks last.
    let remaining = 0;
    let lowest: Level | null = null;
    for (let i = 0; i < armed.size; i++) {
      const k = armed.items[i]!;
      if (losers.includes(k)) continue;
      remaining++;
      if (lowest === null || this.compareRank(lowest, k, e) <= 0) lowest = k;
    }
    if (remaining >= cfg.MaxPending && lowest !== null) {
      if (l.WickStrength > lowest.WickStrength) {
        loserReasons[losers.size] = 'maxPending';
        losers.push(lowest);
      } else mask |= bit('maxPending');
    }
    if (mask !== 0) {
      this.setSuppressed(l, firstReason(mask), mask, false);
      return;
    }
    this.noteChecks(l, 0, false);
    // A-29: a reclaimed setup is consumed; only a re-sweep (startSweep) makes it eligible again.
    if (l.reclaimVol >= 0) return;
    const counterTrend = this.counterTrend(l);
    const f = this.ctx.frozen;
    l.regimeAtArm = { TrendEfficiency: f.TrendEfficiency, TrendSign: f.TrendSign, counterTrend };
    l.sizeHalved = counterTrend;
    this.recordReturn(l, e);
    this.setExits(l);
    const orderId = this.exec.arm(l, side * (side * l.WickLevel - cfg.TriggerOffset), this.MinStrength);
    if (orderId < 0) {
      this.setSuppressed(l, 'minQty', bit('minQty'), false);
      return;
    }
    for (let i = 0; i < losers.size; i++) {
      const k = losers.items[i]!;
      if (k.OrderIds.entry >= 0) this.unarm(k, bit(loserReasons[i]!));
    }
    if (counterTrend) {
      this.bump('counterTrendAllowed');                                       // §8.1: WickStrength ≥ MinStrength + 0.15
      this.bump('counterTrendHalved');
    }
    l.OrderIds.entry = orderId;
    l.suppressed = 'none';
    l.suppressedMask = 0;
    this.move(l, 'ORDER_ARMED', 'arm');
  }

  // Counts a suppression when its first reason changes (`suppress.*`,
  // conflictSuppressed, suppressedNested); `pulled` = a live entry was cancelled.
  private setSuppressed(l: Level, reason: SuppressReason, mask: number, pulled: boolean): void {
    if (l.suppressed !== reason) this.bump(SUPPRESS_COUNTER[reason as CheckReason]);
    this.noteChecks(l, mask, pulled);
    l.suppressed = reason;
  }

  // "Would also have bound" (Spec §5 last paragraph): every evaluation — an
  // arming attempt or the re-check of a live entry — stores the full failing
  // mask; each check counts once per binding episode (it fails now and did not
  // at the level's previous evaluation), so the counts are order-independent.
  private noteChecks(l: Level, mask: number, pulled: boolean): void {
    const fresh = mask & ~l.suppressedMask;
    l.suppressedMask = mask;
    if (fresh === 0) return;
    for (let j = 0; j < SUPPRESS_REASONS.length; j++) if (fresh & (1 << j)) this.bump(BOUND_COUNTER[SUPPRESS_REASONS[j]!]);
    if (fresh & bit('liquidity')) this.bump(pulled ? 'ordersPulledLiquidity' : 'armsBlockedLiquidity');   // §8.8
    if ((fresh & bit('counterTrendBlocked')) && !this.cfg.counterTrendBlock) this.bump('counterTrendBlockedByStrength');  // §8.1
  }

  // < 0 ⇔ a ranks before b: higher WickStrength, then Relevance, then lower
  // levelId. Returns ±1 / 0 (NaN for an undefined Relevance, as the difference
  // did): callers test the sign only, and a small integer is never boxed.
  private compareRank(a: Level, b: Level, e: MergedEvent): number {
    const wa = Number.isNaN(a.WickStrength) ? -Infinity : a.WickStrength;
    const wb = Number.isNaN(b.WickStrength) ? -Infinity : b.WickStrength;
    if (wa !== wb) return wb > wa ? 1 : -1;
    const { Vol, BucketVolume } = this.ctx;
    const { AgeScale, DistanceScale, ageClock } = this.cfg;
    const ra = levelRelevance(a, e.p, Vol, BucketVolume, AgeScale, DistanceScale, this.ctx.t, ageClock);
    const rb = levelRelevance(b, e.p, Vol, BucketVolume, AgeScale, DistanceScale, this.ctx.t, ageClock);
    if (ra !== rb) return rb > ra ? 1 : rb < ra ? -1 : NaN;
    return a.levelId - b.levelId;
  }

  // Same-side levels within BreakoutMult·max(VolUnit_created) (A-23).
  private nested(a: Level, b: Level): boolean {
    return Math.abs(a.WickLevel - b.WickLevel) <= this.cfg.BreakoutMult * Math.max(a.VolUnit_created, b.VolUnit_created);
  }

  // §8.6: ReturnSpeed = (S − P) / (VolUnit_created · buckets since sweepExtremeVol); 0 on zero volume.
  private returnSpeed(l: Level, e: MergedEvent): number {
    const buckets = (this.ctx.Vol - l.sweepExtremeVol) / this.ctx.BucketVolume;
    if (!(buckets > 0)) return 0;
    const side = l.Side;
    return (side * l.SweepExtreme - side * e.p) / (l.VolUnit_created * buckets);
  }

  private recordReturn(l: Level, e: MergedEvent): void {
    l.ReturnSpeed = this.returnSpeed(l, e);
    l.ReturnImbalance = l.returnQ > 0 ? (-l.Side * l.returnSq) / l.returnQ + 0 : 0;
  }

  // At trigger (Spec §5 §8.3, §8.6): PriorTouches histogram {0, 1, 2, ≥3};
  // violent = ReturnSpeed ≥ RejectSpeed_sweep ∧ ReturnImbalance ≥ 0.2, slow =
  // ReturnSpeed < MinReturnSpeed. An unknown sweep RejectSpeed (no sweep pivot,
  // merged, not yet rejected) is never violent.
  private recordReclaim(l: Level): void {
    const id = l.sweepPivotId;
    l.RejectSpeed_sweep = id < 0 ? NaN : this.ctx.rejectSpeedOf?.(id) ?? this.store.byId(id)?.features?.RejectSpeed ?? NaN;
    this.bump(PRIOR_TOUCHES_COUNTER[Math.min(l.PriorTouches, 3)]!);
    if (l.ReturnSpeed >= l.RejectSpeed_sweep && l.ReturnImbalance >= VIOLENT_RETURN_IMBALANCE) this.bump('reclaimViolent');
    else if (l.ReturnSpeed < this.cfg.MinReturnSpeed) this.bump('reclaimSlow');
  }

  // ---------------------------------------------------------------- bucket close

  // Spec §3.10 step 2l: ageing and regime for every live level. Armed levels
  // are re-evaluated by onPrint of the same print (stats are frozen until the
  // next close, so the result is the same).
  onBucketClose(k: number): void {
    if (!(k > this.lastClosedK)) invariantFailed(`LevelBook.onBucketClose: bucket ${k} after ${this.lastClosedK}`);
    this.lastClosedK = k;
    // Most closes change nothing: only then pay for the levelId-ordered pass.
    if (!this.bucketCloseActs(this.bySide[0]) && !this.bucketCloseActs(this.bySide[1])) return;
    const live = this.liveById();
    for (let i = 0; i < live.size; i++) {
      const l = live.items[i]!;
      const aged = this.aged(l);
      const regime = this.regimeBroken(l);
      if (l.State === 'IN_TRADE') {
        if ((aged || regime) && !l.retireAfterClose) {                         // A-31: exits govern
          l.retireAfterClose = true;
          this.move(l, 'IN_TRADE', 'retireAfterClose');
        }
      } else if (aged) this.terminate(l, 'EXPIRED', 'age');
      else if (regime) this.terminate(l, 'INVALIDATED', 'regime');
    }
  }

  private aged(l: Level): boolean {
    return levelAge(l, this.ctx.Vol, this.ctx.BucketVolume, this.ctx.t, this.cfg.ageClock) > this.cfg.MaxAge;
  }

  private regimeBroken(l: Level): boolean {
    const ratio = this.ctx.frozen.VolUnit_now / l.VolUnit_created;
    return !(ratio >= REGIME_MIN && ratio <= REGIME_MAX);
  }

  // Whether onBucketClose transitions any of `levels` (the checks depend on
  // the level and the close only): aged / regimeBroken with the close's
  // values read once.
  private bucketCloseActs(levels: ReadonlyArray<Level>): boolean {
    const { Vol, BucketVolume, t, frozen } = this.ctx;
    const { MaxAge, ageClock } = this.cfg;
    const VolUnit_now = frozen.VolUnit_now;
    for (const l of levels) {
      if (l.State === 'IN_TRADE' && l.retireAfterClose) continue;
      if (levelAge(l, Vol, BucketVolume, t, ageClock) > MaxAge) return true;
      const ratio = VolUnit_now / l.VolUnit_created;
      if (!(ratio >= REGIME_MIN && ratio <= REGIME_MAX)) return true;
    }
    return false;
  }

  // Tick-size change (Spec §3.11): every live level → INVALIDATED(tickChange).
  invalidateAll(e: MergedEvent): void {
    const live = this.liveById();
    for (let i = 0; i < live.size; i++) {
      const l = live.items[i]!;
      if (l.State === 'IN_TRADE') {
        this.exec.exit(l, 'tickChange', e);
        this.trade = null;
      }
      this.terminate(l, 'INVALIDATED', 'tickChange');
    }
  }

  // Live levels by levelId, into a reused list the caller may iterate while terminating.
  private liveById(): LevelList {
    const out = this.liveScratch;
    out.clear();
    for (const l of this.bySide[0]) out.push(l);
    for (const l of this.bySide[1]) out.push(l);
    out.sort(byLevelId);
    return out;
  }

  // ---------------------------------------------------------------- bookkeeping

  // Terminal transition that first cancels a live entry order.
  private terminate(l: Level, to: LevelState, reason: string): void {
    if (l.OrderIds.entry >= 0) {
      this.exec.cancelEntry(l);
      l.OrderIds.entry = -1;
    }
    this.move(l, to, reason);
  }

  private move(l: Level, to: LevelState, reason: string): void {
    const from = l.State;
    if (!transitionAllowed(from, to, reason)) invariantFailed(`LevelBook: level ${l.levelId} ${transitionKey(from, to, reason)} not in the table`);
    const t = this.ctx.t;
    l.State = to;
    l.stateSince = t;
    l.stateReason = reason;
    this.log.push({ t, seq: this.ctx.seq, levelId: l.levelId, from, to, reason });
    if (from === 'PIVOT_PENDING') this.insertLive(l);
    const wasActive = isActiveState(from);
    const isActive = isActiveState(to);
    if (wasActive && !isActive) removeAt(this.active, this.active.indexOf(l));
    else if (!wasActive && isActive) this.insertActive(l);
    if (isTerminalState(to)) {
      if (!(l.OrderIds.entry < 0 && this.trade !== l)) invariantFailed(`LevelBook: level ${l.levelId} terminal with a live order or trade`);
      this.removeLive(l);
      this.store.setLevelOutcome(l.pivotId, to, reason);
    }
  }

  private insertActive(l: Level): void {
    let i = this.active.length;
    while (i > 0 && this.active[i - 1]!.levelId > l.levelId) i--;
    insertAt(this.active, i, l);
  }

  // Binary insert by Side·WickLevel ascending, ties by levelId.
  private insertLive(l: Level): void {
    const arr = this.bySide[sideIndex(l.Side)];
    const key = l.Side * l.WickLevel;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = arr[mid]!;
      const mk = m.Side * m.WickLevel;
      if (mk < key || (mk === key && m.levelId < l.levelId)) lo = mid + 1;
      else hi = mid;
    }
    insertAt(arr, lo, l);
  }

  private removeLive(l: Level): void {
    const arr = this.bySide[sideIndex(l.Side)];
    const i = arr.indexOf(l);
    if (!(i >= 0)) invariantFailed(`LevelBook: level ${l.levelId} not live`);
    removeAt(arr, i);
  }

  private bump(key: string): void {
    this.counterMap.set(key, (this.counterMap.get(key) ?? 0) + 1);
  }

  snapshot(): LevelBookSnapshot {
    return {
      levels: this.levels.map((l) => ({ ...l, OrderIds: { ...l.OrderIds }, regimeAtArm: l.regimeAtArm && { ...l.regimeAtArm }, trades: [...l.trades] })),
      transitions: [...this.log], counters: this.counters, MinStrength: this.MinStrength,
      openTradeLevelId: this.trade?.levelId ?? -1, lastClosedK: this.lastClosedK,
    };
  }

  // Tick-size re-basing: call after invalidateAll. History (levels, log,
  // counters) is kept; levelId stays monotone; bucket indices restart at 0.
  reset(): void {
    assert(this.trade === null && this.active.length === 0, 'LevelBook.reset: live levels remain (call invalidateAll first)');
    this.bySide[0].length = 0;
    this.bySide[1].length = 0;
    this.pivotThisPrint[0] = -1;
    this.pivotThisPrint[1] = -1;
    this.lastClosedK = -1;
  }
}
