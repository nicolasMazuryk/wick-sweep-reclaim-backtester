import { readFile } from 'node:fs/promises';
import { assertTickRange, assertVolumeBound, type Engine, type FundingSchedule, type MergedEvent, type Ms, type RunConfig, type Side, type VenueId } from '@wsr/core';
import {
  addDays, DataIntegrityError, dayEndMs, dayStartMs, donePath, eachDay, formatDay, openMergedParquet, partitionPath, readDoneMarkerForReplay,
  readFunding, readHygiene, readInstrumentHistory, sha256Hex, type HygieneReport, type InstrumentMeta,
  type InstrumentMetaHistory, type UtcDay,
} from '@wsr/data';
import { buildBlacklist, type LoadedBlacklist, readMacroReleases, ReplayInputError } from './blacklist-load.js';

// Spec §3.2.4: the replay starts WarmupDays before the span; the warm-up span
// is excluded from every statistic.
export const WARMUP_DAYS = 8;

export interface ReplayInput {
  readonly dataRoot: string;
  readonly venue: VenueId;                  // one venue per run, never mixed (§9.5)
  readonly symbol: string;
  readonly from: UtcDay;                    // first span day (statistics start here)
  readonly to: UtcDay;                      // last span day, inclusive
  readonly warmupDays?: number;
}

export type DayStatus = 'ok' | 'missing' | 'checksumFailed';

export interface DayEntry {
  readonly day: UtcDay;
  readonly label: string;                   // 'YYYY-MM-DD'
  readonly status: DayStatus;
  readonly warmup: boolean;                 // before `from`
  readonly path: string;                    // merged partition
  readonly sha256Merged: string | null;
  readonly rows: number;
}

export interface ReplayPlan {
  readonly input: ReplayInput;
  readonly replayFrom: UtcDay;              // from − warmupDays
  readonly spanStart: Ms;                   // dayStartMs(from)
  readonly spanEnd: Ms;                     // dayEndMs(to), exclusive
  readonly days: ReadonlyArray<DayEntry>;
  readonly instrument: InstrumentMetaHistory;
  readonly funding: FundingSchedule;
  readonly blacklist: LoadedBlacklist;
  readonly dataChecksums: ReadonlyArray<{ readonly day: string; readonly sha256Merged: string }>;
  readonly feesVerifiedAt: string | null;
  readonly warnings: ReadonlyArray<string>;
}

// Reads the metadata of every replay day (`.done`, hygiene), the instrument
// history and funding, and builds the blacklist. Partition bytes are read
// later, one day at a time, by `replay`.
export async function planReplay(input: ReplayInput, cfg: RunConfig): Promise<ReplayPlan> {
  const { dataRoot, venue, symbol } = input;
  const warmupDays = input.warmupDays ?? WARMUP_DAYS;
  if (dayStartMs(input.from) > dayStartMs(input.to)) {
    throw new ReplayInputError(`span ${formatDay(input.from)}…${formatDay(input.to)} is empty`);
  }
  const replayFrom = addDays(input.from, -warmupDays);
  const spanStart = dayStartMs(input.from);
  const spanEnd = dayEndMs(input.to);
  const instrument = await readInstrumentHistory(dataRoot, venue, symbol);
  if (instrument === undefined) {
    throw new DataIntegrityError(`${venue}/${symbol}: no instrument_history.json under ${dataRoot}/meta (run \`wsr data meta\`)`);
  }
  const warnings: string[] = [];
  const days: DayEntry[] = [];
  const reports: HygieneReport[] = [];
  const excludedDays: { day: UtcDay; reason: string }[] = [];
  for (const day of eachDay(replayFrom, input.to)) {
    const label = formatDay(day);
    const path = partitionPath(dataRoot, 'merged', venue, symbol, day);
    const warmup = dayStartMs(day) < spanStart;
    const [marker, hygiene] = await Promise.all([readDoneMarkerForReplay(donePath(path)), readHygiene(dataRoot, venue, symbol, day)]);
    let status: DayStatus = 'ok';
    if (hygiene?.checksumFailed === true) status = 'checksumFailed';
    else if (marker === undefined) status = 'missing';
    if (status !== 'ok') {
      // A-70: not fed; a whole-day blacklist interval keeps levels off the hole.
      excludedDays.push({ day, reason: status === 'missing' ? 'missingPartition' : 'checksum' });
      warnings.push(`${label}: ${status === 'missing' ? 'merged partition missing or incomplete (no .done)' : 'checksum failed'} — day not replayed, blacklisted`);
      days.push({ day, label, status, warmup, path, sha256Merged: null, rows: 0 });
      continue;
    }
    if (hygiene === undefined) warnings.push(`${label}: no hygiene report — no blacklist intervals for this day`);
    else reports.push(hygiene);
    days.push({ day, label, status, warmup, path, sha256Merged: marker!.sha256Merged, rows: marker!.rowsMerged });
  }

  const meta0 = instrument.at(dayStartMs(replayFrom));
  const records = (await readFunding(dataRoot, venue, symbol)).filter((r) => r.t >= dayStartMs(replayFrom) && r.t < spanEnd);
  // A-38: an empty schedule still carries the venue interval, so every settlement is charged the fallback.
  const funding = { records, intervalMs: meta0.fundingIntervalHours * 3_600_000 };
  if (records.length === 0) warnings.push('no funding records in the replay span — funding charged per A-38');
  const macroReleases = cfg.blacklistMacroReleases ? await readMacroReleases(dataRoot) : null;
  const blacklist = buildBlacklist(
    { reports, excludedDays, funding: records, macroReleases, start: dayStartMs(replayFrom), end: spanEnd }, cfg,
  );
  const feesVerifiedAt = instrument.at(spanStart).feesVerifiedAt;
  if (feesVerifiedAt === null) warnings.push('[VERIFY] fees unverified');
  const ticks = instrument.records.filter((r) => r.validFrom > dayStartMs(replayFrom) && r.validFrom < spanEnd);
  for (const r of ticks) warnings.push(`tick/lot size change at ${new Date(r.validFrom).toISOString()} — engine re-based, warm-up restarted`);
  return {
    input, replayFrom, spanStart, spanEnd, days, instrument, funding, blacklist,
    dataChecksums: days.filter((d) => d.status === 'ok').map((d) => ({ day: d.label, sha256Merged: d.sha256Merged! })),
    feesVerifiedAt, warnings,
  };
}

function sameGrid(a: InstrumentMeta, b: InstrumentMeta): boolean {
  return a.Tick === b.Tick && a.LotSize === b.LotSize;
}

export interface ReplayOptions {
  readonly onDay?: (day: DayEntry) => void;
}

// Spec §10 "Progress": one sample per decoded batch (≤ 1 M rows), never per print.
export interface ReplayProgress {
  readonly day: string;                     // 'YYYY-MM-DD' of the batch just fed
  readonly batchEvents: number;             // rows of this batch
  readonly events: number;                  // rows fed so far in this replay
}

// Spec §10 "Progress" / §2.7.2 exit 130 (A-140). A replay is driven by many call sites
// (reaction pass, trading pass, sweeps, bench), so the CLI installs its hooks
// once for the whole process instead of threading them through every caller.
// Worker threads have their own module instance: the grid drives those through
// its own task runner.
export interface ReplayHooks {
  readonly shouldStop?: () => boolean;      // first SIGINT: checked between batches
  readonly onProgress?: (p: ReplayProgress) => void;
}

// Thrown when `shouldStop` turns true mid-replay; the CLI turns it into exit 130.
export class RunInterrupted extends Error {
  constructor(message = 'interrupted') {
    super(message);
    this.name = 'RunInterrupted';
  }
}

let replayHooks: ReplayHooks = {};

// Installs the hooks for every in-process replay; the returned function restores the previous ones.
export function installReplayHooks(hooks: ReplayHooks): () => void {
  const previous = replayHooks;
  replayHooks = hooks;
  return () => { replayHooks = previous; };
}

// Streams the planned days through the engine, one ≤ 1 M-row record batch in
// memory at a time (Spec §10). `seq` is re-numbered across the whole replay (A-69): the
// stored per-day seq restarts at 0 every day. The engine is re-based
// (`resetOnTickChange`) before the first print on a new tick/lot grid.
// Every partition's bytes are checked against the sha256 of its `.done`.
export async function replay(plan: ReplayPlan, engine: Engine, opts: ReplayOptions = {}): Promise<void> {
  let seq = 0;                              // also the count of events fed so far (A-69)
  let sumQ = 0;
  let meta = firstMeta(plan);
  let nextChangeT = -Infinity;              // re-check the grid once t reaches the next validFrom
  // One reused event (Spec §10: no per-print allocation); the engine and its
  // observers copy what they keep, and resetOnTickChange runs before it is overwritten.
  const e: { -readonly [K in keyof MergedEvent]: MergedEvent[K] } = { t: 0, seq: 0, p: 0, q: 0, s: 1, n: 0 };
  for (const d of plan.days) {
    opts.onDay?.(d);
    if (d.status !== 'ok') continue;
    const bytes = await readFile(d.path);
    const sha = sha256Hex(bytes);
    if (sha !== d.sha256Merged) throw new DataIntegrityError(`${d.path}: sha256 ${sha} does not match .done ${d.sha256Merged}`);
    // Spec §10: the day is decoded as record batches of ≤ 1 M rows; only the
    // batch being fed is held. The footer row count is checked before any decode.
    const reader = await openMergedParquet(bytes);
    try {
      if (reader.rows !== d.rows) throw new DataIntegrityError(`${d.path}: ${reader.rows} rows, .done says ${d.rows}`);
      for await (const cols of reader.batches()) {
        if (replayHooks.shouldStop?.() === true) throw new RunInterrupted(`interrupted while replaying ${d.label}`);
        const { t, p, q, s, n } = cols;
        // Numeric domain (Spec §3.11): Σq < 2^52 over the span, |p| < 2^31 ticks;
        // checked on the batch before any of its prints is fed.
        let maxAbsP = 0;
        for (let i = 0; i < cols.length; i++) {
          sumQ += q[i]!;
          const a = Math.abs(p[i]!);
          if (a > maxAbsP) maxAbsP = a;
        }
        try {
          assertVolumeBound(sumQ);
          assertTickRange(maxAbsP);
        } catch (err) {
          throw new DataIntegrityError(`${d.path}: ${(err as Error).message}`);
        }
        for (let i = 0; i < cols.length; i++) {
          const ti = t[i]!;
          if (ti >= nextChangeT) {
            const m = plan.instrument.at(ti);
            if (!sameGrid(meta, m)) engine.resetOnTickChange({ Tick: m.Tick, LotSize: m.LotSize });
            meta = m;
            nextChangeT = plan.instrument.records.find((r) => r.validFrom > ti)?.validFrom ?? Infinity;
          }
          e.t = ti;
          e.seq = seq++;
          e.p = p[i]!;
          e.q = q[i]!;
          e.s = s[i]! as Side;
          e.n = n[i]!;
          engine.onPrint(e);
        }
        replayHooks.onProgress?.({ day: d.label, batchEvents: cols.length, events: seq });
      }
    } finally {
      reader.close();
    }
  }
  engine.finish();
}

// Instrument record in force on the first replayed day.
function firstMeta(plan: ReplayPlan): InstrumentMeta {
  const first = plan.days.find((d) => d.status === 'ok') ?? plan.days[0]!;
  return plan.instrument.at(dayStartMs(first.day));
}

// Tick / lot grid for Engine.fromConfig.
export function initialInstrument(plan: ReplayPlan): { Tick: number; LotSize: number } {
  const m = firstMeta(plan);
  return { Tick: m.Tick, LotSize: m.LotSize };
}
