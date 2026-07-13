import { validateProviderResources } from './manifest.mjs';

const TOKEN_NAMES = [
  'WORKER_NAME',
  'APP_ORIGIN',
  'EMAIL_FROM',
  'DB_BACKEND',
  'CRON_LIST',
  'STRIPE_MODE_SUFFIX',
  'DATABASE_BLOCK',
  'R2_BUCKET',
];
const EXPECTED_OCCURRENCES = { EMAIL_FROM: 2 };

const jsonContent = (value) => JSON.stringify(String(value)).slice(1, -1);
const quote = (value) => JSON.stringify(String(value));

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Wrangler resource requires ${label}`);
}

export function renderWrangler(template, manifest) {
  if (!manifest || !['d1', 'supabase'].includes(manifest.database)) {
    throw new Error('Wrangler database must be d1 or supabase');
  }
  if (!manifest.site || !manifest.resources) throw new Error('Wrangler requires site and resource configuration');
  requireString(manifest.site.slug, 'a Worker name');
  requireString(manifest.site.appOrigin, 'an app origin');
  requireString(manifest.site.emailFrom, 'an email sender');
  validateProviderResources(manifest.resources, manifest.database, { requireBindingIds: true });

  const databaseBlock = manifest.database === 'd1'
    ? `"d1_databases": [{ "binding": "DB", "database_name": ${quote(manifest.resources.d1DatabaseName)}, "database_id": ${quote(manifest.resources.d1DatabaseId)}, "migrations_dir": "migrations" }],`
    : `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": ${quote(manifest.resources.hyperdriveId)} }],`;
  const replacements = {
    WORKER_NAME: jsonContent(manifest.site.slug),
    APP_ORIGIN: jsonContent(manifest.site.appOrigin),
    EMAIL_FROM: jsonContent(manifest.site.emailFrom),
    DB_BACKEND: jsonContent(manifest.database),
    CRON_LIST: JSON.stringify(manifest.database === 'd1'
      ? ['0 13 * * *', '0 14 * * 4', '0 9 * * *']
      : ['0 13 * * *', '0 14 * * 4', '*/5 * * * *']).replaceAll('","', '", "'),
    STRIPE_MODE_SUFFIX: manifest.database === 'supabase' ? ', "STRIPE_MODE": "test"' : '',
    DATABASE_BLOCK: databaseBlock,
    R2_BUCKET: jsonContent(manifest.resources.r2BucketName),
  };

  let output = template;
  for (const token of TOKEN_NAMES) {
    const marker = `@@${token}@@`;
    const expected = EXPECTED_OCCURRENCES[token] ?? 1;
    const occurrences = output.split(marker).length - 1;
    if (occurrences !== expected) {
      const expectation = expected === 1 ? 'exactly once' : `exactly ${expected} times`;
      throw new Error(`template must contain ${marker} ${expectation}`);
    }
    output = output.replaceAll(marker, replacements[token]);
  }
  const leftovers = output.match(/@@[A-Z_]+@@/g);
  if (leftovers) throw new Error(`unresolved template tokens: ${leftovers.join(', ')}`);
  return output.endsWith('\n') ? output : `${output}\n`;
}
