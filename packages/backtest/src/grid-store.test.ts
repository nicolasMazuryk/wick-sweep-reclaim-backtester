import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellsDirOf, decodeResult, encodeResult, readTask, taskKeyOf, writeTask } from './grid-store.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsr-grid-store-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('grid task store (Spec §10 resumable runs)', () => {
  it('encoding keeps NaN / ±Infinity; the task key is stable and input-sensitive', () => {
    const v = { a: [1, NaN, -Infinity], b: { c: Infinity, d: 'x' } };
    const back = decodeResult<typeof v>(encodeResult(v));
    expect(back.a[1]).toBeNaN();
    expect(back.a[2]).toBe(-Infinity);
    expect(back.b).toEqual({ c: Infinity, d: 'x' });
    expect(taskKeyOf({ k: [1, NaN] })).toBe(taskKeyOf({ k: [1, NaN] }));
    expect(taskKeyOf({ k: [1, NaN] })).not.toBe(taskKeyOf({ k: [1, 2] }));
  });

  it('json is written before .done; reads back the round-tripped value; absent without .done', async () => {
    const runDir = join(dir, 'run1');
    expect(await readTask(runDir, 'baseline.c0001', 'k1')).toEqual({ status: 'absent' });
    const written = await writeTask(runDir, 'baseline.c0001', 'k1', { x: NaN, y: [1, 2] });
    expect(written.x).toBeNaN();
    expect((await readdir(cellsDirOf(runDir))).sort()).toEqual(['baseline.c0001.done', 'baseline.c0001.json']);
    const done = JSON.parse(await readFile(join(cellsDirOf(runDir), 'baseline.c0001.done'), 'utf8'));
    expect(Object.keys(done)).toEqual(['taskId', 'taskKey', 'sha256']);
    const r = await readTask<{ x: number; y: number[] }>(runDir, 'baseline.c0001', 'k1');
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.result.y).toEqual([1, 2]);
    // A json without its .done (crash between the two writes) is not a result.
    await writeFile(join(cellsDirOf(runDir), 'baseline.c0002.json'), '{}');
    expect((await readTask(runDir, 'baseline.c0002', 'k1')).status).toBe('absent');
  });

  it('key mismatch, edited json or corrupt .done ⇒ stale (recompute)', async () => {
    const runDir = join(dir, 'run2');
    await writeTask(runDir, 't', 'k1', { v: 1 });
    expect(await readTask(runDir, 't', 'k2')).toEqual({ status: 'stale', reason: 'task key mismatch (other inputs)' });
    await writeFile(join(cellsDirOf(runDir), 't.json'), '{"v":2}');
    expect(await readTask(runDir, 't', 'k1')).toEqual({ status: 'stale', reason: 'result json sha256 mismatch' });
    await writeFile(join(cellsDirOf(runDir), 't.done'), '{not json');
    expect(await readTask(runDir, 't', 'k1')).toEqual({ status: 'stale', reason: 'corrupt .done' });
  });
});
