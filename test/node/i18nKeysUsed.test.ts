import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_CODES, isComplete } from '../../scripts/i18n/lib.mjs';

// Dictionary parity cannot catch a key that is missing from BOTH dictionaries:
// the page then shows the raw key. Every literal key passed to t() must exist.
const dictionaryKeys = (file: string) =>
  new Set([...readFileSync(file, 'utf8').matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path.endsWith('i18n') ? [] : sourceFiles(path);
    return /\.(ts|astro|mjs)$/.test(name) ? [path] : [];
  });
}

describe('translation keys used in source', () => {
  it('exist in the English source and in every complete language', () => {
    // In-progress languages (config/i18n-status.json) may still lack keys: t() falls back to English.
    const required = SUPPORTED_CODES.filter((code: string) => code === 'en' || isComplete(code));
    const dictionaries = Object.fromEntries(required.map((code: string) => [code, dictionaryKeys(`src/i18n/${code}.ts`)]));
    const missing: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*[A-Za-z_.]+\s*,\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) {
        for (const code of required) {
          if (!dictionaries[code].has(match[1])) missing.push(`${match[1]} in ${code} (${file})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
