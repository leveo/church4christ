import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';

// Migrations 0041-0049 replace every CHECK (locale IN ('en','zh')) with a foreign key to
// supported_locales. SQLite cannot alter a CHECK, so the tables are rebuilt; these tests
// prove the rebuild changes the locale constraint and nothing else, loses no rows, and
// does not cascade into tables that reference the rebuilt ones.

const MIGRATIONS = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
const BEFORE = MIGRATIONS.filter((f) => f < '0041');
const FIRST_LOCALE_FK = MIGRATIONS.filter((f) => f >= '0041' && f < '0050');
// Later migrations (0050 onward) add their own tables; this suite covers 0041-0049 only.
const AFTER_LOCALE_FK = [...BEFORE, ...FIRST_LOCALE_FK];

const LOCALE_TABLES = [
  'people',
  'ministry_i18n',
  'team_i18n',
  'position_i18n',
  'service_type_i18n',
  'testimonies',
  'prayer_sheets',
  'announcement_i18n',
  'event_i18n',
  'email_templates',
  'custom_page_i18n',
  'newcomer_status_i18n',
  'newcomer_field_i18n',
  'newcomer_field_option_i18n',
  'newcomer_submissions',
  'identity_recovery_notification_outbox',
  'identity_giving_checkout_continuations',
  'identity_registration_continuations',
] as const;

// Tables whose rows a naive drop-and-recreate of a parent would cascade away or null out.
const CHILD_TABLES = [
  'newcomer_answers',
  'newcomer_notes',
  'newcomer_activity',
  'newcomer_field_options',
  'learning_identity_links',
  'campus_memberships',
  'identity_person_canonical_keys',
  'identity_recovery_notification_receipts',
  'contact_points',
  'identity_recovery_cases',
  'newcomer_fields',
] as const;

type Row = Record<string, unknown>;

// D1 runs each migration file as one transaction; mirror that so defer_foreign_keys
// behaves as it does there.
function apply(db: DatabaseSync, files: string[]) {
  for (const file of files) {
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(`migrations/${file}`, 'utf8'));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
}

function migrated(files: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  apply(db, files);
  return db;
}

const all = (db: DatabaseSync, sql: string): Row[] => db.prepare(sql).all().map((row) => ({ ...row }));

function snapshot(db: DatabaseSync, table: string) {
  const master = all(db, `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${table}' AND sql IS NOT NULL`);
  const indexes = all(db, `PRAGMA index_list(${table})`)
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: all(db, `PRAGMA index_info(${index.name})`).map((c) => c.name),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const sqlOf = (type: string) =>
    Object.fromEntries(master.filter((row) => row.type === type).map((row) => [row.name, row.sql]));
  return {
    sql: master.find((row) => row.type === 'table')!.sql as string,
    columns: all(db, `PRAGMA table_xinfo(${table})`).map(({ cid: _cid, ...rest }) => rest),
    foreignKeys: all(db, `PRAGMA foreign_key_list(${table})`).map(({ id: _id, ...rest }) => rest),
    indexes,
    indexSql: sqlOf('index'),
    triggerSql: sqlOf('trigger'),
  };
}

const byName = (rows: Row[]) => [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)));
const byFrom = (rows: Row[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const localeFk = (fk: Row) => fk.table === 'supported_locales';

// Independent of the generator: express the expected post-migration table SQL as the
// pre-migration SQL with only the locale CHECK swapped for the foreign key.
function expectedSql(before: string): string {
  return before
    .replace(
      "locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0 AND locale IN ('en','zh'))",
      'locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0) REFERENCES supported_locales(code)',
    )
    .replace(
      "locale TEXT NOT NULL CHECK (locale IN ('en','zh'))",
      'locale TEXT NOT NULL REFERENCES supported_locales(code)',
    )
    .replace(
      "locale TEXT CHECK (locale IN ('en','zh'))",
      'locale TEXT REFERENCES supported_locales(code)',
    );
}

describe('locale lookup migrations 0041-0049: schema', () => {
  it('ship exactly the expected forward files after the frozen history', () => {
    expect(FIRST_LOCALE_FK[0]).toBe('0041_supported_locales.sql');
    expect(FIRST_LOCALE_FK.length).toBe(9);
    expect(BEFORE).toHaveLength(40);
    expect(MIGRATIONS.slice(0, 40)).toEqual(BEFORE);
  });

  it('seeds the twelve planned languages', () => {
    const db = migrated(AFTER_LOCALE_FK);
    expect(all(db, 'SELECT code FROM supported_locales ORDER BY code').map((r) => r.code)).toEqual(
      ['de', 'en', 'es', 'fr', 'hi', 'id', 'ja', 'ko', 'ms', 'pt', 'vi', 'zh'],
    );
  });

  it('leaves no hard-coded locale list in the schema', () => {
    const db = migrated(AFTER_LOCALE_FK);
    const hardCoded = all(
      db,
      "SELECT name FROM sqlite_master WHERE sql LIKE '%IN (''en'',''zh'')%' AND type IN ('table','trigger','index')",
    );
    expect(hardCoded).toEqual([]);
  });

  describe.each(LOCALE_TABLES.filter((t) => t !== 'people'))('%s', (table) => {
    let before: ReturnType<typeof snapshot>;
    let after: ReturnType<typeof snapshot>;
    beforeAll(() => {
      before = snapshot(migrated(BEFORE), table);
      after = snapshot(migrated(AFTER_LOCALE_FK), table);
    });

    it('differs only by swapping the locale CHECK for the foreign key', () => {
      expect(after.sql).toBe(expectedSql(before.sql));
      expect(after.sql).not.toBe(before.sql);
      expect(after.columns).toEqual(before.columns);
      expect(after.foreignKeys.filter(localeFk)).toHaveLength(1);
      expect(byFrom(after.foreignKeys.filter((fk) => !localeFk(fk)))).toEqual(byFrom(before.foreignKeys));
    });

    it('keeps every index and trigger with identical definitions', () => {
      expect(after.indexes).toEqual(before.indexes);
      expect(after.indexSql).toEqual(before.indexSql);
      expect(after.triggerSql).toEqual(before.triggerSql);
    });
  });

  describe('people', () => {
    it('replaces only the lang constraint and keeps indexes and triggers', () => {
      const before = snapshot(migrated(BEFORE), 'people');
      const after = snapshot(migrated(AFTER_LOCALE_FK), 'people');
      const strip = (columns: Row[]) => byName(columns.filter((c) => c.name !== 'lang'));
      expect(strip(after.columns)).toEqual(strip(before.columns));
      expect(after.columns.find((c) => c.name === 'lang')).toEqual(before.columns.find((c) => c.name === 'lang'));
      expect(before.sql).toContain("lang TEXT CHECK (lang IN ('en','zh'))");
      expect(after.sql).not.toContain("IN ('en','zh')");
      expect(after.foreignKeys.filter(localeFk)).toHaveLength(1);
      expect(byFrom(after.foreignKeys.filter((fk) => !localeFk(fk)))).toEqual(byFrom(before.foreignKeys));
      expect(after.indexes).toEqual(before.indexes);
      expect(after.indexSql).toEqual(before.indexSql);
      expect(after.triggerSql).toEqual(before.triggerSql);
    });
  });

  it('leaves the whole database schema otherwise unchanged', () => {
    const names = (db: DatabaseSync) =>
      all(db, "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_locale_bak_%'")
        .map((r) => `${r.type}:${r.name}`)
        .sort();
    const before = names(migrated(BEFORE));
    const after = names(migrated(AFTER_LOCALE_FK));
    expect(after.filter((n) => !before.includes(n))).toEqual(['table:supported_locales']);
    expect(before.filter((n) => !after.includes(n))).toEqual([]);
  });

  it('keeps foreign keys consistent and leaves no scratch tables', () => {
    const db = migrated(AFTER_LOCALE_FK);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(db, "SELECT name FROM sqlite_master WHERE name LIKE '_locale_bak_%'")).toEqual([]);
    expect(all(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });
});

// A database at 0040 holding a row in every populated rebuilt table and in the tables a
// careless parent rebuild would damage.
function seededAt0040(): DatabaseSync {
  const db = migrated(BEFORE);
  // The Registration demo block (the file's last section) needs tables that 0050 creates,
  // which a database frozen at 0040 does not have yet.
  db.exec(readFileSync('seed/dev-seed.sql', 'utf8').split('-- Event Registration (free events')[0]);
  db.exec(`
    INSERT INTO newcomer_fields (id, key, type, required, active, sort, fixed) VALUES (900, 'locale_probe', 'select', 0, 1, 99, 0);
    INSERT INTO newcomer_field_options (field_id, value, sort) VALUES (900, 'a', 1);
    INSERT INTO newcomer_field_option_i18n (field_id, value, locale, label) VALUES (900, 'a', 'en', 'A'), (900, 'a', 'zh', 'A-zh');
    INSERT INTO newcomer_answers (submission_id, field_id, value) VALUES ('70000000-0000-4000-8000-000000000001', 900, 'a');
    INSERT INTO newcomer_notes (id, submission_id, author_person_id, body)
      VALUES ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 1, 'Followed up');
    INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (900, 'email', 'probe@example.test', 'probe@example.test');
    INSERT INTO identity_recovery_cases (id, person_id, contact_point_id, requester_bucket_hash, expires_at)
      VALUES (900, 1, 900, '${'a'.repeat(32)}', '2099-01-01 00:00:00');
    INSERT INTO identity_recovery_notification_outbox (id, case_id, category, contact_point_id, recipient_hash, locale)
      VALUES (900, 900, 'request_old_contact', 900, '${'b'.repeat(64)}', 'zh');
  `);
  db.exec("UPDATE people SET lang = 'zh' WHERE id = 1; UPDATE people SET lang = 'en' WHERE id = 2;");
  return db;
}

function rows(db: DatabaseSync, table: string): string[] {
  return all(db, `SELECT * FROM ${table}`).map((row) =>
    JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))),
  ).sort();
}

describe('locale lookup migrations 0041-0049: data', () => {
  it('preserves every row of every rebuilt table and of the tables that reference them', () => {
    const db = seededAt0040();
    const watched = [...LOCALE_TABLES, ...CHILD_TABLES];
    const before = Object.fromEntries(watched.map((t) => [t, rows(db, t)]));
    // Sanity: the fixture really populates the dangerous cases.
    for (const t of ['people', 'newcomer_submissions', 'newcomer_answers', 'newcomer_notes', 'newcomer_activity',
      'newcomer_field_option_i18n', 'identity_recovery_notification_outbox', 'identity_recovery_notification_receipts',
      'learning_identity_links', 'campus_memberships', 'identity_person_canonical_keys', 'ministry_i18n', 'testimonies',
      'prayer_sheets', 'announcement_i18n', 'event_i18n', 'email_templates', 'custom_page_i18n',
      'newcomer_status_i18n', 'newcomer_field_i18n', 'team_i18n', 'position_i18n', 'service_type_i18n']) {
      expect(before[t].length, t).toBeGreaterThan(0);
    }

    apply(db, FIRST_LOCALE_FK);

    for (const t of watched) expect(rows(db, t), t).toEqual(before[t]);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps the people triggers working after the migration', () => {
    const db = seededAt0040();
    apply(db, FIRST_LOCALE_FK);
    const canonical = () => all(db, 'SELECT person_id FROM identity_person_canonical_keys').length;
    const people = all(db, 'SELECT id FROM people').length;
    expect(canonical()).toBe(people);
    db.exec(`INSERT INTO people (display_name, email, role, lang) VALUES ('Trigger Probe', 'probe@example.test', 'member', 'es')`);
    expect(canonical()).toBe(people + 1);
  });

  it('keeps the newcomer submission guards working after the migration', () => {
    const db = seededAt0040();
    apply(db, FIRST_LOCALE_FK);
    const triggers = all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'newcomer_submissions'");
    expect(triggers.length).toBeGreaterThan(0);
  });
});

describe('locale lookup migrations 0041-0049: behavior', () => {
  const upgraded = () => {
    const db = seededAt0040();
    apply(db, FIRST_LOCALE_FK);
    return db;
  };
  const ministry = (db: DatabaseSync) => all(db, 'SELECT id FROM ministries LIMIT 1')[0].id as number;

  it('accepts languages in supported_locales and rejects others on i18n tables', () => {
    const db = upgraded();
    const id = ministry(db);
    const insert = (locale: string) =>
      db.prepare('INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (?, ?, ?, ?)').run(id, locale, 'Name', 'Blurb');
    expect(() => insert('es')).not.toThrow();
    expect(() => insert('xx')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insert('en\u0000')).toThrow(/constraint failed/);
    expect(all(db, `SELECT locale FROM ministry_i18n WHERE ministry_id = ${id} AND locale IN ('en','zh')`).length).toBe(2);
  });

  it('validates people.lang and keeps it nullable', () => {
    const db = upgraded();
    expect(() => db.exec("UPDATE people SET lang = 'xx' WHERE id = 3")).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.exec("UPDATE people SET lang = 'es' WHERE id = 3")).not.toThrow();
    expect(() => db.exec('UPDATE people SET lang = NULL WHERE id = 3')).not.toThrow();
    expect(all(db, 'SELECT lang FROM people WHERE id = 1')).toEqual([{ lang: 'zh' }]);
  });

  it('validates newcomer submission and notification locales', () => {
    const db = upgraded();
    const id = '70000000-0000-4000-8000-000000000001';
    // The immutability guards forbid editing a submission, so probe the column constraint
    // with a rolled-back direct insert of a copy.
    const cols = all(db, 'PRAGMA table_info(newcomer_submissions)').map((c) => c.name as string);
    const copy = (locale: string) => {
      db.exec('SAVEPOINT probe');
      try {
        const list = cols.map((c) => (c === 'id' ? "'70000000-0000-4000-8000-0000000000ff'" : c === 'locale' ? `'${locale}'` : c));
        db.exec(`INSERT INTO newcomer_submissions (${cols.join(',')}) SELECT ${list.join(',')} FROM newcomer_submissions WHERE id = '${id}'`);
      } finally {
        db.exec('ROLLBACK TO probe; RELEASE probe');
      }
    };
    expect(() => copy('es')).not.toThrow();
    expect(() => copy('xx')).toThrow(/FOREIGN KEY constraint failed/);

    const outbox = (locale: string) => {
      db.exec('SAVEPOINT probe');
      try {
        db.exec(`INSERT INTO identity_recovery_notification_outbox (case_id, category, contact_point_id, recipient_hash, locale)
          VALUES (900, 'completed_old_contact', 900, '${'c'.repeat(64)}', '${locale}')`);
      } finally {
        db.exec('ROLLBACK TO probe; RELEASE probe');
      }
    };
    expect(() => outbox('de')).not.toThrow();
    expect(() => outbox('xx')).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('makes a new language an INSERT, not a schema change', () => {
    const db = upgraded();
    const id = ministry(db);
    const insert = () => db.prepare('INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (?, ?, ?, ?)').run(id, 'it', 'Nome', 'Testo');
    expect(insert).toThrow(/FOREIGN KEY constraint failed/);
    db.exec("INSERT INTO supported_locales (code) VALUES ('it')");
    expect(insert).not.toThrow();
  });

  it('refuses to remove a language that rows still use', () => {
    const db = upgraded();
    expect(() => db.exec("DELETE FROM supported_locales WHERE code = 'en'")).toThrow(/FOREIGN KEY constraint failed/);
  });
});
