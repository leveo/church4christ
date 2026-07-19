import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};
const nodeVersion = (await readFile('.nvmrc', 'utf8').catch(() => '')).trim();

describe('fresh-clone installation contract', () => {
  test('declares the required runtime and TypeScript toolchain', () => {
    expect(packageJson.devDependencies).toHaveProperty('typescript');
    expect(packageJson.engines?.node).toBe('>=22.12.0');
    expect(nodeVersion).toBe('22.12.0');
  });

  test('runs generated artifacts and builds through the canonical scripts', () => {
    expect(packageJson.scripts?.prepare).toBe('npm run tokens');
    expect(packageJson.scripts?.preview).toBe('npm run build && astro preview');
    expect(packageJson.scripts?.deploy).toBe('npm run build && wrangler deploy');
  });

  test('keeps guided setup as the installation handoff', () => {
    expect(packageJson.scripts?.setup).toBe('node scripts/setup/index.mjs');
  });
});
