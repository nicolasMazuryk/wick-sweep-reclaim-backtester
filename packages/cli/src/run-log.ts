import { join } from 'node:path';
import type { PipelineLogger } from '@wsr/data';
import pino from 'pino';

// Spec §10 "Progress" (A-140): a sample every 5 s.
export const PROGRESS_INTERVAL_MS = 5_000;

export interface ProgressSample {
  readonly type: 'progress';
  readonly command: string;
  readonly runId: string;
  readonly venue: string;
  readonly symbol: string;
  readonly eventsProcessed: number;
  readonly eventsPerSec: number;
  readonly days: number;
  readonly elapsedMs: number;
}

// Rate-limited progress: `add` is called once per decoded replay batch (never
// per print) and emits at most one sample per intervalMs; `flush` emits the
// last one. `eventsPerSec` is measured over the whole run so far.
export class ProgressTicker {
  private events = 0;
  private days = new Set<string>();
  private readonly start: number;
  private last: number;
  private emitted = 0;

  constructor(
    private readonly emit: (sample: ProgressSample) => void,
    private readonly base: Pick<ProgressSample, 'command' | 'runId' | 'venue' | 'symbol'>,
    private readonly now: () => number = () => Date.now(),
    private readonly intervalMs: number = PROGRESS_INTERVAL_MS,
  ) {
    this.start = now();
    this.last = this.start;
  }

  add(events: number, day: string): void {
    this.events += events;
    this.days.add(day);
    const t = this.now();
    if (t - this.last >= this.intervalMs) {
      this.last = t;
      this.sample(t);
    }
  }

  // Final sample of a run; skipped when nothing was replayed.
  flush(): void {
    if (this.events > 0 && this.emitted === 0) this.sample(this.now());
  }

  private sample(t: number): void {
    const elapsedMs = t - this.start;
    this.emitted += 1;
    this.emit({
      ...this.base,
      type: 'progress',
      eventsProcessed: this.events,
      eventsPerSec: elapsedMs > 0 ? (this.events * 1000) / elapsedMs : 0,
      days: this.days.size,
      elapsedMs,
    });
  }
}

export interface RunLog {
  readonly log: PipelineLogger;
  // Spec §10 output layout: runs/{runId}/logs/{command}.jsonl; null when logging is off.
  readonly path: string | null;
  readonly close: () => Promise<void>;
}

const SILENT: PipelineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export const NO_RUN_LOG: RunLog = { log: SILENT, path: null, close: async () => {} };

// Spec §10 "Logging" (A-140): pino JSON lines under runs/{runId}/logs/{command}.jsonl,
// every line carrying runId, venue, symbol (and whatever `base` adds). Level
// 'silent' (and an injected logger, i.e. tests) writes no file at all, so the
// run directory stays exactly the Spec §7.1 artefact set.
export function openRunLog(
  runsRoot: string, runId: string, command: string, level: string, base: Readonly<Record<string, unknown>>,
): RunLog {
  if (level === 'silent') return NO_RUN_LOG;
  const path = join(runsRoot, runId, 'logs', `${command}.jsonl`);
  const destination = pino.destination({ dest: path, sync: true, mkdir: true });
  const log = pino({ level, base: { runId, ...base } }, destination);
  return {
    log,
    path,
    close: async () => {
      destination.flushSync();
      destination.end();
    },
  };
}
