import { expect } from 'vitest';

/** Cross-platform tolerance for Stage B floats (see docs/adr/0003-determinism-contract.md). */
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

/**
 * Golden check for one run file. Byte-exact everywhere except `stageB.json`, which is
 * compared as parsed JSON with a 1e-12 relative tolerance on numbers: its logistic fit
 * differs in the last ulp between macOS arm64 and Linux x64.
 */
export function expectGolden(name: string, actual: string, expected: string): void {
  if (name === 'stageB.json') expectClose(JSON.parse(actual), JSON.parse(expected), name);
  else expect(actual, name).toBe(expected);
}
