import { normalizeEmail, normalizeOrigin } from './answers.mjs';
import { validateProviderResources } from './manifest.mjs';

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
