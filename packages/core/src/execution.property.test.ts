import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ExecutionConfig, ExecutionModel } from './execution.js';
import { LevelBook } from './level-book.js';
import { LEVEL_CFG } from './testing/level-script.js';
import { ReplayHarness, syntheticPath } from './testing/replay-harness.js';

const EVENTS = 20_000;
const EXEC: ExecutionConfig = {
  latencyMs: 150, stopMode: 'client', exchangeLatencyMs: 30, SlipTicks: 1, SlipCoef: 0.05, FillWindow: 100,
  targetMode: 'sweepDepth', TargetMult: 2, StopMult: 1, RiskFraction: 0.0025, equity: 100_000, DailyLossLimit: 3,
  TakerFee: 0, MakerFee: 0,
};

// Full harness: pipeline → LevelBook → ExecutionModel (Spec §3.10 steps 5 and 9).
// Synthetic paths span < 1 day, so Vol100ms is supplied (the builder's profile
// needs 7 prior days and would stay at the 1-lot floor, i.e. Qty < 1).
// `onPrint` runs after every print.
function run(seed: number, onPrint: (exec: ExecutionModel) => void = () => {}): { h: ReplayHarness; exec: ExecutionModel } {
  const Vol100ms = new Float64Array(24).fill(20);
  let exec: ExecutionModel | null = null;
  const h = new ReplayHarness({
    exec: (ctx) => (exec = new ExecutionModel(EXEC, { Tick: 1, LotSize: 1 }, null, { get t() { return ctx.t; }, get frozen() { return ctx.frozen; }, Vol100ms })),
    book: (store, ctx) => new LevelBook(LEVEL_CFG, store, exec!, ctx),
  });
  for (const e of syntheticPath(seed, { events: EVENTS })) {
    h.onPrint(e);
    onPrint(exec!);
  }
  h.finish();
  return { h, exec: exec! };
}

describe('ExecutionModel on synthetic replays (Spec §4, L6–L8)', () => {
  it('attached to the harness, a replay produces filled and exited trades', () => {
    const { exec } = run(1);
    const exited = exec.trades().filter((tr) => tr.exit !== null);
    expect(exited.length).toBeGreaterThan(0);
    for (const tr of exited) expect(Number.isFinite(tr.pnl_R) && Number.isFinite(tr.BreakevenHitRate)).toBe(true);
  });

  it('property: #triggers == #entries, fillSeq > triggerSeq on every market fill, ≤ 1 open position on every print', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      let maxOpen = 0;
      const { h, exec } = run(seed, (x) => {
        let open = 0;
        for (const tr of x.trades()) if (tr.exit === null) open++;
        maxOpen = Math.max(maxOpen, open);
      });
      expect(maxOpen).toBeLessThanOrEqual(1);
      // L7: every IN_TRADE trigger has a trade whose entry fill resolved (no cancellation path).
      const triggers = h.book!.transitions.filter((r) => r.to === 'IN_TRADE' && r.reason === 'trigger');
      const trades = exec.trades();
      expect(trades.map((tr) => [tr.levelId, tr.triggerSeq])).toEqual(triggers.map((r) => [r.levelId, r.seq]));
      let lastExitSeq = -1;
      for (const tr of trades) {
        expect(tr.entry).not.toBeNull();
        expect(tr.entry!.fillSeq).toBeGreaterThan(tr.triggerSeq);                     // L6
        expect(tr.triggerSeq).toBeGreaterThanOrEqual(lastExitSeq);                     // one position per symbol
        if (tr.exit === null) continue;
        expect(tr.exitTriggerSeq).toBeGreaterThanOrEqual(tr.entry!.fillSeq);           // exits live from the entry fill
        if (tr.exit.noPrintFallback || tr.exitKind !== 'target') expect(tr.exit.fillSeq).toBeGreaterThan(tr.exitTriggerSeq);
        else expect(tr.exit.FillPrice).toBe(tr.Target);                               // limit Target fills at its price
        lastExitSeq = tr.exit.fillSeq;
      }
    }), { seed: 17, numRuns: 40 });
  });
});
