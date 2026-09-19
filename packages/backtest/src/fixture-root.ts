import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  addDays, compareDays, dayStartMs, donePath, eachDay, type FundingRecord, formatDay, MS_PER_DAY, parseDay, partitionPath, readDoneMarker,
  readFunding, type UtcDay, type VenueId,
} from '@wsr/data';
import { ReplayInputError } from './blacklist-load.js';
import { writeSyntheticDataRoot } from './synthetic-data-root.js';

// Spec §11.4 / A-150: a checked-in end-to-end fixture is one recorded venue-day
// (`recorded/` — a Spec §2.5 data-root subtree: merged partition, `.done`,
// hygiene report, instrument history, funding) plus the synthetic days the
// replay needs in front of it, generated at materialisation time from the
// recorded day's own statistics. `wsr backtest --fixture <dir>` materialises
// the pair into a data root and runs the fixture's declared inputs.
export interface E2eFixtureManifest {
  readonly schemaVersion: number;
  readonly name: string;
  readonly venue: VenueId;
  readonly symbol: string;
  readonly recorded: ReadonlyArray<string>;            // recorded UTC days, ascending
  readonly syntheticFrom: string;                      // first generated day (warm-up + span filler)
  readonly span: { readonly from: string; readonly to: string };
  readonly folds: string;                              // `--folds <train,test,step>`
  readonly seed: number;
  readonly bootstrap: number;
  // Floor of the generated days' print interval: the recorded day's own rate
  // (86 400 s / merged events) would put ≈ 1 M prints on every generated day.
  readonly minPrintIntervalMs: number;
  readonly createdAt: string;
  readonly gitCommit: string;
  readonly wsrVersion: string;
}

export const FIXTURE_MANIFEST = 'fixture.json';
export const FIXTURE_RECORDED_DIR = 'recorded';

function fail(dir: string, why: string): never {
  throw new ReplayInputError(`--fixture ${dir}: ${why}`);
}

export async function readE2eFixture(dir: string): Promise<E2eFixtureManifest> {
  let text: string;
  try {
    text = await readFile(join(dir, FIXTURE_MANIFEST), 'utf8');
  } catch (error) {
    return fail(dir, `cannot read ${FIXTURE_MANIFEST}: ${(error as Error).message}`);
  }
  const manifest = JSON.parse(text) as E2eFixtureManifest;
  if (manifest.schemaVersion !== 1) fail(dir, `unsupported fixture schemaVersion ${String(manifest.schemaVersion)}`);
  if (manifest.recorded.length === 0) fail(dir, 'no recorded day');
  return manifest;
}

// Writes the fixture's data root into `dataRoot`: the recorded subtree verbatim
// (its bytes are the golden input) and then the generated days, whose walk
// starts at the recorded day's own first merged price and whose hygiene reports
// are checked against the recorded funding schedule. Deterministic: the same
// fixture directory always produces the same data root.
export async function materialiseFixtureRoot(dir: string, dataRoot: string): Promise<E2eFixtureManifest> {
  const manifest = await readE2eFixture(dir);
  await cp(join(dir, FIXTURE_RECORDED_DIR), dataRoot, { recursive: true });

  const recorded = manifest.recorded.map(parseDay).sort(compareDays);
  const first = recorded[0]!;
  const marker = await readDoneMarker(donePath(partitionPath(dataRoot, 'merged', manifest.venue, manifest.symbol, first)));
  if (marker.mergedFirst === undefined) fail(dir, `recorded day ${formatDay(first)} has no merged rows`);

  const syntheticFrom = parseDay(manifest.syntheticFrom);
  const syntheticTo = addDays(first, -1);
  if (compareDays(syntheticFrom, syntheticTo) > 0) fail(dir, 'syntheticFrom is not before the first recorded day');
  const days = eachDay(syntheticFrom, syntheticTo).length;
  // The recorded day's own print rate, floored so the generated days stay small.
  const recordedIntervalMs = Math.round(MS_PER_DAY / marker.rowsMerged);
  const funding: FundingRecord[] = (await readFunding(dataRoot, manifest.venue, manifest.symbol))
    .filter((r) => r.t < dayStartMs(first));

  await writeSyntheticDataRoot({
    dataRoot, venue: manifest.venue, symbol: manifest.symbol, from: syntheticFrom, days, seed: manifest.seed,
    origin: marker.mergedFirst.p, printIntervalMs: Math.max(manifest.minPrintIntervalMs, recordedIntervalMs), keepMeta: true, funding,
  });
  return manifest;
}

export function fixtureSpan(manifest: E2eFixtureManifest): { readonly from: UtcDay; readonly to: UtcDay } {
  return { from: parseDay(manifest.span.from), to: parseDay(manifest.span.to) };
}
