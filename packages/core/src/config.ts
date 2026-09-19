import { createHash } from 'node:crypto';
import { z } from 'zod';

// Duplicated locally on purpose: @wsr/core must not import @wsr/data's VenueId.
export const VENUE_IDS = ['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin'] as const;
export type VenueId = (typeof VENUE_IDS)[number];

// Fractions; a negative (rebate) fee would soften the §7.4 cost floor.
const FeeSchema = z.object({
  TakerFee: z.number().min(0).max(0.01),
  MakerFee: z.number().min(0).max(0.01),
  verifiedAt: z.string(),
});

const feesShape = Object.fromEntries(VENUE_IDS.map((venueId) => [venueId, FeeSchema])) as Record<
  VenueId,
  typeof FeeSchema
>;
const FeesSchema = z.object(feesShape).strict();

// Spec §8.2 ranges of the six grid parameters (shared by the key and its grid values).
const PivotMultSchema = z.number().min(0.8).max(2.0);
const BandWidthMultSchema = z.number().min(0.3).max(0.8);
const MinSpikeSizeSchema = z.number().min(1.0).max(3.0);
const minStrengthPassRateSchema = z.number().min(0.3).max(0.6);
const MinSweepMultSchema = z.number().min(0.3).max(1.0);
const BreakoutMultSchema = z.number().min(1.5).max(4.0);

// Exactly the six §9.3 class:'grid' parameters; a 7th key must fail (Spec §8.1, §8.2).
// Every grid value lies in its parameter's range.
const GridSchema = z
  .object({
    PivotMult: z.array(PivotMultSchema).default([]),
    BandWidthMult: z.array(BandWidthMultSchema).default([]),
    MinSpikeSize: z.array(MinSpikeSizeSchema).default([]),
    minStrengthPassRate: z.array(minStrengthPassRateSchema).default([]),
    MinSweepMult: z.array(MinSweepMultSchema).default([]),
    BreakoutMult: z.array(BreakoutMultSchema).default([]),
  })
  .strict();

const TargetGridSchema = z
  .object({
    TargetMult: z.array(z.number().positive()).default([]),
    StopMult: z.array(z.number().positive()).default([]),
  })
  .strict();

const SearchSchema = z
  .object({
    grid: GridSchema.default({}),
    targetGrid: TargetGridSchema.default({}),
  })
  .strict();

const DataSchema = z
  .object({
    lowCapSymbol: z.string().regex(/^[A-Z0-9]+USDT$/, 'canonical symbol: base + USDT, upper case, no separators (Spec §2.3.3)'),
  })
  .strict();

// Spec §8.2 rows whose range is "fixed": the only accepted value is the default.
const fixed = <T extends number>(value: T) => z.literal(value).default(value);

// BucketVolume (computed daily, no static value) and MaxAge (derived = 3*AgeScale)
// are intentionally absent from this schema; `.strict()` rejects both if present
// in the input, which is exactly the Spec §8.1 rule for those two keys. Every
// other key is range-checked against Spec §8.2 (plan item 19); counts of
// buckets / pivots / events and tick offsets are integers.
export const RunConfigSchema = z
  .object({
    UnitWindow: z.number().int().min(30).max(120).default(60),
    PivotMult: PivotMultSchema.default(1.2),
    BandWidthMult: BandWidthMultSchema.default(0.5),
    MinSpikeSize: MinSpikeSizeSchema.default(1.5),
    MaxSpikeDuration: z.number().min(1).max(6).default(3),
    MinRejectSpeed: z.number().min(0.3).max(1.0).default(0.5),
    MinRejectImbalance: z.number().min(0.1).max(0.4).default(0.2),
    MinRetrace: z.number().min(0.5).max(0.8).default(0.6),
    RetraceWindow: z.number().min(3).max(10).default(5),
    MaxTopDwell: z.number().min(0.25).max(1).default(0.5),
    TopBandMult: fixed(0.15),
    AnchorWindow: fixed(20),
    MergeTolerance: z.number().min(0.15).max(0.4).default(0.25),
    RankWindow: z.number().int().min(300).max(1000).default(500),
    minStrengthPassRate: minStrengthPassRateSchema.default(0.4),
    strengthModel: z.enum(['stageA', 'stageB']).default('stageA'),
    stageB: z
      .object({
        lambda: fixed(1.0),
      })
      .strict()
      .default({}),
    AgeScale: z.number().min(100).max(600).default(240),
    ageClock: z.enum(['volume', 'wall']).default('volume'),
    DistanceScale: z.number().min(3).max(10).default(5),
    MinSweepMult: MinSweepMultSchema.default(0.5),
    BreakoutMult: BreakoutMultSchema.default(2.5),
    ArmMode: z.enum(['RestEarly', 'ArmOnApproach']).default('RestEarly'),
    ArmDistance: z.number().min(0.3).max(1.0).default(0.5),
    MinReturnSpeed: fixed(0.3),
    TriggerOffset: z.number().int().min(0).max(2).default(0),
    StopOffset: fixed(1),
    TargetMult: z.number().positive().default(2),            // §6.5 target grid (search.targetGrid may list others)
    StopMult: z.number().positive().default(1),
    targetMode: z.enum(['sweepDepth', 'volUnit', 'market', 'twoStage']).default('sweepDepth'),
    TargetUnits: z.number().min(0.5).max(3).default(2),
    timeStop: z.boolean().default(false),
    MaxHold: z.number().min(2).max(8).default(4),
    MaxUses: z.number().int().min(1).max(3).default(1),
    MaxSweeps: fixed(3),
    MaxPending: fixed(4),
    latencyMs: z.number().min(0).max(500).default(150),
    stopMode: z.enum(['client', 'exchangeNative']).default('client'),
    exchangeLatencyMs: z.number().min(10).max(50).default(30),
    SlipTicks: z.number().int().min(1).max(2).default(1),
    SlipCoef: z.number().min(0).default(0.05),
    FillWindow: fixed(100),
    RiskFraction: z.number().min(0.001).max(0.005).default(0.0025),
    equity: z.number().positive().default(100000),
    DailyLossLimit: fixed(3),
    counterTrendBlock: z.boolean().default(false),
    // Variant: off, or the extreme print must reach the 10th percentile of event size (§3.1, Spec §3.4).
    minExtremePrintQtyPct: z.union([z.literal(false), z.literal(0.1)]).default(false),
    blacklistMacroReleases: z.boolean().default(false),
    blacklistFunding: z.boolean().default(false),
    fees: FeesSchema,
    data: DataSchema,
    seed: z.number().int().min(0).max(0xffffffff).default(1),
    search: SearchSchema.default({}),
  })
  .strict();

export type ValidatedRunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfig = ValidatedRunConfig & { readonly MaxAge: number };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

// Canonical JSON (sorted keys, no whitespace) -> sha256. Deterministic and
// clock/network/random-free, so it does not violate the @wsr/core purity rule.
export function computeConfigHash(config: RunConfig): string {
  const canonicalJson = JSON.stringify(canonicalize(config));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

// Spec §6.1.6 gate config: the keys that cannot change the reaction pass
// (pass 1 runs at MinStrength 0 without Stage B; `search` / `data` are CLI
// inputs) are left out; everything else can move the PivotStore through the
// LevelBook (merges into WICK_ACTIVE levels, A-74) and stays in (A-136).
export const NON_GATE_CONFIG_KEYS = ['data', 'minStrengthPassRate', 'search', 'stageB'] as const;

export function computeGateConfigHash(config: RunConfig): string {
  const rest: Record<string, unknown> = { ...config };
  for (const key of NON_GATE_CONFIG_KEYS) delete rest[key];
  return createHash('sha256').update(JSON.stringify(canonicalize(rest))).digest('hex');
}

export function parseRunConfig(input: unknown): RunConfig {
  const validated = RunConfigSchema.parse(input);
  const config: RunConfig = {
    ...validated,
    MaxAge: 3 * validated.AgeScale,
  };
  return deepFreeze(config);
}
