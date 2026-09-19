import { Worker } from 'node:worker_threads';
import { InvariantViolation } from '@wsr/core';
import { DataIntegrityError } from '@wsr/data';
import { afterEach, describe, expect, it } from 'vitest';
import { InProcessRunner, type PoolTask, type TaskRunner, WorkerPoolRunner } from './worker-pool.js';

interface Spec { readonly x: number; readonly delay?: number; readonly fail?: string; readonly crash?: boolean }

// Inline worker speaking the pool protocol: result = 2x after `delay` ms.
const WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (t) => {
  if (t.spec.crash) process.exit(3);
  if (t.spec.fail) {
    parentPort.postMessage({ taskId: t.taskId, ok: false, error: { name: t.spec.fail, message: 'boom', stack: undefined } });
    return;
  }
  setTimeout(() => parentPort.postMessage({ taskId: t.taskId, ok: true, result: t.spec.x * 2 }), t.spec.delay ?? 0);
});`;

const tasks = (specs: Spec[]): PoolTask<Spec>[] => specs.map((spec, i) => ({ taskId: `t${String(i).padStart(2, '0')}`, spec }));
const pools: TaskRunner<Spec, number>[] = [];
function pool(n: number): TaskRunner<Spec, number> {
  const p = new WorkerPoolRunner<Spec, number>(n, () => new Worker(WORKER, { eval: true }));
  pools.push(p);
  return p;
}
const inProcess = (): TaskRunner<Spec, number> => new InProcessRunner<Spec, number>(async (s) => {
  if (s.fail !== undefined) throw new InvariantViolation('boom');
  return s.x * 2;
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

async function collect(runner: TaskRunner<Spec, number>, list: PoolTask<Spec>[], stopAfter = Infinity) {
  const got = new Map<string, number>();
  const order: string[] = [];
  const r = await runner.run(list, { shouldStop: () => order.length >= stopAfter, onResult: (id, v) => { got.set(id, v); order.push(id); } });
  return { r, got, order };
}

describe('worker pool (Spec §10)', () => {
  it('in-process and worker runners give the same results; merged in task-id order they are identical', async () => {
    const list = tasks(Array.from({ length: 12 }, (_, i) => ({ x: i, delay: (7 * i) % 5 })));
    const a = await collect(inProcess(), list);
    const p = pool(3);
    const b = await collect(p, list);
    const c = await collect(p, list);                  // the pool is reusable across runs
    expect(a.r).toEqual({ completed: 12, stopped: false });
    expect(b.r).toEqual({ completed: 12, stopped: false });
    const sorted = (m: Map<string, number>) => [...m].sort(([x], [y]) => (x < y ? -1 : 1));
    expect(sorted(b.got)).toEqual(sorted(a.got));
    expect(sorted(c.got)).toEqual(sorted(a.got));
    expect(a.order).toEqual(list.map((t) => t.taskId));
  });

  it('shouldStop: no dispatch after the request, in-flight tasks finish', async () => {
    const list = tasks(Array.from({ length: 10 }, (_, i) => ({ x: i, delay: 5 })));
    const a = await collect(inProcess(), list, 3);
    expect(a.r).toEqual({ completed: 3, stopped: true });
    expect(a.order).toEqual(['t00', 't01', 't02']);
    const b = await collect(pool(2), list, 3);
    expect(b.r.stopped).toBe(true);
    expect(b.r.completed).toBeGreaterThanOrEqual(3);
    expect(b.r.completed).toBeLessThanOrEqual(4);       // at most one more was in flight
    expect(b.order).toHaveLength(b.r.completed);
  });

  it('a task error stops dispatching and is re-thrown with its class (exit-code mapping)', async () => {
    const list = tasks([{ x: 1, delay: 20 }, { x: 2, fail: 'InvariantViolation' }, ...Array.from({ length: 6 }, (_, i) => ({ x: i }))]);
    const p = pool(2);
    const run = collect(p, list);
    await expect(run).rejects.toBeInstanceOf(InvariantViolation);
    await expect(run).rejects.toThrow('t01: boom');
    await expect(collect(pool(1), tasks([{ x: 1, fail: 'DataIntegrityError' }]))).rejects.toBeInstanceOf(DataIntegrityError);
    await expect(collect(inProcess(), list)).rejects.toBeInstanceOf(InvariantViolation);
  });

  it('a crashed worker fails the run', async () => {
    await expect(collect(pool(2), tasks([{ x: 1, delay: 10 }, { x: 2, crash: true }, { x: 3 }]))).rejects.toThrow(/exited with code 3/);
  });
});
