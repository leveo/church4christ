import { normalizeEmail, normalizeOrigin } from './answers.mjs';
import { validateProviderResources } from './manifest.mjs';
import { parseJsoncObject } from './jsonc.mjs';

const normalizeText = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function importExistingInstallation({ catalog, config, settings, admins }) {
  const backend = config.database ?? config.backend ?? 'd1';
  if (!['d1', 'supabase'].includes(backend)) throw new Error('existing backend must be d1 or supabase');
  const site = config.site ?? {};
  const activeAdmins = Array.isArray(admins) ? admins : [];
  const soleAdmin = activeAdmins.length === 1 ? activeAdmins[0] : null;
  const locale = settings['locale.default'] ?? site.locale ?? config.locale;
  const churchName = settings[`site.name.${locale}`] ?? site.name ?? config.churchName;
  const sourceResources = config.resources ?? {};
  validateProviderResources(sourceResources, backend, { requireBindingIds: true });
  const resources = { ...sourceResources };
  const rawOrigin = site.appOrigin ?? config.appOrigin;
  let mode = 'deploy';
  if (rawOrigin) {
    let parsed;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      throw new Error('existing app origin is invalid');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === 'http:' && loopback) mode = 'local';
  }

  return {
    mode,
    preset: null,
    modules: catalog.order.filter((key) => settings[`module.${key}`] !== '0'),
    siteSlug: normalizeText(site.slug ?? config.siteSlug)?.toLowerCase(),
    churchName: normalizeText(churchName),
    locale: normalizeText(locale),
    adminEmail: soleAdmin ? normalizeEmail(soleAdmin.email, 'existing admin email') : undefined,
    adminName: soleAdmin ? normalizeText(soleAdmin.display_name ?? soleAdmin.displayName) : undefined,
    appOrigin: normalizeOrigin(rawOrigin, mode, 'existing app origin'),
    emailFrom: normalizeEmail(site.emailFrom ?? config.emailFrom, 'existing email sender'),
    backendOverride: backend,
    existingBackend: backend,
    resources,
    currentState: { existingBackend: backend, resources: { ...resources } },
    demoData: false,
    mutations: [],
  };
}

const oneBinding = (entries, binding, label) => {
  if (!Array.isArray(entries)) throw new Error(`legacy ${label} binding is missing`);
  const matches = entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.binding === binding);
  if (matches.length !== 1 || entries.length !== 1) throw new Error(`legacy ${label} binding is missing or ambiguous`);
  return matches[0];
};

export function parseLegacyWrangler(content) {
  if (/@@[A-Z_]+@@|\bYOUR_[A-Z0-9_]*\b/.test(content)) throw new Error('legacy Wrangler configuration contains unresolved placeholders');
  const parsed = parseJsoncObject(content, 'legacy wrangler.jsonc');
  const backend = parsed.vars?.DB_BACKEND ?? 'd1';
  if (!['d1', 'supabase'].includes(backend)) throw new Error('legacy DB_BACKEND must be d1 or supabase');
  if (typeof parsed.name !== 'string' || !parsed.name) throw new Error('legacy Worker name is missing');
  const r2 = oneBinding(parsed.r2_buckets, 'MEDIA', 'R2 MEDIA');
  if (typeof r2.bucket_name !== 'string') throw new Error('legacy R2 bucket name is missing');
  let resources;
  if (backend === 'd1') {
    if (Object.hasOwn(parsed, 'hyperdrive')) throw new Error('legacy database bindings are ambiguous');
    const d1 = oneBinding(parsed.d1_databases, 'DB', 'D1 DB');
    resources = {
      d1DatabaseName: d1.database_name,
      d1DatabaseId: d1.database_id,
      r2BucketName: r2.bucket_name,
      hyperdriveId: null,
    };
  } else {
    if (Object.hasOwn(parsed, 'd1_databases')) throw new Error('legacy database bindings are ambiguous');
    const hyperdrive = oneBinding(parsed.hyperdrive, 'HYPERDRIVE', 'Hyperdrive');
    resources = {
      d1DatabaseName: null,
      d1DatabaseId: null,
      r2BucketName: r2.bucket_name,
      hyperdriveId: hyperdrive.id,
    };
  }
  validateProviderResources(resources, backend, { requireBindingIds: true });
  return {
    backend,
    siteSlug: parsed.name,
    appOrigin: parsed.vars?.APP_ORIGIN,
    emailFrom: parsed.vars?.EMAIL_FROM,
    resources,
  };
}

const rows = async (db, sql) => {
  const result = await db.prepare(sql).all();
  if (!result || !Array.isArray(result.results)) throw new Error('legacy database returned an invalid read result');
  return result.results;
};

/** Read-only inspection of a pre-manifest Wrangler installation. */
export async function inspectLegacyInstallation(options) {
  const { catalog, configContent, baselineContent, environment = process.env } = options ?? {};
  if (!catalog || typeof configContent !== 'string' || typeof baselineContent !== 'string') {
    throw new TypeError('legacy inspection requires catalog and configuration bytes');
  }
  if (configContent === baselineContent) return {};
  const config = parseLegacyWrangler(configContent);
  const initial = importExistingInstallation({ catalog, config, settings: {}, admins: [] });
  let opened;
  if (config.backend === 'd1') {
    if (typeof options.openD1 !== 'function') throw new TypeError('legacy D1 inspection requires openD1');
    opened = options.openD1({ mode: initial.mode, config });
  } else {
    const url = environment.SUPABASE_DB_URL ?? (initial.mode === 'local'
      ? environment.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
      : undefined);
    if (!url) {
      throw new Error('SUPABASE_DB_URL is required in the environment to inspect a legacy Supabase installation before setup');
    }
    if (typeof options.openPostgres !== 'function') throw new TypeError('legacy Supabase inspection requires openPostgres');
    opened = options.openPostgres(url);
  }
  const db = opened?.db ?? opened;
  if (!db || typeof db.prepare !== 'function') throw new TypeError('legacy database opener returned an invalid AppDb');
  try {
    const settingRows = await rows(db, "SELECT key, value FROM settings WHERE key LIKE 'module.%' OR key LIKE 'site.name.%' OR key='locale.default'");
    const adminRows = await rows(db, "SELECT email, display_name FROM people WHERE role='admin' AND active=1 AND deleted_at IS NULL ORDER BY lower(email)");
    const settings = Object.fromEntries(settingRows.map((row) => {
      if (!row || typeof row.key !== 'string' || typeof row.value !== 'string') throw new Error('legacy settings result is invalid');
      return [row.key, row.value];
    }));
    const admins = adminRows.map((row) => {
      if (!row || typeof row.email !== 'string') throw new Error('legacy admin result is invalid');
      return row;
    });
    const proposal = importExistingInstallation({ catalog, config, settings, admins });
    if (options.requestedMode && options.requestedMode !== proposal.mode) {
      return {
        ...proposal,
        currentResources: { ...proposal.resources },
        resources: undefined,
        currentState: { existingBackend: proposal.existingBackend },
      };
    }
    return proposal;
  } finally {
    await opened?.close?.();
  }
}
