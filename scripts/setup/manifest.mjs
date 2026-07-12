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
const SITE_KEYS = ['slug', 'name', 'locale', 'appOrigin', 'emailFrom'];
const RESOURCE_KEYS = ['d1DatabaseName', 'd1DatabaseId', 'r2BucketName', 'hyperdriveId'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

function validateOrigin(origin, mode) {
  if (typeof origin !== 'string') throw new Error('manifest site.appOrigin is invalid');
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('manifest site.appOrigin is invalid');
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(mode === 'local' && url.protocol === 'http:' && isLocal))
  ) {
    throw new Error('manifest site.appOrigin is invalid');
  }
}

function nullableResourceId(value, label) {
  if (value !== null && (typeof value !== 'string' || !RESOURCE_ID.test(value))) {
    throw new Error(`manifest resources.${label} is invalid`);
  }
}

export function validateManifest(value, catalog) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'manifest');
  requireExactKeys(value.site, SITE_KEYS, 'manifest site');
  requireExactKeys(value.resources, RESOURCE_KEYS, 'manifest resources');

  if (value.schemaVersion !== 1) throw new Error('church.config.json schemaVersion must be 1');
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
  const incompatibleModules = value.modules.filter((key) => {
    const required = catalog.capabilities[key].requiresBackend;
    return required && required !== value.database;
  });
  if (incompatibleModules.length) {
    throw new Error(`manifest database is incompatible with modules: ${incompatibleModules.join(', ')}`);
  }

  if (!SLUG.test(value.site.slug ?? '')) throw new Error('manifest site.slug is invalid');
  if (typeof value.site.name !== 'string' || !value.site.name.trim()) throw new Error('manifest site.name is invalid');
  if (!['en', 'zh'].includes(value.site.locale)) throw new Error('manifest site.locale must be en or zh');
  validateOrigin(value.site.appOrigin, value.mode);
  if (typeof value.site.emailFrom !== 'string' || !EMAIL.test(value.site.emailFrom)) {
    throw new Error('manifest site.emailFrom is invalid');
  }

  const resources = value.resources;
  if (!RESOURCE_NAME.test(resources.r2BucketName ?? '')) {
    throw new Error('manifest resources.r2BucketName is invalid');
  }
  nullableResourceId(resources.d1DatabaseId, 'd1DatabaseId');
  nullableResourceId(resources.hyperdriveId, 'hyperdriveId');
  if (value.database === 'd1') {
    if (!RESOURCE_NAME.test(resources.d1DatabaseName ?? '')) {
      throw new Error('manifest resources.d1DatabaseName is invalid');
    }
    if (resources.hyperdriveId !== null) throw new Error('manifest D1 resources must not include Hyperdrive');
  } else {
    if (resources.d1DatabaseName !== null || resources.d1DatabaseId !== null) {
      throw new Error('manifest Supabase resources must not include D1');
    }
  }
  return value;
}

export function manifestFromPlan(plan, catalog) {
  const fallbackResources = plan.backend === 'supabase'
    ? {
        d1DatabaseName: null,
        d1DatabaseId: null,
        r2BucketName: `${plan.site.slug}-media`,
        hyperdriveId: null,
      }
    : {
        d1DatabaseName: `${plan.site.slug}-db`,
        d1DatabaseId: plan.mode === 'local' ? 'local' : null,
        r2BucketName: `${plan.site.slug}-media`,
        hyperdriveId: null,
      };
  return validateManifest({
    schemaVersion: 1,
    mode: plan.mode,
    site: {
      slug: plan.site.slug,
      name: plan.site.name,
      locale: plan.site.locale,
      appOrigin: plan.site.appOrigin,
      emailFrom: plan.site.emailFrom,
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
