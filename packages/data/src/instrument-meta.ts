import { readFile } from 'node:fs/promises';
import type { Ms } from '@wsr/core';
import { z } from 'zod';
import { instrumentHistoryPath } from './paths.js';
import { atomicWriteFile } from './storage.js';
import type { InstrumentMeta, InstrumentMetaHistory, VenueId } from './venue.js';

// Spec §2.1 InstrumentMetaHistory: one record per tick/lot change, sorted by
// validFrom; at(t) = last record with validFrom ≤ t (the first record also
// covers any earlier t).
export function createMetaHistory(records: readonly InstrumentMeta[]): InstrumentMetaHistory {
  if (records.length === 0) {
    throw new Error('InstrumentMetaHistory needs at least one record');
  }
  const sorted = [...records].sort((a, b) => a.validFrom - b.validFrom);
  return {
    records: sorted,
    at(t: Ms): InstrumentMeta {
      let lo = 0;
      let hi = sorted.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (sorted[mid]!.validFrom <= t) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return sorted[lo]!;
    },
  };
}

// Adds (or replaces, on equal validFrom) a record.
export function withMetaRecord(history: InstrumentMetaHistory, record: InstrumentMeta): InstrumentMetaHistory {
  return createMetaHistory([...history.records.filter((r) => r.validFrom !== record.validFrom), record]);
}

const InstrumentMetaSchema = z
  .object({
    venue: z.string(),
    symbol: z.string(),
    venueSymbol: z.string(),
    Tick: z.number().positive(),
    TickDecimal: z.string(),
    LotSize: z.number().positive(),
    LotSizeDecimal: z.string(),
    contractMultiplier: z.number().positive(),
    contractMultiplierDecimal: z.string(),
    TakerFee: z.number(),
    MakerFee: z.number(),
    feesVerifiedAt: z.string().nullable(),
    fundingIntervalHours: z.number().positive(),
    validFrom: z.number().int(),
    // Optional (A-102): files written before it stay readable.
    unverified: z.array(z.enum(['fundingIntervalHours', 'validFrom'])).optional(),
  })
  .strict();

const InstrumentHistoryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    // [VERIFY] placeholders carried in the file itself (Spec §2.7 `wsr data
    // meta`, A-102); `note` is the pre-A-102 single fee reminder.
    note: z.string().optional(),
    verify: z.array(z.string()).optional(),
    records: z.array(InstrumentMetaSchema).min(1),
  })
  .strict();

// One [VERIFY] line per placeholder value (Spec §2.1 InstrumentMeta
// comments, §2.3.2, §2.7): unverified fees, a defaulted funding interval, a
// change instant that is not from a venue announcement.
export function verifyNotes(history: InstrumentMetaHistory): string[] {
  const notes: string[] = [];
  for (const r of history.records) {
    const at = `record validFrom=${r.validFrom} (${new Date(r.validFrom).toISOString()})`;
    if (r.feesVerifiedAt === null) {
      notes.push(`[VERIFY] ${at}: TakerFee/MakerFee are placeholders until feesVerifiedAt is set from the venue VIP-0 schedule`);
    }
    if (r.unverified?.includes('fundingIntervalHours') === true) {
      notes.push(`[VERIFY] ${at}: fundingIntervalHours=${r.fundingIntervalHours} is a default (the venue reported none); check it, then drop 'fundingIntervalHours' from unverified`);
    }
    if (r.unverified?.includes('validFrom') === true) {
      notes.push(`[VERIFY] ${at}: change instant inferred or observed, not from a venue announcement (Spec §2.3.2); correct validFrom, then drop 'validFrom' from unverified`);
    }
  }
  return notes;
}

export async function readInstrumentHistory(dataRoot: string, venue: VenueId, symbol: string): Promise<InstrumentMetaHistory | undefined> {
  let text: string;
  try {
    text = await readFile(instrumentHistoryPath(dataRoot, venue, symbol), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const parsed = InstrumentHistoryFileSchema.parse(JSON.parse(text));
  return createMetaHistory(parsed.records as InstrumentMeta[]);
}

export async function writeInstrumentHistory(dataRoot: string, venue: VenueId, symbol: string, history: InstrumentMetaHistory): Promise<string> {
  const path = instrumentHistoryPath(dataRoot, venue, symbol);
  const notes = verifyNotes(history);
  const body = { schemaVersion: 1, ...(notes.length > 0 ? { verify: notes } : {}), records: history.records };
  await atomicWriteFile(path, Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
  return path;
}
