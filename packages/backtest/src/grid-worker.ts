import { parentPort, workerData } from 'node:worker_threads';
import type { RunConfig } from '@wsr/core';
import { executeTask, type TaskResult, type TaskSpec } from './grid-cell.js';
import { planReplay, type ReplayInput, type ReplayPlan } from './replay.js';
import type { Fold } from './walk-forward.js';
import { type PoolTask, serializeError, type WorkerReply } from './worker-pool.js';

// Grid worker entry (dist/grid-worker.js): plans the replay once, then runs
// one task per message. Stateless across tasks apart from the plan (Spec §9.2).
export interface GridWorkerData {
  readonly input: ReplayInput;
  readonly folds: ReadonlyArray<Fold>;
  readonly planCfg: RunConfig;              // the run's config (blacklist switches)
}

const data = workerData as GridWorkerData;
let plan: Promise<ReplayPlan> | null = null;

parentPort!.on('message', (task: PoolTask<TaskSpec>) => {
  void (async () => {
    let reply: WorkerReply<TaskResult>;
    try {
      plan ??= planReplay(data.input, data.planCfg);
      reply = { taskId: task.taskId, ok: true, result: await executeTask(await plan, data.folds, task.spec) };
    } catch (error) {
      reply = { taskId: task.taskId, ok: false, error: serializeError(error) };
    }
    parentPort!.postMessage(reply);
  })();
});
