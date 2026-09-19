import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { computeConfigHash, type RunConfig, type VenueId } from '@wsr/core';
import { atomicWriteFile } from '@wsr/data';

// Spec §7.1.
export interface RunManifest {
  readonly runId: string; readonly createdAt: string; readonly gitCommit: string; readonly wsrVersion: string;
  readonly venue: VenueId; readonly symbol: string; readonly span: { readonly from: string; readonly to: string }; readonly seed: number;
  readonly config: RunConfig; readonly configHash: string; readonly dataChecksums: ReadonlyArray<{ readonly day: string; readonly sha256Merged: string }>;
  readonly feesVerifiedAt: string | null; readonly warnings: readonly string[];
  readonly fromGrid?: string;               // `wsr backtest --from-grid <runId>` (A-134); part of the runId
}

export interface ManifestInput {
  readonly venue: VenueId;
  readonly symbol: string;
  readonly span: { readonly from: string; readonly to: string };   // 'YYYY-MM-DD', inclusive
  readonly seed: number;
  readonly config: RunConfig;
  readonly dataChecksums: RunManifest['dataChecksums'];
  readonly feesVerifiedAt: string | null;
  readonly warnings: readonly string[];
  // Injected so identical inputs give byte-identical outputs (A-72).
  readonly createdAt: string;
  readonly gitCommit: string;
  readonly wsrVersion: string;
  readonly fromGrid?: string;
}

// A-72: runId = first 16 hex of sha256(venue|symbol|from|to|configHash|seed),
// so reruns of the same inputs land in the same directory; a `--from-grid`
// run appends `|fromGrid:<grid runId>` (its own directory, A-134).
export function runIdOf(
  venue: VenueId, symbol: string, span: { from: string; to: string }, configHash: string, seed: number, fromGrid?: string,
): string {
  const parts: Array<string | number> = [venue, symbol, span.from, span.to, configHash, seed];
  if (fromGrid !== undefined) parts.push(`fromGrid:${fromGrid}`);
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function buildManifest(m: ManifestInput): RunManifest {
  const configHash = computeConfigHash(m.config);
  return {
    runId: runIdOf(m.venue, m.symbol, m.span, configHash, m.seed, m.fromGrid), createdAt: m.createdAt, gitCommit: m.gitCommit, wsrVersion: m.wsrVersion,
    venue: m.venue, symbol: m.symbol, span: { from: m.span.from, to: m.span.to }, seed: m.seed, config: m.config, configHash,
    dataChecksums: m.dataChecksums, feesVerifiedAt: m.feesVerifiedAt, warnings: m.warnings,
    ...(m.fromGrid === undefined ? {} : { fromGrid: m.fromGrid }),
  };
}

// Spec §7.1 JSON rules: sorted keys; a non-finite number becomes null with a
// `<key>Defined: false` sibling (for an array element: on the array's key);
// undefined members are dropped; −0 is written as 0.
export function reportValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value + 0 : null;
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return reportValue(Array.from(value as unknown as ArrayLike<number>));
  if (Array.isArray(value)) return value.map(reportValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const defined = new Set<string>();
  for (const key of keys) {
    const v = obj[key];
    const bad = typeof v === 'number' ? !Number.isFinite(v)
      : Array.isArray(v) && v.some((x) => typeof x === 'number' && !Number.isFinite(x));
    if (bad) defined.add(`${key}Defined`);
  }
  for (const key of [...keys, ...defined].sort()) {
    out[key] = defined.has(key) && !(key in obj) ? false : reportValue(obj[key]);
  }
  return out;
}

// One output file: `runManifest` first (Spec §7.1 "Every file starts with
// runManifest"), then the body's keys sorted; 2-space indent, trailing newline.
export function toReportJson(manifest: RunManifest, body: Record<string, unknown> = {}): string {
  const rest = reportValue(body) as Record<string, unknown>;
  delete rest.runManifest;
  return `${JSON.stringify({ runManifest: reportValue(manifest), ...rest }, null, 2)}\n`;
}

export interface RunOutputPaths {
  readonly runDir: string;
  readonly runJson: string;
  readonly reactionJson: string;
}

export function runDirOf(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

// runs/{runId}/run.json and runs/{runId}/reaction.json, each written atomically.
export async function writeRunOutputs(runsRoot: string, manifest: RunManifest, reaction: object): Promise<RunOutputPaths> {
  const runDir = runDirOf(runsRoot, manifest.runId);
  const runJson = join(runDir, 'run.json');
  const reactionJson = join(runDir, 'reaction.json');
  await atomicWriteFile(runJson, Buffer.from(toReportJson(manifest)));
  await atomicWriteFile(reactionJson, Buffer.from(toReportJson(manifest, reaction as Record<string, unknown>)));
  return { runDir, runJson, reactionJson };
}
