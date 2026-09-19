import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SCHEMA_VERSION } from './schema.js';

// Spec §2.5 completion marker JSON shape. fetchedAt is the one place a
// wall-clock timestamp is allowed in this pipeline (everything else —
// Parquet bytes, metadata — must be deterministic).
export const DoneMarkerSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    rowsRaw: z.number().int().nonnegative(),
    rowsMerged: z.number().int().nonnegative(),
    sha256Raw: z.string().regex(/^[0-9a-f]{64}$/),
    sha256Merged: z.string().regex(/^[0-9a-f]{64}$/),
    // Every venue is served from bulk archives (A-57); 'rest' stays readable.
    source: z.enum(['archive', 'rest']),
    checksumVerified: z.boolean(),
    fetchedAt: z.string().datetime(),
    adapterVersion: z.string(),
    // Boundary records of the merged day, so the next day's midnightSplit
    // (Spec §2.4) can be decided without reading this partition.
    mergedFirst: z.object({ p: z.number().int(), s: z.union([z.literal(1), z.literal(-1)]) }).strict().optional(),
    mergedLast: z.object({ p: z.number().int(), s: z.union([z.literal(1), z.literal(-1)]) }).strict().optional(),
    // Our own sha256 of every archive file the day was built from, in
    // delivery order (Spec §2.5 "Checksums": venues without a published
    // checksum). Optional: markers written before A-100 stay valid.
    // sha256 of the instrument-meta grid records the day was normalised with
    // (A-103); a mismatch with instrument_history.json means re-fetch.
    sha256Meta: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    sha256Payload: z
      .array(z.object({ url: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
      .optional(),
  })
  .strict();

export type DoneMarker = z.infer<typeof DoneMarkerSchema>;

export function parseDoneMarker(input: unknown): DoneMarker {
  return DoneMarkerSchema.parse(input);
}

// A partition without a valid, readable .done file is incomplete (Spec
// §2.5); this throws on a missing file and on malformed/invalid JSON alike,
// so callers can treat any rejection as "needs re-fetch".
export async function readDoneMarker(path: string): Promise<DoneMarker> {
  const raw = await readFile(path, 'utf8');
  return parseDoneMarker(JSON.parse(raw));
}
