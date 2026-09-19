import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eachDay } from './days.js';
import { NotFoundError, type HttpClient } from './http.js';
import { cachePath } from './paths.js';
import { atomicWriteFile } from './storage.js';
import type { ArchiveFileRef, DayAvailability, LocalFile, RawDayPayload, UtcDay, VenueId } from './venue.js';

// Spec §2.5 "Retry": a checksum mismatch is retried (with the retryPolicy
// backoff, when it lists 'checksum') at most twice more, then the partition
// fails and hygiene records checksumFailed.
export const CHECKSUM_EXTRA_ATTEMPTS = 2;

export class ChecksumMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`sha256 mismatch for ${url}: expected ${expected}, got ${actual}`);
    this.name = 'ChecksumMismatchError';
  }
}

// A required archive file is not (yet) published.
export class ArchiveUnavailableError extends Error {
  constructor(readonly url: string) {
    super(`archive not available: ${url}`);
    this.name = 'ArchiveUnavailableError';
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// `sha256sum` format: "<hex>  <file name>".
export function parseChecksumFile(text: string): string {
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`unrecognised checksum file: '${text.slice(0, 80)}'`);
  }
  return hex;
}

async function withSha256(files: readonly LocalFile[]): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const file of files) {
    out.push({ ...file, sha256: await sha256File(file.path) });
  }
  return out;
}

interface FetchedRef {
  readonly files: LocalFile[];
  readonly checksumVerified: boolean;
}

const PARTS_MANIFEST = '.parts.json';

// Downloads the archive files of one venue into {dataRoot}/cache/{venue}/,
// shared by all partitions of a run: concurrent requests for the same file
// (Gate's month, OKX/Bitget's D+1 file) share one download.
export class ArchiveFetcher {
  private readonly inFlight = new Map<string, Promise<FetchedRef>>();
  private readonly existsMemo = new Map<string, Promise<boolean>>();

  constructor(
    private readonly venue: VenueId,
    private readonly http: HttpClient,
    private readonly dataRoot: string,
  ) {}

  private localPath(cacheKey: string): string {
    return cachePath(this.dataRoot, this.venue, cacheKey);
  }

  private exists(url: string, signal?: AbortSignal): Promise<boolean> {
    let pending = this.existsMemo.get(url);
    if (pending === undefined) {
      pending = this.http.exists(url, signal);
      this.existsMemo.set(url, pending);
      pending.catch(() => this.existsMemo.delete(url));
    }
    return pending;
  }

  // HEAD probes only (Spec §2.1 listAvailable: never downloads trade data).
  async listAvailable(refsFor: (day: UtcDay) => readonly ArchiveFileRef[], from: UtcDay, to: UtcDay, signal?: AbortSignal): Promise<DayAvailability[]> {
    const result: DayAvailability[] = [];
    for (const day of eachDay(from, to)) {
      let available = true;
      for (const ref of refsFor(day)) {
        const cached = ref.probeParts === undefined ? await fileExists(this.localPath(ref.cacheKey)) : await fileExists(join(this.localPath(ref.cacheKey), PARTS_MANIFEST));
        if (!cached && !(await this.exists(ref.url, signal))) {
          available = false;
          break;
        }
      }
      result.push({ day, source: available ? 'archive' : 'unavailable' });
    }
    return result;
  }

  async fetchDay(symbol: string, day: UtcDay, refs: readonly ArchiveFileRef[], signal: AbortSignal): Promise<RawDayPayload> {
    const files: LocalFile[] = [];
    let checksumVerified = refs.length > 0;
    for (const ref of refs) {
      const fetched = await this.fetchRef(ref, signal);
      files.push(...fetched.files);
      checksumVerified &&= fetched.checksumVerified;
    }
    return { symbol, day, source: 'archive', files, cacheKeys: refs.map((ref) => ref.cacheKey), checksumVerified };
  }

  private fetchRef(ref: ArchiveFileRef, signal: AbortSignal): Promise<FetchedRef> {
    let pending = this.inFlight.get(ref.cacheKey);
    if (pending === undefined) {
      pending = ref.probeParts === undefined ? this.fetchSingle(ref, signal) : this.fetchParts(ref, signal);
      this.inFlight.set(ref.cacheKey, pending);
      pending.catch(() => this.inFlight.delete(ref.cacheKey));
    }
    return pending;
  }

  private async fetchSingle(ref: ArchiveFileRef, signal: AbortSignal): Promise<FetchedRef> {
    const dest = this.localPath(ref.cacheKey);
    const file: LocalFile = { path: dest, contentType: ref.contentType, url: ref.url };
    if (ref.checksumUrl === undefined) {
      if (!(await fileExists(dest))) {
        await this.downloadRequired(ref.url, dest, signal);
      }
      // No published checksum: our own sha256 goes into .done (Spec §2.5).
      return { files: [{ ...file, sha256: await sha256File(dest) }], checksumVerified: false };
    }
    const expected = parseChecksumFile(await this.http.getText(ref.checksumUrl, signal));
    let actual = '';
    const extra = this.http.retries('checksum') ? CHECKSUM_EXTRA_ATTEMPTS : 0;
    for (let attempt = 0; attempt <= extra; attempt += 1) {
      if (attempt > 0) {
        await this.http.backoff(ref.url, attempt, 'checksum', signal);
      }
      if (!(await fileExists(dest))) {
        await this.downloadRequired(ref.url, dest, signal);
      }
      actual = await sha256File(dest);
      if (actual === expected) {
        return { files: [{ ...file, sha256: actual }], checksumVerified: true };
      }
      await rm(dest, { force: true });
    }
    throw new ChecksumMismatchError(ref.url, expected, actual);
  }

  private async downloadRequired(url: string, dest: string, signal: AbortSignal): Promise<void> {
    try {
      await this.http.download(url, dest, signal);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ArchiveUnavailableError(url);
      }
      throw error;
    }
  }

  // Probe part 1, 2, … until 403/404; part 1 must exist.
  private async fetchParts(ref: ArchiveFileRef, signal: AbortSignal): Promise<FetchedRef> {
    const probe = ref.probeParts!;
    const dir = this.localPath(ref.cacheKey);
    const manifestPath = join(dir, PARTS_MANIFEST);
    const toFile = (n: number): LocalFile => {
      const part = probe.part(n);
      return { path: this.localPath(part.cacheKey), contentType: ref.contentType, url: part.url };
    };
    try {
      const count = (JSON.parse(await readFile(manifestPath, 'utf8')) as { parts: number }).parts;
      const files = Array.from({ length: count }, (_, i) => toFile(i + 1));
      if ((await Promise.all(files.map((f) => fileExists(f.path)))).every(Boolean)) {
        return { files: await withSha256(files), checksumVerified: false };
      }
    } catch {
      // no usable manifest: probe
    }
    const files: LocalFile[] = [];
    for (let n = 1; n <= probe.maxParts; n += 1) {
      const file = toFile(n);
      if (!(await fileExists(file.path))) {
        try {
          await mkdir(dirname(file.path), { recursive: true });
          await this.http.download(file.url, file.path, signal);
        } catch (error) {
          if (error instanceof NotFoundError) {
            break;
          }
          throw error;
        }
      }
      files.push(file);
    }
    if (files.length === 0) {
      throw new ArchiveUnavailableError(ref.url);
    }
    if (files.length === probe.maxParts) {
      throw new Error(`part probe hit the ${probe.maxParts}-part safety cap: ${ref.url}`);
    }
    await atomicWriteFile(manifestPath, Buffer.from(JSON.stringify({ parts: files.length })));
    return { files: await withSha256(files), checksumVerified: false };
  }

  // Drops a cached archive (file or part directory) once no planned day needs it.
  async remove(cacheKey: string): Promise<void> {
    this.inFlight.delete(cacheKey);
    await rm(this.localPath(cacheKey), { recursive: true, force: true });
  }
}
