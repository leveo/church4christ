import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_CODES, isComplete } from '../../scripts/i18n/lib.mjs';

// Dictionary parity cannot catch a key that is missing from BOTH dictionaries:
// the page then shows the raw key. Every literal key passed to t() must exist.
import { loadI18nData } from '../../scripts/i18n/load.mjs';

// Load the real dictionaries (bundled with esbuild) rather than scraping source text, so
// quoting style and generated spreads such as moduleMetadata() are handled.
const { dicts } = (await loadI18nData()) as { dicts: Record<string, Record<string, string>> };
const dictionaryKeys = (code: string) => new Set(Object.keys(dicts[code] ?? {}));

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
    const dictionaries = Object.fromEntries(required.map((code: string) => [code, dictionaryKeys(code)]));
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
