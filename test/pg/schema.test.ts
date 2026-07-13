import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { discoverD1MigrationFiles, parseFinalD1Schema, type D1Constraint } from './schemaParity';

const D1_FILES = discoverD1MigrationFiles();

// These feature tables intentionally have no D1 equivalent. Keeping this list
// explicit makes a new Postgres-only table a reviewed schema decision.
const SUPABASE_ONLY_TABLES = new Set([
  // Giving
  'funds',
  'fund_i18n',
  'gifts',
  'recurring_gifts',
  // Registration
  'reg_events',
  'reg_event_i18n',
  'reg_questions',
  'reg_question_i18n',
  'registrations',
  'reg_answers',
  // Member portal
  'group_members',
  'group_applications',
  'group_files',
  'event_admins',
  'prayer_items',
]);

const INFRASTRUCTURE_TABLES = new Set(['_migrations']);

function normalizePgDefault(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (/^datetime\s*\(\s*'now'::text(?:\s*,[\s\S]*)?\)$/i.test(normalized)) return 'utc-now';
  const text = normalized.match(/^'((?:[^']|'')*)'::text$/i);
  if (text) return text[1].replaceAll("''", "'");
  return normalized.toLowerCase();
}

function expectedPgType(table: string, column: string, d1Type: string): string {
  // SQLite's INTEGER affinity stores custom-page UUIDs in revisions.entity_id;
  // Postgres must widen that shared column to text to preserve the same values.
  if (table === 'revisions' && column === 'entity_id') return 'text';
  if (d1Type === 'blob') return 'bytea';
  return d1Type;
}

function normalizePredicate(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.replaceAll(/::(?:text|character varying)/gi, '').replace(/\s+/g, ' ').toLowerCase();
}

function pgIdentifierArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1);
    return body ? body.split(',').map((item) => item.replace(/^"|"$/g, '')) : [];
  }
  throw new Error(`unexpected Postgres identifier array: ${JSON.stringify(value)}`);
}

function constraintSignature(table: string, constraint: D1Constraint): string {
  const target =
    constraint.kind === 'foreign'
      ? `->${constraint.foreignTable}(${constraint.foreignColumns?.join(',') ?? ''})`
      : '';
  return `${table}:${constraint.kind}(${constraint.columns.join(',')})${target}`;
}

describe.skipIf(!hasPg)('Postgres schema port', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const d1 = parseFinalD1Schema(
    D1_FILES.map((file) => readFileSync(`migrations/${file}`, 'utf8')),
  );

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('has exactly the shared, explicitly Supabase-only, and migration tables', async () => {
    const rows = await sql.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actual = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
    const expected = new Set([
      ...d1.tables.keys(),
      ...SUPABASE_ONLY_TABLES,
      ...INFRASTRUCTURE_TABLES,
    ]);

    const missing = [...expected].filter((table) => !actual.has(table)).sort();
    const unexpectedSharedDrift = [...actual].filter((table) => !expected.has(table)).sort();
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches shared columns, types, nullability, defaults, and identity metadata bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const actual = new Map(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)))
        .map((row) => [
          `${row.table_name}.${row.column_name}`,
          {
            type: String(row.data_type).toLowerCase(),
            nullable: row.is_nullable === 'YES',
            defaultValue: normalizePgDefault(row.column_default as string | null),
            identity: row.is_identity === 'YES',
          },
        ]),
    );
    const expected = new Map<string, (typeof actual extends Map<string, infer T> ? T : never)>();
    for (const [tableName, table] of d1.tables) {
      for (const [columnName, column] of table.columns) {
        expected.set(`${tableName}.${columnName}`, {
          type: expectedPgType(tableName, columnName, column.type),
          nullable: column.nullable,
          defaultValue: column.defaultValue,
          identity: column.identity,
        });
      }
    }

    const missing = [...expected].flatMap(([key, value]) =>
      JSON.stringify(actual.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual.get(key))}`],
    );
    const unexpectedSharedDrift = [...actual].flatMap(([key, value]) =>
      JSON.stringify(expected.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: received ${JSON.stringify(value)}, expected ${JSON.stringify(expected.get(key))}`],
    );
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches shared primary, unique, and foreign-key constraints bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT rel.relname AS table_name, con.contype,
        ARRAY(
          SELECT att.attname
          FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
          ORDER BY key.ord
        ) AS columns,
        frel.relname AS foreign_table,
        CASE WHEN con.confkey IS NULL THEN NULL ELSE ARRAY(
          SELECT att.attname
          FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = key.attnum
          ORDER BY key.ord
        ) END AS foreign_columns
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      LEFT JOIN pg_class frel ON frel.oid = con.confrelid
      WHERE namespace.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
    `);
    const kinds = { p: 'primary', u: 'unique', f: 'foreign' } as const;
    const actual = new Set(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)))
        .map((row) =>
          constraintSignature(String(row.table_name), {
            kind: kinds[row.contype as keyof typeof kinds],
            columns: pgIdentifierArray(row.columns),
            foreignTable: row.foreign_table ? String(row.foreign_table) : undefined,
            foreignColumns:
              row.foreign_columns === null ? undefined : pgIdentifierArray(row.foreign_columns),
          }),
        ),
    );
    const expected = new Set(
      [...d1.tables].flatMap(([tableName, table]) =>
        table.constraints.map((constraint) => constraintSignature(tableName, constraint)),
      ),
    );
    const missing = [...expected].filter((value) => !actual.has(value)).sort();
    const unexpectedSharedDrift = [...actual].filter((value) => !expected.has(value)).sort();
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches every application-significant shared index bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT tbl.relname AS table_name, idx.relname AS index_name,
        indexes.indisunique,
        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = indexes.indexrelid) AS is_constraint,
        ARRAY(
          SELECT pg_get_indexdef(indexes.indexrelid, position, true)
          FROM generate_series(1, indexes.indnkeyatts) position
          ORDER BY position
        ) AS columns,
        pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
      FROM pg_index indexes
      JOIN pg_class idx ON idx.oid = indexes.indexrelid
      JOIN pg_class tbl ON tbl.oid = indexes.indrelid
      JOIN pg_namespace namespace ON namespace.oid = tbl.relnamespace
      WHERE namespace.nspname = 'public'
    `);
    const actual = new Map(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)) && !row.is_constraint)
        .map((row) => [
          String(row.index_name),
          {
            table: String(row.table_name),
            columns: pgIdentifierArray(row.columns),
            unique: Boolean(row.indisunique),
            predicate: normalizePredicate(row.predicate as string | null),
          },
        ]),
    );
    const expected = new Map(
      [...d1.indexes].map(([name, index]) => [
        name,
        {
          table: index.table,
          columns: index.columns,
          unique: index.unique,
          predicate: normalizePredicate(index.predicate),
        },
      ]),
    );
    const missing = [...expected].flatMap(([key, value]) =>
      JSON.stringify(actual.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual.get(key))}`],
    );
    const unexpectedSharedDrift = [...actual].flatMap(([key, value]) =>
      JSON.stringify(expected.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: received ${JSON.stringify(value)}, expected ${JSON.stringify(expected.get(key))}`],
    );
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('accepts explicit identity ids and still autogenerates afterwards', async () => {
    await sql.unsafe("INSERT INTO settings (key, value) VALUES ('probe', '1')");
    await sql.unsafe(
      "INSERT INTO people (id, first_name, last_name, display_name, email) VALUES (9000, 'A', 'B', 'A B', 'probe@example.com')",
    );
    await sql.unsafe("SELECT setval(pg_get_serial_sequence('people', 'id'), (SELECT max(id) FROM people))");
    const rows = await sql.unsafe(
      "INSERT INTO people (first_name, last_name, display_name, email) VALUES ('C', 'D', 'C D', 'probe2@example.com') RETURNING id",
    );
    expect(Number(rows[0].id)).toBeGreaterThan(9000);
  });
});
