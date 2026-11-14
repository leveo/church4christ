import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import catalog from '../../config/capabilities.json';
import config from '../../config/editions.json';
import { loadEditionInputs, renderEdition } from '../../scripts/editions/render.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = `v${pkg.version}`;

describe('single-feature edition config', () => {
  it('maps each edition to a distinct D1-only preset with valid GitHub metadata', () => {
    const repos = config.editions.map((e) => e.repo);
    expect(new Set(repos).size).toBe(repos.length);
    for (const edition of config.editions) {
      const preset = catalog.presets[edition.preset as keyof typeof catalog.presets];
      expect(preset, edition.repo).toBeDefined();
      for (const key of preset.modules) {
        const capability = catalog.capabilities[key as keyof typeof catalog.capabilities] as { requiresBackend?: string };
        expect(capability.requiresBackend, `${edition.repo}:${key}`).toBeUndefined();
      }
      expect(edition.repo).toMatch(/^[a-z0-9-]+$/);
      expect(edition.description.length).toBeLessThanOrEqual(350);
      expect(edition.topics.length).toBeLessThanOrEqual(20);
      expect(new Set(edition.topics).size).toBe(edition.topics.length);
      for (const topic of edition.topics) expect(topic).toMatch(/^[a-z0-9][a-z0-9-]{0,49}$/);
    }
  });

  it('only references screenshots and docs that exist in this repository', () => {
    for (const edition of config.editions) {
      for (const { path } of [...edition.screenshots, ...edition.docs]) {
        expect(existsSync(path), `${edition.repo}: ${path}`).toBe(true);
      }
    }
  });
});

describe('edition renderer', () => {
  it('renders a pinned, self-describing repository for every edition', async () => {
    const inputs = await loadEditionInputs();
    expect(inputs.version).toBe(version);
    for (const edition of config.editions) {
      const files = renderEdition(edition, inputs);
      expect(Object.keys(files).sort()).toEqual(
        ['.github/ISSUE_TEMPLATE/config.yml', 'AGENTS.md', 'LICENSE', 'README.md', 'edition.json'],
      );
      const readme = files['README.md'];
      expect(readme.startsWith(`# ${edition.title}\n`)).toBe(true);
      expect(readme).toContain(`--branch ${version} https://github.com/leveo/church4christ.git`);
      expect(readme).toContain(`npm run onboard -- --preset ${edition.preset}`);
      expect(readme).toContain(`https://raw.githubusercontent.com/leveo/church4christ/${version}/docs/images/`);
      expect(readme).toContain(config.demoUrl);
      expect(files['AGENTS.md']).toContain(`--preset ${edition.preset}`);
      expect(files.LICENSE).toBe(readFileSync('LICENSE', 'utf8'));
      expect(JSON.parse(files['edition.json'])).toMatchObject({ version, preset: edition.preset, topics: edition.topics });
      for (const contents of Object.values(files)) {
        expect(contents).not.toMatch(/b1app|churchapps/i);
        expect(contents).not.toContain('docs/superpowers');
      }
    }
  });

  it('rejects an edition whose preset is missing from the catalog', async () => {
    const inputs = await loadEditionInputs();
    expect(() => renderEdition({ ...config.editions[0], preset: 'missing' }, inputs)).toThrow(/unknown preset/);
  });
});
