import { type ExecutionConfig, ExecutionModel } from '../execution.js';
import { LevelBook, type LevelBookConfig } from '../level-book.js';
import { LEVEL_CFG } from './level-script.js';
import { type HarnessOptions, ReplayHarness } from './replay-harness.js';

export const EXEC_CFG: ExecutionConfig = {
  latencyMs: 150, stopMode: 'client', exchangeLatencyMs: 30, SlipTicks: 1, SlipCoef: 0.05, FillWindow: 100,
  targetMode: 'sweepDepth', TargetMult: 2, StopMult: 1, RiskFraction: 0.0025, equity: 100_000, DailyLossLimit: 3,
  TakerFee: 0, MakerFee: 0,
};

// The full Spec §3.10 loop on a ReplayHarness: pipeline → LevelBook →
// ExecutionModel. Synthetic paths span < 1 day, so Vol100ms is supplied (the
// builder's profile needs 7 prior days and would stay at the 1-lot floor,
// i.e. Qty < 1 and no trades).
// `exec` / `level` override EXEC_CFG / LEVEL_CFG (e.g. the Spec §11.3
// `zeroCosts` / `targetOnTouch` test switches).
export interface FullHarnessOptions extends Omit<HarnessOptions, 'book' | 'exec'> {
  readonly exec?: Partial<ExecutionConfig>;
  readonly level?: Partial<LevelBookConfig>;
  readonly MinStrength?: number;
}

export function fullHarness(options: FullHarnessOptions = {}): ReplayHarness {
  const { exec: execOver, level: levelOver, MinStrength, ...rest } = options;
  const Vol100ms = new Float64Array(24).fill(20);
  let exec: ExecutionModel | null = null;
  return new ReplayHarness({
    ...rest,
    exec: (ctx) => (exec = new ExecutionModel({ ...EXEC_CFG, ...execOver }, { Tick: 1, LotSize: 1 }, null, {
      get t() { return ctx.t; }, get frozen() { return ctx.frozen; }, Vol100ms,
    })),
    book: (store, ctx) => new LevelBook({ ...LEVEL_CFG, ...levelOver }, store, exec!, ctx, { MinStrength }),
  });
}
