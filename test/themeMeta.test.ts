// Node project: verifies the theme-meta generator that build-tokens emits into
// src/lib/themeMeta.generated.ts (the admin theme picker's swatch source). The
// pure generator is asserted for shape + values, then the writer is run to prove
// `npm run tokens` produces the (gitignored) generated module.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateThemeMeta, writeThemeMeta } from '../scripts/build-tokens.mjs';
import harvest from '../design/themes/harvest.json';
import midnight from '../design/themes/midnight.json';
import sanctuary from '../design/themes/sanctuary.json';

const themes = [sanctuary, harvest, midnight];
const HEX = /^#[0-9A-Fa-f]{6}$/;

// build-tokens.mjs is untyped (plain Node ESM), so annotate the generator's
// result to keep noImplicitAny happy — same approach as tokens.test.ts.
type Meta = {
  name: string;
  label: string;
  defaultMode: string;
  swatches: { primary: string; accent: string; surface: string };
};

describe('generateThemeMeta', () => {
  const meta = generateThemeMeta(themes) as Meta[];

  it('emits one entry per theme, in source order', () => {
    expect(meta).toHaveLength(3);
    expect(meta.map((m) => m.name)).toEqual(['sanctuary', 'harvest', 'midnight']);
  });

  it('reads swatches from each theme default-mode palette as hex strings', () => {
    const s = meta.find((m) => m.name === 'sanctuary')!;
    expect(s.label).toBe('Sanctuary');
    expect(s.defaultMode).toBe('light');
    expect(s.swatches.primary).toBe(sanctuary.modes.light.primary);
    expect(s.swatches.accent).toBe(sanctuary.modes.light.accent);
    expect(s.swatches.surface).toBe(sanctuary.modes.light.surface);
    for (const m of meta) {
      expect(m.swatches.primary).toMatch(HEX);
      expect(m.swatches.accent).toMatch(HEX);
      expect(m.swatches.surface).toMatch(HEX);
    }
  });

  it('reports midnight as dark-default with its dark palette swatches', () => {
    const mid = meta.find((m) => m.name === 'midnight')!;
    expect(mid.defaultMode).toBe('dark');
    expect(mid.swatches.primary).toBe(midnight.modes.dark.primary);
    expect(mid.swatches.surface).toBe(midnight.modes.dark.surface);
  });

  it('writes the generated module to src/lib/themeMeta.generated.ts', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const out = writeThemeMeta(root, themes);
    expect(out.endsWith('src/lib/themeMeta.generated.ts')).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});
