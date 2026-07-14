import { result } from '../readiness.mjs';
import { redact } from '../redact.mjs';

const FINAL_SHARED_TABLES = Object.freeze(['checkins', 'custom_pages']);
const ALWAYS_REQUIRED_TABLES = Object.freeze([
  'people', 'settings', 'tokens', 'media', ...FINAL_SHARED_TABLES,
]);
const TABLES_BY_CAPABILITY = Object.freeze({
  bulletins: Object.freeze(['bulletins', 'bulletin_announcements', 'revisions']),
  sermons: Object.freeze(['sermons', 'revisions']),
  'prayer-sheets': Object.freeze(['prayer_sheets', 'revisions']),
  'prayer-wall': Object.freeze(['prayer_requests', 'prayer_activity']),
  events: Object.freeze(['announcements', 'announcement_i18n', 'events', 'event_i18n', 'revisions']),
  serve: Object.freeze([
    'ministries', 'ministry_i18n', 'teams', 'team_i18n', 'positions', 'position_i18n',
    'team_members', 'service_types', 'service_type_i18n', 'plans', 'plan_positions',
    'roster_assignments', 'blockout_dates', 'team_applications', 'person_interests',
    'email_rules', 'email_templates', 'email_log',
  ]),
  gifts: Object.freeze(['gift_results']),
  testimonies: Object.freeze(['testimonies']),
  articles: Object.freeze([]),
  fellowships: Object.freeze([]),
  groups: Object.freeze([
    'groups', 'group_members', 'group_join_requests', 'group_events', 'group_event_occurrences',
    'group_attendance', 'group_attendance_tokens',
  ]),
  people: Object.freeze(['households', 'household_members', 'person_notes']),
  children: Object.freeze(['checkin_events', 'checkins', 'households', 'household_members']),
  'page-builder': Object.freeze(['custom_pages', 'custom_page_i18n', 'revisions']),
  portal: Object.freeze([
    'group_members', 'group_files',
    'event_admins', 'prayer_items', 'households', 'household_members', 'reg_events', 'reg_event_i18n',
    'registrations',
  ]),
  giving: Object.freeze(['funds', 'fund_i18n', 'gifts', 'recurring_gifts', 'households', 'household_members']),
  registration: Object.freeze([
    'reg_events', 'reg_event_i18n', 'reg_questions', 'reg_question_i18n', 'registrations', 'reg_answers',
  ]),
});
const PRIVATE_TABLES_BY_CAPABILITY = Object.freeze({
  giving: Object.freeze(['church_private.stripe_webhook_events']),
  registration: Object.freeze([
    'church_private.stripe_webhook_events',
    'church_private.stripe_checkout_requests',
  ]),
});
const SUPABASE_TABLES_BY_CAPABILITY = Object.freeze({
  groups: Object.freeze(['group_reg_events']),
});

function rows(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== 'meta|results|success' ||
      value.success !== true || !Array.isArray(value.results) || !value.meta || typeof value.meta !== 'object' || Array.isArray(value.meta)) {
    throw new Error(`${label} returned malformed results`);
  }
  return value.results;
}

function plainRow(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function qualifiedBaseTableNames(tableRows) {
  if (!Array.isArray(tableRows)) throw new TypeError('qualified base table rows must be an array');
  const names = new Set();
  for (const row of tableRows) {
    const keys = plainRow(row) ? Object.keys(row).sort().join('|') : '';
    const relation = keys === 'table_name|table_schema|table_type' &&
      typeof row.table_schema === 'string' && typeof row.table_name === 'string' && row.table_type === 'BASE TABLE'
      ? `${row.table_schema}.${row.table_name}`
      : null;
    if (!relation || names.has(relation)) throw new TypeError('qualified base table row is invalid or duplicated');
    names.add(relation);
  }
  return names;
}

function issue(code, message, remediation) {
  return result(code, 'error', message, remediation);
}

async function queryAll(db, sql, binds = []) {
  let statement = db.prepare(sql);
  if (!statement || typeof statement !== 'object') throw new Error('database prepare returned an invalid statement');
  if (binds.length) {
    if (typeof statement.bind !== 'function') throw new Error('database statement does not support binding');
    statement = statement.bind(...binds);
  }
  if (!statement || typeof statement.all !== 'function') throw new Error('database statement does not support all');
  return rows(await statement.all(), 'database query');
}

async function queryFirst(db, sql, binds = []) {
  let statement = db.prepare(sql);
  if (!statement || typeof statement !== 'object') throw new Error('database prepare returned an invalid statement');
  if (binds.length) {
    if (typeof statement.bind !== 'function') throw new Error('database statement does not support binding');
    statement = statement.bind(...binds);
  }
  if (!statement || typeof statement.first !== 'function') throw new Error('database statement does not support first');
  return statement.first();
}

function expectedTables(manifest) {
  const qualifyPublic = (table) => manifest.database === 'supabase' ? `public.${table}` : table;
  const names = new Set(ALWAYS_REQUIRED_TABLES.map(qualifyPublic));
  for (const key of manifest.modules) {
    for (const table of TABLES_BY_CAPABILITY[key] ?? []) names.add(qualifyPublic(table));
    if (manifest.database === 'supabase') {
      for (const table of SUPABASE_TABLES_BY_CAPABILITY[key] ?? []) names.add(qualifyPublic(table));
      for (const table of PRIVATE_TABLES_BY_CAPABILITY[key] ?? []) names.add(table);
    }
  }
  return [...names].sort();
}

export function missingRequiredTables(catalog, database, createdTables) {
  if (!catalog || !Array.isArray(catalog.order) || !catalog.capabilities || typeof catalog.capabilities !== 'object') {
    throw new TypeError('table readiness catalog is invalid');
  }
  if (!['d1', 'supabase'].includes(database)) throw new TypeError('table readiness provider is invalid');
  if (!(createdTables instanceof Set) || [...createdTables].some((name) => typeof name !== 'string')) {
    throw new TypeError('created tables must be a set of strings');
  }
  const qualifyPublic = (table) => database === 'supabase' ? `public.${table}` : table;
  const required = new Set(ALWAYS_REQUIRED_TABLES.map(qualifyPublic));
  for (const key of catalog.order) {
    const capability = catalog.capabilities[key];
    if (!capability || typeof capability !== 'object') throw new TypeError(`table readiness capability is invalid: ${String(key)}`);
    if (capability.requiresBackend && capability.requiresBackend !== database) continue;
    const owned = TABLES_BY_CAPABILITY[key];
    if (!owned) throw new Error(`table readiness mapping is missing: ${key}`);
    for (const table of owned) required.add(qualifyPublic(table));
    if (database === 'supabase') {
      for (const table of SUPABASE_TABLES_BY_CAPABILITY[key] ?? []) required.add(qualifyPublic(table));
      for (const table of PRIVATE_TABLES_BY_CAPABILITY[key] ?? []) required.add(table);
    }
  }
  return [...required].filter((table) => !createdTables.has(table)).sort();
}

function commandResult(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.stdout === 'string' && typeof value.stderr === 'string' && Number.isInteger(value.exitCode);
}

async function d1MigrationReadiness(options) {
  if (options.runner === undefined) {
    return result('database.d1-migrations-unavailable', 'info', 'This Wrangler version has no injected machine-readable D1 migration-list capability; final shared schema tables were probed instead.', 'Upgrade Wrangler when a stable machine-readable migration list becomes available.');
  }
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('database check runner.run must be a function');
  if (typeof options.wranglerBin !== 'string' || !options.wranglerBin) throw new TypeError('database check wranglerBin is required with runner');
  if (typeof options.configPath !== 'string' || !options.configPath) throw new TypeError('database check configPath is required with runner');
  if (!['local', 'deploy'].includes(options.manifest.mode)) throw new TypeError('database check D1 mode is invalid');
  const help = await options.runner.run(options.wranglerBin, ['d1', 'migrations', 'list', '--help'], { allowNonzero: true });
  if (!commandResult(help) || help.exitCode !== 0) throw new Error('Wrangler D1 migration-list help failed');
  if (!/^\s*--json\b/m.test(help.stdout)) {
    return result('database.d1-migrations-unavailable', 'info', 'This Wrangler version has no machine-readable D1 migration-list output; final shared schema tables were probed instead.', 'Upgrade Wrangler when a stable machine-readable migration list becomes available.');
  }
  const location = options.manifest.mode === 'deploy' ? '--remote' : '--local';
  const listed = await options.runner.run(options.wranglerBin, ['d1', 'migrations', 'list', 'DB', location, '--json', '--config', options.configPath]);
  if (!commandResult(listed) || listed.exitCode !== 0 || listed.stderr !== '') throw new Error('Wrangler D1 migration list failed');
  let pending;
  try { pending = JSON.parse(listed.stdout); } catch { throw new Error('Wrangler D1 migration list returned malformed JSON'); }
  if (!Array.isArray(pending) || pending.some((name) => typeof name !== 'string' || !/^\d+_[a-z0-9_-]+\.sql$/.test(name)) || new Set(pending).size !== pending.length) {
    throw new Error('Wrangler D1 migration list returned invalid JSON');
  }
  return pending.length
    ? issue('database.migrations', 'D1 has unapplied migrations.', 'Apply all D1 migrations before running the site.')
    : null;
}

export async function checkDatabase(options) {
  if (!options || !options.db || typeof options.db.prepare !== 'function') throw new TypeError('database check AppDb is required');
  if (!options.catalog || !Array.isArray(options.catalog.order) || options.catalog.order.length === 0) throw new TypeError('database check requires a non-empty capability catalog');
  if (!options.manifest || !['d1', 'supabase'].includes(options.manifest.database) || !Array.isArray(options.manifest.modules)) {
    throw new TypeError('database check manifest is invalid');
  }
  if (typeof options.readDir !== 'function') throw new TypeError('database check readDir is required');
  const secrets = options.secrets ?? [];
  try {
    const connectivity = await queryFirst(options.db, 'SELECT 1 AS ok');
    if (!plainRow(connectivity) || Object.keys(connectivity).length !== 1 || connectivity.ok !== 1) {
      return [issue('database.connectivity', 'The database connectivity probe returned malformed data.', 'Verify the selected database and provider binding.')];
    }
  } catch {
    return redact([issue('database.exception', 'The database connectivity probe failed.', 'Verify credentials, bindings, and database availability.')], secrets);
  }

  const checks = [];
  try {
    const moduleRows = await queryAll(options.db, "SELECT key, value FROM settings WHERE key LIKE 'module.%' ORDER BY key");
    const expectedKeys = options.catalog.order.map((key) => `module.${key}`);
    const selected = new Set(options.manifest.modules);
    const found = new Map();
    let valid = moduleRows.length === expectedKeys.length;
    for (const row of moduleRows) {
      if (!plainRow(row) || Object.keys(row).sort().join('|') !== 'key|value' || typeof row.key !== 'string' ||
          !expectedKeys.includes(row.key) || !['0', '1'].includes(row.value) || found.has(row.key)) {
        valid = false;
        continue;
      }
      found.set(row.key, row.value);
    }
    for (const key of options.catalog.order) {
      if (found.get(`module.${key}`) !== (selected.has(key) ? '1' : '0')) valid = false;
    }
    if (!valid) checks.push(issue('database.modules', 'Module settings are incomplete, duplicated, invalid, or differ from the manifest.', 'Rerun setup to write every module setting explicitly.'));
  } catch {
    checks.push(issue('database.modules', 'Module settings could not be verified.', 'Repair the settings table and rerun setup.'));
  }

  try {
    const admin = await queryFirst(options.db, 'SELECT COUNT(*) AS count FROM people WHERE role=? AND active=? AND deleted_at IS NULL', ['admin', 1]);
    if (!plainRow(admin) || Object.keys(admin).length !== 1 || !Number.isSafeInteger(admin.count) || admin.count < 1) {
      checks.push(issue('database.admin', 'No active, nondeleted administrator is available.', 'Bootstrap or reactivate an administrator explicitly.'));
    }
  } catch {
    checks.push(issue('database.admin', 'Administrator readiness could not be verified.', 'Repair the people table and bootstrap an administrator.'));
  }

  try {
    const tableRows = options.manifest.database === 'd1'
      ? await queryAll(options.db, 'SELECT name FROM sqlite_master WHERE type=? ORDER BY name', ['table'])
      : await queryAll(options.db, 'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema IN (?,?) AND table_type=? ORDER BY table_schema, table_name', ['public', 'church_private', 'BASE TABLE']);
    const names = options.manifest.database === 'supabase' ? qualifiedBaseTableNames(tableRows) : new Set();
    let valid = true;
    if (options.manifest.database === 'd1') {
      for (const row of tableRows) {
        if (!plainRow(row) || Object.keys(row).length !== 1 || typeof row.name !== 'string' || names.has(row.name)) valid = false;
        else names.add(row.name);
      }
    }
    if (!valid || expectedTables(options.manifest).some((name) => !names.has(name))) {
      checks.push(issue('database.tables', 'Required shared or capability tables are missing or the schema probe was malformed.', 'Apply all migrations for the selected provider.'));
    }
  } catch {
    checks.push(issue('database.tables', 'Required database tables could not be verified.', 'Apply migrations and verify schema inspection permissions.'));
  }

  if (options.manifest.database === 'supabase') {
    try {
      const files = await options.readDir('migrations-supabase');
      if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) throw new Error('migration directory returned malformed data');
      const expected = files.filter((file) => file.endsWith('.sql')).sort();
      const migrationRows = await queryAll(options.db, 'SELECT name FROM _migrations ORDER BY name');
      const actual = migrationRows.map((row) => plainRow(row) && Object.keys(row).length === 1 && typeof row.name === 'string' ? row.name : null);
      if (actual.includes(null) || new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some((name, index) => actual[index] !== name)) {
        checks.push(issue('database.migrations', 'Supabase migration history does not exactly match the sorted migration files.', 'Run the Supabase migration command and investigate any unexpected history rows.'));
      }
    } catch {
      checks.push(issue('database.migrations', 'Supabase migration history could not be verified.', 'Verify _migrations and the migrations-supabase directory.'));
    }
  } else {
    try {
      const migration = await d1MigrationReadiness(options);
      if (migration) checks.push(migration);
    } catch {
      checks.push(issue('database.migrations', 'D1 migration readiness could not be verified safely.', 'Verify the Wrangler version and apply all D1 migrations.'));
    }
  }

  return redact(checks.every((check) => check.severity === 'info')
    ? [...checks, result('database.ok', 'info', 'Database connectivity, modules, administrator, tables, and available migration history are ready.', 'No action is required.')]
    : checks, secrets);
}

export { ALWAYS_REQUIRED_TABLES, FINAL_SHARED_TABLES, PRIVATE_TABLES_BY_CAPABILITY, SUPABASE_TABLES_BY_CAPABILITY, TABLES_BY_CAPABILITY };
