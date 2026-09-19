import type { ExcursionFeatures, ResolutionNote } from './features.js';
import { failedFromMask, failedMask, type GateId, type GateResult, type PivotClass } from './gates.js';
import { invariantFailed } from './invariant.js';
import type { Lots, Ms, Pivot, Side, Ticks } from './types.js';
import { FEATURE_COUNT } from './wickstrength.js';

// Append-only: the index is the stored encoding.
const CLASSES: ReadonlyArray<PivotClass> = ['WickLevel', 'SlowExtreme', 'BurstPivot', 'Unresolved', 'Merged'];
const NOTES: ReadonlyArray<ResolutionNote | null> = [null, 'noEnter', 'pendingLimit', 'blacklist'];

// ExcursionFeatures fields in storage order.
const FEATURE_FIELDS = [
  'SpikeSize', 'ApproachVolume', 'RejectVolume', 'ApproachDuration', 'RejectDuration', 'ApproachSpeed', 'RejectSpeed',
  'SpeedAsymmetry', 'ApproachImbalance', 'RejectImbalance', 'VolumeBurst', 'TopDwell', 'RetraceFraction',
  'MaxTradeSize', 'MaxAggressorRun', 'MaxPrintGap', 'EnterTime', 'ExitTime', 'Anchor', 'BandEdge', 'retraceAvailableAt',
] as const satisfies ReadonlyArray<keyof ExcursionFeatures>;
const FEATURE_STRIDE = FEATURE_FIELDS.length;

export interface StoredPivot {
  readonly pivot: Pivot;
  readonly cls: PivotClass;
  readonly failed: GateId[];
  readonly classifiedAt: Ms;
  readonly featuresAvailable: boolean;
  readonly features: ExcursionFeatures | null;
  readonly ranks: number[] | null;
  readonly WickStrength_0: number;
  readonly WickStrength_B: number;
  readonly levelId: number;                 // −1 = none
  readonly note: ResolutionNote | null;
  readonly finalState: string | null;       // survivorship reporting (§9.5)
  readonly reason: string | null;
  readonly VolUnit_created: Ticks;          // VolUnit_now at confirmed_at (A-9); NaN for merged pivots
  readonly availableVol: Lots;              // Vol at classifiedAt (reaction-test availability, Spec §6.1.1)
}

const INDEX_BLOCK = 512;

// One sorted run of a PriceIndex.
class PriceBlock {
  readonly prices = new Int32Array(INDEX_BLOCK);
  readonly rows = new Int32Array(INDEX_BLOCK);
  length = 0;

  get max(): Ticks { return this.prices[this.length - 1]!; }

  // First position whose price is ≥ x.
  lowerBound(x: Ticks): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.prices[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// Per-side index of rows sorted by price, for PriorTouches: consecutive
// sorted blocks of ≤ INDEX_BLOCK entries, so an insert moves at most one
// block instead of every row (the store never evicts, Spec §10).
class PriceIndex {
  readonly blocks: PriceBlock[] = [new PriceBlock()];

  // First block whose max is ≥ x (the last block if none).
  blockAtLeast(x: Ticks): number {
    let lo = 0;
    let hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.blocks[mid]!.max < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Insert after equal prices: stable in row order.
  insert(price: Ticks, row: number): void {
    let b = this.blockAtLeast(price + 1);
    let block = this.blocks[b]!;
    if (block.length === INDEX_BLOCK) {
      const upper = new PriceBlock();
      const half = INDEX_BLOCK >> 1;
      upper.prices.set(block.prices.subarray(half));
      upper.rows.set(block.rows.subarray(half));
      upper.length = INDEX_BLOCK - half;
      block.length = half;
      this.blocks.splice(b + 1, 0, upper);
      if (price + 1 > block.max) {
        b++;
        block = upper;
      }
    }
    const at = block.lowerBound(price + 1);
    block.prices.copyWithin(at + 1, at, block.length);
    block.rows.copyWithin(at + 1, at, block.length);
    block.prices[at] = price;
    block.rows[at] = row;
    block.length++;
  }
}

function grow<T extends Float64Array | Int32Array | Int8Array | Uint8Array>(col: T, capacity: number): T {
  const next = new (col.constructor as new (n: number) => T)(capacity);
  next.set(col);
  return next;
}

// Spec §3.8. Every confirmed pivot with class, features, ranks and scores.
// Rows are appended in classification order (so `classifiedAt` is
// non-decreasing by row); `pivotId → row` is a separate map because pivots
// resolve out of pivotId order. Never evicts.
export class PivotStore {
  private pivots: Pivot[] = [];
  private rowOf = new Int32Array(64).fill(-1);
  private sideCol = new Int8Array(64);
  private priceCol = new Int32Array(64);
  private confirmedVolCol = new Float64Array(64);
  private clsCol = new Uint8Array(64);
  private failedCol = new Uint8Array(64);
  private classifiedAtCol = new Float64Array(64);
  private featuresAvailableCol = new Uint8Array(64);
  private featureCol = new Float64Array(64 * FEATURE_STRIDE);
  private rankCol = new Float64Array(64 * FEATURE_COUNT);
  private ws0Col = new Float64Array(64);
  private wsbCol = new Float64Array(64);
  private levelIdCol = new Int32Array(64);
  private noteCol = new Uint8Array(64);
  private volUnitCol = new Float64Array(64);
  private availableVolCol = new Float64Array(64);
  private finalStates: (string | null)[] = [];
  private reasons: (string | null)[] = [];
  private readonly bySide = { up: new PriceIndex(), down: new PriceIndex() };

  get size(): number { return this.pivots.length; }

  private ensureRowCapacity(): void {
    const capacity = this.sideCol.length;
    if (this.pivots.length < capacity) return;
    const next = capacity * 2;
    this.sideCol = grow(this.sideCol, next);
    this.priceCol = grow(this.priceCol, next);
    this.confirmedVolCol = grow(this.confirmedVolCol, next);
    this.clsCol = grow(this.clsCol, next);
    this.failedCol = grow(this.failedCol, next);
    this.classifiedAtCol = grow(this.classifiedAtCol, next);
    this.featuresAvailableCol = grow(this.featuresAvailableCol, next);
    this.featureCol = grow(this.featureCol, next * FEATURE_STRIDE);
    this.rankCol = grow(this.rankCol, next * FEATURE_COUNT);
    this.ws0Col = grow(this.ws0Col, next);
    this.wsbCol = grow(this.wsbCol, next);
    this.levelIdCol = grow(this.levelIdCol, next);
    this.noteCol = grow(this.noteCol, next);
    this.volUnitCol = grow(this.volUnitCol, next);
    this.availableVolCol = grow(this.availableVolCol, next);
  }

  private ensureIdCapacity(pivotId: number): void {
    if (pivotId < this.rowOf.length) return;
    let next = this.rowOf.length;
    while (next <= pivotId) next *= 2;
    const rowOf = new Int32Array(next).fill(-1);
    rowOf.set(this.rowOf);
    this.rowOf = rowOf;
  }

  add(
    p: Pivot, f: ExcursionFeatures | null, g: GateResult, ranks: Float64Array | null, WickStrength_0: number,
    WickStrength_B: number, levelId = -1, note: ResolutionNote | null = null, VolUnit_created: Ticks = NaN,
    availableVol: Lots = NaN,
  ): void {
    this.ensureIdCapacity(p.pivotId);
    if (this.rowOf[p.pivotId] !== -1) invariantFailed(`PivotStore.add: pivot ${p.pivotId} already stored`);
    this.ensureRowCapacity();
    const row = this.pivots.length;
    this.pivots.push(p);
    this.finalStates.push(null);
    this.reasons.push(null);
    this.rowOf[p.pivotId] = row;
    this.sideCol[row] = p.side;
    this.priceCol[row] = p.price;
    this.confirmedVolCol[row] = p.confirmedVol;
    this.clsCol[row] = CLASSES.indexOf(g.cls);
    this.classifiedAtCol[row] = g.classifiedAt;
    this.levelIdCol[row] = levelId;
    this.noteCol[row] = NOTES.indexOf(note);
    this.volUnitCol[row] = VolUnit_created;
    this.availableVolCol[row] = availableVol;
    this.writeFeatures(row, f, g.failed, ranks, WickStrength_0, WickStrength_B);
    (p.side === 1 ? this.bySide.up : this.bySide.down).insert(p.price, row);
  }

  // Completes an early-G2 SlowExtreme stored at its verdict (Spec §3.5.1):
  // class and classifiedAt stay, features/failed/ranks/scores are filled in.
  updateFeatures(
    pivotId: number, f: ExcursionFeatures | null, failed: ReadonlyArray<GateId>, ranks: Float64Array | null,
    WickStrength_0: number, WickStrength_B: number, note: ResolutionNote | null = null,
  ): void {
    const row = this.row(pivotId);
    this.noteCol[row] = NOTES.indexOf(note);
    this.writeFeatures(row, f, failed, ranks, WickStrength_0, WickStrength_B);
  }

  private writeFeatures(
    row: number, f: ExcursionFeatures | null, failed: ReadonlyArray<GateId>, ranks: Float64Array | null,
    WickStrength_0: number, WickStrength_B: number,
  ): void {
    this.failedCol[row] = failedMask(failed);
    this.featuresAvailableCol[row] = f === null ? 0 : 1;
    for (let j = 0; j < FEATURE_STRIDE; j++) this.featureCol[row * FEATURE_STRIDE + j] = f === null ? NaN : f[FEATURE_FIELDS[j]!];
    for (let j = 0; j < FEATURE_COUNT; j++) this.rankCol[row * FEATURE_COUNT + j] = ranks === null ? NaN : ranks[j]!;
    this.ws0Col[row] = WickStrength_0;
    this.wsbCol[row] = WickStrength_B;
  }

  private row(pivotId: number): number {
    const row = pivotId < this.rowOf.length ? this.rowOf[pivotId]! : -1;
    if (!(row >= 0)) invariantFailed(`PivotStore: pivot ${pivotId} not stored`);
    return row;
  }

  has(pivotId: number): boolean {
    return pivotId < this.rowOf.length && this.rowOf[pivotId]! >= 0;
  }

  // PriorTouches (§4.1): stored pivots on `side` with |price − p| ≤ tol, class
  // ≠ Unresolved, confirmedVol ≥ minVol and fromPivotId ≤ pivotId < beforePivotId
  // (`fromPivotId` excludes pivots from before a tick-size change). O(log n + hits).
  countNear(side: Side, price: Ticks, tol: Ticks, minVol: Lots, beforePivotId: number, fromPivotId = 0): number {
    const index = side === 1 ? this.bySide.up : this.bySide.down;
    const unresolved = CLASSES.indexOf('Unresolved');
    const lo = price - tol;
    const hi = price + tol;
    let count = 0;
    for (let b = index.blockAtLeast(lo); b < index.blocks.length; b++) {
      const block = index.blocks[b]!;
      for (let i = block.lowerBound(lo); i < block.length; i++) {
        if (block.prices[i]! > hi) return count;
        const row = block.rows[i]!;
        if (this.clsCol[row] !== unresolved && this.confirmedVolCol[row]! >= minVol && this.pivots[row]!.pivotId < beforePivotId &&
          this.pivots[row]!.pivotId >= fromPivotId) {
          count++;
        }
      }
    }
    return count;
  }

  byId(pivotId: number): StoredPivot | undefined {
    return this.has(pivotId) ? this.read(this.rowOf[pivotId]!) : undefined;
  }

  // Row `row` in classification order (0 ≤ row < size): observers consume new
  // rows incrementally. An early-G2 SlowExtreme row is stored at its verdict
  // and completed later by updateFeatures.
  at(row: number): StoredPivot {
    if (!(Number.isInteger(row) && row >= 0 && row < this.pivots.length)) invariantFailed(`PivotStore.at: row ${row} out of range`);
    return this.read(row);
  }

  // Pivots of class `cls` with classifiedAt ∈ [fromT, toT), in classification order.
  *iterate(cls: PivotClass, fromT: Ms, toT: Ms): Generator<StoredPivot> {
    const code = CLASSES.indexOf(cls);
    for (let row = 0; row < this.pivots.length; row++) {
      const t = this.classifiedAtCol[row]!;
      if (t >= toT) return;
      if (this.clsCol[row] === code && t >= fromT) yield this.read(row);
    }
  }

  setLevelId(pivotId: number, levelId: number): void {
    this.levelIdCol[this.row(pivotId)] = levelId;
  }

  setLevelOutcome(pivotId: number, finalState: string, reason: string): void {
    const row = this.row(pivotId);
    this.finalStates[row] = finalState;
    this.reasons[row] = reason;
  }

  private read(row: number): StoredPivot {
    const featuresAvailable = this.featuresAvailableCol[row] === 1;
    let features: ExcursionFeatures | null = null;
    if (featuresAvailable) {
      const f: Record<string, number> = {};
      FEATURE_FIELDS.forEach((name, j) => { f[name] = this.featureCol[row * FEATURE_STRIDE + j]!; });
      features = f as unknown as ExcursionFeatures;
    }
    const ranks = Array.from(this.rankCol.subarray(row * FEATURE_COUNT, (row + 1) * FEATURE_COUNT));
    return {
      pivot: this.pivots[row]!, cls: CLASSES[this.clsCol[row]!]!, failed: failedFromMask(this.failedCol[row]!),
      classifiedAt: this.classifiedAtCol[row]!, featuresAvailable, features,
      ranks: Number.isNaN(ranks[0]) ? null : ranks, WickStrength_0: this.ws0Col[row]!, WickStrength_B: this.wsbCol[row]!,
      levelId: this.levelIdCol[row]!, note: NOTES[this.noteCol[row]!] ?? null, finalState: this.finalStates[row]!,
      reason: this.reasons[row]!, VolUnit_created: this.volUnitCol[row]!, availableVol: this.availableVolCol[row]!,
    };
  }

  snapshot(): StoredPivot[] {
    return this.pivots.map((_, row) => this.read(row));
  }

  reset(): void {
    this.pivots = [];
    this.rowOf.fill(-1);
    this.finalStates = [];
    this.reasons = [];
    this.bySide.up = new PriceIndex();
    this.bySide.down = new PriceIndex();
  }
}
