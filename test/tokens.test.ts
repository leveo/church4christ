import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contrastViolations, generateCss } from '../scripts/build-tokens.mjs';
import { findViolations } from '../scripts/check-tokens.mjs';
import foundation from '../design/foundation.json';
import harvest from '../design/themes/harvest.json';
import midnight from '../design/themes/midnight.json';
import sanctuary from '../design/themes/sanctuary.json';

const themes = [sanctuary, harvest, midnight];

/** Extract the body of the rule whose selector matches exactly (default-mode
 * blocks are disambiguated from [data-mode] overrides by the trailing " {"). */
function block(css: string, selector: string): string {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) throw new Error(`selector not found: ${selector}`);
  const start = css.indexOf('{', idx);
  return css.slice(start + 1, css.indexOf('}', start));
}

describe('generateCss', () => {
  const css = generateCss(foundation, themes);

  it('emits sanctuary default (light) block with its light palette', () => {
    const b = block(css, ':root[data-theme="sanctuary"]');
    expect(b).toContain('--color-primary: #31487A;');
    expect(b).toContain('--color-on-primary: #FFFFFF;');
  });

  it('emits sanctuary dark override block with the dark palette', () => {
    const b = block(css, ':root[data-theme="sanctuary"][data-mode="dark"]');
    expect(b).toContain('--color-primary: #93ACDD;');
  });

  it('midnight default block is its dark palette, with a light override', () => {
    const dark = block(css, ':root[data-theme="midnight"]');
    expect(dark).toContain('--color-surface: #0E1116;');
    const light = block(css, ':root[data-theme="midnight"][data-mode="light"]');
    expect(light).toContain('--color-surface: #F3F5F7;');
    // midnight must NOT get a [data-mode="dark"] override — dark is its default
    expect(css).not.toContain(':root[data-theme="midnight"][data-mode="dark"]');
  });

  it('emits foundation vars once under :root', () => {
    const b = block(css, ':root');
    expect(b).toContain('--text-xs: 0.75rem;');
    expect(b).toContain('--text-display-2xl: clamp(2.5rem, 1.8rem + 3vw, 4.5rem);');
    expect(b).toContain('--leading-cjk: 1.85;');
    expect(b).toContain('--tracking-caps: 0.08em;');
    expect(b).toContain('--container-content: 72rem;');
    expect(b).toContain('--z-modal: 60;');
    expect(b).toContain('--duration-fast: 120ms;');
    expect(b).toContain('--ease-out: cubic-bezier(0.25, 1, 0.5, 1);');
  });

  it('joins font family + fallback into --font-* vars', () => {
    const b = block(css, ':root[data-theme="sanctuary"]');
    expect(b).toContain("--font-display: 'Fraunces Variable', Georgia,");
    expect(b).toContain('--font-mono: ui-monospace, SFMono-Regular,');
    expect(b).toContain('--radius-md: 10px;');
    expect(b).toContain('--shadow-lg: 0 12px 32px rgba(25, 30, 45, 0.12);');
  });

  it('contains a block per theme and no "undefined" values', () => {
    for (const t of ['sanctuary', 'harvest', 'midnight']) {
      expect(css).toContain(`:root[data-theme="${t}"] {`);
    }
    expect(css).not.toContain('undefined');
  });
});

describe('contrastViolations', () => {
  it('returns [] for all three shipped themes', () => {
    expect(contrastViolations(themes)).toEqual([]);
  });

  it('flags a doctored theme whose on-primary fails against primary', () => {
    const doctored = structuredClone(sanctuary) as typeof sanctuary & { name: string };
    doctored.name = 'doctored';
    doctored.modes.light['on-primary'] = '#EEE';
    doctored.modes.light['primary'] = '#DDD';
    const violations = contrastViolations([doctored]);
    expect(violations.length).toBeGreaterThan(0);
    const hit = violations.find(
      (v: { theme: string; mode: string; pair: string; ratio: number }) =>
        v.theme === 'doctored' && v.mode === 'light' && v.pair === 'on-primary|primary',
    );
    expect(hit).toBeDefined();
    expect(hit!.ratio).toBeLessThan(4.5);
  });
});

describe('findViolations (check-tokens)', () => {
  type Violation = { file: string; line: number; rule: string };
  let dir: string;

  function fixture(files: Record<string, string>): Violation[] {
    dir = mkdtempSync(join(tmpdir(), 'tokens-check-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return findViolations(dir);
  }

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('flags a hex color with file and line', () => {
    const v = fixture({ 'bad.css': '.x {\n  color: #FF0000;\n}\n' });
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe(join(dir, 'bad.css'));
    expect(v[0].line).toBe(2);
  });

  it('allows a hex color escaped with /* tokens-ok */ on the same line', () => {
    const v = fixture({ 'ok.css': '.x { color: #FF0000; } /* tokens-ok */\n' });
    expect(v).toEqual([]);
  });

  it('flags rgb()/hsl() and literal font-family in ts and astro files', () => {
    const v = fixture({
      'bad.ts': "const brand = 'rgb(49, 72, 122)';\n",
      'bad.astro': '<style>\np { font-family: Arial, sans-serif; }\nh1 { background: hsl(220, 50%, 40%); }\n</style>\n',
    });
    expect(v).toHaveLength(3);
  });

  it('accepts var()-only styling, including font-family: var(--font-*)', () => {
    const v = fixture({
      'good.css':
        'body {\n  color: var(--color-ink);\n  background: var(--color-surface);\n  font-family: var(--font-body);\n}\n',
    });
    expect(v).toEqual([]);
  });

  it('skips tokens.generated.css and non-source extensions', () => {
    const v = fixture({
      'tokens.generated.css': ':root { --color-primary: #31487A; }\n',
      'notes.md': 'color: #FF0000\n',
    });
    expect(v).toEqual([]);
  });

  it('recurses into subdirectories', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokens-check-'));
    mkdirSync(join(dir, 'components'));
    writeFileSync(join(dir, 'components', 'Card.astro'), '<div style="color: #232630"></div>\n');
    const v = findViolations(dir) as Violation[];
    expect(v).toHaveLength(1);
    expect(v[0].file).toBe(join(dir, 'components', 'Card.astro'));
  });
});
