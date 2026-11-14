import { normalizeEmail, normalizeOrigin } from './answers.mjs';
import { resolveProvider } from './resolve-provider.mjs';
import { LEGACY_ENABLED_LOCALES, SUPPORTED_LOCALE_CODES } from './locales.mjs';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'mode',
  'site',
  'preset',
  'modules',
  'database',
  'demoData',
  'resources',
];
// v1 recorded only the default language; v2 adds the enabled set (`locales`).
const SITE_KEYS = ['slug', 'name', 'locale', 'appOrigin', 'emailFrom'];
const SITE_KEYS_V2 = [...SITE_KEYS, 'locales'];
export const MANIFEST_SCHEMA_VERSION = 2;
const RESOURCE_KEYS = ['d1DatabaseName', 'd1DatabaseId', 'r2BucketName', 'hyperdriveId'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]+$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}

function nullableResourceId(value, label) {
  if (value !== null && (typeof value !== 'string' || !RESOURCE_ID.test(value))) {
    throw new Error(`manifest resources.${label} is invalid`);
  }
}

export function validateProviderResources(resources, database, { requireBindingIds = false } = {}) {
  requireExactKeys(resources, RESOURCE_KEYS, 'manifest resources');
  if (!['d1', 'supabase'].includes(database)) throw new Error('manifest database must be d1 or supabase');
  if (!RESOURCE_NAME.test(resources.r2BucketName ?? '')) {
    throw new Error('manifest resources.r2BucketName is invalid');
  }
  nullableResourceId(resources.d1DatabaseId, 'd1DatabaseId');
  nullableResourceId(resources.hyperdriveId, 'hyperdriveId');
  if (database === 'd1') {
    if (!RESOURCE_NAME.test(resources.d1DatabaseName ?? '')) {
      throw new Error('manifest resources.d1DatabaseName is invalid');
    }
    if (resources.hyperdriveId !== null) throw new Error('manifest D1 resources must not include Hyperdrive');
    if (requireBindingIds && !resources.d1DatabaseId) throw new Error('D1 configuration requires a database id');
  } else {
    if (resources.d1DatabaseName !== null || resources.d1DatabaseId !== null) {
      throw new Error('manifest Supabase resources must not include D1');
    }
    if (requireBindingIds && !resources.hyperdriveId) throw new Error('Supabase configuration requires a Hyperdrive id');
  }
  return resources;
}

export function validateManifest(value, catalog) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'manifest');
  if (![1, MANIFEST_SCHEMA_VERSION].includes(value.schemaVersion)) {
    throw new Error('church.config.json schemaVersion must be 1 or 2');
  }
  requireExactKeys(value.site, value.schemaVersion === 1 ? SITE_KEYS : SITE_KEYS_V2, 'manifest site');

  if (!['local', 'deploy'].includes(value.mode)) throw new Error('manifest mode must be local or deploy');
  if (!['d1', 'supabase'].includes(value.database)) throw new Error('manifest database must be d1 or supabase');
  if (typeof value.demoData !== 'boolean') throw new Error('manifest demoData must be boolean');
  if (value.preset !== null && !Object.hasOwn(catalog.presets, value.preset)) {
    throw new Error('manifest preset is unknown');
  }

  const moduleSet = new Set(catalog.order);
  if (!Array.isArray(value.modules) || value.modules.some((key) => typeof key !== 'string' || !moduleSet.has(key))) {
    throw new Error('manifest contains an unknown module');
  }
  if (new Set(value.modules).size !== value.modules.length) throw new Error('manifest contains duplicate modules');
  if (value.preset !== null) {
    const expected = resolveProvider(catalog.presets[value.preset].modules, value.database, catalog).modules;
    if (expected.length !== value.modules.length || expected.some((key) => !value.modules.includes(key))) {
      throw new Error('manifest preset modules must exactly match the canonical preset membership');
    }
  }
  const incompatibleModules = value.modules.filter((key) => {
    const required = catalog.capabilities[key].requiresBackend;
    return required && required !== value.database;
  });
  if (incompatibleModules.length) {
    throw new Error(`manifest database is incompatible with modules: ${incompatibleModules.join(', ')}`);
  }

  if (!SLUG.test(value.site.slug ?? '')) throw new Error('manifest site.slug is invalid');
  if (typeof value.site.name !== 'string' || !value.site.name.trim()) throw new Error('manifest site.name is invalid');
  if (!SUPPORTED_LOCALE_CODES.includes(value.site.locale)) {
    throw new Error(`manifest site.locale must be one of: ${SUPPORTED_LOCALE_CODES.join(', ')}`);
  }
  if (value.schemaVersion === MANIFEST_SCHEMA_VERSION) {
    const { locales } = value.site;
    if (!Array.isArray(locales) || locales.length === 0 || new Set(locales).size !== locales.length
      || locales.some((code) => !SUPPORTED_LOCALE_CODES.includes(code))) {
      throw new Error('manifest site.locales must list unique supported languages');
    }
    if (!locales.includes(value.site.locale)) throw new Error('manifest site.locale must be one of site.locales');
  }
  try {
    const canonicalOrigin = normalizeOrigin(value.site.appOrigin, value.mode, 'manifest site.appOrigin');
    if (!canonicalOrigin || canonicalOrigin !== value.site.appOrigin) throw new Error();
  } catch {
    throw new Error('manifest site.appOrigin is invalid');
  }
  try {
    const canonicalEmail = normalizeEmail(value.site.emailFrom, 'manifest site.emailFrom');
    if (!canonicalEmail || canonicalEmail !== value.site.emailFrom) throw new Error();
  } catch {
    throw new Error('manifest site.emailFrom is invalid');
  }

  validateProviderResources(value.resources, value.database);
  return value;
}

export function manifestFromPlan(plan, catalog) {
  const fallbackResources = plan.backend === 'supabase'
    ? {
        d1DatabaseName: null,
        d1DatabaseId: null,
        r2BucketName: `${plan.site.slug}-media`,
        hyperdriveId: plan.mode === 'local' ? 'local' : null,
      }
    : {
        d1DatabaseName: `${plan.site.slug}-db`,
        d1DatabaseId: plan.mode === 'local' ? 'local' : null,
        r2BucketName: `${plan.site.slug}-media`,
        hyperdriveId: null,
      };
  return validateManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    mode: plan.mode,
    site: {
      slug: plan.site.slug,
      name: plan.site.name,
      locale: plan.site.locale,
      appOrigin: plan.site.appOrigin,
      emailFrom: plan.site.emailFrom,
      locales: [...(plan.site.locales ?? [plan.site.locale])],
    },
    preset: plan.preset,
    modules: [...plan.modules],
    database: plan.backend,
    demoData: plan.demoData,
    resources: { ...(plan.resources ?? fallbackResources) },
  }, catalog);
}

export function renderManifest(plan, catalog) {
  return `${JSON.stringify(manifestFromPlan(plan, catalog), null, 2)}\n`;
}

/** Enabled languages recorded by a manifest of either version. A v1 manifest
 *  predates the enabled set: it means the legacy en+zh pair with its default. */
export function manifestLocales(manifest) {
  return manifest.schemaVersion === 1
    ? { locales: [...LEGACY_ENABLED_LOCALES], defaultLocale: manifest.site.locale }
    : { locales: [...manifest.site.locales], defaultLocale: manifest.site.locale };
}
