import { readFile } from 'node:fs/promises';
import { parseDoneMarker, type DoneMarker } from './done-marker.js';
import { SCHEMA_VERSION } from './schema.js';

// Spec §2.7.2 exit code 4: a stored partition cannot be trusted (schema
// version mismatch, sha256 differs from its `.done`, unreadable marker).
export class DataIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataIntegrityError';
  }
}

// `.done` of a partition the replay is about to read: undefined when absent
// (partition incomplete / never fetched), DataIntegrityError when present
// but of another schema version or malformed (Spec §2.5 "Readers refuse a
// mismatched major version").
export async function readDoneMarkerForReplay(path: string): Promise<DoneMarker | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DataIntegrityError(`${path}: unreadable completion marker: ${(error as Error).message}`);
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    throw new DataIntegrityError(`${path}: schemaVersion ${String(version)} does not match reader schemaVersion ${SCHEMA_VERSION}`);
  }
  try {
    return parseDoneMarker(json);
  } catch (error) {
    throw new DataIntegrityError(`${path}: invalid completion marker: ${(error as Error).message}`);
  }
}
