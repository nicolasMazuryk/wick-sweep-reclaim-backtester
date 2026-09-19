export type Ms = number; export type Ticks = number; export type Lots = number; export type Side = 1 | -1;
export type Buckets = number;          // volume-clock length in buckets, may be fractional (Spec §3.5.2)

export interface MergedEvent {          // struct-of-arrays on the hot path; this is the logical record
  readonly t: Ms; readonly seq: number; readonly p: Ticks; readonly q: Lots; readonly s: Side; readonly n: number;
}

export interface Bucket {               // §2.2 fields, all fixed at close
  readonly k: number;                   // 0-based bucket index since engine start
  readonly dayIndex: number;            // UTC day index of the bucket's close print
  readonly tOpen: Ms; readonly tClose: Ms;
  readonly volOpen: Lots; readonly volClose: Lots;   // cumulative Vol at first / last print
  readonly High_k: Ticks; readonly Low_k: Ticks;
  readonly Imbalance_k: Lots;           // Σ s_i q_i
  readonly Vwap_k: number;              // float, ticks; Σ p q / Σ q
  readonly Count_k: number;
  readonly WallDuration_k: Ms;          // tClose − tOpen
  readonly targetVolume: Lots;          // BucketVolume in force when the bucket opened
  readonly maxPrintGap_k: Ticks;        // max |p_i − p_{i−1}| inside the bucket (§8.7 burst input)
}

export type PivotKind = 'PivotHigh' | 'PivotLow';
export interface Pivot {                // §3.1 emission
  readonly kind: PivotKind; readonly side: Side;        // PivotHigh ⇒ side=+1 (upper), PivotLow ⇒ side=−1
  readonly price: Ticks;                // = LegExtreme at emission
  readonly time: Ms; readonly seq: number;             // = LegExtremeTime (+ seq of that print)
  readonly confirmed_at: Ms; readonly confirmedSeq: number;
  readonly confirmedVol: Lots;          // Vol at confirmation
  readonly pivotId: number;             // monotone
}
