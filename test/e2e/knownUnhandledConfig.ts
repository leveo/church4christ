import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKnownUnhandledErrorFilter } from './knownUnhandled';

const READER_LINE =
  'while ({done, value} = await tcp.reader.read(), !done) tcp.emit("data", Buffer.from(value));';
const READER_CONTEXT = [
  'async function read() {',
  'try {',
  'let done, value;',
  READER_LINE,
  '} catch (err) {',
  'error(err);',
  '}',
];

/**
 * Locate the exact generated frame for postgres.js's Cloudflare socket reader.
 * Closing that reader intentionally rejects its pending read with
 * "Stream was cancelled.". The package source path is lost after bundling, so
 * the Vitest config derives an allowlist from the dependency's full emitted
 * code block instead of trusting an arbitrary bundled function named `read`.
 */
export function discoverPostgresCfReaderFrames(root = process.cwd()): ReadonlySet<string> {
  const chunksDirectory = join(root, 'dist/server/chunks');
  let chunkFiles: string[];
  try {
    chunkFiles = readdirSync(chunksDirectory)
      .filter((file) => file.endsWith('.mjs'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }

  const frames = new Set<string>();
  for (const file of chunkFiles) {
    const lines = readFileSync(join(chunksDirectory, file), 'utf8').split(/\r?\n/);
    for (let index = 0; index <= lines.length - READER_CONTEXT.length; index += 1) {
      const candidate = lines.slice(index, index + READER_CONTEXT.length).map((line) => line.trim());
      if (!candidate.every((line, offset) => line === READER_CONTEXT[offset])) continue;

      const readerLineIndex = index + 3;
      const column = lines[readerLineIndex].indexOf('await tcp.reader.read()') + 1;
      frames.add(`dist/server/chunks/${file}:${readerLineIndex + 1}:${column}`);
    }
  }
  return frames;
}

export const ignoreKnownUnhandledError = createKnownUnhandledErrorFilter(
  discoverPostgresCfReaderFrames(),
);
