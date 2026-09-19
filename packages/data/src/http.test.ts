import { describe, expect, it } from 'vitest';
import { FakeClock, InstantClock } from './testing/fixtures.js';
import { HttpClient, HttpError, NotFoundError, TokenBucket, backoffDelay, type FetchFn } from './http.js';
import { DEFAULT_RETRY_POLICY } from './venue.js';

const rateLimit = { requestsPerSecond: 1000, burstSize: 1000, concurrent: 4 };

function scripted(statuses: Array<number | Error>): { fetchFn: FetchFn; calls: () => number } {
  let i = 0;
  return {
    fetchFn: async () => {
      const next = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      if (next instanceof Error) {
        throw next;
      }
      return new Response(next === 200 ? 'ok' : null, { status: next });
    },
    calls: () => i,
  };
}

describe('TokenBucket (fake clock)', () => {
  it('allows a burst, then paces at the refill rate', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(2, 2, clock); // 2 req/s, burst 2
    const taken: number[] = [];
    const takes = [0, 1, 2, 3].map((i) => bucket.take().then(() => taken.push(i)));
    await clock.advance(0);
    expect(taken).toEqual([0, 1]);
    await clock.advance(499);
    expect(taken).toEqual([0, 1]);
    await clock.advance(1);
    expect(taken).toEqual([0, 1, 2]);
    await clock.advance(500);
    expect(taken).toEqual([0, 1, 2, 3]);
    await Promise.all(takes);
  });
});

describe('backoffDelay (full jitter)', () => {
  it('is uniform in [0, min(max, base·mult^(attempt−1)))', () => {
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 1, () => 0.999)).toBe(499);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 3, () => 0.5)).toBe(1000);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 20, () => 0.5)).toBe(30_000);
    expect(backoffDelay(DEFAULT_RETRY_POLICY, 2, () => 0)).toBe(0);
  });
});

describe('HttpClient retry', () => {
  it('retries injected 429 and 5xx, then succeeds', async () => {
    const clock = new InstantClock();
    const script = scripted([429, 503, 502, 200]);
    const retries: string[] = [];
    const http = new HttpClient({ rateLimit, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn: script.fetchFn, clock, random: () => 0.5, onRetry: (r) => retries.push(r.reason) });
    await expect(http.getText('https://x/a')).resolves.toBe('ok');
    expect(script.calls()).toBe(4);
    expect(retries).toEqual(['HTTP 429', 'HTTP 503', 'HTTP 502']);
    expect(clock.sleeps).toEqual([250, 500, 1000]);
  });

  it('retries network resets', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const script = scripted([reset, 200]);
    const http = new HttpClient({ rateLimit, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn: script.fetchFn, clock: new InstantClock() });
    await expect(http.getText('https://x/a')).resolves.toBe('ok');
    expect(script.calls()).toBe(2);
  });

  it.each([403, 404])('does not retry %i: NotFoundError', async (status) => {
    const script = scripted([status]);
    const http = new HttpClient({ rateLimit, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn: script.fetchFn, clock: new InstantClock() });
    await expect(http.getText('https://x/a')).rejects.toBeInstanceOf(NotFoundError);
    expect(script.calls()).toBe(1);
    await expect(http.exists('https://x/a')).resolves.toBe(false);
  });

  it('does not retry other 4xx', async () => {
    const script = scripted([400]);
    const http = new HttpClient({ rateLimit, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn: script.fetchFn, clock: new InstantClock() });
    await expect(http.getText('https://x/a')).rejects.toBeInstanceOf(HttpError);
    expect(script.calls()).toBe(1);
  });

  it('gives up after maxAttempts', async () => {
    const script = scripted([500]);
    const http = new HttpClient({ rateLimit, retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 }, fetchFn: script.fetchFn, clock: new InstantClock() });
    await expect(http.getText('https://x/a')).rejects.toMatchObject({ status: 500 });
    expect(script.calls()).toBe(3);
  });

  it('does not retry after the caller aborts', async () => {
    const controller = new AbortController();
    const fetchFn: FetchFn = async () => {
      controller.abort(new Error('stop'));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const http = new HttpClient({ rateLimit, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn, clock: new InstantClock() });
    await expect(http.getText('https://x/a', controller.signal)).rejects.toThrow('aborted');
  });

  it('caps concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const fetchFn: FetchFn = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return new Response('ok');
    };
    const http = new HttpClient({ rateLimit: { ...rateLimit, concurrent: 2 }, retryPolicy: DEFAULT_RETRY_POLICY, fetchFn });
    const all = Promise.all([1, 2, 3, 4, 5].map((i) => http.getText(`https://x/${i}`)));
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      release.shift()?.();
    }
    await all;
    expect(peak).toBe(2);
  });
});
