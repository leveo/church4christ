import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import raw from '../../../config/capabilities.json';
import { resolveProvider } from '../../../scripts/setup/resolve-provider.mjs';

const cloneCatalog = (): any => structuredClone(raw);

describe('resolveProvider', () => {
  it('defaults D1-compatible selections to D1', () => {
    expect(resolveProvider(['sermons', 'people'], undefined, raw)).toMatchObject({
      backend: 'd1',
      modules: ['sermons', 'people'],
      addedDependencies: [],
      reasons: [],
    });
  });

  it('permits an explicit Supabase override for D1-compatible selections', () => {
    expect(resolveProvider(['sermons'], 'supabase', raw)).toMatchObject({
      backend: 'supabase',
      modules: ['sermons'],
    });
  });

  it.each(['portal', 'giving', 'registration'])(
    'selects Supabase when %s is selected',
    (key) => {
      expect(resolveProvider([key], undefined, raw)).toMatchObject({
        backend: 'supabase',
        reasons: [{ capability: key, requiresBackend: 'supabase' }],
      });
    },
  );

  it('rejects D1 before mutation and lists every incompatible capability', () => {
    const selected = ['portal', 'giving', 'registration'];
    const catalog = cloneCatalog();

    expect(() => resolveProvider(selected, 'd1', catalog)).toThrow(
      /portal, giving, registration.*require Supabase/i,
    );
    expect(selected).toEqual(['portal', 'giving', 'registration']);
    expect(catalog).toEqual(raw);
  });

  it('rejects every unknown selected capability in one error without mutating inputs', () => {
    const selected = ['sermons', 'constructor', 'toString', '__proto__', 'missing', 'also-missing'];
    const catalog = cloneCatalog();

    expect(() => resolveProvider(selected, undefined, catalog)).toThrow(
      /unknown capabilities.*constructor.*toString.*__proto__.*missing.*also-missing/i,
    );
    expect(selected).toEqual([
      'sermons',
      'constructor',
      'toString',
      '__proto__',
      'missing',
      'also-missing',
    ]);
    expect(catalog).toEqual(raw);
  });

  it.each(['postgres', 'D1', '', ' supabase '])(
    'rejects the unknown database override %j',
    (override) => {
      expect(() => resolveProvider(['sermons'], override, raw)).toThrow(
        /unknown database override/i,
      );
    },
  );

  it('expands hard dependencies transitively, orders modules by catalog, and reports additions', () => {
    const catalog = cloneCatalog();
    catalog.capabilities.people.dependsOn = ['gifts'];
    catalog.capabilities.gifts.dependsOn = ['serve'];

    const result = resolveProvider(['people'], undefined, catalog);

    expect(result.modules).toEqual(['serve', 'gifts', 'people']);
    expect(result.addedDependencies).toEqual([
      { capability: 'people', added: 'gifts' },
      { capability: 'gifts', added: 'serve' },
    ]);
  });

  it('never expands soft uses', () => {
    const result = resolveProvider(['gifts'], undefined, raw);
    expect(result.modules).toEqual(['gifts']);
    expect(result.addedDependencies).toEqual([]);
    expect(result.modules).not.toContain('serve');
  });

  it('rejects otherwise valid catalogs that declare an unsupported provider', () => {
    const catalog = cloneCatalog();
    catalog.providers.neon = {
      label: 'Neon Postgres',
      requiredServices: ['worker'],
      optionalServices: [],
    };
    catalog.capabilities.sermons.requiresBackend = 'neon';

    expect(() => resolveProvider(['sermons'], undefined, catalog)).toThrow(
      /unsupported database provider.*neon/i,
    );
  });

  it('lists all modules incompatible with an explicit supported backend', () => {
    const catalog = cloneCatalog();
    catalog.capabilities.sermons.requiresBackend = 'd1';
    catalog.capabilities.people.requiresBackend = 'd1';

    expect(() => resolveProvider(['sermons', 'people'], 'supabase', catalog)).toThrow(
      /sermons, people.*require d1.*cannot run on supabase/i,
    );
  });

  it('rejects selections whose required supported providers conflict', () => {
    const catalog = cloneCatalog();
    catalog.capabilities.sermons.requiresBackend = 'd1';

    expect(() => resolveProvider(['sermons', 'portal'], undefined, catalog)).toThrow(
      /conflicting database requirements.*sermons.*d1.*portal.*supabase/i,
    );
  });

  it('has no prompt, filesystem, or mutation imports', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../scripts/setup/resolve-provider.mjs', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"](?:node:)?(?:fs|fs\/promises)['"]/);
    expect(source).not.toMatch(/from\s+['"](?:@inquirer\/prompts|inquirer|prompts)['"]/);
    expect(source).not.toMatch(/from\s+['"].*(?:mutat|write|apply).*['"]/i);
  });
});
