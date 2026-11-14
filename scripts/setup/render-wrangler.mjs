import { validateProviderResources } from './manifest.mjs';
import { parseJsoncObject } from './jsonc.mjs';

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

/**
 * The Stripe go-live opt-in an operator already placed in a generated wrangler.jsonc:
 * 'live' only when STRIPE_MODE is "live" AND STRIPE_LIVE_CONFIRMED is "1"; otherwise
 * 'test'. The installer provisions test mode; rerunning it must preserve a deliberate
 * live opt-in rather than silently reverting production to test mode.
 */
export function preservedStripeMode(config) {
  if (typeof config !== 'string') return 'test';
  try {
    const vars = parseJsoncObject(config, 'generated Wrangler configuration').vars ?? {};
    return vars.STRIPE_MODE === 'live' && vars.STRIPE_LIVE_CONFIRMED === '1' ? 'live' : 'test';
  } catch {
    return 'test';
  }
}

export function renderWrangler(template, manifest, options = {}) {
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
      ? ['0 13 * * *', '0 14 * * 4', '0 9 * * *', '0 * * * *', '15,45 * * * *']
      : ['0 13 * * *', '0 14 * * 4', '0 * * * *', '15,45 * * * *', '*/5 * * * *']).replaceAll('","', '", "'),
    STRIPE_MODE_SUFFIX: manifest.database !== 'supabase'
      ? ''
      : options.stripeMode === 'live'
        ? ', "STRIPE_MODE": "live", "STRIPE_LIVE_CONFIRMED": "1"'
        : ', "STRIPE_MODE": "test"',
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
