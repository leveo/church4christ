import { parseArgs } from 'node:util';

export const SETUP_HELP = `Usage: npm run setup -- [options]
  --mode local|deploy
  --preset website|website-community|full-church
  --modules key,key,... (repeatable)
  --site-slug slug
  --church-name name
  --locale en|zh
  --admin-email email
  --admin-name name
  --app-origin https://church.example
  --email-from serve@church.example
  --backend d1|supabase
  --demo-data
  --yes --dry-run --json --force-config --promote-existing-admin
  --doctor --strict
  --help`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETUP_ANSWER_OPTIONS = [
  'mode',
  'preset',
  'modules',
  'site-slug',
  'church-name',
  'locale',
  'admin-email',
  'admin-name',
  'app-origin',
  'email-from',
  'backend',
  'demo-data',
];

const trim = (value) => value?.trim();
const normalizedEmail = (value) => trim(value)?.toLowerCase();

function normalizeOrigin(value) {
  const input = trim(value);
  if (!input) return undefined;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('--app-origin must be an HTTPS origin without a path, query, or hash');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('--app-origin must be an HTTPS origin without a path, query, or hash');
  }
  return url.origin;
}

export function parseSetupArgs(argv, catalog) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean' },
      mode: { type: 'string' },
      preset: { type: 'string' },
      modules: { type: 'string', multiple: true },
      'site-slug': { type: 'string' },
      'church-name': { type: 'string' },
      locale: { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-name': { type: 'string' },
      'app-origin': { type: 'string' },
      'email-from': { type: 'string' },
      backend: { type: 'string' },
      'demo-data': { type: 'boolean' },
      yes: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      'force-config': { type: 'boolean' },
      'promote-existing-admin': { type: 'boolean' },
      doctor: { type: 'boolean' },
      strict: { type: 'boolean' },
    },
  });

  if (values.preset && values.modules) {
    throw new Error('--preset and --modules cannot be combined');
  }
  if (values.doctor && SETUP_ANSWER_OPTIONS.some((key) => Object.hasOwn(values, key))) {
    throw new Error('--doctor cannot be combined with setup answers');
  }
  if (values.strict && !values.doctor) throw new Error('--strict requires --doctor');

  const knownPresets = new Set(Object.keys(catalog?.presets ?? {}));
  if (values.preset && !knownPresets.has(values.preset)) {
    throw new Error(`Unknown preset: ${values.preset}`);
  }

  const modules = [values.modules ?? []]
    .flat()
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  const knownCapabilities = new Set(Object.keys(catalog?.capabilities ?? {}));
  const unknownCapabilities = modules.filter((key) => !knownCapabilities.has(key));
  if (unknownCapabilities.length) {
    throw new Error(`Unknown capabilities: ${unknownCapabilities.join(', ')}`);
  }

  if (values.mode && values.mode !== 'local' && values.mode !== 'deploy') {
    throw new Error('--mode must be local or deploy');
  }
  if (values.locale && values.locale !== 'en' && values.locale !== 'zh') {
    throw new Error('--locale must be en or zh');
  }
  if (values.backend && values.backend !== 'd1' && values.backend !== 'supabase') {
    throw new Error('--backend must be d1 or supabase');
  }

  const adminEmail = normalizedEmail(values['admin-email']);
  const emailFrom = normalizedEmail(values['email-from']);
  if (adminEmail && !EMAIL.test(adminEmail)) throw new Error('--admin-email must be valid');
  if (emailFrom && !EMAIL.test(emailFrom)) throw new Error('--email-from must be valid');

  const siteSlug = trim(values['site-slug']);
  if (siteSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteSlug)) {
    throw new Error('--site-slug must be lowercase kebab-case');
  }

  return {
    help: values.help ?? false,
    mode: values.mode,
    preset: values.preset,
    modules: values.modules ? modules : undefined,
    siteSlug,
    churchName: trim(values['church-name']),
    locale: values.locale,
    adminEmail,
    adminName: trim(values['admin-name']),
    appOrigin: normalizeOrigin(values['app-origin']),
    emailFrom,
    backendOverride: values.backend,
    demoData: values['demo-data'] ?? false,
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    json: values.json ?? false,
    forceConfig: values['force-config'] ?? false,
    promoteExistingAdmin: values['promote-existing-admin'] ?? false,
    doctor: values.doctor ?? false,
    strict: values.strict ?? false,
  };
}
