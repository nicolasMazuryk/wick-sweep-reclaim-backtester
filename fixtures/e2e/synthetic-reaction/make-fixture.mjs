#!/usr/bin/env node
// Writes the synthetic data root of this fixture (Spec §11.4, build step 11):
// 8 warm-up days + 4 span days of a seeded walk with planted spikes,
// breakouts and one 15-minute outage. Run after `pnpm build`:
//   node fixtures/e2e/synthetic-reaction/make-fixture.mjs <dataRoot>
//   node packages/cli/dist/main.js reaction --data-root <dataRoot> --venue binance --symbol ETHUSDT \
//     --from 2025-01-09 --to 2025-01-12 --config fixtures/e2e/synthetic-reaction/config.json --seed 1
import { readFileSync } from 'node:fs';
import { writeSyntheticDataRoot } from '../../../packages/backtest/dist/index.js';
import { VENUE_ORDER, parseDay } from '../../../packages/data/dist/index.js';

const dataRoot = process.argv[2];
if (dataRoot === undefined) {
  process.stderr.write('usage: make-fixture.mjs <dataRoot>\n');
  process.exit(1);
}
const f = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
await writeSyntheticDataRoot({
  dataRoot, venue: VENUE_ORDER[f.venueIndex], symbol: f.symbol, from: parseDay(f.firstDay), days: f.days, seed: f.seed,
  gaps: f.gaps.map((g) => ({ start: Date.parse(g.start), end: Date.parse(g.end) })),
});
process.stdout.write(`${dataRoot}\n`);
