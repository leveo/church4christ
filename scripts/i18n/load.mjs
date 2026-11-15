// Loads every locale's dictionary, design copy, and catalog copy for the CLI tools.
// The sources are TypeScript, so they are bundled in memory with esbuild (already
// installed through Vite/Astro) and evaluated; nothing is written to disk.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SUPPORTED_CODES } from './lib.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

export async function loadI18nData() {
  const imports = SUPPORTED_CODES.map((code) => `import * as m_${code} from ${JSON.stringify(`${ROOT}/src/i18n/${code}.ts`)};`);
  const entry = [
    ...imports,
    `import { DESIGN_SOURCES } from ${JSON.stringify(`${ROOT}/src/i18n/designRegistry.ts`)};`,
    `const mods = { ${SUPPORTED_CODES.map((code) => `${code}: m_${code}`).join(', ')} };`,
    'export const dicts = Object.fromEntries(Object.entries(mods).map(([c, m]) => [c, m.default]));',
    'export const designs = Object.fromEntries(Object.entries(mods).filter(([, m]) => m.design).map(([c, m]) => [c, m.design]));',
    'export const catalogs = Object.fromEntries(Object.entries(mods).filter(([, m]) => m.catalog).map(([c, m]) => [c, m.catalog]));',
    'export const designSources = DESIGN_SOURCES;',
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    loader: { '.json': 'json' },
  });
  const code = result.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const capabilities = readJson('config/capabilities.json');
  const readiness = readJson('config/readiness.json');
  return {
    dicts: mod.dicts,
    designs: mod.designs,
    catalogs: mod.catalogs,
    designSources: mod.designSources,
    catalogBase: { capabilities: capabilities.capabilities, presets: capabilities.presets, readiness: readiness.checks },
  };
}
