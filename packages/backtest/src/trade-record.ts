import {
  type Buckets, type Engine, type ExecutionInstrument, type FillResult, hourOfDay, type Lots, type Ms, type OptExitKind, type Side,
  type Ticks, type Trade,
} from '@wsr/core';
import type { PostEntryImbalanceObserver } from './imbalance.js';
import type { TradePath } from './mfe-mae.js';
import { type RegimeLabel, regimeLabel } from './regime.js';
import { type Fold, foldOf } from './walk-forward.js';

// Spec §7.1. `kind` adds `tickChange` (Spec §3.11, A-92, as FillKind does in @wsr/core).
export interface ExitRecord {
  readonly kind: 'stop' | 'target' | 'time' | 'kill' | 'tickChange' | 'none';
  readonly t: Ms | null;
  readonly price: Ticks | null;
  readonly pnl_bps: number | null;
}

// Spec §7.1 trades.jsonl / trades.parquet row.
export interface TradeRecord {
  readonly tradeId: number; readonly levelId: number; readonly Side: Side; readonly foldId: number; readonly cellId: string;
  readonly WickLevel: Ticks; readonly SweepExtreme: Ticks; readonly SweepDepth: Ticks; readonly VolUnit_created: Ticks; readonly VolUnit_now: Ticks;
  readonly WickStrength: number; readonly WickStrength_0: number; readonly WickStrength_B: number | null; readonly decile: number;
  readonly WickStrength_sweep: number | null;
  readonly TriggerTime: Ms; readonly FillTime: Ms; readonly EntryFill: Ticks; readonly Qty: Lots; readonly FilledQty: Lots;
  readonly touchAndReverse: boolean; readonly touchAndFly: boolean; readonly 'burst': boolean; readonly noPrintFallback: boolean;
  readonly StopLoss: Ticks; readonly Target: Ticks; readonly exit: ExitRecord; readonly exitOpt: ExitRecord;
  // targetMode twoStage (§6.5): the first half at 1·SweepDepth (pnl_bps null: the trade's pnl_bps covers both legs).
  readonly exitPartial?: ExitRecord;
  readonly MFE: number; readonly MAE: number;
  readonly firstPassage: { readonly 'T': Record<string, Buckets | null>; readonly 'S': Record<string, Buckets | null> };
  readonly holdBuckets: Buckets; readonly RoundTripCost_bps: number; readonly fundingAccrued_bps: number;
  readonly pnl_bps: number; readonly pnl_R: number; readonly BreakevenHitRate: number;
  readonly regime: RegimeLabel; readonly TrendEfficiency: number;
  readonly hourOfDay: number; readonly SweepCount: number; readonly PriorTouches: number; readonly ReturnSpeed: number; readonly ReturnImbalance: number;
  readonly postEntryImbalance2: number;
  readonly caps: { readonly g: number; readonly counterTrendHalved: boolean; readonly liquidityCap: boolean; readonly minQty: boolean };
}

// Decile 1..10 of x among `sorted` (ascending, finite): the §6.1.1 rule of
// set (1); −1 when x is not finite or the reference set is empty.
export function decileIn(sorted: ReadonlyArray<number>, x: number): number {
  if (!Number.isFinite(x) || sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(10, Math.floor((10 * lo) / sorted.length) + 1);
}

const EXIT_KIND: Record<OptExitKind, ExitRecord['kind']> = {
  stop: 'stop', 'target': 'target', targetOpt: 'target', time: 'time', killSwitch: 'kill', tickChange: 'tickChange',
};

function exitRecord(kind: OptExitKind | null, fill: FillResult | null, pnl_bps: number): ExitRecord {
  if (kind === null || fill === null) return { kind: 'none', t: null, price: null, pnl_bps: null };
  return { kind: EXIT_KIND[kind], t: fill.fillT, price: fill.FillPrice, pnl_bps: Number.isFinite(pnl_bps) ? pnl_bps : null };
}

const finiteOrNull = (x: number): number | null => (Number.isFinite(x) ? x : null);

export interface TradeRecordContext {
  readonly engine: Engine;
  readonly paths: ReadonlyArray<TradePath>;
  readonly observer: PostEntryImbalanceObserver;
  readonly folds: ReadonlyArray<Fold>;
  // Per fold (by index): train-window WickLevel scores of the selected model, ascending.
  readonly trainScores: ReadonlyArray<ReadonlyArray<number>>;
  readonly instrument: ExecutionInstrument;
  readonly StopOffset: number;
  readonly cellId?: string;
}

// One record per trade whose entry filled (every trade that has a tracked
// path), by tradeId. Setup fields are the Trade's copies at trigger; only the
// frozen level constants (VolUnit_created, scores) are read from the LevelBook. `decile` is
// relative to the train WickLevels of the trade's test fold (−1 outside
// every test window).
export function buildTradeRecords(ctx: TradeRecordContext): TradeRecord[] {
  const { engine, observer, folds, instrument } = ctx;
  const out: TradeRecord[] = [];
  for (const path of ctx.paths) {
    const tr: Readonly<Trade> = path.trade;
    const level = engine.book?.byId(tr.levelId);
    const entry = tr.entry;
    if (level === undefined || entry === null) continue;
    const obs = observer.trade(tr.tradeId);
    const foldId = foldOf(tr.TriggerTime, folds);
    const { regime } = tr;
    const entryNotional = entry.FillPrice * instrument.Tick * instrument.LotSize * tr.FilledQty;
    const RiskPerTrade = tr.sizing.RiskPerTrade;
    const optBps = (tr.pnlOpt_R * RiskPerTrade * 1e4) / entry.FillPrice;
    const passage = (grid: ReadonlyArray<number>, buckets: Float64Array): Record<string, Buckets | null> =>
      Object.fromEntries(grid.map((x, j) => [String(x), finiteOrNull(buckets[j]!)]));
    out.push({
      tradeId: tr.tradeId, levelId: tr.levelId, Side: tr.Side, foldId, cellId: ctx.cellId ?? 'base',
      WickLevel: tr.WickLevel, SweepExtreme: tr.StopLoss - tr.Side * ctx.StopOffset, SweepDepth: tr.SweepDepth,
      VolUnit_created: level.VolUnit_created, VolUnit_now: obs?.VolUnit_now ?? NaN,
      WickStrength: level.WickStrength, WickStrength_0: level.WickStrength_0, WickStrength_B: finiteOrNull(level.WickStrength_B),
      decile: foldId < 0 ? -1 : decileIn(ctx.trainScores[foldId] ?? [], level.WickStrength),
      WickStrength_sweep: finiteOrNull(tr.WickStrength_sweep),
      TriggerTime: tr.TriggerTime, FillTime: entry.fillT, EntryFill: entry.FillPrice, Qty: tr.Qty, FilledQty: tr.FilledQty,
      touchAndReverse: entry.touchAndReverse, touchAndFly: entry.touchAndFly, 'burst': entry.inBurst, noPrintFallback: entry.noPrintFallback,
      StopLoss: tr.StopLoss, Target: tr.Target,
      exit: exitRecord(tr.exitKind, tr.exit, tr.pnl_bps), exitOpt: exitRecord(tr.exitOptKind, tr.exitOpt, optBps),
      ...(tr.partial === null ? {} : { exitPartial: exitRecord('target', tr.partial, NaN) }),
      MFE: path.MFE, MAE: path.MAE,
      firstPassage: { 'T': passage(path.TargetMults, path.firstTBuckets), 'S': passage(path.StopMults, path.firstSBuckets) },
      holdBuckets: obs?.holdBuckets ?? NaN, RoundTripCost_bps: tr.RoundTripCost_bps,
      fundingAccrued_bps: entryNotional > 0 ? (tr.fundingAccrued / entryNotional) * 1e4 : NaN,
      pnl_bps: tr.pnl_bps, pnl_R: tr.pnl_R, BreakevenHitRate: tr.BreakevenHitRate,
      regime: regime === null ? 'neutral' : regimeLabel(regime.TrendEfficiency, regime.TrendSign, tr.Side),
      TrendEfficiency: regime?.TrendEfficiency ?? NaN, hourOfDay: hourOfDay(tr.TriggerTime), SweepCount: tr.SweepCount,
      PriorTouches: tr.PriorTouches, ReturnSpeed: tr.ReturnSpeed, ReturnImbalance: tr.ReturnImbalance,
      postEntryImbalance2: obs?.postEntryImbalance2 ?? NaN,
      caps: {
        g: tr.sizing.g, counterTrendHalved: tr.sizing.caps.counterTrendHalved, liquidityCap: tr.sizing.caps.liquidityCap,
        minQty: tr.sizing.caps.minQty,
      },
    });
  }
  return out;
}
