// Spec §6.4 one-at-a-time sensitivity: every §10 `sensitivity` parameter at
// its Spec §8.2 range endpoints and midpoint, all else at the centre of the
// fold plateaus. Reported, not optimised.

export const SENSITIVITY_RANGES = {
  MaxSpikeDuration: [1, 6],
  MinRejectSpeed: [0.3, 1],
  MinRejectImbalance: [0.1, 0.4],
  MinRetrace: [0.5, 0.8],
  RetraceWindow: [3, 10],
  MaxTopDwell: [0.25, 1],
  AgeScale: [100, 600],
} as const satisfies Record<string, readonly [number, number]>;

export type SensitivityParam = keyof typeof SENSITIVITY_RANGES;

export interface SensitivityPoint {
  readonly param: SensitivityParam;
  readonly value: number;
  readonly taskId: string;                  // 'sens.MaxSpikeDuration-3.5'
}

// {lo, mid, hi} per parameter in table order: 7 × 3 = 21 points.
export function sensitivityPoints(): SensitivityPoint[] {
  const out: SensitivityPoint[] = [];
  for (const param of Object.keys(SENSITIVITY_RANGES) as SensitivityParam[]) {
    const [lo, hi] = SENSITIVITY_RANGES[param];
    for (const value of [lo, (lo + hi) / 2, hi]) out.push({ param, value, taskId: `sens.${param}-${value}` });
  }
  return out;
}

export interface SensitivityRow {
  readonly param: SensitivityParam | 'base';
  readonly value: number | null;            // null for the base row
  readonly oosTrades: number;
  readonly expectancy_bps: number;          // pooled test windows, realised trades
  readonly sharpeTrade_bps: number;
}
