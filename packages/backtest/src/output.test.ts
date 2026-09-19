import { parseRunConfig, VENUE_IDS } from '@wsr/core';
import { describe, expect, it } from 'vitest';
import { buildManifest, reportValue, runIdOf, toReportJson } from './output.js';

const fees = Object.fromEntries(VENUE_IDS.map((v) => [v, { TakerFee: 0.0005, MakerFee: 0.0002, verifiedAt: '2026-09-19' }]));
const config = parseRunConfig({ fees, data: { lowCapSymbol: 'SOLUSDT' } });
const manifest = buildManifest({
  venue: VENUE_IDS[0], symbol: 'ETHUSDT', span: { from: '2025-01-09', to: '2025-01-12' }, seed: 7, config, dataChecksums: [],
  feesVerifiedAt: null, warnings: [], createdAt: '2026-09-19T00:00:00.000Z', gitCommit: 'abc', wsrVersion: '0.0.1',
});

describe('run outputs (Spec §7.1)', () => {
  it('runId is a deterministic 16-hex hash of venue|symbol|span|configHash|seed (A-72)', () => {
    expect(manifest.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.runId).toBe(runIdOf(VENUE_IDS[0], 'ETHUSDT', manifest.span, manifest.configHash, 7));
    expect(runIdOf(VENUE_IDS[0], 'ETHUSDT', manifest.span, manifest.configHash, 8)).not.toBe(manifest.runId);
  });

  it('non-finite numbers → null with a <key>Defined:false sibling; keys sorted; −0 → 0', () => {
    expect(reportValue({ b: NaN, a: 1, ci: [NaN, 2], ok: [1, 2], z: -0, nested: { x: Infinity }, u: undefined })).toEqual({
      a: 1, b: null, bDefined: false, ci: [null, 2], ciDefined: false, nested: { x: null, xDefined: false }, ok: [1, 2], z: 0,
    });
    expect(Object.keys(reportValue({ b: NaN, a: 1 }) as object)).toEqual(['a', 'b', 'bDefined']);
  });

  it('every file starts with runManifest', () => {
    const text = toReportJson(manifest, { verdict: { pass: false }, a: 1, runManifest: 'ignored' });
    expect(Object.keys(JSON.parse(text))).toEqual(['runManifest', 'a', 'verdict']);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(toReportJson(manifest)).runManifest.config.MaxAge).toBe(720);
  });
});
