import type { RunConfig } from './config.js';
import type { ExcursionFeatures } from './features.js';
import { invariantFailed } from './invariant.js';
import type { Ms } from './types.js';

// Spec §3.6 (strategy §3.3). `Merged` (A-91): a pivot merged into a WICK_ACTIVE
// level by LevelBook.onPivot (Spec §3.9.4) — a touch (A-26), never a level.
export type PivotClass = 'WickLevel' | 'SlowExtreme' | 'BurstPivot' | 'Unresolved' | 'Merged';
export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
export interface GateResult { readonly cls: PivotClass; readonly failed: ReadonlyArray<GateId>; readonly classifiedAt: Ms; }

export const GATE_IDS: ReadonlyArray<GateId> = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];

export interface GateConfig {
  readonly MinSpikeSize: number;
  readonly MaxSpikeDuration: number;
  readonly MinRejectSpeed: number;
  readonly MinRejectImbalance: number;
  readonly MinRetrace: number;
  readonly MaxTopDwell: number;
}

export function gateConfigFrom(cfg: RunConfig): GateConfig {
  return {
    MinSpikeSize: cfg.MinSpikeSize, MaxSpikeDuration: cfg.MaxSpikeDuration, MinRejectSpeed: cfg.MinRejectSpeed,
    MinRejectImbalance: cfg.MinRejectImbalance, MinRetrace: cfg.MinRetrace, MaxTopDwell: cfg.MaxTopDwell,
  };
}

// Failed gates in G1…G6 order; empty ⇔ every gate passes.
export function evaluateGates(f: ExcursionFeatures, cfg: GateConfig): GateId[] {
  const failed: GateId[] = [];
  if (!(f.SpikeSize >= cfg.MinSpikeSize)) failed.push('G1');
  if (!(f.ApproachDuration + f.RejectDuration <= cfg.MaxSpikeDuration)) failed.push('G2');
  if (!(f.RejectSpeed >= cfg.MinRejectSpeed)) failed.push('G3');
  if (!(f.RejectImbalance >= cfg.MinRejectImbalance)) failed.push('G4');
  if (!(f.RetraceFraction >= cfg.MinRetrace)) failed.push('G5');
  if (!(f.TopDwell <= cfg.MaxTopDwell)) failed.push('G6');
  return failed;
}

// All six gates at `now` ≥ retraceAvailableAt (L3: G5 is never evaluated
// earlier). WickLevel iff all pass, else SlowExtreme. Burst exclusion, the
// early G2 verdict and Unresolved need stream state and are decided by
// ExcursionFeaturesTracker.
export function applyGates(f: ExcursionFeatures, cfg: GateConfig, now: Ms): GateResult {
  if (!(now >= f.retraceAvailableAt)) invariantFailed(`applyGates: now ${now} < retraceAvailableAt ${f.retraceAvailableAt} (L3)`);
  const failed = evaluateGates(f, cfg);
  return { cls: failed.length === 0 ? 'WickLevel' : 'SlowExtreme', failed, classifiedAt: now };
}

// Bitmask encoding of `failed` (bit j ⇔ G(j+1)) for PivotStore.
export function failedMask(failed: ReadonlyArray<GateId>): number {
  let mask = 0;
  for (const id of failed) mask |= 1 << GATE_IDS.indexOf(id);
  return mask;
}

export function failedFromMask(mask: number): GateId[] {
  return GATE_IDS.filter((_, j) => (mask & (1 << j)) !== 0);
}
