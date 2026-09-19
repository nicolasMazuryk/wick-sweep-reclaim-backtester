#!/usr/bin/env node
import { ExitCode } from './exit-codes.js';
import { runCli } from './program.js';

// First SIGINT: finish the partition / grid task in flight, start no more (exit 130).
// Second SIGINT: abort in-flight downloads too.
let stopRequested = false;
const abort = new AbortController();
process.on('SIGINT', () => {
  if (stopRequested) {
    abort.abort(new Error('interrupted'));
    return;
  }
  stopRequested = true;
  process.stderr.write('\ninterrupt: finishing in-flight work (Ctrl-C again to abort)\n');
});

const code = await runCli(process.argv.slice(2), { shouldStop: () => stopRequested, signal: abort.signal });
process.exitCode = stopRequested && code === ExitCode.success ? ExitCode.interrupted : code;
