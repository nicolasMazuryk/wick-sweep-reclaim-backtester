import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeConfigHash, computeGateConfigHash, Engine, type Ms, type RunConfig, type VenueId } from '@wsr/core';
import { dayEndMs, dayStartMs, formatDay } from '@wsr/data';
import type { RunManifest } from './output.js';
import {
  type ContrastStats, type LevelSetId, type ReactionObservation, ReactionObserver, reactionConfigFrom, reactionStats, type SetStats,
} from './reaction.js';
import { initialInstrument, planReplay, replay, type ReplayInput, type ReplayPlan } from './replay.js';
import { rngStream } from './rng.js';

// Bootstrap stream id of a whole-span (not per-fold) reaction test:
// rngStream(seed, 'bootstrap', SPAN_FOLD_ID). Fold ids are small integers.
export const SPAN_FOLD_ID = 0xffffffff;

// §9.2, printed verbatim when the (1)−(2) CI contains 0 (Spec §6.1.6).
export const CONCLUSION_ONLY_EXTREMUM = 'fast/decisive is irrelevant and only extremum matters';

// Spec §6.1.5 plus diagnostics.
export interface ReactionTestResult {
  readonly venue: VenueId; readonly symbol: string; readonly span: { readonly from: Ms; readonly to: Ms }; readonly seed: number;
  readonly sets: Record<LevelSetId, SetStats>;
  readonly wickByDecile: ReadonlyArray<SetStats & { readonly decile: number }>;
  readonly contrasts: { readonly '1-4': ContrastStats; readonly '1-2': ContrastStats; readonly '1-3': ContrastStats };
  readonly monotone: { readonly slope: number; readonly ci95: [number, number]; readonly spearman: number; readonly pass: boolean };
  readonly gate: { readonly pass: boolean; readonly reasons: readonly string[] };
  readonly B: number;
  readonly blocks: number;                  // volume-days holding at least one complete observation
  readonly randomClipped: number;
  readonly blacklistedBuckets: number;
  readonly totalBuckets: number;
  readonly conclusion12: string | null;
  readonly configHash: string;
  readonly gateConfigHash: string;          // Spec §6.1.6 gate config (A-136); part of reactionKey
  // Lookup key for `wsr backtest` (Spec §6.1.6): same (venue, symbol, span, config).
  readonly reactionKey: string;
}

export interface ReactionRunCounters {
  readonly events: number;
  readonly tickChanges: number;
  readonly ringUnderflow: number;
  readonly blacklistedBuckets: number;
  readonly totalBuckets: number;
  readonly randomClipped: number;
}

export interface ReactionRun {
  readonly result: ReactionTestResult;
  readonly plan: ReplayPlan;
  readonly counters: ReactionRunCounters;
  readonly observations: ReadonlyArray<ReactionObservation>;
  readonly engine: Engine;
  readonly warnings: readonly string[];     // plan warnings + run warnings
}

// span.to is exclusive (end of the last span day); gateConfigHash = computeGateConfigHash (A-136).
export function reactionKeyOf(venue: VenueId, symbol: string, span: { from: Ms; to: Ms }, gateConfigHash: string): string {
  return createHash('sha256').update(JSON.stringify([venue, symbol, span.from, span.to, gateConfigHash])).digest('hex');
}

// reactionKey of a ReplayInput's span (Spec §6.1.6: venue, symbol, span, gate config).
export function reactionKeyFor(input: Pick<ReplayInput, 'venue' | 'symbol' | 'from' | 'to'>, cfg: RunConfig): string {
  return reactionKeyOf(input.venue, input.symbol, { from: dayStartMs(input.from), to: dayEndMs(input.to) }, computeGateConfigHash(cfg));
}

// Spec §6.1: replay the span (plus warm-up) through a Stage A engine with the
// ReactionObserver attached, then the §6.1.4 statistics and the §6.1.6 gate.
// Set membership does not depend on MinStrength: set (1) is built from the
// PivotStore (L9).
export async function runReactionTest(
  input: ReplayInput, cfg: RunConfig, seed: number, opts: { readonly B?: number } = {},
): Promise<ReactionRun> {
  const plan = await planReplay(input, cfg);
  const observer = new ReactionObserver({ ...reactionConfigFrom(cfg), seed, spanStart: plan.spanStart });
  const engine = Engine.fromConfig(cfg, input.venue, initialInstrument(plan), {
    blacklist: plan.blacklist.blacklist, funding: plan.funding, observers: [observer],
  });
  await replay(plan, engine);

  const observations = observer.observations();
  const B = opts.B ?? 2000;
  const stats = reactionStats(observations, { B, rng: rngStream(seed, 'bootstrap', SPAN_FOLD_ID) });
  const ec = engine.counters;
  const { randomClipped, firstSpanT, preSpanPrints } = observer.counters;
  const warnings = [...plan.warnings];
  if (Number.isNaN(firstSpanT)) warnings.push('warm-up did not end before the end of the span — no reaction observations');
  else if (preSpanPrints === 0) warnings.push(`warm-up ran into the span until ${new Date(firstSpanT).toISOString()}`);
  const span = { from: plan.spanStart, to: plan.spanEnd };
  const configHash = computeConfigHash(cfg);
  const gateConfigHash = computeGateConfigHash(cfg);
  const ci12 = stats.contrasts['1-2'].ci95;
  const result: ReactionTestResult = {
    venue: input.venue, symbol: input.symbol, span, seed,
    sets: stats.sets, wickByDecile: stats.wickByDecile, contrasts: stats.contrasts, monotone: stats.monotone, gate: stats.gate,
    B: stats.B, blocks: stats.blocks, randomClipped, blacklistedBuckets: ec.blacklistedBuckets, totalBuckets: ec.totalBuckets,
    conclusion12: Number.isFinite(ci12[0]) && Number.isFinite(ci12[1]) && ci12[0] <= 0 && ci12[1] >= 0 ? CONCLUSION_ONLY_EXTREMUM : null,
    configHash, gateConfigHash, reactionKey: reactionKeyOf(input.venue, input.symbol, span, gateConfigHash),
  };
  const counters: ReactionRunCounters = {
    events: engine.events, tickChanges: ec.tickChanges, ringUnderflow: ec.ringUnderflow,
    blacklistedBuckets: ec.blacklistedBuckets, totalBuckets: ec.totalBuckets, randomClipped,
  };
  return { result, plan, counters, observations, engine, warnings };
}

// Span of a ReplayInput as manifest strings.
export function spanLabels(input: Pick<ReplayInput, 'from' | 'to'>): { from: string; to: string } {
  return { from: formatDay(input.from), to: formatDay(input.to) };
}

// `reaction.json` as written by writeRunOutputs (numbers already made finite).
export interface StoredReaction {
  readonly runManifest: RunManifest;
  readonly reactionKey: string;
  readonly gate: { readonly pass: boolean; readonly reasons: readonly string[] };
  readonly [key: string]: unknown;
}

export async function readReaction(runDir: string): Promise<StoredReaction> {
  return JSON.parse(await readFile(join(runDir, 'reaction.json'), 'utf8')) as StoredReaction;
}

// A stored reaction.json applies to a run of the same inputs (reactionKey, A-136) and bootstrap B.
export function storedReactionMatches(stored: StoredReaction | null, reactionKey: string, B: number): stored is StoredReaction {
  return stored !== null && stored.reactionKey === reactionKey && stored['B'] === B;
}

// Spec §6.1.6: the first runs/*/reaction.json (by directory name) of the same
// (venue, symbol, span, gate config) and B, whichever run wrote it; null when none.
export async function findStoredReaction(runsRoot: string, reactionKey: string, B: number): Promise<StoredReaction | null> {
  let names: string[];
  try {
    names = (await readdir(runsRoot)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names) {
    let stored: StoredReaction;
    try {
      stored = await readReaction(join(runsRoot, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw error;
    }
    if (storedReactionMatches(stored, reactionKey, B)) return stored;
  }
  return null;
}
