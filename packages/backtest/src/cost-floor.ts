import { ceilTicksConservative, type Level, type Ticks, type Trade } from '@wsr/core';
import { percentile } from './numeric.js';

export interface Percentiles {
  readonly n: number;
  readonly p10: number; readonly p25: number; readonly p50: number; readonly p75: number; readonly p90: number;
}

export interface CostFloorDiagnostic {
  readonly minSweepSetByCost: number;       // levels whose MinSweepDepth was set by the 2·RoundTripCost floor
  readonly shareOfSpikes: number;           // … as a share of all registered WickLevels
  readonly BreakevenHitRate: Percentiles;
  readonly BreakevenAtMultDepth?: Percentiles;
}

// Ex-ante breakeven at the unfloored depth d = ceil(MinSweepMult·VolUnit_created)
// (A-55): what BreakevenHitRate would be if SweepDepth were the MinSweepMult
// depth instead of the cost-floored one. `roundTripCostTicks` is the §4.4
// ex-ante cost at a price (e.g. engine.exec.roundTripCostTicks).
export interface MultDepthBreakeven {
  readonly MinSweepMult: number;
  readonly TargetMult: number;
  readonly StopMult: number;
  readonly roundTripCostTicks: (p: Ticks) => Ticks;
}

function percentilesOf(xs: ReadonlyArray<number>): Percentiles {
  return {
    n: xs.length, p10: percentile(xs, 0.1), p25: percentile(xs, 0.25), p50: percentile(xs, 0.5), p75: percentile(xs, 0.75),
    p90: percentile(xs, 0.9),
  };
}

// Spec §4.4 / §7.2 report section 3 (§12 weakness 1): how often the cost floor
// set MinSweepDepth (Level.minSweepFloorBinding, including the re-floor at
// arming) and the distribution of the trades' realised BreakevenHitRate; with
// `atMultDepth`, also the per-level ex-ante breakeven at the unfloored depth,
// (S·d + c)/((T + S)·d) in the general form of A-37.
export function costFloorDiagnostic(
  levels: ReadonlyArray<Readonly<Level>>, trades: ReadonlyArray<Readonly<Trade>>, atMultDepth?: MultDepthBreakeven,
): CostFloorDiagnostic {
  const minSweepSetByCost = levels.filter((l) => l.minSweepFloorBinding === 'cost').length;
  const be = trades.map((tr) => tr.BreakevenHitRate).filter((x) => Number.isFinite(x));
  const out = {
    minSweepSetByCost, shareOfSpikes: levels.length === 0 ? NaN : minSweepSetByCost / levels.length,
    BreakevenHitRate: percentilesOf(be),
  };
  if (atMultDepth === undefined) return out;
  const { MinSweepMult, TargetMult, StopMult, roundTripCostTicks } = atMultDepth;
  const beMult = levels.map((l) => {
    const d = ceilTicksConservative(MinSweepMult * l.VolUnit_created);
    return (StopMult * d + roundTripCostTicks(l.WickLevel)) / ((TargetMult + StopMult) * d);
  }).filter((x) => Number.isFinite(x));
  return { ...out, BreakevenAtMultDepth: percentilesOf(beMult) };
}
