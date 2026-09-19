import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { InvariantViolation } from '@wsr/core';
import { DataIntegrityError } from '@wsr/data';
import { ReplayInputError } from './blacklist-load.js';

// Spec §10 parallelism: grid tasks over a `worker_threads` pool. Workers are
// stateless across tasks (Spec §9.2); results are handed to `onResult` one at
// a time, and the caller merges them in task-id order, never arrival order.

export interface PoolTask<S> {
  readonly taskId: string;
  readonly spec: S;
}

export interface RunTasksOptions<R> {
  // Checked before each dispatch; in-flight tasks always finish (first SIGINT).
  readonly shouldStop?: () => boolean;
  // Called once per finished task, serially; the worker is reused only after it resolves.
  readonly onResult: (taskId: string, result: R) => Promise<void> | void;
}

export interface RunTasksResult {
  readonly completed: number;
  readonly stopped: boolean;                // tasks were left undispatched
}

export interface TaskRunner<S, R> {
  run(tasks: ReadonlyArray<PoolTask<S>>, opts: RunTasksOptions<R>): Promise<RunTasksResult>;
  close(): Promise<void>;
}

// Worker ↔ parent messages (structured clone, plain objects).
export type WorkerReply<R> =
  | { readonly taskId: string; readonly ok: true; readonly result: R }
  | { readonly taskId: string; readonly ok: false; readonly error: SerializedError };

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

export function serializeError(error: unknown): SerializedError {
  const e = error instanceof Error ? error : new Error(String(error));
  return { name: e.name, message: e.message, stack: e.stack };
}

// Re-creates the error classes the CLI maps to exit codes (Spec §2.7.2).
export function reviveError(e: SerializedError, taskId: string): Error {
  const message = `${taskId}: ${e.message}`;
  const error = e.name === 'InvariantViolation' ? new InvariantViolation(message)
    : e.name === 'DataIntegrityError' ? new DataIntegrityError(message)
      : e.name === 'ReplayInputError' ? new ReplayInputError(message)
        : Object.assign(new Error(message), { name: e.name });
  if (e.stack !== undefined) error.stack = `${error.name}: ${message}\n${e.stack.split('\n').slice(1).join('\n')}`;
  return error;
}

// Default pool size: os.availableParallelism() − 1, at least 1.
export function defaultWorkerCount(): number {
  return Math.max(1, availableParallelism() - 1);
}

// `n` workers of `url` (default dist/grid-worker.js) with `workerData`, or
// `execute` on the calling thread when n = 0.
export function poolRunner<S, R>(
  n: number, workerData: unknown, execute: (spec: S) => Promise<R>, url: URL = new URL('./grid-worker.js', import.meta.url),
): TaskRunner<S, R> {
  if (n === 0) return new InProcessRunner(execute);
  return new WorkerPoolRunner<S, R>(n, () => new Worker(url, { workerData }));
}

// Sequential runner on the calling thread (`--workers 0`, tests).
export class InProcessRunner<S, R> implements TaskRunner<S, R> {
  constructor(private readonly execute: (spec: S) => Promise<R>) {}

  async run(tasks: ReadonlyArray<PoolTask<S>>, opts: RunTasksOptions<R>): Promise<RunTasksResult> {
    let completed = 0;
    for (const task of tasks) {
      if (opts.shouldStop?.() === true) return { completed, stopped: true };
      const result = await this.execute(task.spec);
      await opts.onResult(task.taskId, result);
      completed++;
    }
    return { completed, stopped: false };
  }

  async close(): Promise<void> {}
}

interface RunState<S, R> {
  readonly tasks: ReadonlyArray<PoolTask<S>>;
  readonly opts: RunTasksOptions<R>;
  readonly resolve: (r: RunTasksResult) => void;
  readonly reject: (e: Error) => void;
  next: number;
  inFlight: number;
  completed: number;
  stopped: boolean;
  failed: Error | null;
}

// Fixed pool of `n` workers made by `spawn` (created on first use, reused
// across runs). Each worker answers one `PoolTask` message with one
// `WorkerReply`. The first failure stops dispatching; in-flight tasks finish,
// then the error is re-thrown (InvariantViolation / DataIntegrityError /
// ReplayInputError keep their class).
export class WorkerPoolRunner<S, R> implements TaskRunner<S, R> {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private readonly busy = new Map<Worker, string>();
  private state: RunState<S, R> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly n: number, private readonly spawn: () => Worker) {
    if (!(Number.isInteger(n) && n >= 1)) throw new Error(`WorkerPoolRunner: ${n} workers`);
  }

  private start(): void {
    if (this.workers.length > 0) return;
    for (let i = 0; i < this.n; i++) {
      const w = this.spawn();
      w.on('message', (msg: WorkerReply<R>) => this.onReply(w, msg));
      w.on('error', (error: Error) => this.onDead(w, error));
      w.on('exit', (code) => this.onDead(w, new Error(`grid worker exited with code ${code}`)));
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(tasks: ReadonlyArray<PoolTask<S>>, opts: RunTasksOptions<R>): Promise<RunTasksResult> {
    if (this.state !== null) throw new Error('WorkerPoolRunner: run already in progress');
    this.start();
    return new Promise<RunTasksResult>((resolve, reject) => {
      this.state = { tasks, opts, resolve, reject, next: 0, inFlight: 0, completed: 0, stopped: false, failed: null };
      this.pump();
    });
  }

  private pump(): void {
    const s = this.state;
    if (s === null) return;
    while (s.failed === null && !s.stopped && this.idle.length > 0 && s.next < s.tasks.length) {
      if (s.opts.shouldStop?.() === true) {
        s.stopped = true;
        break;
      }
      const w = this.idle.shift()!;
      const task = s.tasks[s.next++]!;
      s.inFlight++;
      this.busy.set(w, task.taskId);
      w.postMessage(task);
    }
    if (s.inFlight > 0) return;
    if (s.failed === null && !s.stopped && s.next < s.tasks.length) {
      if (this.idle.length > 0) return;
      s.failed = new Error('WorkerPoolRunner: no live worker left');
    }
    this.state = null;
    if (s.failed !== null) s.reject(s.failed);
    else s.resolve({ completed: s.completed, stopped: s.stopped || s.next < s.tasks.length });
  }

  private onReply(w: Worker, msg: WorkerReply<R>): void {
    const s = this.state;
    if (s === null || this.busy.get(w) !== msg.taskId) return;
    this.chain = this.chain.then(async () => {
      try {
        if (!msg.ok) throw reviveError(msg.error, msg.taskId);
        if (s.failed === null) {
          await s.opts.onResult(msg.taskId, msg.result);
          s.completed++;
        }
      } catch (error) {
        s.failed ??= error as Error;
      }
      this.busy.delete(w);
      this.idle.push(w);
      s.inFlight--;
      this.pump();
    });
  }

  private onDead(w: Worker, error: Error): void {
    const i = this.workers.indexOf(w);
    if (i < 0) return;                      // terminated by close()
    this.workers.splice(i, 1);
    const idleAt = this.idle.indexOf(w);
    if (idleAt >= 0) this.idle.splice(idleAt, 1);
    const s = this.state;
    const taskId = this.busy.get(w);
    this.busy.delete(w);
    if (s === null) return;
    this.chain = this.chain.then(() => {
      if (taskId !== undefined) {
        s.inFlight--;
        s.failed ??= Object.assign(error, { message: `${taskId}: ${error.message}` });
      }
      this.pump();
    });
  }

  async close(): Promise<void> {
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.all(workers.map((w) => w.terminate()));
  }
}
