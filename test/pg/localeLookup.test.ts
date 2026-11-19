import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPg, pgClient, resetSchema } from './helpers';

// Migration 0041 swaps the hard-coded CHECK (locale IN ('en','zh')) for a foreign key to
// supported_locales on every locale column. Upgrading a database that already holds rows
// must change those constraints and nothing else.

const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['people', 'lang'],
  ['ministry_i18n', 'locale'],
  ['team_i18n', 'locale'],
  ['position_i18n', 'locale'],
  ['service_type_i18n', 'locale'],
  ['testimonies', 'locale'],
  ['prayer_sheets', 'locale'],
  ['announcement_i18n', 'locale'],
  ['event_i18n', 'locale'],
  ['email_templates', 'locale'],
  ['custom_page_i18n', 'locale'],
  ['newcomer_status_i18n', 'locale'],
  ['newcomer_field_i18n', 'locale'],
  ['newcomer_field_option_i18n', 'locale'],
  ['newcomer_submissions', 'locale'],
  ['identity_recovery_notification_outbox', 'locale'],
  ['identity_giving_checkout_continuations', 'locale'],
  ['identity_registration_continuations', 'locale'],
  ['fund_i18n', 'locale'],
  ['reg_event_i18n', 'locale'],
  ['reg_question_i18n', 'locale'],
];

const files = readdirSync('migrations-supabase').filter((f) => f.endsWith('.sql')).sort();
const before = files.filter((f) => f < '0041');

function seedStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The demo seeds describe the current schema, but this suite seeds a database frozen at
// 0040. Drop what only exists from 0042 onward (the dev-seed Registration block, which
// is the file's last section, and registration-seed's v2 columns and statements).
function preV2Seed(file: string, sql: string): string[] {
  if (file === 'dev-seed.sql') return seedStatements(sql.split('-- Event Registration (free events')[0]);
  if (file !== 'registration-seed.sql') return seedStatements(sql);
  return seedStatements(sql)
    .filter((statement) => !/^(INSERT INTO reg_attendees|UPDATE reg_events)\b/.test(statement))
    .map((statement) =>
      statement.startsWith('INSERT INTO registrations')
        ? statement
            .replace(', submission_key, confirmation_no)', ')')
            .replace(/, 'seed-reg-\d+', '[A-Z]+-\d{4}'\)/g, ')')
        : statement,
    );
}

describe.skipIf(!hasPg)('locale lookup migration 0041 on PostgreSQL', () => {
  const sql = hasPg ? pgClient() : (null as never);

  const constraints = async () =>
    (await sql.unsafe(`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2
    `)) as unknown as { tbl: string; conname: string; def: string }[];
  const dump = async (table: string) =>
    (await sql.unsafe(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`)).map((r) => r.row as string);

  let constraintsBefore: { tbl: string; conname: string; def: string }[];
  const rowsBefore = new Map<string, string[]>();

  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
    for (const file of before) {
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(`migrations-supabase/${file}`, 'utf8'));
        await tx.unsafe('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      });
    }
    for (const file of ['dev-seed.sql', 'giving-seed.sql', 'registration-seed.sql']) {
      for (const statement of preV2Seed(file, readFileSync(`seed/${file}`, 'utf8'))) await sql.unsafe(statement);
    }
    await sql.unsafe("UPDATE people SET lang = 'zh' WHERE id = 1; UPDATE people SET lang = 'en' WHERE id = 2");

    constraintsBefore = await constraints();
    for (const [table] of COLUMNS) rowsBefore.set(table, await dump(table));
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync('migrations-supabase/0041_supported_locales.sql', 'utf8'));
      await tx.unsafe("INSERT INTO _migrations(name) VALUES ('0041_supported_locales.sql')");
    });
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('seeds the twelve planned languages', async () => {
    const codes = (await sql.unsafe('SELECT code FROM supported_locales ORDER BY code')).map((r) => r.code);
    expect(codes).toEqual(['de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'ms', 'pt', 'vi', 'zh']);
  });

  it('replaces every locale CHECK with a named foreign key and changes no other constraint', async () => {
    const after = await constraints();
    const isLocaleCheck = (c: { def: string }) => c.def.startsWith('CHECK') && c.def.includes("'en'") && c.def.includes("'zh'");
    const droppedChecks = constraintsBefore.filter(isLocaleCheck);
    expect(droppedChecks).toHaveLength(COLUMNS.length);
    expect(after.filter(isLocaleCheck)).toEqual([]);

    const added = after.filter((c) => c.tbl !== 'supported_locales' && !constraintsBefore.some((b) => b.tbl === c.tbl && b.conname === c.conname));
    expect(added.map((c) => `${c.tbl}:${c.conname}:${c.def}`).sort()).toEqual(
      COLUMNS.map(
        ([table, column]) =>
          `${table}:${table}_${column}_locale_fk:FOREIGN KEY (${column}) REFERENCES supported_locales(code)`,
      ).sort(),
    );
    const removed = constraintsBefore.filter((b) => !after.some((c) => c.tbl === b.tbl && c.conname === b.conname));
    expect(removed.map((c) => `${c.tbl}:${c.conname}`).sort()).toEqual(droppedChecks.map((c) => `${c.tbl}:${c.conname}`).sort());
  });

  it('preserves every row in the affected tables', async () => {
    let populated = 0;
    for (const [table] of COLUMNS) {
      const rows = await dump(table);
      expect(rows, table).toEqual(rowsBefore.get(table));
      if (rows.length) populated += 1;
    }
    expect(populated).toBeGreaterThan(10);
  });

  it('accepts supported languages and rejects others with a foreign key error', async () => {
    const ministry = (await sql.unsafe('SELECT id FROM ministries LIMIT 1'))[0].id as number;
    const insert = (locale: string) =>
      sql.unsafe('INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES ($1, $2, $3)', [ministry, locale, 'Name']);
    await expect(insert('es')).resolves.toBeDefined();
    await expect(insert('xx')).rejects.toMatchObject({ code: '23503', constraint_name: 'ministry_i18n_locale_locale_fk' });
    expect((await sql.unsafe("SELECT 1 FROM ministry_i18n WHERE ministry_id = $1 AND locale IN ('en','zh')", [ministry])).length).toBe(2);
  });

  it('keeps people.lang nullable and validated, and fund translations validated', async () => {
    await expect(sql.unsafe("UPDATE people SET lang = 'xx' WHERE id = 3")).rejects.toMatchObject({ code: '23503' });
    await expect(sql.unsafe("UPDATE people SET lang = 'es' WHERE id = 3")).resolves.toBeDefined();
    await expect(sql.unsafe('UPDATE people SET lang = NULL WHERE id = 3')).resolves.toBeDefined();
    const fund = (await sql.unsafe('SELECT id FROM funds LIMIT 1'))[0].id as number;
    await expect(
      sql.unsafe("INSERT INTO fund_i18n (fund_id, locale, name) VALUES ($1, 'xx', 'x')", [fund]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('makes a new language an INSERT, not a schema change', async () => {
    const ministry = (await sql.unsafe('SELECT id FROM ministries LIMIT 1'))[0].id as number;
    const insert = () => sql.unsafe("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES ($1, 'it', 'Nome')", [ministry]);
    await expect(insert()).rejects.toMatchObject({ code: '23503' });
    await sql.unsafe("INSERT INTO supported_locales (code) VALUES ('it')");
    await expect(insert()).resolves.toBeDefined();
  });
});
