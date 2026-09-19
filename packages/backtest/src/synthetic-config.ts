import {
  type EngineTestOptions, type ExecutionInstrument, parseRunConfig, type RunConfig, VENUE_IDS, type VenueId,
} from '@wsr/core';

// Spec §11.3 synthetic-path settings. Several are outside the RunConfig schema
// ranges (MinSpikeSize 0, MaxSpikeDuration ∞, …), so they are applied after
// validation: a synthetic config never comes from a file.
export const SYNTHETIC_OVERRIDES = {
  MinSpikeSize: 0, MaxSpikeDuration: Infinity, MinRejectSpeed: 0, MinRejectImbalance: -1, MinRetrace: 0,
  MaxTopDwell: Infinity, minStrengthPassRate: 1, latencyMs: 0, SlipTicks: 0, SlipCoef: 0, targetMode: 'sweepDepth',
} as const satisfies Partial<RunConfig>;

// Engine-level switches of Spec §11.3 (never part of a RunConfig).
export const SYNTHETIC_TEST: EngineTestOptions = { targetOnTouch: true, zeroCosts: true };

// One tick = one quote unit, one lot = one base unit.
export const SYNTHETIC_INSTRUMENT: ExecutionInstrument = { Tick: 1, LotSize: 1 };

// Any venue works (fees are zero for all); the first of the canonical tuple.
export const SYNTHETIC_VENUE: VenueId = VENUE_IDS[0];

const ZERO_FEES = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0, MakerFee: 0, verifiedAt: 'synthetic' }]));

// Validated defaults + the §11.3 overrides + `over` (e.g. fees and SlipTicks
// back at their defaults for the cost test). MaxAge stays 3·AgeScale.
export function syntheticRunConfig(over: Partial<RunConfig> = {}): RunConfig {
  const base = parseRunConfig({ fees: ZERO_FEES, data: { lowCapSymbol: 'SYNTHUSDT' } });
  const cfg: RunConfig = { ...base, ...SYNTHETIC_OVERRIDES, ...over };
  return { ...cfg, MaxAge: 3 * cfg.AgeScale };
}
