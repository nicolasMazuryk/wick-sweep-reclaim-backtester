import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Clock, FetchFn } from '../http.js';

// Test-only helpers (Spec §11.5 recorded venue responses).

// {repo}/fixtures/venues/ from src/testing or dist/testing.
export const VENUE_FIXTURES = fileURLToPath(new URL('../../../../fixtures/venues/', import.meta.url));

export function venueFixture(venue: string, name: string): string {
  return `${VENUE_FIXTURES}${venue}/${name}`;
}

export type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

export interface FakeFetch {
  readonly fetchFn: FetchFn;
  // "METHOD url" of every request, in order.
  readonly calls: string[];
}

// Serves `routes` by exact URL; everything else answers `fallbackStatus`
// (Bitget's CDN answers 403 for a missing key).
export function fakeFetch(routes: ReadonlyMap<string, Route>, fallbackStatus = 404): FakeFetch {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const route = routes.get(url);
    if (route === undefined) {
      return new Response(null, { status: fallbackStatus });
    }
    const response = await route(init);
    return init?.method === 'HEAD' ? new Response(null, { status: response.status }) : response;
  };
  return { fetchFn, calls };
}

export function fileRoute(path: string): Route {
  return async () => new Response(await readFile(path));
}

export function jsonRoute(body: unknown): Route {
  return () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

export function textRoute(body: string): Route {
  return () => new Response(body);
}

// Manually advanced clock; sleep() resolves once the clock passes its deadline.
export class FakeClock implements Clock {
  private current = 0;
  private readonly sleepers: Array<{ until: number; resolve: () => void }> = [];
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve) => {
      this.sleepers.push({ until: this.current + ms, resolve });
    });
  }

  // Advances time and wakes due sleepers (then lets their continuations run).
  async advance(ms: number): Promise<void> {
    this.current += ms;
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.until <= this.current) {
        this.sleepers.splice(this.sleepers.indexOf(sleeper), 1);
        sleeper.resolve();
      }
    }
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }
}

// Clock whose sleep() returns immediately but advances time (retry tests).
export class InstantClock implements Clock {
  private current = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.current;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}
