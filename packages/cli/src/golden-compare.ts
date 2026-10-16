import { readRecordsParquet } from '@wsr/data';
import { expect } from 'vitest';

/** Cross-platform relative tolerance for Stage B-derived floats (see docs/adr/0003-determinism-contract.md). */
export const STAGE_B_REL_TOL = 1e-12;

function expectClose(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const scale = Math.max(Math.abs(expected), Math.abs(actual), Number.MIN_VALUE);
    expect(Math.abs(actual - expected) / scale, `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(STAGE_B_REL_TOL);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual.length, `${path}.length`).toBe(expected.length);
    expected.forEach((e, i) => expectClose(actual[i], e, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object' && actual !== null && typeof actual === 'object') {
    expect(Object.keys(actual).sort(), `${path} keys`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      expectClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

/** Rounds every decimal number in formatted text to 9 significant digits. */
function roundNumbers(text: string): string {
  return text.replace(/-?\d+\.\d+(?:e[+-]?\d+)?/gi, (m) => String(Number(Number(m).toPrecision(9))));
}

const TOLERANT_JSON = new Set(['stageB.json', 'run.json']);

/**
 * Golden check for one run file. Byte-exact on the same platform; across platforms the
 * logistic fit behind Stage B differs in the last ulp between macOS arm64 and Linux x64 and
 * that reaches the files derived from it. Those are compared structurally:
 * `stageB.json` and `run.json` as parsed JSON, `trades.jsonl` line by line, with a 1e-12
 * relative tolerance on numbers (integers stay exact in practice), and `report.md` text
 * with decimals rounded to 9 significant digits. Everything else stays byte-exact.
 */
export function expectGolden(name: string, actual: string, expected: string): void {
  if (TOLERANT_JSON.has(name)) expectClose(JSON.parse(actual), JSON.parse(expected), name);
  else if (name === 'trades.jsonl') {
    const a = actual.split('\n');
    const e = expected.split('\n');
    expect(a.length, `${name} line count`).toBe(e.length);
    e.forEach((line, i) => {
      if (line === '') expect(a[i], `${name}:${i + 1}`).toBe('');
      else expectClose(JSON.parse(a[i]!), JSON.parse(line), `${name}:${i + 1}`);
    });
  } else if (name === 'report.md') expect(roundNumbers(actual), name).toBe(roundNumbers(expected));
  else expect(actual, name).toBe(expected);
}

/**
 * Parquet golden: byte-exact when equal; otherwise the decoded rows are compared with the same
 * relative tolerance (and the key-value metadata exactly), because the Stage B float noise
 * described above reaches `trades.parquet` too.
 */
export function expectParquetGolden(name: string, actual: Buffer, expected: Buffer): void {
  if (actual.equals(expected)) return;
  const a = readRecordsParquet(actual);
  const e = readRecordsParquet(expected);
  expect(Object.fromEntries(a.metadata), `${name} metadata`).toEqual(Object.fromEntries(e.metadata));
  expectClose(a.rows, e.rows, name);
}
