import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import yauzl from 'yauzl';
import type { ArchiveContentType } from './venue.js';

// Streams the single CSV member of a venue zip archive.
function openZipEntry(path: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(openError ?? new Error(`cannot open zip ${path}`));
        return;
      }
      zip.on('error', reject);
      zip.on('end', () => reject(new Error(`zip ${path} has no CSV entry`)));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/') || entry.fileName.startsWith('__MACOSX/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            reject(streamError ?? new Error(`cannot read ${entry.fileName} in ${path}`));
            return;
          }
          resolve(stream);
        });
      });
      zip.readEntry();
    });
  });
}

async function openDecompressed(path: string, contentType: ArchiveContentType): Promise<Readable> {
  if (contentType === 'zip') {
    return openZipEntry(path);
  }
  return createReadStream(path).pipe(createGunzip());
}

// Non-empty lines of the archive's CSV body (CR stripped), streamed.
export async function* readArchiveLines(path: string, contentType: ArchiveContentType): AsyncGenerator<string> {
  const stream = await openDecompressed(path, contentType);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 0) {
        yield line;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

// A header row is any first line whose first field is not numeric.
export function isHeaderLine(fields: readonly string[]): boolean {
  const first = fields[0]?.trim() ?? '';
  return !/^[0-9.+-]/.test(first);
}

// CSV rows as field arrays. Venue trade CSVs carry no quoted fields.
export async function* readArchiveRows(path: string, contentType: ArchiveContentType): AsyncGenerator<string[]> {
  for await (const line of readArchiveLines(path, contentType)) {
    yield line.split(',');
  }
}
