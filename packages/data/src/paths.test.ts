import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { donePath, partitionPath } from './paths.js';

describe('partitionPath', () => {
  it('lays out {dataRoot}/{kind}/{venue}/{symbol}/{YYYY}/{YYYY-MM-DD}.parquet', () => {
    const path = partitionPath('/data', 'raw', 'testvenue', 'ETHUSDT', { y: 2025, m: 3, d: 1 });
    expect(path).toBe(['', 'data', 'raw', 'testvenue', 'ETHUSDT', '2025', '2025-03-01.parquet'].join(sep));
  });

  it('pads single-digit month and day', () => {
    const path = partitionPath('/data', 'merged', 'testvenue', 'ETHUSDT', { y: 2025, m: 1, d: 5 });
    expect(path.endsWith(`2025${sep}2025-01-05.parquet`)).toBe(true);
  });

  it('distinguishes raw and merged kinds', () => {
    const day = { y: 2025, m: 3, d: 1 };
    const raw = partitionPath('/data', 'raw', 'testvenue', 'ETHUSDT', day);
    const merged = partitionPath('/data', 'merged', 'testvenue', 'ETHUSDT', day);
    expect(raw).not.toBe(merged);
  });
});

describe('donePath', () => {
  it('appends .done to the partition path', () => {
    const path = partitionPath('/data', 'merged', 'testvenue', 'ETHUSDT', { y: 2025, m: 3, d: 1 });
    expect(donePath(path)).toBe(`${path}.done`);
  });
});
