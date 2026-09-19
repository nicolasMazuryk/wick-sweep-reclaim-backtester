import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { RateLimit, RetryableCondition, RetryPolicy } from './venue.js';

// Spec §2.5 "Retry": token bucket per adapter + exponential backoff with full
// jitter. Node's built-in fetch is used (no undici dependency); everything
// time- or randomness-dependent is injectable so tests run on a fake clock.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

// Archive miss: {403, 404} (Bitget's CDN answers 403 for an absent key). Never
// retried.
export class NotFoundError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`not found (${status}): ${url}`);
    this.name = 'NotFoundError';
  }
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status}: ${url}`);
    this.name = 'HttpError';
  }
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }

  // Resolves when one token has been taken. Callers are served FIFO.
  take(signal?: AbortSignal): Promise<void> {
    const next = this.queue.then(() => this.takeOne(signal));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async takeOne(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.ratePerSecond) / 1000);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSecond), signal);
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  // A released slot is handed straight to the next waiter, so the count
  // never exceeds the limit.
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return () => {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.active -= 1;
      } else {
        next();
      }
    };
  }
}

export interface HttpClientOptions {
  readonly rateLimit: RateLimit;
  readonly retryPolicy: RetryPolicy;
  readonly fetchFn?: FetchFn;
  readonly clock?: Clock;
  readonly random?: () => number;
  // Per-request timeout (aborts the attempt; retried like ETIMEDOUT).
  readonly timeoutMs?: number;
  readonly onRetry?: (info: { readonly url: string; readonly attempt: number; readonly delayMs: number; readonly reason: string }) => void;
}

const NOT_FOUND_STATUSES = new Set([403, 404]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const withCode = error as { code?: unknown; cause?: unknown; name?: unknown };
  if (typeof withCode.code === 'string') {
    return withCode.code;
  }
  if (withCode.cause !== undefined) {
    return errorCode(withCode.cause);
  }
  return undefined;
}

// Full-jitter backoff delay for the given 1-based failed attempt.
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** (attempt - 1));
  return Math.floor(random() * cap);
}

export class HttpClient {
  private readonly bucket: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpClientOptions) {
    this.clock = options.clock ?? systemClock;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.bucket = new TokenBucket(options.rateLimit.requestsPerSecond, options.rateLimit.burstSize, this.clock);
    this.semaphore = new Semaphore(options.rateLimit.concurrent);
  }

  // Classifies a failed attempt: undefined → do not retry.
  private retryReason(error: unknown, signal?: AbortSignal): string | undefined {
    if (signal?.aborted === true) {
      return undefined;
    }
    const retryOn = this.options.retryPolicy.retryOn;
    if (error instanceof HttpError) {
      return retryOn.includes(error.status) ? `HTTP ${error.status}` : undefined;
    }
    if (error instanceof NotFoundError) {
      return undefined;
    }
    const code = errorCode(error);
    if (code === 'ECONNRESET' && retryOn.includes('ECONNRESET')) {
      return code;
    }
    const name = (error as { name?: unknown } | null)?.name;
    // Per-attempt timeout (AbortSignal.timeout → TimeoutError / AbortError),
    // socket timeouts, and undici's generic "fetch failed" network TypeError.
    if (
      retryOn.includes('ETIMEDOUT') &&
      (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || name === 'TimeoutError' || name === 'AbortError')
    ) {
      return 'ETIMEDOUT';
    }
    if (error instanceof TypeError && retryOn.includes('ECONNRESET')) {
      return `network: ${code ?? error.message}`;
    }
    return undefined;
  }

  // Runs one request with rate limiting, concurrency cap and retry. `consume`
  // receives the per-attempt signal and must consume the response body.
  async request<T>(url: string, method: 'GET' | 'HEAD', signal: AbortSignal | undefined, consume: (response: Response, attemptSignal: AbortSignal) => Promise<T>): Promise<T> {
    const policy = this.options.retryPolicy;
    for (let attempt = 1; ; attempt += 1) {
      await this.bucket.take(signal);
      const releaseSlot = await this.semaphore.acquire();
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          releaseSlot();
        }
      };
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const attemptSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        const response = await this.fetchFn(url, { method, signal: attemptSignal });
        if (NOT_FOUND_STATUSES.has(response.status)) {
          await response.body?.cancel();
          throw new NotFoundError(url, response.status);
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpError(url, response.status);
        }
        return await consume(response, attemptSignal);
      } catch (error) {
        const reason = this.retryReason(error, signal);
        if (reason === undefined || attempt >= policy.maxAttempts) {
          throw error;
        }
        const delayMs = backoffDelay(policy, attempt, this.random);
        this.options.onRetry?.({ url, attempt, delayMs, reason });
        release(); // do not hold a concurrency slot while backing off
        await this.clock.sleep(delayMs, signal);
      } finally {
        release();
      }
    }
  }

  // Backoff before re-running a failed step the client cannot see (a
  // checksum mismatch, Spec §2.5 "Retry"): same full-jitter schedule.
  async backoff(url: string, attempt: number, reason: string, signal?: AbortSignal): Promise<void> {
    const delayMs = backoffDelay(this.options.retryPolicy, attempt, this.random);
    this.options.onRetry?.({ url, attempt, delayMs, reason });
    await this.clock.sleep(delayMs, signal);
  }

  retries(condition: RetryableCondition): boolean {
    return this.options.retryPolicy.retryOn.includes(condition);
  }

  // true → exists; false → 403/404.
  async exists(url: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request(url, 'HEAD', signal, async () => undefined);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return false;
      }
      throw error;
    }
  }

  getText(url: string, signal?: AbortSignal): Promise<string> {
    return this.request(url, 'GET', signal, (response) => response.text());
  }

  async getJson<T = unknown>(url: string, signal?: AbortSignal): Promise<T> {
    return JSON.parse(await this.getText(url, signal)) as T;
  }

  // Streams the body to `{dest}.part-{pid}-{rand}`, then renames into place.
  async download(url: string, dest: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    await this.request(url, 'GET', signal, async (response, attemptSignal) => {
      const tmp = `${dest}.part-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        if (response.body === null) {
          throw new Error(`empty body: ${url}`);
        }
        await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), createWriteStream(tmp), { signal: attemptSignal });
        await rename(tmp, dest);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    });
  }
}
