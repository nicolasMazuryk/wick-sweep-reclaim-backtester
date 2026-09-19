import { readFile } from 'node:fs/promises';
import { readFundingParquet, writeFundingParquet } from './parquet.js';
import { fundingPath } from './paths.js';
import { atomicWriteFile } from './storage.js';
import type { FundingRecord, VenueId } from './venue.js';

export async function readFunding(dataRoot: string, venue: VenueId, symbol: string): Promise<FundingRecord[]> {
  try {
    return readFundingParquet(await readFile(fundingPath(dataRoot, venue, symbol)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// Union by t (incoming wins), sorted ascending.
export function mergeFunding(existing: readonly FundingRecord[], incoming: readonly FundingRecord[]): FundingRecord[] {
  const byTime = new Map<number, FundingRecord>();
  for (const record of [...existing, ...incoming]) {
    byTime.set(record.t, record);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export async function writeFunding(dataRoot: string, venue: VenueId, symbol: string, records: readonly FundingRecord[]): Promise<string> {
  const path = fundingPath(dataRoot, venue, symbol);
  await atomicWriteFile(path, writeFundingParquet(records));
  return path;
}
