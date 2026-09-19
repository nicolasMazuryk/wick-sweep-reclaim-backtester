// Runtime invariant assertions (Spec §9.1: L3, L4, L6, L12 are compiled in).
// The CLI maps an InvariantViolation to exit code 5 (Spec §2.7.2).
export class InvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new InvariantViolation(message);
  }
}

// Hot-path form: `if (!cond) invariantFailed(msg)` builds the message only on
// failure (an `assert` template literal allocates a string on every call, Spec §10).
export function invariantFailed(message: string): never {
  throw new InvariantViolation(message);
}
