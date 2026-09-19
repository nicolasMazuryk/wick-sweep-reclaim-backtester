import type { ExecutionPort, ExitKind } from '../level-book.js';
import type { Level } from '../level.js';
import type { MergedEvent, Ticks } from '../types.js';

export interface PortCall {
  readonly kind: 'arm' | 'cancelEntry' | 'replaceStop' | 'enter' | 'exit' | 'partialExit';
  readonly levelId: number;
  readonly id: number;                      // orderId / tradeId (−1 when not applicable or refused)
  readonly price: Ticks | -1;               // TriggerPrice (arm), StopLoss (replaceStop), print price (enter/exit)
  readonly seq: number | -1;
  readonly exit?: ExitKind;
}

// Test fake for the step-7 ExecutionModel/Sizing: records every call, arms
// unless `refuseArm` says otherwise (Qty < 1 lot); round-trip cost from `costTicks`;
// a twoStage first leg moves the stop to `partialStop(level)` (−1: unsplit).
export class RecordingPort implements ExecutionPort {
  readonly calls: PortCall[] = [];
  costTicks: (p: Ticks) => Ticks = () => 0;
  refuseArm: (level: Readonly<Level>) => boolean = () => false;
  partialStop: (level: Readonly<Level>) => Ticks | -1 = (level) => level.WickLevel;
  private nextOrderId = 0;
  private nextTradeId = 0;

  roundTripCostTicks(p: Ticks): Ticks { return this.costTicks(p); }

  arm(level: Readonly<Level>, TriggerPrice: Ticks): number {
    const id = this.refuseArm(level) ? -1 : this.nextOrderId++;
    this.calls.push({ kind: 'arm', levelId: level.levelId, id, price: TriggerPrice, seq: -1 });
    return id;
  }

  cancelEntry(level: Readonly<Level>): void {
    this.calls.push({ kind: 'cancelEntry', levelId: level.levelId, id: level.OrderIds.entry, price: -1, seq: -1 });
  }

  replaceStop(level: Readonly<Level>): void {
    this.calls.push({ kind: 'replaceStop', levelId: level.levelId, id: level.OrderIds.entry, price: level.StopLoss, seq: -1 });
  }

  enter(level: Readonly<Level>, e: MergedEvent): number {
    const id = this.nextTradeId++;
    this.calls.push({ kind: 'enter', levelId: level.levelId, id, price: e.p, seq: e.seq });
    return id;
  }

  exit(level: Readonly<Level>, kind: ExitKind, e: MergedEvent): void {
    this.calls.push({ kind: 'exit', levelId: level.levelId, id: level.tradeId, price: e.p, seq: e.seq, exit: kind });
  }

  partialExit(level: Readonly<Level>, e: MergedEvent): Ticks | -1 {
    this.calls.push({ kind: 'partialExit', levelId: level.levelId, id: level.tradeId, price: e.p, seq: e.seq });
    return this.partialStop(level);
  }

  exitsLive(): boolean { return true; }
  takePrintsAfterEntryFill(): ReadonlyArray<MergedEvent> { return []; }
  flat(): boolean { return true; }

  of(kind: PortCall['kind']): PortCall[] { return this.calls.filter((c) => c.kind === kind); }
}
