import { parseArgs } from 'node:util';
import { normalizeSetupAnswers } from './answers.mjs';

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
  --allow-hyperdrive-secret-in-argv
      Explicitly permit Wrangler to receive a Supabase URL in its argv when creating deploy Hyperdrive
  --doctor --strict
  Machine-readable: node scripts/setup/index.mjs [options] --json
                    npm run --silent setup -- [options] --json
  --help`;

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
      'allow-hyperdrive-secret-in-argv': { type: 'boolean' },
      doctor: { type: 'boolean' },
      strict: { type: 'boolean' },
    },
  });

  if (values.help) return { help: true };
  const doctorOptions = new Set(['doctor', 'strict', 'json']);
  if (values.doctor && Object.keys(values).some((key) => !doctorOptions.has(key))) {
    throw new Error(
      '--doctor cannot be combined with setup answers or setup controls; it may only be combined with --strict and --json',
    );
  }
  if (values.strict && !values.doctor) throw new Error('--strict requires --doctor');
  if (values.doctor) {
    return {
      help: false,
      doctor: true,
      strict: values.strict ?? false,
      json: values.json ?? false,
    };
  }

  const modules = [values.modules ?? []]
    .flat()
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  const answers = normalizeSetupAnswers({
    mode: values.mode,
    preset: values.preset,
    modules: values.modules ? modules : undefined,
    siteSlug: values['site-slug'],
    churchName: values['church-name'],
    locale: values.locale,
    adminEmail: values['admin-email'],
    adminName: values['admin-name'],
    appOrigin: values['app-origin'],
    emailFrom: values['email-from'],
    backendOverride: values.backend,
    demoData: values['demo-data'] ?? false,
  }, catalog);
  return {
    ...answers,
    help: values.help ?? false,
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    json: values.json ?? false,
    forceConfig: values['force-config'] ?? false,
    promoteExistingAdmin: values['promote-existing-admin'] ?? false,
    allowHyperdriveSecretInArgv: values['allow-hyperdrive-secret-in-argv'] ?? false,
    demoDataSpecified: values['demo-data'] !== undefined,
    doctor: false,
    strict: false,
  };
}
