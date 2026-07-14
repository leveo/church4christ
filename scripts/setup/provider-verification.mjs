const PROVIDER_FAILURE = 'Selected database provider verification failed before setup mutations';
const INSPECTION_FAILURE = 'Existing database could not be inspected safely before setup mutations';

function strictOne(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).length === 1 && Object.hasOwn(row, 'ok') && row.ok === 1;
}

function strictCount(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).length === 1 && Object.hasOwn(row, 'count') &&
    Number.isSafeInteger(row.count) && row.count >= 0;
}

function missingPeopleTable(error, backend) {
  if (!error || typeof error !== 'object') return false;
  if (backend === 'supabase') return error.code === '42P01';
  return /(?:^|\b)no such table:\s*(?:main\.)?people\b/i.test(error instanceof Error ? error.message : String(error));
}

function parseD1List(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('D1 validation failed'); }
  if (!Array.isArray(parsed) || !parsed.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof entry.name === 'string' && typeof entry.uuid === 'string' && entry.name.length > 0 && /^[A-Za-z0-9_-]+$/.test(entry.uuid))) {
    throw new Error('D1 validation failed');
  }
  return parsed;
}

function requireDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('provider verification database is required');
}

export async function verifyProviderPreflight(options) {
  if (!options || !['d1', 'supabase'].includes(options.backend) || !['local', 'deploy'].includes(options.mode)) {
    throw new TypeError('provider verification backend and mode are required');
  }
  try {
    if (options.backend === 'd1' && options.mode === 'deploy') {
      if (!options.runner || typeof options.runner.run !== 'function') throw new Error('runner unavailable');
      if (typeof options.wranglerBin !== 'string' || !options.wranglerBin || typeof options.configPath !== 'string' || !options.configPath) {
        throw new Error('Wrangler configuration unavailable');
      }
      const result = await options.runner.run(options.wranglerBin,
        ['d1', 'list', '--json', '--config', options.configPath],
        { allowNonzero: true, env: { ...process.env, WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' } });
      if (!result || typeof result !== 'object' || result.exitCode !== 0 || typeof result.stdout !== 'string' ||
          typeof result.stderr !== 'string') throw new Error('D1 validation failed');
      const databases = parseD1List(result.stdout);
      const recordedName = options.resources?.d1DatabaseName;
      const recordedId = options.resources?.d1DatabaseId;
      if (typeof recordedName === 'string' && typeof recordedId === 'string' && recordedId !== 'local') {
        const matches = databases.filter((entry) => entry.name === recordedName && entry.uuid === recordedId);
        if (matches.length !== 1) throw new Error('D1 validation failed');
      }
      return true;
    }
    requireDb(options.db);
    const row = await options.db.prepare('SELECT 1 AS ok').first();
    if (!strictOne(row)) throw new Error('connectivity result malformed');
    return true;
  } catch {
    throw new Error(PROVIDER_FAILURE);
  }
}

export async function applyAfterProviderPreflight({ providerOptions, apply } = {}) {
  if (typeof apply !== 'function') throw new TypeError('provider preflight apply callback is required');
  await verifyProviderPreflight(providerOptions);
  return apply();
}

export async function assertDemoSeedTarget(options) {
  if (!options || !['d1', 'supabase'].includes(options.backend)) throw new TypeError('demo target backend is required');
  requireDb(options.db);
  let row;
  try {
    row = await options.db.prepare('SELECT COUNT(*) AS count FROM people').first();
  } catch (error) {
    if (missingPeopleTable(error, options.backend)) return true;
    throw new Error(INSPECTION_FAILURE);
  }
  if (!strictCount(row)) throw new Error(INSPECTION_FAILURE);
  if (row.count === 0) return true;
  let canonical = false;
  try {
    canonical = typeof options.canonicalDemoReady === 'function' && await options.canonicalDemoReady() === true;
  } catch {
    throw new Error(INSPECTION_FAILURE);
  }
  if (!canonical) throw new Error('Fictional demo data can only be added to a fresh database; refusing to collide with existing people');
  return true;
}
