const normalizeText = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const normalizeEmail = (value) => normalizeText(value)?.toLowerCase();

function normalizeOrigin(value) {
  const text = normalizeText(value);
  if (!text) return undefined;
  try {
    return new URL(text).origin;
  } catch {
    return text;
  }
}

export function importExistingInstallation({ catalog, config, settings, admins }) {
  const backend = config.database ?? config.backend;
  const site = config.site ?? {};
  const activeAdmins = Array.isArray(admins) ? admins : [];
  const soleAdmin = activeAdmins.length === 1 ? activeAdmins[0] : null;
  const locale = settings['locale.default'] ?? site.locale ?? config.locale;
  const churchName = settings[`site.name.${locale}`] ?? site.name ?? config.churchName;
  const sourceResources = config.resources ?? {};

  return {
    mode: (site.appOrigin ?? config.appOrigin)?.startsWith('http://localhost') ? 'local' : 'deploy',
    preset: null,
    modules: catalog.order.filter((key) => settings[`module.${key}`] !== '0'),
    siteSlug: normalizeText(site.slug ?? config.siteSlug)?.toLowerCase(),
    churchName: normalizeText(churchName),
    locale: normalizeText(locale),
    adminEmail: soleAdmin ? normalizeEmail(soleAdmin.email) : undefined,
    adminName: soleAdmin ? normalizeText(soleAdmin.display_name ?? soleAdmin.displayName) : undefined,
    appOrigin: normalizeOrigin(site.appOrigin ?? config.appOrigin),
    emailFrom: normalizeEmail(site.emailFrom ?? config.emailFrom),
    backendOverride: backend,
    existingBackend: backend,
    resources: {
      d1DatabaseName: sourceResources.d1DatabaseName ?? null,
      d1DatabaseId: sourceResources.d1DatabaseId ?? null,
      r2BucketName: sourceResources.r2BucketName ?? null,
      hyperdriveId: sourceResources.hyperdriveId ?? null,
    },
    demoData: false,
    mutations: [],
  };
}
