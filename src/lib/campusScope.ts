import type { AppDb, AppDbResult, AppStatement } from './appDb';

// Every entry here must carry the non-null campus_id column added by the matching
// D1 and Postgres migrations. Keeping the list explicit makes a schema addition
// fail review/tests instead of silently becoming cross-campus data.
export const D1_CAMPUS_SCOPED_TABLES = [
  'activity_score_config',
  'activity_score_dimensions',
  'announcement_i18n',
  'announcements',
  'audit_events',
  'blockout_dates',
  'bulletin_announcements',
  'bulletins',
  'checkin_events',
  'checkins',
  'custom_page_i18n',
  'custom_pages',
  'email_log',
  'email_rules',
  'email_templates',
  'event_i18n',
  'events',
  'external_ids',
  'gift_results',
  'group_attendance',
  'group_attendance_tokens',
  'group_event_occurrences',
  'group_events',
  'group_join_requests',
  'group_members',
  'groups',
  'household_members',
  'households',
  'learning_activities',
  'learning_activity_events',
  'learning_canvas_cleanup_tasks',
  'learning_canvas_event_receipts',
  'learning_canvas_oauth_states',
  'learning_canvas_webhook_configs',
  'learning_courses',
  'learning_enrollments',
  'learning_google_cleanup_tasks',
  'learning_google_notification_receipts',
  'learning_google_oauth_states',
  'learning_google_registrations',
  'learning_identity_links',
  'learning_programs',
  'learning_provider_connections',
  'learning_provider_credentials',
  'learning_resources',
  'learning_submission_snapshots',
  'learning_sync_runs',
  'media',
  'ministries',
  'ministry_i18n',
  'newcomer_activity',
  'newcomer_answers',
  'newcomer_field_i18n',
  'newcomer_field_option_i18n',
  'newcomer_field_options',
  'newcomer_fields',
  'newcomer_notes',
  'newcomer_rate_limits',
  'newcomer_status_i18n',
  'newcomer_statuses',
  'newcomer_submissions',
  'onboarding_acknowledgements',
  'people_import_mappings',
  'person_interests',
  'person_notes',
  'plan_positions',
  'plans',
  'position_i18n',
  'positions',
  'prayer_activity',
  'prayer_requests',
  'prayer_sheets',
  'revisions',
  'roster_assignments',
  'sermons',
  'service_attendance',
  'service_checkin_link_state',
  'service_type_checkin_events',
  'service_type_i18n',
  'service_types',
  'team_applications',
  'team_i18n',
  'team_members',
  'teams',
  'testimonies',
] as const;

// The Supabase backend has feature tables that D1 intentionally does not ship.
// They still cross the same request-scoped boundary, including the two tables
// in the private payment-operations schema.
export const POSTGRES_ONLY_CAMPUS_SCOPED_TABLES = [
  'funds',
  'fund_i18n',
  'gifts',
  'recurring_gifts',
  'reg_events',
  'reg_event_i18n',
  'reg_questions',
  'reg_question_i18n',
  'registrations',
  'reg_answers',
  'group_files',
  'event_admins',
  'prayer_items',
  'group_reg_events',
  'church_private.stripe_webhook_events',
  'church_private.stripe_checkout_requests',
] as const;

export const CAMPUS_SCOPED_TABLES = [
  ...D1_CAMPUS_SCOPED_TABLES,
  ...POSTGRES_ONLY_CAMPUS_SCOPED_TABLES,
] as const;

const CLAUSE_WORDS = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'on',
  'group', 'order', 'limit', 'offset', 'union', 'intersect', 'except', 'having',
  'returning', 'set', 'values', 'window', 'for',
]);

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Same-length SQL mask: code is retained, literals/identifiers/comments become spaces. */
function maskSql(sql: string): string {
  let out = '';
  let mode: 'code' | 'single' | 'double' | 'backtick' | 'bracket' | 'line' | 'block' = 'code';
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (mode === 'code') {
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'backtick';
      else if (char === '[') mode = 'bracket';
      else if (char === '-' && next === '-') mode = 'line';
      else if (char === '/' && next === '*') mode = 'block';
      if (mode === 'code') {
        out += char;
        continue;
      }
    } else if (mode === 'single' && char === "'" && next === "'") {
      out += '  ';
      i++;
      continue;
    } else if (mode === 'double' && char === '"' && next === '"') {
      out += '  ';
      i++;
      continue;
    } else if (mode === 'single' && char === "'") mode = 'code';
    else if (mode === 'double' && char === '"') mode = 'code';
    else if (mode === 'backtick' && char === '`') mode = 'code';
    else if (mode === 'bracket' && char === ']') mode = 'code';
    else if (mode === 'line' && char === '\n') mode = 'code';
    else if (mode === 'block' && char === '*' && next === '/') {
      out += '  ';
      i++;
      mode = 'code';
      continue;
    }
    out += char === '\n' ? '\n' : ' ';
  }
  return out;
}

function hasFollowingAlias(mask: string, at: number): boolean {
  const tail = mask.slice(at);
  const asAlias = tail.match(/^\s+AS\s+[A-Za-z_][A-Za-z0-9_]*/i);
  if (asAlias) return true;
  const bare = tail.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return bare ? !CLAUSE_WORDS.has(bare[1].toLowerCase()) : false;
}

function scopeReadTable(sql: string, table: string, campusId: number, projection?: string): string {
  const re = new RegExp(`\\b(FROM|JOIN)\\s+${escaped(table)}\\b`, 'gi');
  const mask = maskSql(sql);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const match of mask.matchAll(re)) {
    const start = match.index;
    const keyword = match[1];
    // DELETE FROM is a mutation target, not a read source. scopeDelete already
    // added its campus predicate and SQLite cannot delete from a subquery.
    if (keyword.toUpperCase() === 'FROM' && /DELETE\s*$/i.test(mask.slice(0, start))) continue;
    const end = start + match[0].length;
    const source = projection ?? `SELECT * FROM ${table} WHERE campus_id = ${campusId}`;
    const defaultAlias = table.split('.').at(-1) ?? table;
    const alias = hasFollowingAlias(mask, end) ? '' : ` AS ${defaultAlias}`;
    replacements.push({ start, end, value: `${keyword} (${source})${alias}` });
  }
  for (const replacement of replacements.reverse()) {
    sql = sql.slice(0, replacement.start) + replacement.value + sql.slice(replacement.end);
  }
  return sql;
}

function scopeInsert(
  sql: string,
  table: string,
  campusId: number,
  partitionColumn = 'campus_id',
): string {
  const insertHead = `\\bINSERT(?:\\s+OR\\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK))?\\s+INTO\\s+${escaped(table)}\\b`;
  const mask = maskSql(sql);
  const defaultMatch = new RegExp(`${insertHead}\\s+DEFAULT\\s+VALUES`, 'i').exec(mask);
  if (defaultMatch) {
    const defaultAt = defaultMatch.index + defaultMatch[0].search(/\bDEFAULT\b/i);
    const head = sql.slice(defaultMatch.index, defaultAt).trimEnd();
    return sql.slice(0, defaultMatch.index)
      + `${head} (${partitionColumn}) VALUES (${campusId})`
      + sql.slice(defaultMatch.index + defaultMatch[0].length);
  }

  const statement = new RegExp(`${insertHead}\\s*\\(([^)]*)\\)\\s*(VALUES|SELECT)\\b`, 'i').exec(mask);
  if (!statement) {
    if (new RegExp(insertHead, 'i').test(mask)) throw new Error(`campus_scope_unsupported_insert:${table}`);
    return sql;
  }
  const openColumn = mask.indexOf('(', statement.index);
  const closeColumn = mask.indexOf(')', openColumn + 1);
  const columns = sql.slice(openColumn + 1, closeColumn);
  if (columns.split(',').some((column) => column.trim().toLowerCase() === partitionColumn)) return sql;

  const insertions = [openColumn + 1];
  const kind = statement[2].toUpperCase();
  const keywordAt = statement.index + statement[0].toUpperCase().lastIndexOf(kind);
  if (kind === 'SELECT') {
    let valueAt = keywordAt + kind.length;
    const modifier = /^\s+(?:DISTINCT|ALL)\b/i.exec(mask.slice(valueAt));
    if (modifier) valueAt += modifier[0].length;
    insertions.push(valueAt);
  } else {
    let cursor = keywordAt + kind.length;
    while (cursor < mask.length) {
      while (/\s/.test(mask[cursor] ?? '')) cursor++;
      if (mask[cursor] !== '(') break;
      insertions.push(cursor + 1);
      let depth = 0;
      for (; cursor < mask.length; cursor++) {
        if (mask[cursor] === '(') depth++;
        else if (mask[cursor] === ')') {
          depth--;
          if (depth === 0) {
            cursor++;
            break;
          }
        }
      }
      while (/\s/.test(mask[cursor] ?? '')) cursor++;
      if (mask[cursor] !== ',') break;
      cursor++;
    }
  }
  for (const at of insertions.sort((a, b) => b - a)) {
    const value = at === openColumn + 1
      ? `${partitionColumn}, `
      : kind === 'SELECT'
        ? ` ${campusId},`
        : `${campusId}, `;
    sql = sql.slice(0, at) + value + sql.slice(at);
  }
  return sql;
}

function scopeMutationWhere(sql: string, predicate: string, after: number): string {
  const mask = maskSql(sql);
  const tail = mask.slice(after);
  const where = /\bWHERE\b/i.exec(tail);
  const returning = /\bRETURNING\b/i.exec(tail);
  const end = returning ? after + returning.index : sql.length;
  if (!where || after + where.index >= end) {
    return `${sql.slice(0, end).trimEnd()} WHERE ${predicate} ${sql.slice(end)}`.trimEnd();
  }
  const whereStart = after + where.index;
  const expressionStart = whereStart + where[0].length;
  const expression = sql.slice(expressionStart, end).trim();
  return `${sql.slice(0, whereStart)}WHERE ${predicate} AND (${expression}) ${sql.slice(end)}`.trimEnd();
}

function scopeUpdate(sql: string, table: string, campusId: number): string {
  const re = new RegExp(
    `\\bUPDATE\\s+${escaped(table)}\\b(?:\\s+(?:AS\\s+)?((?!SET\\b)[A-Za-z_][A-Za-z0-9_]*))?\\s+SET\\b`,
    'i',
  );
  const match = re.exec(maskSql(sql));
  if (!match) return sql;
  const qualifier = match[1] || table.split('.').at(-1) || table;
  return scopeMutationWhere(sql, `${qualifier}.campus_id = ${campusId}`, match.index + match[0].length);
}

function scopeDelete(sql: string, table: string, campusId: number): string {
  const re = new RegExp(
    `\\bDELETE\\s+FROM\\s+${escaped(table)}\\b(?:\\s+(?:AS\\s+)?((?!WHERE\\b|RETURNING\\b)[A-Za-z_][A-Za-z0-9_]*))?`,
    'i',
  );
  const match = re.exec(maskSql(sql));
  if (!match) return sql;
  const qualifier = match[1] || table.split('.').at(-1) || table;
  return scopeMutationWhere(sql, `${qualifier}.campus_id = ${campusId}`, match.index + match[0].length);
}

function scopePeopleMutations(sql: string, campusId: number): string {
  const update = /\bUPDATE\s+people\b(?:\s+(?:AS\s+)?((?!SET\b)[A-Za-z_][A-Za-z0-9_]*))?\s+SET\b/i
    .exec(maskSql(sql));
  if (update) {
    const qualifier = update[1] || 'people';
    sql = scopeMutationWhere(
      sql,
      `EXISTS (SELECT 1 FROM campus_memberships campus_guard
        WHERE campus_guard.person_id = ${qualifier}.id
          AND campus_guard.campus_id = ${campusId}
          AND campus_guard.active = 1)`,
      update.index + update[0].length,
    );
  }
  const remove = /\bDELETE\s+FROM\s+people\b(?:\s+(?:AS\s+)?((?!WHERE\b|RETURNING\b)[A-Za-z_][A-Za-z0-9_]*))?/i
    .exec(maskSql(sql));
  if (remove) {
    const qualifier = remove[1] || 'people';
    sql = scopeMutationWhere(
      sql,
      `EXISTS (SELECT 1 FROM campus_memberships campus_guard
        WHERE campus_guard.person_id = ${qualifier}.id
          AND campus_guard.campus_id = ${campusId}
          AND campus_guard.active = 1)`,
      remove.index + remove[0].length,
    );
  }
  return sql;
}

function replaceSettingsMutationTarget(sql: string, kind: 'insert' | 'update' | 'delete'): string {
  const pattern = kind === 'insert'
    ? /\bINSERT(?:\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+settings\b/i
    : kind === 'update'
      ? /\bUPDATE\s+settings\b/i
      : /\bDELETE\s+FROM\s+settings\b/i;
  const match = pattern.exec(maskSql(sql));
  if (!match) return sql;
  const relative = match[0].toLowerCase().lastIndexOf('settings');
  const at = match.index + relative;
  return `${sql.slice(0, at)}campus_settings${sql.slice(at + 'settings'.length)}`;
}

function scopeSettings(sql: string, campusId: number): string {
  // Campus 1 is the upgrade/default campus. Keep its canonical settings in the
  // legacy table so existing setup scripts, direct operational updates, and an
  // upgraded admin workflow continue to take effect immediately. Every campus
  // created after the upgrade uses the separate campus_settings store below.
  if (campusId === 1) return sql;
  let scoped = replaceSettingsMutationTarget(sql, 'insert');
  scoped = replaceSettingsMutationTarget(scoped, 'update');
  scoped = replaceSettingsMutationTarget(scoped, 'delete');
  scoped = scopeInsert(scoped, 'campus_settings', campusId);
  scoped = scopeUpdate(scoped, 'campus_settings', campusId);
  scoped = scopeDelete(scoped, 'campus_settings', campusId);

  // settings has a global single-column key, while campus_settings owns a
  // compound key. Preserve all existing settings callers' upsert syntax.
  const conflict = /\bON\s+CONFLICT\s*\(\s*key\s*\)/i.exec(maskSql(scoped));
  if (conflict) {
    scoped = `${scoped.slice(0, conflict.index)}ON CONFLICT(campus_id, key)${scoped.slice(conflict.index + conflict[0].length)}`;
  }

  return scopeReadTable(
    scoped,
    'settings',
    campusId,
    `SELECT key, value FROM campus_settings WHERE campus_id = ${campusId}`,
  );
}

/** Add the trusted numeric campus partition to one application SQL statement. */
export function scopeCampusSql(sql: string, campusId: number): string {
  if (!Number.isSafeInteger(campusId) || campusId <= 0) throw new Error('invalid_campus_id');
  let scoped = scopeSettings(sql, campusId);
  // People are shared identities, not tenant data, but a newly created identity
  // must join the campus in which it was created. The database trigger consumes
  // this request-injected home campus and creates the membership atomically.
  scoped = scopeInsert(scoped, 'people', campusId, 'home_campus_id');
  for (const table of CAMPUS_SCOPED_TABLES) {
    scoped = scopeInsert(scoped, table, campusId);
    scoped = scopeUpdate(scoped, table, campusId);
    scoped = scopeDelete(scoped, table, campusId);
    scoped = scopeReadTable(scoped, table, campusId);
  }
  scoped = scopePeopleMutations(scoped, campusId);
  const peopleProjection = `SELECT campus_people.* FROM people campus_people
    JOIN campus_memberships campus_access
      ON campus_access.person_id = campus_people.id
     AND campus_access.campus_id = ${campusId}
     AND campus_access.active = 1`;
  return scopeReadTable(scoped, 'people', campusId, peopleProjection);
}

const DATABASE_CAMPUS_IDS = new WeakMap<AppDb, number>();

class CampusScopedDb implements AppDb {
  constructor(private readonly source: AppDb, private readonly campusId: number) {
    DATABASE_CAMPUS_IDS.set(this, campusId);
  }

  prepare(sql: string): AppStatement {
    return this.source.prepare(scopeCampusSql(sql, this.campusId));
  }

  batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    return this.source.batch<T>(statements);
  }

  snapshotBatch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    return this.source.snapshotBatch
      ? this.source.snapshotBatch<T>(statements)
      : this.source.batch<T>(statements);
  }
}

export function scopeDatabase(db: AppDb, campusId: number | null): AppDb {
  return campusId === null ? db : new CampusScopedDb(db, campusId);
}

/** Cache/diagnostic identity for a request-scoped database; null means global. */
export function campusIdForDatabase(db: AppDb): number | null {
  return DATABASE_CAMPUS_IDS.get(db) ?? null;
}
