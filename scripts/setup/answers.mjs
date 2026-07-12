const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const isPresent = (value) => typeof value === 'string' ? value.trim().length > 0 : value != null;

const optionalString = (value, option) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${option} must be a string`);
  return value.trim();
};

const optionalIdentifier = (value, option) => optionalString(value, option) || undefined;

export function normalizeEmail(value, option) {
  const address = optionalIdentifier(value, option)?.toLowerCase();
  if (!address) return undefined;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@') || address.length > 254) {
    throw new Error(`${option} must be a valid email address`);
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const labels = domain.split('.');
  if (
    local.length > 64 ||
    !EMAIL_LOCAL.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !EMAIL_DOMAIN_LABEL.test(label))
  ) {
    throw new Error(`${option} must be a valid email address`);
  }
  return address;
}

export function normalizeOrigin(value, mode, option = '--app-origin') {
  const input = optionalIdentifier(value, option);
  if (!input) return undefined;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${option} must be an HTTPS origin, or an HTTP loopback origin in local mode, without a path, query, or hash`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(mode === 'local' && url.protocol === 'http:' && loopback))
  ) {
    throw new Error(`${option} must be an HTTPS origin, or an HTTP loopback origin in local mode, without a path, query, or hash`);
  }
  return url.origin;
}

export function normalizeSetupAnswers(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Setup answers must be an object');
  }
  if (input.demoData !== undefined && typeof input.demoData !== 'boolean') {
    throw new Error('demoData must be a boolean');
  }

  const mode = optionalIdentifier(input.mode, '--mode');
  const preset = optionalIdentifier(input.preset, '--preset');
  const locale = optionalIdentifier(input.locale, '--locale');
  const backendOverride = optionalIdentifier(input.backendOverride, '--backend');
  const siteSlug = optionalIdentifier(input.siteSlug, '--site-slug');

  if (mode && mode !== 'local' && mode !== 'deploy') {
    throw new Error('--mode must be local or deploy');
  }
  if (locale && locale !== 'en' && locale !== 'zh') {
    throw new Error('--locale must be en or zh');
  }
  if (backendOverride && backendOverride !== 'd1' && backendOverride !== 'supabase') {
    throw new Error('--backend must be d1 or supabase');
  }
  if (siteSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug)) {
    throw new Error('--site-slug must be lowercase kebab-case');
  }

  if (input.modules !== undefined && !Array.isArray(input.modules)) {
    throw new Error('--modules must be a list of capability keys');
  }
  const modules = input.modules?.map((key) => optionalIdentifier(key, '--modules'))
    .filter(Boolean)
    .filter((key, index, all) => all.indexOf(key) === index);
  if (preset && input.modules !== undefined) {
    throw new Error('--preset and --modules cannot be combined');
  }

  const knownPresets = new Set(Object.keys(catalog?.presets ?? {}));
  if (preset && !knownPresets.has(preset)) throw new Error(`Unknown preset: ${preset}`);
  const knownCapabilities = new Set(Object.keys(catalog?.capabilities ?? {}));
  const unknownCapabilities = (modules ?? []).filter((key) => !knownCapabilities.has(key));
  if (unknownCapabilities.length) {
    throw new Error(`Unknown capabilities: ${unknownCapabilities.join(', ')}`);
  }

  return {
    mode,
    preset,
    modules,
    siteSlug,
    churchName: optionalString(input.churchName, '--church-name'),
    locale,
    adminEmail: normalizeEmail(input.adminEmail, '--admin-email'),
    adminName: optionalString(input.adminName, '--admin-name'),
    appOrigin: normalizeOrigin(input.appOrigin, mode),
    emailFrom: normalizeEmail(input.emailFrom, '--email-from'),
    backendOverride,
    demoData: input.demoData ?? false,
  };
}

export function missingAnswers(answers) {
  const missing = [];
  if (!isPresent(answers.mode)) missing.push('mode');
  if (!isPresent(answers.preset) && !(Array.isArray(answers.modules) && answers.modules.length > 0)) {
    missing.push('featureChoice');
  }
  for (const key of ['siteSlug', 'churchName', 'locale', 'adminEmail', 'adminName']) {
    if (!isPresent(answers[key])) missing.push(key);
  }
  if (answers.mode === 'deploy') {
    if (!isPresent(answers.appOrigin)) missing.push('appOrigin');
    if (!isPresent(answers.emailFrom)) missing.push('emailFrom');
  }
  return missing;
}
