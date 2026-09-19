import { describe, expect, it } from 'vitest';
import type { ExcursionFeatures } from './features.js';
import { applyGates, evaluateGates, failedFromMask, failedMask, type GateConfig, type GateId } from './gates.js';
import { InvariantViolation } from './invariant.js';

const cfg: GateConfig = {
  MinSpikeSize: 1.5, MaxSpikeDuration: 3, MinRejectSpeed: 0.5, MinRejectImbalance: 0.2, MinRetrace: 0.6, MaxTopDwell: 0.5,
};

// Passes every gate with margin; each case below breaks exactly one.
const passing: ExcursionFeatures = {
  SpikeSize: 2, ApproachVolume: 10, RejectVolume: 10, ApproachDuration: 1, RejectDuration: 1, ApproachSpeed: 1,
  RejectSpeed: 1, SpeedAsymmetry: 0, ApproachImbalance: 0.5, RejectImbalance: 0.5, VolumeBurst: 1, TopDwell: 0.2,
  RetraceFraction: 0.8, MaxTradeSize: 1, MaxAggressorRun: 3, MaxPrintGap: 0.1, EnterTime: 0, ExitTime: 1000, Anchor: 0,
  BandEdge: 0, retraceAvailableAt: 2000,
};

describe('SpikeGates (Spec §3.6)', () => {
  it('all six pass → WickLevel with no failures, classifiedAt = now', () => {
    expect(applyGates(passing, cfg, 2000)).toEqual({ cls: 'WickLevel', failed: [], classifiedAt: 2000 });
  });

  const cases: [GateId, Partial<ExcursionFeatures>][] = [
    ['G1', { SpikeSize: 1.49 }],
    ['G2', { ApproachDuration: 2, RejectDuration: 1.01 }],
    ['G3', { RejectSpeed: 0.49 }],
    ['G4', { RejectImbalance: 0.19 }],
    ['G5', { RetraceFraction: 0.59 }],
    ['G6', { TopDwell: 0.51 }],
  ];
  it.each(cases)('%s failing alone → SlowExtreme', (gate, patch) => {
    const r = applyGates({ ...passing, ...patch }, cfg, 5000);
    expect(r.cls).toBe('SlowExtreme');
    expect(r.failed).toEqual([gate]);
  });

  it('boundaries are inclusive (≥ / ≤)', () => {
    const edge = { ...passing, SpikeSize: 1.5, ApproachDuration: 1.5, RejectDuration: 1.5, RejectSpeed: 0.5,
      RejectImbalance: 0.2, RetraceFraction: 0.6, TopDwell: 0.5 };
    expect(evaluateGates(edge, cfg)).toEqual([]);
  });

  it('NaN features fail their gate', () => {
    expect(evaluateGates({ ...passing, RejectSpeed: NaN }, cfg)).toEqual(['G3']);
  });

  it('L3: applyGates before retraceAvailableAt throws InvariantViolation', () => {
    expect(() => applyGates(passing, cfg, 1999)).toThrow(InvariantViolation);
  });

  it('failed bitmask round-trips in G1…G6 order', () => {
    expect(failedFromMask(failedMask(['G5', 'G2']))).toEqual(['G2', 'G5']);
    expect(failedMask([])).toBe(0);
  });
});

describe('SpikeGates at the Spec §11.3 synthetic values', () => {
  const open: GateConfig = { MinSpikeSize: 0, MaxSpikeDuration: Infinity, MinRejectSpeed: 0, MinRejectImbalance: -1, MinRetrace: 0, MaxTopDwell: Infinity };
  it('every gate passes for any finite feature values with a non-negative excursion', () => {
    const extremes: Partial<ExcursionFeatures>[] = [
      {}, { SpikeSize: 0 }, { ApproachDuration: 1e9, RejectDuration: 1e9 }, { RejectSpeed: 1e-12 }, { RejectImbalance: -1 },
      { RetraceFraction: 0 }, { TopDwell: 1e12 },
    ];
    for (const over of extremes) expect(applyGates({ ...passing, ...over }, open, 2000)).toMatchObject({ cls: 'WickLevel', failed: [] });
  });
});
