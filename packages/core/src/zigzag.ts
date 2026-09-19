import type { Lots, Ms, Pivot, Ticks } from './types.js';

// Spec §3.4, strategy §3.1 + Appendix A. VolUnit-scaled online zigzag: the
// look-ahead boundary of the whole system (L1). Leg state is private; the only
// output is the Pivot emitted on the confirming print.
export class Zigzag {
  private LegDir: 0 | 1 | -1 = 0;           // 0 = undefined (before init)
  private LegExtreme: Ticks = 0;
  private LegExtremeTime: Ms = 0;
  private LegExtremeSeq = 0;
  private LegExtremeVol: Lots = 0;
  private nextPivotId = 0;

  get initialized(): boolean { return this.LegDir !== 0; }

  // Spec §3.10 step 2j: starts an up leg at the first post-warm-up print.
  init(t: Ms, seq: number, p: Ticks, vol: Lots): void {
    this.LegDir = 1;
    this.setExtreme(t, seq, p, vol);
  }

  // At most one pivot per print. `PivotReversal` is the value frozen at the last
  // bucket close; `minExtremeQty` > 0 enables the minExtremePrintQtyPct variant
  // (caller passes eventSizeP10): a smaller print cannot move LegExtreme.
  update(t: Ms, seq: number, p: Ticks, q: Lots, vol: Lots, PivotReversal: Ticks, minExtremeQty: Lots = 0): Pivot | null {
    if (this.LegDir === 0) {
      this.init(t, seq, p, vol);
      return null;
    }
    if (this.LegDir === 1) {
      if (p > this.LegExtreme) {
        if (q >= minExtremeQty) this.setExtreme(t, seq, p, vol);
      } else if (p <= this.LegExtreme - PivotReversal) {
        return this.flip(t, seq, p, vol);
      }
    } else if (p < this.LegExtreme) {
      if (q >= minExtremeQty) this.setExtreme(t, seq, p, vol);
    } else if (p >= this.LegExtreme + PivotReversal) {
      return this.flip(t, seq, p, vol);
    }
    return null;
  }

  // Tests and snapshot hashing only (Spec §9.1 truncation property): no
  // consumer reads leg state, so L1 still holds.
  snapshot(): { LegDir: number; LegExtreme: Ticks; LegExtremeTime: Ms; LegExtremeSeq: number; LegExtremeVol: Lots; nextPivotId: number } {
    return {
      LegDir: this.LegDir, LegExtreme: this.LegExtreme, LegExtremeTime: this.LegExtremeTime, LegExtremeSeq: this.LegExtremeSeq,
      LegExtremeVol: this.LegExtremeVol, nextPivotId: this.nextPivotId,
    };
  }

  // Tick-change restart (Spec §3.11). pivotId stays monotone across restarts.
  reset(): void {
    this.LegDir = 0;
    this.LegExtreme = 0;
    this.LegExtremeTime = 0;
    this.LegExtremeSeq = 0;
    this.LegExtremeVol = 0;
  }

  private setExtreme(t: Ms, seq: number, p: Ticks, vol: Lots): void {
    this.LegExtreme = p;
    this.LegExtremeTime = t;
    this.LegExtremeSeq = seq;
    this.LegExtremeVol = vol;
  }

  // Emits the pivot for the finished leg and starts the opposite leg at this print.
  private flip(t: Ms, seq: number, p: Ticks, vol: Lots): Pivot {
    const up = this.LegDir === 1;
    const piv: Pivot = {
      kind: up ? 'PivotHigh' : 'PivotLow',
      side: up ? 1 : -1,
      price: this.LegExtreme,
      time: this.LegExtremeTime,
      seq: this.LegExtremeSeq,
      confirmed_at: t,
      confirmedSeq: seq,
      confirmedVol: vol,
      pivotId: this.nextPivotId++,
    };
    this.LegDir = up ? -1 : 1;
    this.setExtreme(t, seq, p, vol);
    return piv;
  }
}
