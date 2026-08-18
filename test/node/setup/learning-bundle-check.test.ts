import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoScreenshotSessionInBundle } from '../../../scripts/check-production-bundle.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'c4c-learning-bundle-'));
  roots.push(root);
  const server = join(root, 'server');
  mkdirSync(server, { recursive: true });
  writeFileSync(join(server, 'entry.mjs'), contents);
  return root;
}

describe('production bundle screenshot-session exclusion', () => {
  it('fails a built bundle containing any dev-session marker and accepts ordinary output', () => {
    expect(() => assertNoScreenshotSessionInBundle(bundle('const marker="c4c-learning-screenshot-session-dev-only"')))
      .toThrow(/screenshot-only session code.*entry\.mjs/i);
    expect(() => assertNoScreenshotSessionInBundle(bundle('export const worker = "production"')))
      .not.toThrow();
  });

  it('runs the assertion after every production build and uses a tree-shaken dev import', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { build: string } };
    const middleware = readFileSync('src/middleware.ts', 'utf8');
    expect(pkg.scripts.build).toContain('scripts/check-production-bundle.mjs');
    expect(middleware).toMatch(/if \([^\n]*import\.meta\.env\.DEV[^\n]*\)[\s\S]*await import\('\.\/lib\/screenshotSessionDev'\)/);
    expect(readFileSync('src/lib/session.ts', 'utf8')).not.toContain('verifySessionWithScreenshotFallback');
  });
});
