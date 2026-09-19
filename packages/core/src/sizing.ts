import { invariantFailed } from './invariant.js';
import { ceilTicksConservative } from './numerics.js';
import type { Lots, Ticks } from './types.js';

// g(WickStrength) = clip((WickStrength − MinStrength)/(1 − MinStrength), 0.5, 1),
// evaluated at arming (Spec §3.7.5). A degenerate MinStrength ≥ 1 gives 1;
// MinStrength = −∞ (pass rate 1, Spec §11.3) gives the limit 1, not ∞/∞.
export function g(WickStrength: number, MinStrength: number): number {
  const span = 1 - MinStrength;
  if (!(span > 0) || span === Infinity) return 1;
  return Math.min(1, Math.max(0.5, (WickStrength - MinStrength) / span));
}

export interface SizingInput {
  readonly WickStrength: number;
  readonly MinStrength: number;
  readonly SweepDepth: Ticks;
  readonly counterTrend: boolean;           // §8.1: Qty halved
  readonly SpreadEst_t: Ticks;
  readonly VolUnit_now: Ticks;
  readonly Vol100ms: Lots;                  // Vol100ms[h] at the arming hour
  readonly Tick: number;                    // quote currency per tick
  readonly LotSize: number;                 // base units per lot
  readonly RiskFraction: number;
  readonly equity: number;                  // constant (A-40)
  readonly SlipTicks: Ticks;
  readonly SlipCoef: number;
}

// Which Spec §4.7 caps bound on this order (§11 "Report how often each cap binds").
export interface SizingCaps {
  readonly g: boolean;
  readonly counterTrendHalved: boolean;
  readonly liquidityCap: boolean;
  readonly minQty: boolean;
}

export interface SizingResult {
  readonly Qty: Lots;                       // whole lots; 0 when minQty binds
  readonly RiskPerTrade: Ticks;             // SweepDepth + E[Slippage]
  readonly ESlippage: Ticks;
  readonly g: number;
  readonly caps: SizingCaps;
  // Qty ratio after / before each cap (1 when it did not bind).
  readonly reductions: { readonly g: number; readonly counterTrendHalved: number; readonly liquidityCap: number };
}

// Spec §4.7. Qty₀ comes from a first pass with RiskPerTrade = SweepDepth (no
// slippage term, the larger size and so the larger E[Slippage]); one
// fixed-point iteration then sets E[Slippage] and the final Qty (A-39).
export function sizeOrder(x: SizingInput): SizingResult {
  if (!(x.SweepDepth > 0)) invariantFailed(`sizeOrder: SweepDepth ${x.SweepDepth} must be positive`);
  const gx = g(x.WickStrength, x.MinStrength);
  const liquidityMax = 0.5 * x.Vol100ms;
  const planned = (RiskPerTrade: Ticks): { halved: number; capped: number } => {
    const raw = (x.RiskFraction * x.equity) / (RiskPerTrade * x.Tick * x.LotSize);
    const halved = raw * gx * (x.counterTrend ? 0.5 : 1);
    return { halved, capped: Math.min(halved, liquidityMax) };
  };
  const halfSpread = Math.ceil(x.SpreadEst_t / 2);
  const Qty0 = planned(x.SweepDepth).capped;
  const ESlippage = x.SlipTicks + halfSpread + ceilTicksConservative((x.SlipCoef * Qty0 * x.VolUnit_now) / x.Vol100ms);
  const RiskPerTrade = x.SweepDepth + ESlippage;
  const { halved, capped } = planned(RiskPerTrade);
  const Qty = Math.floor(capped + 1e-9);
  const minQty = Qty < 1;
  return {
    Qty: minQty ? 0 : Qty, RiskPerTrade, ESlippage, g: gx,
    caps: { g: gx < 1, counterTrendHalved: x.counterTrend, liquidityCap: capped < halved, minQty },
    reductions: { g: gx, counterTrendHalved: x.counterTrend ? 0.5 : 1, liquidityCap: halved > 0 && capped < halved ? capped / halved : 1 },
  };
}

export interface KillSwitchSnapshot {
  readonly volumeDay: number;
  readonly realisedR: number;
  readonly active: boolean;
  readonly trips: number;
}

// Daily kill switch (Spec §4.6, §11): realised P&L in R for the current
// volumeDay ≤ −DailyLossLimit ⇒ active until the next volumeDay (Spec §3.2.5).
export class KillSwitch {
  private day = -1;
  private realisedR = 0;
  private tripped = false;
  private tripCount = 0;

  constructor(readonly DailyLossLimit: number) {}

  get active(): boolean { return this.tripped; }
  get trips(): number { return this.tripCount; }

  sync(volumeDay: number): void {
    if (volumeDay === this.day) return;
    this.day = volumeDay;
    this.realisedR = 0;
    this.tripped = false;
  }

  onTradeClosed(pnl_R: number): void {
    this.realisedR += pnl_R;
    if (!this.tripped && this.realisedR <= -this.DailyLossLimit) {
      this.tripped = true;
      this.tripCount++;
    }
  }

  snapshot(): KillSwitchSnapshot {
    return { volumeDay: this.day, realisedR: this.realisedR, active: this.tripped, trips: this.tripCount };
  }

  reset(): void {
    this.day = -1;
    this.realisedR = 0;
    this.tripped = false;
  }
}
