import { ceilTicksConservative } from './numerics.js';
import type { Buckets, Lots, Ms, Side, Ticks } from './types.js';

// Spec §3.9.1. RETIRED is terminal (A-22).
export type LevelState = 'PIVOT_PENDING' | 'WICK_ACTIVE' | 'SWEEPING' | 'SWEEP_CONFIRMED' | 'ORDER_ARMED' | 'IN_TRADE' | 'CLOSED'
                       | 'INVALIDATED' | 'EXPIRED' | 'CANCELLED' | 'RETIRED';

export const TERMINAL_STATES: ReadonlySet<LevelState> = new Set(['INVALIDATED', 'EXPIRED', 'CANCELLED', 'RETIRED']);

// Live states whose transitions depend on every print regardless of distance (Spec §3.9.2).
export const ACTIVE_STATES: ReadonlySet<LevelState> = new Set(['SWEEPING', 'SWEEP_CONFIRMED', 'ORDER_ARMED', 'IN_TRADE']);

// TERMINAL_STATES.has / ACTIVE_STATES.has without hashing, for the per-print loop (Spec §10).
export function isTerminalState(s: LevelState): boolean {
  return s === 'INVALIDATED' || s === 'EXPIRED' || s === 'CANCELLED' || s === 'RETIRED';
}

export function isActiveState(s: LevelState): boolean {
  return s === 'SWEEPING' || s === 'SWEEP_CONFIRMED' || s === 'ORDER_ARMED' || s === 'IN_TRADE';
}

// Spec §3.9.5 checks a–i as suppression reasons, in check order. The spec
// union is extended with the reasons of checks it leaves unnamed: `costFloor`
// (MinSweepDepth re-floored at arming, Spec §3.9.1), `minStrength` (a),
// `approach` (b), `position` (e) and `minQty` (sizing, Spec §4.7).
export const SUPPRESS_REASONS = [
  'costFloor', 'minStrength', 'approach', 'liquidity', 'blacklist', 'killSwitch', 'position', 'counterTrendBlocked',
  'conflict', 'nested', 'maxPending', 'minQty',
] as const;
export type SuppressReason = 'none' | (typeof SUPPRESS_REASONS)[number];

export interface RegimeAtArm { readonly TrendEfficiency: number; readonly TrendSign: number; readonly counterTrend: boolean }

export type MinSweepFloor = 'mult' | 'tick' | 'spread' | 'cost';

export interface Level {
  readonly levelId: number; readonly pivotId: number; readonly Side: Side;
  WickLevel: Ticks;                         // may move outward on merge (§3.1)
  readonly VolUnit_created: Ticks;          // frozen (§2.3)
  WickStrength: number;                     // selected score (strengthModel)
  readonly WickStrength_0: number; readonly WickStrength_B: number;
  State: LevelState; stateSince: Ms; stateReason: string;
  readonly createdAt: Ms;                   // = classifiedAt (Spec §3.6)
  readonly ExitTime: Ms;                    // Age anchor (§5)
  readonly exitVol: Lots;                   // Vol at ExitTime: Age runs on the volume clock
  SweepExtreme: Ticks | -1; SweepDepth: Ticks | -1; SweepRunningMax: Ticks | -1;
  sweepStartVol: Lots; sweepExtremeVol: Lots; sweepLegDurationBuckets: Buckets;
  sweepPivotId: number | -1; WickStrength_sweep: number;
  PriorTouches: number; SweepCount: number; UseCount: number;
  MinSweepDepth: Ticks; readonly BreakoutDepth: Ticks; minSweepFloorBinding: MinSweepFloor;
  OrderIds: { entry: number | -1; stop: number | -1; limit: number | -1 };   // limit = the Target order
  suppressed: SuppressReason;
  suppressedMask: number;                   // bit j ⇔ SUPPRESS_REASONS[j] failed at the last evaluation
  regimeAtArm: RegimeAtArm | null;
  sizeHalved: boolean;                      // counter-trend arm (§8.1)
  ReturnSpeed: number; ReturnImbalance: number;   // at arming, then at trigger (§8.6)
  RejectSpeed_sweep: number;                // sweep pivot's RejectSpeed at trigger (§8.6 violent test); NaN unknown
  returnSq: Lots; returnQ: Lots;            // Σ s q and Σ q over prints since sweepExtremeVol
  StopLoss: Ticks | -1; Target: Ticks | -1; // raw prices, set at arming / re-confirmation; twoStage moves StopLoss to EntryFill
  Target1: Ticks | -1;                      // twoStage first-leg target W − 1·SweepDepth (§6.5); −1 otherwise
  target1Done: boolean;                     // twoStage first leg taken (or dropped for a 1-lot position)
  entryVol: Lots;                           // Vol at the trigger print (TimeStop)
  tradeId: number | -1;
  trades: number[];                         // tradeIds produced by this level
  retireAfterClose: boolean;                // aged / regime-invalidated while IN_TRADE (A-31)
  reclaimVol: Lots;                         // Vol at the first unarmed reclaim print (A-29); −1 none
  reclaimBelowQ: Lots;                      // Σq of prints at or below W since reclaimVol (A-29 cancel timer)
}

export interface TransitionRecord {
  readonly t: Ms; readonly seq: number; readonly levelId: number;
  readonly from: LevelState; readonly to: LevelState; readonly reason: string;
}

export function transitionKey(from: LevelState, to: LevelState, reason: string): string {
  return `${from} → ${to} (${reason})`;
}

// Every (from, to, reason) of the Spec §3.9.6 table that LevelBook can log.
// PIVOT_PENDING rows that create no level never reach LevelBook; the
// "SWEEPING → SWEEPING (otherwise)" row updates R silently. The two A-30 rows
// (entry left live through a re-sweep) are implied by the ORDER_ARMED re-sweep row.
export const TABLE_TRANSITIONS: ReadonlyArray<readonly [LevelState, LevelState, string]> = [
  ['PIVOT_PENDING', 'WICK_ACTIVE', 'register'],
  ['WICK_ACTIVE', 'INVALIDATED', 'breakout'],
  ['WICK_ACTIVE', 'SWEEPING', 'sweep'],
  ['WICK_ACTIVE', 'WICK_ACTIVE', 'merge'],
  ['WICK_ACTIVE', 'RETIRED', 'nestedInner'],
  ['WICK_ACTIVE', 'EXPIRED', 'age'],
  ['WICK_ACTIVE', 'INVALIDATED', 'regime'],
  ['SWEEPING', 'INVALIDATED', 'breakout'],
  ['SWEEPING', 'SWEEP_CONFIRMED', 'confirm'],
  ['SWEEPING', 'ORDER_ARMED', 'reconfirm'],
  ['SWEEPING', 'IN_TRADE', 'trigger'],
  ['SWEEPING', 'EXPIRED', 'age'],
  ['SWEEPING', 'INVALIDATED', 'regime'],
  ['SWEEP_CONFIRMED', 'INVALIDATED', 'breakout'],
  ['SWEEP_CONFIRMED', 'SWEEPING', 'resweep'],
  ['SWEEP_CONFIRMED', 'INVALIDATED', 'maxSweeps'],
  ['SWEEP_CONFIRMED', 'ORDER_ARMED', 'arm'],
  ['SWEEP_CONFIRMED', 'SWEEP_CONFIRMED', 'missedReclaim'],
  ['SWEEP_CONFIRMED', 'CANCELLED', 'missedReclaim'],
  ['SWEEP_CONFIRMED', 'EXPIRED', 'age'],
  ['SWEEP_CONFIRMED', 'INVALIDATED', 'regime'],
  ['ORDER_ARMED', 'INVALIDATED', 'breakout'],
  ['ORDER_ARMED', 'SWEEPING', 'resweep'],
  ['ORDER_ARMED', 'INVALIDATED', 'maxSweeps'],
  ['ORDER_ARMED', 'IN_TRADE', 'trigger'],
  ...(['minStrength', 'liquidity', 'blacklist', 'killSwitch', 'position', 'counterTrendBlocked', 'conflict', 'nested', 'maxPending'] as const)
    .map((r) => ['ORDER_ARMED', 'SWEEP_CONFIRMED', r] as const),
  ['ORDER_ARMED', 'CANCELLED', 'conflictFilled'],
  ['ORDER_ARMED', 'EXPIRED', 'age'],
  ['ORDER_ARMED', 'INVALIDATED', 'regime'],
  ['IN_TRADE', 'CLOSED', 'stop'],
  ['IN_TRADE', 'CLOSED', 'target'],
  ['IN_TRADE', 'CLOSED', 'time'],
  ['IN_TRADE', 'CLOSED', 'killSwitch'],
  ['IN_TRADE', 'IN_TRADE', 'retireAfterClose'],
  ['IN_TRADE', 'IN_TRADE', 'partialTarget'],       // targetMode twoStage first leg (§6.5)
  ['CLOSED', 'RETIRED', 'usesExhausted'],
  ['CLOSED', 'WICK_ACTIVE', 'reuse'],
  ['WICK_ACTIVE', 'RETIRED', 'breakoutAfterUse'],
];

// Tick-size change (Spec §3.11): every live level → INVALIDATED(tickChange).
export const TICK_CHANGE_TRANSITIONS: ReadonlyArray<readonly [LevelState, LevelState, string]> =
  (['WICK_ACTIVE', 'SWEEPING', 'SWEEP_CONFIRMED', 'ORDER_ARMED', 'IN_TRADE'] as const)
    .map((from) => [from, 'INVALIDATED', 'tickChange'] as const);

// stateMachineClosed (Spec §11.2): LevelBook asserts every logged transition is in here.
export const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set(
  [...TABLE_TRANSITIONS, ...TICK_CHANGE_TRANSITIONS].map(([from, to, reason]) => transitionKey(from, to, reason)),
);

// ALLOWED_TRANSITIONS as from → to → reasons: the per-transition check builds no key string (Spec §10).
const ALLOWED_BY_STATE = new Map<LevelState, Map<LevelState, Set<string>>>();
for (const [from, to, reason] of [...TABLE_TRANSITIONS, ...TICK_CHANGE_TRANSITIONS]) {
  const byTo = ALLOWED_BY_STATE.get(from) ?? ALLOWED_BY_STATE.set(from, new Map()).get(from)!;
  (byTo.get(to) ?? byTo.set(to, new Set()).get(to)!).add(reason);
}

export function transitionAllowed(from: LevelState, to: LevelState, reason: string): boolean {
  return ALLOWED_BY_STATE.get(from)?.get(to)?.has(reason) ?? false;
}

export interface GeometryConfig {
  readonly MinSweepMult: number;
  readonly BreakoutMult: number;
}

export interface LevelGeometry {
  readonly MinSweepDepth: Ticks;
  readonly BreakoutDepth: Ticks;
  readonly minSweepFloorBinding: MinSweepFloor;
}

// Spec §3.9.3, integer ticks (Tick = 1 tick). The binding floor is the first
// of mult, tick, spread, cost that attains the max.
export function levelGeometry(
  cfg: GeometryConfig, VolUnit_created: Ticks, SpreadEst_t: Ticks, RoundTripCostTicks: Ticks,
): LevelGeometry {
  // First floor attaining the max, in the order mult, tick, spread, cost (no per-level tuple arrays).
  let MinSweepDepth = ceilTicksConservative(cfg.MinSweepMult * VolUnit_created);
  let binding: MinSweepFloor = 'mult';
  if (3 > MinSweepDepth) { MinSweepDepth = 3; binding = 'tick'; }
  if (2 * SpreadEst_t > MinSweepDepth) { MinSweepDepth = 2 * SpreadEst_t; binding = 'spread'; }
  if (2 * RoundTripCostTicks > MinSweepDepth) { MinSweepDepth = 2 * RoundTripCostTicks; binding = 'cost'; }
  return { MinSweepDepth, BreakoutDepth: ceilTicksConservative(cfg.BreakoutMult * VolUnit_created), minSweepFloorBinding: binding };
}

// Wall-clock ageing variant (§5 "test wall-clock as variant"): a bucket is one
// median-liquidity minute by construction (§2.2 BucketVolume), so the wall age
// in buckets is minutes since ExitTime and AgeScale keeps its meaning (A-88).
export const WALL_MS_PER_BUCKET = 60_000;
export type AgeClock = 'volume' | 'wall';

// Spec §3.9.1 derived quantities: Age on the volume clock (default) or the wall clock.
export function levelAge(level: Level, Vol: Lots, BucketVolume: Lots, t: Ms = NaN, ageClock: AgeClock = 'volume'): Buckets {
  return ageClock === 'wall' ? (t - level.ExitTime) / WALL_MS_PER_BUCKET : (Vol - level.exitVol) / BucketVolume;
}

export function levelDistance(level: Level, p: Ticks): number {
  return (level.Side * (level.WickLevel - p)) / level.VolUnit_created;
}

export function levelRelevance(
  level: Level, p: Ticks, Vol: Lots, BucketVolume: Lots, AgeScale: number, DistanceScale: number, t: Ms = NaN,
  ageClock: AgeClock = 'volume',
): number {
  return Math.exp(-levelAge(level, Vol, BucketVolume, t, ageClock) / AgeScale) * Math.exp(-Math.max(levelDistance(level, p), 0) / DistanceScale);
}
