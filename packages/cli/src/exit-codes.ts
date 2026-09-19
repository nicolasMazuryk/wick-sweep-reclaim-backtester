// Spec §2.7.2 exit codes (all `wsr` commands).
export const ExitCode = {
  success: 0,
  usage: 1,
  partialFailure: 2,
  reactionFailed: 3,
  integrityFailure: 4,
  invariantViolated: 5,
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

interface StatusLike {
  readonly status: string;
}

// Integrity (checksum / sha / schema) beats interruption beats partial failure.
export function exitCodeFor(results: readonly StatusLike[], interrupted = false): ExitCodeValue {
  if (results.some((r) => r.status === 'checksumFailed' || r.status === 'integrityFailed')) {
    return ExitCode.integrityFailure;
  }
  if (interrupted) {
    return ExitCode.interrupted;
  }
  if (results.some((r) => r.status === 'failed')) {
    return ExitCode.partialFailure;
  }
  return ExitCode.success;
}
