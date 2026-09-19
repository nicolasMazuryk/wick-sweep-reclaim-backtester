import type { Engine, MergedEvent, Ms, Side, Ticks } from '@wsr/core';
import type { Xoshiro128ss } from './rng.js';

export interface RandomWalkOptions {
  readonly events: number;
  readonly p0: Ticks;
  readonly t0: Ms;
  readonly dtMs: Ms;                        // fixed time between prints
  readonly q: number;                       // constant size, lots
  readonly drift?: number;                  // P(up) = (1 + drift)/2, drift ∈ (−1, 1); default 0
}

// Spec §11.3 synthetic path: a ±1-tick move on every print (P(up) = (1 + drift)/2),
// aggressor sign i.i.d. ±1 and independent of the move, constant size, fixed dt.
// Streaming: one event per iteration, no path array.
export function* randomWalk(rng: Xoshiro128ss, o: RandomWalkOptions): Generator<MergedEvent> {
  const drift = o.drift ?? 0;
  if (!(drift > -1 && drift < 1)) throw new Error(`randomWalk: drift ${drift} outside (−1, 1)`);
  if (!(Number.isInteger(o.q) && o.q >= 1)) throw new Error(`randomWalk: size ${o.q} is not a positive lot count`);
  const up = (1 + drift) / 2;
  let p = o.p0;
  for (let i = 0; i < o.events; i++) {
    p += rng.nextFloat() < up ? 1 : -1;
    const s: Side = rng.nextFloat() < 0.5 ? 1 : -1;
    yield { t: o.t0 + (i + 1) * o.dtMs, seq: i, p, q: o.q, s, n: 1 };
  }
}

// Feeds a stream through the engine and resolves fills still in flight at its end.
export function runStream(engine: Engine, events: Iterable<MergedEvent>): Engine {
  for (const e of events) engine.onPrint(e);
  return engine.finish();
}
