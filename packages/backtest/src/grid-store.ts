import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, sha256Hex } from '@wsr/data';

// Spec §10 resumable runs: every grid task writes
// runs/{runId}/cells/{taskId}.json (the result) and then
// runs/{runId}/cells/{taskId}.done (its key and the sha256 of the json), each
// atomically. A task is skipped on rerun only when its .done matches the
// task key and the json bytes; anything else is recomputed.

// JSON with non-finite numbers kept (NaN / ±Infinity as {"$num": "NaN"}).
export function encodeResult(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? { $num: String(v) } : v));
}

export function decodeResult<T>(text: string): T {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$num') return Number((v as { $num: string }).$num);
    }
    return v;
  }) as T;
}

// sha256 of the canonical encoding of everything the task result depends on.
export function taskKeyOf(parts: unknown): string {
  return createHash('sha256').update(encodeResult(parts)).digest('hex');
}

interface DoneMarker {
  readonly taskId: string;
  readonly taskKey: string;
  readonly sha256: string;
}

export function cellsDirOf(runDir: string): string {
  return join(runDir, 'cells');
}

export type StoredTask<T> =
  | { readonly status: 'done'; readonly result: T }
  | { readonly status: 'absent' }
  | { readonly status: 'stale'; readonly reason: string };

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTask<T>(runDir: string, taskId: string, taskKey: string): Promise<StoredTask<T>> {
  const dir = cellsDirOf(runDir);
  const doneText = await readText(join(dir, `${taskId}.done`));
  if (doneText === null) return { status: 'absent' };
  let marker: DoneMarker;
  try {
    marker = JSON.parse(doneText) as DoneMarker;
  } catch {
    return { status: 'stale', reason: 'corrupt .done' };
  }
  if (marker.taskId !== taskId || marker.taskKey !== taskKey) return { status: 'stale', reason: 'task key mismatch (other inputs)' };
  const json = await readText(join(dir, `${taskId}.json`));
  if (json === null) return { status: 'stale', reason: 'result json missing' };
  if (sha256Hex(Buffer.from(json)) !== marker.sha256) return { status: 'stale', reason: 'result json sha256 mismatch' };
  try {
    return { status: 'done', result: decodeResult<T>(json) };
  } catch {
    return { status: 'stale', reason: 'corrupt result json' };
  }
}

// Writes the json, then the .done; returns the result as a reader would see
// it (round-tripped), so fresh and resumed runs merge identical values.
export async function writeTask<T>(runDir: string, taskId: string, taskKey: string, result: T): Promise<T> {
  const dir = cellsDirOf(runDir);
  const json = encodeResult(result);
  const bytes = Buffer.from(json);
  await atomicWriteFile(join(dir, `${taskId}.json`), bytes);
  const marker: DoneMarker = { taskId, taskKey, sha256: sha256Hex(bytes) };
  await atomicWriteFile(join(dir, `${taskId}.done`), Buffer.from(`${JSON.stringify(marker)}\n`));
  return decodeResult<T>(json);
}
