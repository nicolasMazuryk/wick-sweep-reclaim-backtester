import { describe, expect, it } from 'vitest';
import { g, KillSwitch, sizeOrder, type SizingInput } from './sizing.js';

// RiskFraction·equity = 250; SweepDepth 10; halfSpread 1: Qty₀ = 25 ⇒
// E[Slippage] = 1 + 1 + ceil(0.05·25·10/1000) = 3, RiskPerTrade 13, Qty 19.
const BASE: SizingInput = {
  WickStrength: 1, MinStrength: 0, SweepDepth: 10, counterTrend: false, SpreadEst_t: 2, VolUnit_now: 10, Vol100ms: 1000,
  Tick: 1, LotSize: 1, RiskFraction: 0.0025, equity: 100_000, SlipTicks: 1, SlipCoef: 0.05,
};

describe('Sizing (Spec §4.7)', () => {
  it('g clips (WickStrength − MinStrength)/(1 − MinStrength) to [0.5, 1]', () => {
    expect(g(0.9, 0.4)).toBeCloseTo(0.5 / 0.6, 12);
    expect(g(0.5, 0.4)).toBe(0.5);
    expect(g(1, 0.4)).toBe(1);
    expect(g(1.3, 0.4)).toBe(1);
    expect(g(1, 1)).toBe(1);
    expect(g(0.2, -Infinity)).toBe(1);                   // pass rate 1 (Spec §11.3): the limit, not ∞/∞
  });

  it('no cap binds: Qty = floor(RiskFraction·equity/(RiskPerTrade·Tick·LotSize))', () => {
    const r = sizeOrder(BASE);
    expect([r.Qty, r.RiskPerTrade, r.ESlippage, r.g]).toEqual([19, 13, 3, 1]);
    expect(r.caps).toEqual({ g: false, counterTrendHalved: false, liquidityCap: false, minQty: false });
    expect(r.reductions).toEqual({ g: 1, counterTrendHalved: 1, liquidityCap: 1 });
  });

  it('E[Slippage] takes one fixed-point iteration from Qty₀ at RiskPerTrade = SweepDepth (A-39)', () => {
    // Qty₀ = 25 ⇒ ceil(10·25·10/1000) = 3 ⇒ E[Slippage] 5; a second iteration (Qty 16) would give 4.
    const r = sizeOrder({ ...BASE, SlipCoef: 10 });
    expect([r.ESlippage, r.RiskPerTrade, r.Qty]).toEqual([5, 15, 16]);
  });

  it('g binds and is recorded', () => {
    const r = sizeOrder({ ...BASE, WickStrength: 0.7, MinStrength: 0.4 });
    expect([r.g, r.Qty]).toEqual([0.5, 9]);
    expect(r.caps.g).toBe(true);
    expect(r.reductions.g).toBe(0.5);
  });

  it('counter-trend halving binds and is recorded (§8.1)', () => {
    const r = sizeOrder({ ...BASE, counterTrend: true });
    expect(r.Qty).toBe(9);
    expect(r.caps).toEqual({ g: false, counterTrendHalved: true, liquidityCap: false, minQty: false });
    expect(r.reductions.counterTrendHalved).toBe(0.5);
  });

  it('liquidity cap Qty ≤ 0.5·Vol100ms[h] binds and is recorded', () => {
    const r = sizeOrder({ ...BASE, Vol100ms: 20 });
    expect(r.Qty).toBe(10);
    expect(r.caps.liquidityCap).toBe(true);
    expect(r.reductions.liquidityCap).toBeCloseTo(10 / (250 / 13), 12);
  });

  it('Qty < 1 lot sets minQty (the arm is refused)', () => {
    const r = sizeOrder({ ...BASE, equity: 10 });
    expect([r.Qty, r.caps.minQty]).toEqual([0, true]);
  });

  it('Tick and LotSize convert quote risk into lots', () => {
    const r = sizeOrder({ ...BASE, Tick: 0.5, LotSize: 0.1, Vol100ms: 1e9 });
    expect(r.Qty).toBe(Math.floor(250 / (13 * 0.05)));
  });
});

describe('KillSwitch (Spec §4.6)', () => {
  it('trips when the volumeDay realised R reaches −DailyLossLimit and resets on the next volumeDay', () => {
    const k = new KillSwitch(3);
    k.sync(0);
    k.onTradeClosed(-1.5);
    k.onTradeClosed(1);
    k.onTradeClosed(-1.5);
    expect(k.active).toBe(false);
    k.onTradeClosed(-1);                                  // −3R exactly
    expect([k.active, k.trips]).toEqual([true, 1]);
    k.onTradeClosed(-1);
    k.sync(0);
    expect([k.active, k.trips]).toEqual([true, 1]);
    k.sync(1);
    expect(k.snapshot()).toEqual({ volumeDay: 1, realisedR: 0, active: false, trips: 1 });
  });
});
