import { describe, expect, it } from 'vitest';
import { computeConfigHash, parseRunConfig } from './config.js';

const fee = { TakerFee: 0.0004, MakerFee: 0.0002, verifiedAt: '2026-01-01' };

function baseInput(): Record<string, unknown> {
  return {
    fees: {
      binance: fee,
      bybit: fee,
      okx: fee,
      bitget: fee,
      gate: fee,
      kucoin: fee,
    },
    data: { lowCapSymbol: 'DOGEUSDT' },
  };
}

describe('parseRunConfig', () => {
  it('parses the default config (minimal required keys + schema defaults)', () => {
    const config = parseRunConfig(baseInput());
    expect(config.UnitWindow).toBe(60);
    expect(config.PivotMult).toBe(1.2);
    expect(config.seed).toBe(1);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => parseRunConfig({ ...baseInput(), notAKey: 1 })).toThrow();
  });

  it('rejects search.grid with a 7th key', () => {
    const input = {
      ...baseInput(),
      search: {
        grid: {
          PivotMult: [1.0, 1.2],
          BandWidthMult: [0.5],
          MinSpikeSize: [1.5],
          minStrengthPassRate: [0.4],
          MinSweepMult: [0.5],
          BreakoutMult: [2.5],
          extraKey: [1],
        },
      },
    };
    expect(() => parseRunConfig(input)).toThrow();
  });

  it('accepts search.grid with exactly the six grid keys', () => {
    const input = {
      ...baseInput(),
      search: {
        grid: {
          PivotMult: [1.0, 1.2],
          BandWidthMult: [0.5],
          MinSpikeSize: [1.5],
          minStrengthPassRate: [0.4],
          MinSweepMult: [0.5],
          BreakoutMult: [2.5],
        },
      },
    };
    expect(() => parseRunConfig(input)).not.toThrow();
  });

  it('rejects MaxAge in the input (derived, not settable)', () => {
    expect(() => parseRunConfig({ ...baseInput(), MaxAge: 720 })).toThrow();
  });

  it('computes MaxAge as 3 * AgeScale', () => {
    const config = parseRunConfig({ ...baseInput(), AgeScale: 100 });
    expect(config.MaxAge).toBe(300);
  });

  it('Spec §8.2 fixed rows accept only their value (plan item 19)', () => {
    const fixedRows: ReadonlyArray<[string, number, number]> = [
      ['TopBandMult', 0.15, 0.2], ['AnchorWindow', 20, 30], ['MinReturnSpeed', 0.3, 0.5], ['StopOffset', 1, 2],
      ['MaxSweeps', 3, 4], ['MaxPending', 4, 8], ['FillWindow', 100, 50], ['DailyLossLimit', 3, 5],
    ];
    for (const [key, ok, bad] of fixedRows) {
      expect(parseRunConfig({ ...baseInput(), [key]: ok })[key as 'TopBandMult']).toBe(ok);
      expect(() => parseRunConfig({ ...baseInput(), [key]: bad }), key).toThrow();
    }
    expect(() => parseRunConfig({ ...baseInput(), stageB: { lambda: 2 } })).toThrow();
  });

  it('ranges: integers, grid values inside their parameter range, non-negative fees, canonical lowCapSymbol', () => {
    for (const bad of [
      { UnitWindow: 60.5 }, { RankWindow: 299 }, { MaxUses: 1.5 }, { SlipTicks: 1.5 }, { TriggerOffset: 0.5 }, { SlipCoef: -0.01 },
      { TargetMult: 0 }, { StopMult: -1 }, { search: { grid: { PivotMult: [0.5, 1.2] } } }, { search: { targetGrid: { StopMult: [0] } } },
      { data: { lowCapSymbol: 'doge-usdt' } }, { fees: { ...(baseInput().fees as object), okx: { ...fee, MakerFee: -0.0001 } } },
    ]) {
      expect(() => parseRunConfig({ ...baseInput(), ...bad }), JSON.stringify(bad)).toThrow();
    }
    expect(parseRunConfig({ ...baseInput(), RetraceWindow: 7.5, MaxSpikeDuration: 3.5 }).RetraceWindow).toBe(7.5);   // A-76 midpoints
  });

  it('minExtremePrintQtyPct: off or the §3.1 10th percentile', () => {
    expect(parseRunConfig({ ...baseInput(), minExtremePrintQtyPct: 0.1 }).minExtremePrintQtyPct).toBe(0.1);
    for (const bad of [10, 0.2, true]) expect(() => parseRunConfig({ ...baseInput(), minExtremePrintQtyPct: bad })).toThrow();
  });

  it('returns a frozen config', () => {
    const config = parseRunConfig(baseInput());
    expect(() => {
      (config as { seed: number }).seed = 2;
    }).toThrow();
  });
});

describe('computeConfigHash', () => {
  it('is deterministic regardless of key order in equivalent input objects', () => {
    const configA = parseRunConfig(baseInput());
    const inputB = {
      data: { lowCapSymbol: 'DOGEUSDT' },
      fees: {
        kucoin: fee,
        gate: fee,
        bitget: fee,
        okx: fee,
        bybit: fee,
        binance: fee,
      },
    };
    const configB = parseRunConfig(inputB);
    expect(computeConfigHash(configA)).toBe(computeConfigHash(configB));
  });

  it('differs for different configs', () => {
    const configA = parseRunConfig(baseInput());
    const configB = parseRunConfig({ ...baseInput(), AgeScale: 100 });
    expect(computeConfigHash(configA)).not.toBe(computeConfigHash(configB));
  });
});
