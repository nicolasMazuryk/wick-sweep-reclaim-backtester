import { computeConfigHash, type RunConfig } from '@wsr/core';
import { ReplayInputError } from './blacklist-load.js';
import { costFloorDiagnostic } from './cost-floor.js';
import { type FoldFit, fitFolds, toFoldSchedule, trainWickScores } from './fold-fit.js';
import { type FoldMetrics, foldMetrics } from './fold-metrics.js';
import type { CellParams } from './grid-space.js';
import { withOverrides } from './grid-space.js';
import { censorPath, hitRate0, pathOutcome, type TradePath } from './mfe-mae.js';
import { KahanSum } from './numeric.js';
import { PLACEBO_STOP_MULT, PLACEBO_TARGET_MULT, type PlaceboSetup, placeboSweptStats } from './placebo-sweep.js';
import { type ReactionRun, runReactionTest } from './reaction-run.js';
import type { ReplayInput } from './replay.js';
import { rngStream } from './rng.js';
import {
  type FoldTargetValidation, foldTargetValidation, stabilityOf, targetValidation, type TargetValidation, unitsStabilityOf,
} from './target-validation.js';
import type { TradeRecord } from './trade-record.js';
import { passFoldMetrics, ruleBindingOf, targetGridOf, type TradingPass, tradingPass, type TradingPassSpec } from './trading-pass.js';
import { type Fold, inWindow, windowOf } from './walk-forward.js';

// `wsr backtest --from-grid <runId>` (Spec §6.3 / §6.4, A-48, A-134): each
// fold's test window is traded with the grid's chosen cell for that fold
// (baseline walk-forward), the MinStrength / Stage B fitted at that cell on
// the fold's train window, and the fold's target plateau (TargetMult,
// StopMult) from the cell's train trades, censored at trainEnd.

export interface GridChoice {
  readonly cellId: string;
  readonly params: CellParams;
}

export interface FromGrid {
  readonly runId: string;
  // grid.json `folds` (must equal the run's fold schedule).
  readonly folds: ReadonlyArray<{ readonly foldId: number; readonly trainFrom: string; readonly testFrom: string; readonly testTo: string }>;
  readonly chosen: ReadonlyArray<GridChoice | null>;     // per fold
}

// grid.json → FromGrid: the baseline walk-forward's chosen cell per fold.
export function fromGridOf(runId: string, grid: {
  readonly folds: FromGrid['folds'];
  readonly walkForward: ReadonlyArray<{ readonly variant: string; readonly folds: ReadonlyArray<{ readonly foldId: number; readonly chosen: GridChoice | null }> }>;
}): FromGrid {
  const base = grid.walkForward.find((w) => w.variant === 'baseline');
  if (base === undefined) throw new ReplayInputError(`--from-grid ${runId}: grid.json has no baseline walk-forward`);
  const byFold = new Map(base.folds.map((f) => [f.foldId, f.chosen]));
  return { runId, folds: grid.folds, chosen: grid.folds.map((f) => byFold.get(f.foldId) ?? null) };
}

// folds.json schedule extension of a --from-grid run.
export interface FromGridFold {
  readonly foldId: number;
  readonly cellId: string | null;           // null: no admissible cell in the grid ⇒ no OOS trade (A-75)
  readonly TargetMult: number | null;
  readonly StopMult: number | null;
  readonly plateau: boolean;                // false: no train plateau ⇒ the configured pair
}

export interface FromGridResult {
  readonly fits: FoldFit[];
  readonly paths: TradePath[];              // composite: each fold's test-window paths
  readonly records: TradeRecord[];          // composite, by (TriggerTime, cellId, tradeId)
  readonly foldMetrics: FoldMetrics[];
  readonly targetGrid: TargetValidation;
  readonly folds: FromGridFold[];
  readonly warnings: string[];
}

interface Part {
  readonly k: number;
  readonly cellId: string;
  readonly pass: TradingPass;
  readonly spec: TradingPassSpec;
  readonly TargetMult: number;
  readonly StopMult: number;
}

const isoDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

export async function runFromGrid(o: {
  readonly input: ReplayInput; readonly cfg: RunConfig; readonly seed: number; readonly B: number; readonly folds: ReadonlyArray<Fold>;
  readonly reaction: ReactionRun; readonly configuredFits: ReadonlyArray<FoldFit>; readonly fromGrid: FromGrid;
}): Promise<FromGridResult> {
  const { cfg, folds, seed, B, fromGrid } = o;
  const id = fromGrid.runId;
  const mismatch = fromGrid.folds.length !== folds.length || folds.some((f, k) => {
    const g = fromGrid.folds[k]!;
    return g.foldId !== f.foldId || g.trainFrom !== isoDay(f.trainStart) || g.testFrom !== isoDay(f.testStart) || g.testTo !== isoDay(f.testEnd - DAY_MS);
  });
  if (mismatch) throw new ReplayInputError(`--from-grid ${id}: the grid's fold schedule differs from this run's (same span and --folds needed)`);
  if (fromGrid.chosen.every((c) => c === null)) throw new ReplayInputError(`--from-grid ${id}: no fold has a chosen grid cell`);

  const plan = o.reaction.plan;
  const grid = targetGridOf(cfg);                     // one tracked grid for every pass (the plateau pairs are on it)
  const warnings: string[] = [`--from-grid ${id}: per-fold grid cell, Stage B / MinStrength and target plateau (A-134); levels / pivots / transitions not written`];
  const cells = new Map<string, { readonly params: CellParams; readonly folds: number[] }>();
  fromGrid.chosen.forEach((c, k) => {
    if (c === null) return;
    const e = cells.get(c.cellId) ?? { params: c.params, folds: [] };
    e.folds.push(k);
    cells.set(c.cellId, e);
  });

  const parts: (Part | null)[] = folds.map(() => null);
  const fits: FoldFit[] = [...o.configuredFits];
  const perFoldTv: (FoldTargetValidation | null)[] = folds.map(() => null);
  const foldRows: FromGridFold[] = folds.map((f) => ({ foldId: f.foldId, cellId: null, TargetMult: null, StopMult: null, plateau: false }));
  const passes: TradingPass[] = [];
  for (const cellId of [...cells.keys()].sort()) {
    const cell = cells.get(cellId)!;
    // The cell's config keeps the configured strengthModel: Stage B is fitted at the chosen cell (A-48).
    const cellCfg = withOverrides(cfg, cell.params, `grid cell ${cellId}`);
    const reaction = computeConfigHash(cellCfg) === computeConfigHash(cfg) ? o.reaction : await runReactionTest(o.input, cellCfg, seed, { B: 1 });
    const rows = reaction.engine.store.snapshot();
    const cellFits = fitFolds(rows, reaction.observations, folds, cellCfg);
    const schedule = toFoldSchedule(folds, cellFits);
    const trainScores = folds.map((fold, k) => trainWickScores(rows, fold, cellCfg.strengthModel === 'stageB' ? cellFits[k]!.stageB : null)
      .filter(Number.isFinite).sort((a, b) => a - b));
    const passOf = new Map<string, { pass: TradingPass; spec: TradingPassSpec }>();
    const run = async (TargetMult: number, StopMult: number): Promise<{ pass: TradingPass; spec: TradingPassSpec }> => {
      const key = `${TargetMult}|${StopMult}`;
      const hit = passOf.get(key);
      if (hit !== undefined) return hit;
      const pcfg = TargetMult === cellCfg.TargetMult && StopMult === cellCfg.StopMult ? cellCfg
        : withOverrides(cellCfg, { TargetMult, StopMult }, `grid cell ${cellId} plateau`);
      const spec: TradingPassSpec = { cfg: pcfg, schedule, trainScores, seed, B, placebo: true, cellId: `${cellId}@${TargetMult}x${StopMult}`, grid };
      const out = { pass: await tradingPass(plan, folds, spec), spec };
      passOf.set(key, out);
      passes.push(out.pass);
      return out;
    };
    const base = await run(cellCfg.TargetMult, cellCfg.StopMult);
    for (const k of cell.folds) {
      const fold = folds[k]!;
      fits[k] = cellFits[k]!;
      // Plateau from the cell's train-window paths as known at trainEnd (first passages after it censored).
      const train = base.pass.paths.filter((x) => inWindow(x.trade.TriggerTime, fold, 'train')).map((x) => censorPath(x, fold.trainEnd));
      const test = base.pass.paths.filter((x) => inWindow(x.trade.TriggerTime, fold, 'test'));
      const tv = foldTargetValidation(fold, train, test, grid);
      perFoldTv[k] = tv;
      const TargetMult = tv.plateau?.TargetMult ?? cfg.TargetMult;
      const StopMult = tv.plateau?.StopMult ?? cfg.StopMult;
      if (tv.plateau === null) warnings.push(`--from-grid: fold ${fold.foldId} (${cellId}) has no train plateau — configured (${cfg.TargetMult}, ${cfg.StopMult})`);
      const { pass, spec } = await run(TargetMult, StopMult);
      parts[k] = { k, cellId, pass, spec, TargetMult, StopMult };
      foldRows[k] = { foldId: fold.foldId, cellId, TargetMult, StopMult, plateau: tv.plateau !== null };
    }
  }

  // Composite: fold k's test-window trades from its part.
  const partOf = new Map<TradeRecord, Part>();
  const pathOf = new Map<TradeRecord, TradePath>();
  const records: TradeRecord[] = [];
  const paths: TradePath[] = [];
  parts.forEach((p, k) => {
    if (p === null) return;
    for (const r of p.pass.records) {
      if (!inWindow(r.TriggerTime, folds[k]!, 'test')) continue;
      records.push(r);
      partOf.set(r, p);
      pathOf.set(r, p.pass.pathById.get(r.tradeId)!);
    }
    paths.push(...p.pass.paths.filter((x) => inWindow(x.trade.TriggerTime, folds[k]!, 'test')));
  });
  records.sort((a, b) => a.TriggerTime - b.TriggerTime || (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0) || a.tradeId - b.tradeId);
  paths.sort((a, b) => a.trade.TriggerTime - b.trade.TriggerTime);

  // Per-fold FoldMetrics from the fold's own pass; a fold without a cell has no trades.
  const anyPart = parts.find((p): p is Part => p !== null)!;
  const foldMetricsList: FoldMetrics[] = [];
  folds.forEach((_, k) => {
    const p = parts[k] ?? null;
    foldMetricsList.push(...(p === null
      ? passFoldMetrics({ ...anyPart.pass, records: [] }, folds, anyPart.spec, undefined, k)
      : passFoldMetrics(p.pass, folds, p.spec, undefined, k)));
  });
  foldMetricsList.push(pooledMetrics(records, partOf, parts, anyPart, folds, cfg, seed, B));

  // Target validation: per-fold plateau tables from each cell; pooled tables over the composite test paths.
  const pooledTv = targetValidation(paths, folds, grid, cfg.StopMult);
  const perFold = perFoldTv.map((tv, k) => tv ?? foldTargetValidation(folds[k]!, [], [], grid));
  const pairs = new Set(parts.filter((p): p is Part => p !== null).map((p) => `${p.TargetMult}|${p.StopMult}`));
  const onePair = pairs.size === 1 ? anyPart : null;
  const placebo: PlaceboSetup[] = [];
  let placeboLevels = 0;
  const results = new Map(passes.map((p) => [p, p.placebo!.results()]));
  for (const r of results.values()) placeboLevels += r.levels;
  parts.forEach((p, k) => {
    if (p !== null) placebo.push(...results.get(p.pass)!.setups.filter((x) => inWindow(x.reclaimT, folds[k]!, 'test')));
  });
  const placeboSwept = placeboSweptStats(
    records.map((r) => ({
      volumeDay: partOf.get(r)!.pass.observer.trade(r.tradeId)?.volumeDay ?? -1,
      hit: pathOutcome(pathOf.get(r)!, PLACEBO_TARGET_MULT, PLACEBO_STOP_MULT) === 'hit', hitConfigured: partOf.get(r)!.pass.hit(r),
    })),
    placebo, placeboLevels,
    { B, rng: rngStream(seed, 'placeboSwept'), TargetMult: onePair?.TargetMult ?? NaN, StopMult: onePair?.StopMult ?? NaN },
  );
  return {
    fits, paths, records, foldMetrics: foldMetricsList,
    targetGrid: { ...pooledTv, folds: perFold, stability: stabilityOf(perFold), unitsStability: unitsStabilityOf(perFold), placeboSwept }, folds: foldRows, warnings,
  };
}

// Pooled test FoldMetrics of the composite: each trade's hit and HitRate_0 at
// its fold's pair; window facts summed over the folds' own passes; rule-binding
// counters summed over the distinct passes (whole replays).
function pooledMetrics(
  records: ReadonlyArray<TradeRecord>, partOf: ReadonlyMap<TradeRecord, Part>, parts: ReadonlyArray<Part | null>, anyPart: Part,
  folds: ReadonlyArray<Fold>, cfg: RunConfig, seed: number, B: number,
): FoldMetrics {
  let volumeDays = 0;
  const blacklisted = new KahanSum();
  let killSwitchTrips = 0;
  let ringUnderflow = 0;
  let setByCost = 0;
  let levelCount = 0;
  folds.forEach((fold, k) => {
    const p = parts[k] ?? null;
    const obs = (p ?? anyPart).pass.observer;
    const w = windowOf(fold, 'test');
    const vd = obs.volumeDaysIn(w.from, w.to);
    volumeDays += vd;
    const share = obs.blacklistedBucketShare(w.from, w.to);
    if (Number.isFinite(share)) blacklisted.add(share * vd);
    if (p === null) return;
    killSwitchTrips += obs.killSwitchTripsIn(w.from, w.to);
    ringUnderflow += obs.ringUnderflowIn(w.from, w.to);
    const levels = (p.pass.engine.book?.snapshot().levels ?? []).filter((l) => l.createdAt >= w.from && l.createdAt < w.to);
    setByCost += costFloorDiagnostic(levels, []).minSweepSetByCost;
    levelCount += levels.length;
  });
  const ruleBinding: Record<string, number> = {};
  for (const pass of new Set(parts.filter((p): p is Part => p !== null).map((p) => p.pass))) {
    for (const [key, n] of Object.entries(ruleBindingOf(pass.engine))) ruleBinding[key] = (ruleBinding[key] ?? 0) + n;
  }
  const part = (r: TradeRecord): Part => partOf.get(r)!;
  return foldMetrics(records, {
    foldId: 'pooled', window: 'test', from: folds[0]!.testStart, to: folds[folds.length - 1]!.testEnd, TargetMult: cfg.TargetMult, StopMult: cfg.StopMult,
    hit: (r) => part(r).pass.hit(r), hitRate0: (r) => hitRate0(part(r).TargetMult, part(r).StopMult), decile: (r) => r.decile,
    volumeDayOf: (r) => part(r).pass.observer.trade(r.tradeId)?.volumeDay ?? -1, volumeDays,
    blacklistedBucketShare: volumeDays > 0 ? blacklisted.value / volumeDays : NaN, killSwitchTrips, ringUnderflow,
    ruleBinding: Object.fromEntries(Object.keys(ruleBinding).sort().map((key) => [key, ruleBinding[key]!])),
    costFloor: { minSweepSetByCost: setByCost, shareOfSpikes: levelCount === 0 ? NaN : setByCost / levelCount }, latencyMs: cfg.latencyMs, seed, B,
  });
}
