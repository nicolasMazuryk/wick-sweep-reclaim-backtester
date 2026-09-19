#!/usr/bin/env node
// Builds research/data-manifest.json from the pre-registered universe rules
// (specs/research-plan.md §A). Run it twice:
//   1. now (no research/universe.json): tier placeholders such as "T2#1";
//   2. in Phase 0, after the screen wrote research/universe.json: real symbols.
// Placeholders contain '#' so they can never pass `wsr`'s canonical-symbol check.
// Every number marked ASSUMPTION is replaced by the Phase-0 measurement
// (`wsr data fetch --dry-run`, first-week `du`), see research-plan.md §A.7.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RUN_DATE = '2026-09-19';
const WARMUP_DAYS = 8;            // Spec §3.2.4 WarmupDays (the replay reads them before --from)
const EXTRA_WARMUP = 7;           // slack for archive holes at the start of the span
const PRIMARY = { from: '2025-09-18', to: '2026-09-18' };            // run span (--from/--to of reaction/backtest/grid)
const LONG = { from: '2022-01-01', to: '2026-09-18' };               // long window, Binance only
const VENUES = ['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin'];
const CLI = 'node packages/cli/dist/main.js';
// MEASURED on the VM 2026-09-19 (`wsr data fetch --dry-run`, BNB/XRP/SOL identical): archive publication
// lag per venue. The run span of a lagging venue ends on its last published day (research-plan.md §A.4).
const VENUE_TO = { binance: '2026-09-18', bybit: '2026-09-18', kucoin: '2026-09-18', okx: '2026-09-17', gate: '2026-08-31', bitget: '2026-08-16' };

// ASSUMPTION (Phase 0 replaces): one Binance day of the Spec §10 benchmark symbol (S:260, excluded from the universe) ≈ 1.05 M merged events ≈ 37 MB raw+merged.
const BENCHMARK_DAY_EVENTS = 1_050_000;
const BENCHMARK_DAY_GB = 0.037;
// ASSUMPTION: symbol event count relative to the benchmark symbol, per tier.
const TIER_SCALE = { T1: 0.35, T2: 0.15, T3: 0.06, T4: 0.03, T5: 0.05, T6: 0.05 };
// ASSUMPTION: venue event count relative to Binance for the same symbol (sum of the five = 1.35).
const VENUE_SCALE = { binance: 1.0, bybit: 0.45, okx: 0.35, bitget: 0.25, gate: 0.15, kucoin: 0.15 };

const shiftDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

const universePath = join(here, 'universe.json');
const universe = existsSync(universePath) ? JSON.parse(readFileSync(universePath, 'utf8')) : null;

// Placeholder universe: rules only, no opinion picks beyond the three named majors.
const placeholderSymbols = [
  ...['BNBUSDT', 'XRPUSDT', 'SOLUSDT'].map((s) => ({ symbol: s, tier: 'T1', resolvedBy: 'named in prompts/research-plan.md §A' })),
  ...['T1#4', 'T1#5'].map((s) => ({ symbol: s, tier: 'T1', resolvedBy: 'rule T1: next by 30-day median quote-volume rank after BNB/XRP/SOL, BTC/ETH removed' })),
  ...[1, 2, 3, 4, 5].map((i) => ({ symbol: `T2#${i}`, tier: 'T2', resolvedBy: 'rule T2: volume ranks 6–25, VolUnit-bps quantile positions {min,p25,p50,p75,max}' })),
  ...[1, 2, 3, 4, 5].map((i) => ({ symbol: `T3#${i}`, tier: 'T3', resolvedBy: 'rule T3: volume ranks 26–75, VolUnit-bps quantile positions {min,p25,p50,p75,max}' })),
  ...[1, 2, 3, 4, 5].map((i) => ({ symbol: `T4#${i}`, tier: 'T4', resolvedBy: 'rule T4: volume ranks 76–200 ∧ median trades/min ≥ 10, top 5 by VolUnit bps' })),
  ...[1, 2, 3, 4].map((i) => ({ symbol: `T5#${i}`, tier: 'T5', resolvedBy: 'rule T5: listing age ∈ [250, 410) days ∧ tpm ≥ 10, top 4 by 30-day quote volume', listedOn: '<listingDay>' })),
  ...[1, 2].map((i) => ({ symbol: `T6#${i}`, tier: 'T6', resolvedBy: 'rule T6: tick/price ≥ 1 bp, top 2 by 30-day quote volume (may duplicate a T1–T4 symbol; labelled)' })),
];
const placeholderLong = ['LONG#1', 'LONG#2'].map((s) => ({ symbol: s, tier: 'T2', resolvedBy: 'rule: the two T2 symbols with the greatest listing age (tie → volume rank)' }));

const symbols = universe?.symbols ?? placeholderSymbols;
const longSymbols = universe?.longWindow ?? placeholderLong;

const triples = [];
const tripleOf = (venue, s, purpose, runIn, fetchFrom) => {
  const run = { from: runIn.from, to: VENUE_TO[venue] < runIn.to ? VENUE_TO[venue] : runIn.to };
  const days = daysBetween(fetchFrom, run.to);
  const scale = TIER_SCALE[s.tier] * VENUE_SCALE[venue];
  return {
    venue, symbol: s.symbol, tier: s.tier, purpose,
    from: run.from, to: run.to, fetchFrom,
    fetchDays: days,
    expectedEvents: Math.round(BENCHMARK_DAY_EVENTS * scale * days),
    expectedGB: Number((BENCHMARK_DAY_GB * scale * days).toFixed(2)),
    feasibility: 'probe-in-phase-0',
    dryRun: `${CLI} data fetch --dry-run --venue ${venue} --symbol ${s.symbol} --from ${fetchFrom} --to ${run.to}`,
    fetch: `${CLI} data fetch --venue ${venue} --symbol ${s.symbol} --from ${fetchFrom} --to ${run.to} --concurrency 2`,
  };
};
for (const s of symbols) {
  const run = s.tier === 'T5' ? { from: s.listedOn === '<listingDay>' ? '<listingDay+15d>' : shiftDays(s.listedOn, WARMUP_DAYS + EXTRA_WARMUP), to: PRIMARY.to } : PRIMARY;
  const fetchFrom = s.tier === 'T5' ? (s.listedOn ?? '<listingDay>') : shiftDays(PRIMARY.from, -(WARMUP_DAYS + EXTRA_WARMUP));
  for (const venue of VENUES) triples.push(tripleOf(venue, s, 'primary', run, fetchFrom));
}
for (const s of longSymbols) triples.push(tripleOf('binance', s, 'long-window', LONG, shiftDays(LONG.from, -(WARMUP_DAYS + EXTRA_WARMUP))));

const isPlaceholder = (t) => t.symbol.includes('#') || t.fetchFrom.startsWith('<');
const numeric = triples.filter((t) => !isPlaceholder(t) || t.tier !== 'T5');
const totals = {
  triples: triples.length,
  expectedEventsAllVenues: numeric.reduce((a, t) => a + t.expectedEvents, 0),
  expectedGBAllVenues: Number(numeric.reduce((a, t) => a + t.expectedGB, 0).toFixed(1)),
  expectedGBBinanceOnly: Number(numeric.filter((t) => t.venue === 'binance').reduce((a, t) => a + t.expectedGB, 0).toFixed(1)),
  note: 'T5 rows with a placeholder listing day are priced as a 381-day span; ASSUMPTION scale factors, Phase 0 replaces',
};

const manifest = {
  runDate: RUN_DATE,
  source: universe === null ? 'placeholders (rules only; Phase 0 writes research/universe.json and reruns this script)' : `research/universe.json (${universe.screenedAt ?? 'undated'})`,
  warmupDays: WARMUP_DAYS, extraWarmup: EXTRA_WARMUP,
  spans: { primary: PRIMARY, primaryFetchFrom: shiftDays(PRIMARY.from, -(WARMUP_DAYS + EXTRA_WARMUP)), long: LONG, longFetchFrom: shiftDays(LONG.from, -(WARMUP_DAYS + EXTRA_WARMUP)) },
  exclusions: {
    rule: 'base asset BTC or ETH, and any base starting with BTC or ETH (BTCDOM, ETHW, ETHFI, …), removed before any ranking; never in a tier, this manifest or a config',
    regex: '^(BTC|ETH)',
  },
  admission: {
    allTiers: 'median trades/min over the last 30 complete UTC days ≥ 10',
    listingAgeDays: { min: 410, exceptTier: 'T5' },
    hygiene: 'present/requested ≥ 0.95, suspect ≤ 2 % of present, blacklisted minutes ≤ 3 % of span, no ≥ 7-day hole (research-plan.md §A.6)',
    venueFeasibility: 'dry-run planned days ≥ 95 % of requested and no run of ≥ 7 unavailable days',
  },
  tiers: {
    T1: 'majors: BNBUSDT, XRPUSDT, SOLUSDT plus the next two by 30-day median quote-volume rank (BTC/ETH removed)',
    T2: 'large liquid alts: volume ranks 6–25, five symbols at VolUnit-bps quantile positions {min, p25, p50, p75, max}',
    T3: 'mid-caps: volume ranks 26–75, same quantile pick',
    T4: 'low-cap / high-VolUnit: volume ranks 76–200 ∧ tpm ≥ 10, top five by VolUnit bps; T4#1 becomes data.lowCapSymbol',
    T5: 'recent listings: listing age ∈ [250, 410) days ∧ tpm ≥ 10, top four by quote volume; span = listing + 15 d → 2026-09-18',
    T6: 'coarse tick: tick/price ≥ 1 bp, top two by quote volume; may duplicate T1–T4 (labelled, not double-counted in the budget)',
  },
  venueTo: VENUE_TO,
  assumptions: { BENCHMARK_DAY_EVENTS, BENCHMARK_DAY_GB, TIER_SCALE, VENUE_SCALE, replacedBy: 'Phase 0 step P0.6 (dry-run day counts) and P0.7 (du -sh after the Binance fetch)' },
  trimRule: 'if the Phase-0 projection of all admitted triples exceeds 350 GB: drop venues for T3–T6 in the order kucoin, bitget, gate, okx until ≤ 350 GB; T1–T2 keep all six venues',
  symbols,
  longWindow: longSymbols,
  totals,
  triples,
};
writeFileSync(join(here, 'data-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote research/data-manifest.json: ${triples.length} triples, ≈ ${totals.expectedGBAllVenues} GB all venues (${totals.expectedGBBinanceOnly} GB Binance only)`);
