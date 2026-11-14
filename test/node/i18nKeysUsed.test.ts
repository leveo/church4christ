import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  it('exist in both dictionaries', () => {
    const en = dictionaryKeys('src/i18n/en.ts');
    const zh = dictionaryKeys('src/i18n/zh.ts');
    const missing: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*[A-Za-z_.]+\s*,\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) {
        if (!en.has(match[1]) || !zh.has(match[1])) missing.push(`${match[1]} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
