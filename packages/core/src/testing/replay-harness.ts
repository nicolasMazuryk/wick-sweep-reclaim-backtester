import type { Blacklist } from '../blacklist.js';
import { Engine, type EngineContext, type EngineObserver } from '../engine.js';
import type { ExecutionContext, ExecutionModel } from '../execution.js';
import type { LevelBook, LevelContext } from '../level-book.js';
import type { PipelineConfig, ScoredResolution } from '../pivot-pipeline.js';
import type { PivotStore } from '../pivot-store.js';
import type { MergedEvent, Side } from '../types.js';

const WARMUP_EVENTS = 500;

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  MinSpikeSize: 1.5, MaxSpikeDuration: 3, MinRejectSpeed: 0.5, MinRejectImbalance: 0.2, MinRetrace: 0.6, MaxTopDwell: 0.5,
  BandWidthMult: 0.5, AnchorWindow: 20, RetraceWindow: 5, TopBandMult: 0.15, UnitWindow: 60, MergeTolerance: 0.25,
  RankWindow: 500,
};

export interface HarnessOptions {
  readonly cfg?: PipelineConfig;
  readonly PivotMult?: number;
  readonly ringCapacity?: number;
  readonly blacklist?: Blacklist | null;
  // Attaches a LevelBook (Spec §3.10 steps 2l, 7, 8 → onPendingResolved, 9).
  readonly book?: (store: PivotStore, ctx: LevelContext) => LevelBook;
  // Attaches an ExecutionModel (Spec §3.10 step 5); LevelContext.killSwitchActive then reads its kill switch.
  readonly exec?: (ctx: ExecutionContext) => ExecutionModel;
  readonly observers?: ReadonlyArray<EngineObserver>;
}

// Test Engine: warm-up shortened to the first-day bootstrap + UnitWindow
// completed buckets (+ 500 events) and a 2^13 ring so synthetic paths stay
// short; records every scored resolution.
export class ReplayHarness extends Engine {
  readonly resolutions: ScoredResolution[] = [];

  constructor(options: HarnessOptions = {}) {
    const cfg = options.cfg ?? DEFAULT_PIPELINE_CONFIG;
    super({
      pipeline: cfg,
      PivotMult: options.PivotMult ?? 1.2,
      ringCapacity: options.ringCapacity ?? 1 << 13,
      warmupDone: (e) => e.builder.completedCount >= cfg.UnitWindow && e.warmupEvents >= WARMUP_EVENTS,
      blacklist: options.blacklist,
      book: options.book,
      exec: options.exec,
      observers: options.observers,
    });
  }

  // The engine's LevelContext; book-only tests set killSwitchActive by hand.
  get levelCtx(): EngineContext { return this.ctx; }

  protected override onResolved(r: ScoredResolution): void {
    this.resolutions.push(r);
    super.onResolved(r);
  }
}

// mulberry32: tiny deterministic PRNG for synthetic paths (tests only; @wsr/core
// itself has no randomness, Spec §3.11).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  readonly events: number;
  readonly p0?: number;
  readonly t0?: number;
  readonly spikeRate?: number;              // probability per event of starting a spike
  readonly gapRate?: number;                // probability per event of a multi-VolUnit price gap
  readonly blockRate?: number;              // probability per event of a large print without price move
}

// ±1-tick random walk with aggressor signs following the move, 0.5–1.5 s
// between prints, plus occasional fast spikes (a run of large, one-sided,
// multi-tick prints followed by an equally fast reversal), rare price gaps
// (burst buckets) and block prints (slow excursions, early G2) so that every
// pivot class occurs.
export function syntheticPath(seed: number, options: SyntheticOptions): MergedEvent[] {
  const rnd = mulberry32(seed);
  const out: MergedEvent[] = [];
  let t = options.t0 ?? Date.UTC(2025, 0, 1);
  let p = options.p0 ?? 100_000;
  let seq = 0;
  const script: { dp: number; q: number }[] = [];
  const spikeRate = options.spikeRate ?? 0.004;
  const gapRate = options.gapRate ?? 0.0004;
  const blockRate = options.blockRate ?? 0.004;
  while (out.length < options.events) {
    t += 500 + Math.floor(rnd() * 1000);
    let dp: number;
    let q: number;
    const scripted = script.shift();
    if (scripted) {
      ({ dp, q } = scripted);
    } else {
      if (rnd() < spikeRate) {
        const dir = rnd() < 0.5 ? 1 : -1;
        const len = 4 + Math.floor(rnd() * 10);
        const step = 1 + Math.floor(rnd() * 4);
        const back = len + Math.floor(rnd() * len);
        for (let j = 0; j < len; j++) script.push({ dp: dir * step, q: 3 + Math.floor(rnd() * 8) });
        for (let j = 0; j < back; j++) script.push({ dp: -dir * step, q: 3 + Math.floor(rnd() * 8) });
      }
      const u = rnd();
      dp = u < 0.4 ? -1 : u < 0.8 ? 1 : 0;
      q = 1 + Math.floor(rnd() * 5);
      if (rnd() < gapRate) dp = (rnd() < 0.5 ? 1 : -1) * (40 + Math.floor(rnd() * 40));
      if (rnd() < blockRate) q = 50 + Math.floor(rnd() * 400);
    }
    p += dp;
    const s: Side = dp > 0 ? 1 : dp < 0 ? -1 : rnd() < 0.5 ? 1 : -1;
    out.push({ t, seq: seq++, p, q, s, n: 1 });
  }
  return out;
}
