// Regenerates fixtures/venues/{venue}/expected.json from the recorded archive
// extracts with the current adapters (run `pnpm build` first):
//   node fixtures/venues/make-goldens.mjs
// Only rerun when an adapter change is intended, and review the diff.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as data from '../../packages/data/dist/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'files.json'), 'utf8'));
for (const [venue, entry] of Object.entries(manifest)) {
  const meta = data.createMetaHistory([JSON.parse(readFileSync(join(root, venue, 'meta.json'), 'utf8'))]);
  const payload = {
    symbol: 'ETHUSDT',
    day: data.parseDay(entry.day),
    source: 'archive',
    files: entry.files.map(([name, contentType]) => ({ path: join(root, venue, name), contentType, url: name })),
    cacheKeys: [],
    checksumVerified: false,
  };
  const rows = [];
  for await (const trade of data.normaliseArchiveDay(data.VENUES[venue], payload, meta)) {
    const { venue: v, symbol, tradeId, t, tNsRemainder, seq, p, q, s } = trade;
    rows.push(JSON.stringify({ venue: v, symbol, tradeId, t, tNsRemainder, seq, p, q, s }));
  }
  writeFileSync(join(root, venue, 'expected.json'), `[\n${rows.join(',\n')}\n]\n`);
  console.log(venue, rows.length);
}
