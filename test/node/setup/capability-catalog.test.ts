import { describe, expect, test } from 'vitest';

import catalogJson from '../../../config/capabilities.json';
import {
  CAPABILITIES,
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
} from '../../../src/lib/capabilityCatalog';
import { validateCapabilityCatalog } from '../../../scripts/lib/validate-capability-catalog.mjs';

const EXPECTED_KEYS = [
  'bulletins',
  'sermons',
  'prayer-sheets',
  'prayer-wall',
  'events',
  'serve',
  'gifts',
  'testimonies',
  'articles',
  'fellowships',
  'people',
  'children',
  'page-builder',
  'portal',
  'giving',
  'registration',
] as const;

const cloneCatalog = (): any => structuredClone(catalogJson);

function expectInvalid(mutator: (catalog: any) => void, message?: RegExp): void {
  const candidate = cloneCatalog();
  mutator(candidate);
  expect(() => validateCapabilityCatalog(candidate)).toThrow(message);
}

describe('canonical capability catalog', () => {
  test('exports the stable ordered capability inventory', () => {
    expect(CAPABILITY_KEYS).toEqual(EXPECTED_KEYS);
    expect(Object.keys(CAPABILITIES)).toEqual(EXPECTED_KEYS);
    expect(CAPABILITY_CATALOG).toBe(catalogJson);
  });

  test('defines the three exact presets', () => {
    expect(CAPABILITY_CATALOG.presets.website.modules).toEqual([
      'bulletins',
      'sermons',
      'prayer-sheets',
      'prayer-wall',
      'events',
      'articles',
      'fellowships',
      'page-builder',
    ]);
    expect(CAPABILITY_CATALOG.presets['website-community'].modules).toEqual(
      EXPECTED_KEYS.slice(0, 13),
    );
    expect(CAPABILITY_CATALOG.presets['full-church'].modules).toEqual(EXPECTED_KEYS);
  });

  test('requires Supabase only for portal, giving, and registration', () => {
    const supabaseOnly = CAPABILITY_KEYS.filter(
      (key) => CAPABILITIES[key].requiresBackend === 'supabase',
    );
    expect(supabaseOnly).toEqual(['portal', 'giving', 'registration']);
  });

  test('accepts intentional nested route ownership', () => {
    expect(validateCapabilityCatalog(cloneCatalog())).toEqual(catalogJson);
  });

  test('rejects exact duplicate route ownership', () => {
    expectInvalid((catalog) => {
      catalog.capabilities.gifts.publicPrefixes = ['/serve'];
    }, /duplicate route prefix/i);
  });
});

describe('capability catalog validation', () => {
  test('rejects a missing or blank provider label', () => {
    expectInvalid((catalog) => {
      delete catalog.providers.d1.label;
    }, /provider d1\.label.*required/i);
    expectInvalid((catalog) => {
      catalog.providers.supabase.label = ' ';
    }, /provider supabase\.label.*required/i);
  });

  test.each([
    'publicPrefixes',
    'adminPrefixes',
    'navKeys',
    'uses',
    'dependsOn',
    'requiredServices',
    'optionalServices',
    'seedProfiles',
    'readinessChecks',
  ])(
    'requires capability %s to be an array',
    (field) => {
      expectInvalid((catalog) => {
        catalog.capabilities.bulletins[field] = field === 'navKeys' ? 'nav.bulletin' : {};
      }, new RegExp(`bulletins\\.${field}.*array`, 'i'));
    },
  );

  test.each([
    ['providers', []],
    ['services', {}],
    ['groups', {}],
  ])('rejects malformed top-level %s shape', (field, value) => {
    expectInvalid((catalog) => {
      catalog[field] = value;
    }, new RegExp(`${field} must be an? (?:object|array)`, 'i'));
  });

  test.each([
    ['publicPrefixes', [42]],
    ['adminPrefixes', [' ']],
    ['navKeys', [42]],
    ['uses', [' ']],
    ['dependsOn', [42]],
    ['requiredServices', [' ']],
    ['optionalServices', [42]],
    ['seedProfiles', [' ']],
    ['readinessChecks', [{}]],
  ])('requires nonblank string elements in capability %s', (field, value) => {
    expectInvalid((catalog) => {
      catalog.capabilities.bulletins[field] = value;
    }, new RegExp(`bulletins\\.${field}.*nonblank string`, 'i'));
  });

  test.each([
    ['capability label', (c: any) => (c.capabilities.bulletins.labels.zh = ' ')],
    ['capability description', (c: any) => delete c.capabilities.sermons.descriptions.en],
    ['preset label', (c: any) => (c.presets.website.labels.en = '')],
    ['preset description', (c: any) => delete c.presets.website.descriptions.zh],
  ])('rejects missing bilingual %s', (_name, mutate) => {
    expectInvalid(mutate, /(?:label|description).*(?:en|zh)/i);
  });

  test.each([
    ['unknown group', (c: any) => (c.capabilities.bulletins.group = 'mystery')],
    ['unknown provider', (c: any) => (c.capabilities.bulletins.requiresBackend = 'sqlite')],
    ['unknown required service', (c: any) => c.capabilities.bulletins.requiredServices.push('fax')],
    ['unknown optional service', (c: any) => c.capabilities.bulletins.optionalServices.push('fax')],
    ['unknown soft reference', (c: any) => c.capabilities.gifts.uses.push('missing')],
    ['unknown hard reference', (c: any) => c.capabilities.gifts.dependsOn.push('missing')],
    ['unknown preset reference', (c: any) => c.presets.website.modules.push('missing')],
  ])('rejects an %s', (_name, mutate) => {
    expectInvalid(mutate, /unknown/i);
  });

  test('rejects invalid routes', () => {
    expectInvalid((catalog) => {
      catalog.capabilities.bulletins.publicPrefixes = ['bulletin'];
    }, /route.*slash|slash.*route/i);
  });

  test('rejects duplicate order entries', () => {
    expectInvalid((catalog) => {
      catalog.order[1] = catalog.order[0];
    }, /order.*duplicate/i);
  });

  test('rejects order/key mismatch', () => {
    expectInvalid((catalog) => {
      catalog.order.pop();
    }, /order.*key|key.*order/i);
  });

  test('rejects duplicate numeric orders', () => {
    expectInvalid((catalog) => {
      catalog.capabilities.sermons.order = catalog.capabilities.bulletins.order;
    }, /numeric order.*duplicate/i);
  });

  test('rejects numeric order mismatch with the order array', () => {
    expectInvalid((catalog) => {
      catalog.capabilities.bulletins.order = 16;
    }, /numeric order.*position|position.*numeric order/i);
  });

  test('rejects duplicate preset references', () => {
    expectInvalid((catalog) => {
      catalog.presets.website.modules.push('bulletins');
    }, /preset.*duplicate/i);
  });

  test('rejects hard dependency cycles', () => {
    expectInvalid((catalog) => {
      catalog.capabilities.bulletins.dependsOn = ['sermons'];
      catalog.capabilities.sermons.dependsOn = ['bulletins'];
    }, /dependency cycle/i);
  });
});
