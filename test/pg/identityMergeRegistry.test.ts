import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDENTITY_MERGE_REFERENCE_REGISTRY,
  IDENTITY_MERGE_TEXT_ACTOR_REGISTRY,
  mergeReferenceKey,
} from '../../src/lib/identityMergeRegistry';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('identity merge reference registry (PostgreSQL catalog)', () => {
  const sql = hasPg ? pgClient() : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  it('fails closed on every unclassified or stale people foreign key', async () => {
    const rows = await sql.unsafe(`
      SELECT namespace.nspname AS schema_name, relation.relname AS table_name, attribute.attname AS column_name
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid=constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_class target ON target.oid=constraint_row.confrelid
      JOIN pg_namespace target_namespace ON target_namespace.oid=target.relnamespace
      JOIN LATERAL unnest(constraint_row.conkey) AS key_column(attnum) ON TRUE
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attnum=key_column.attnum
      WHERE constraint_row.contype='f' AND target_namespace.nspname='public' AND target.relname='people'
        AND namespace.nspname IN ('public','church_private')
      ORDER BY namespace.nspname,relation.relname,attribute.attname
    `);
    const actual = rows.map((row) => mergeReferenceKey(
      row.schema_name === 'public' ? String(row.table_name) : `${row.schema_name}.${row.table_name}`,
      String(row.column_name),
    ));
    const registered = IDENTITY_MERGE_REFERENCE_REGISTRY.map(({ table, column }) => mergeReferenceKey(table, column));
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...actual].sort());
  });

  it('seeds exactly the static journal reference registry', async () => {
    const rows = await sql.unsafe('SELECT reference_key,policy FROM person_merge_registry_keys ORDER BY reference_key');
    const expected = [...IDENTITY_MERGE_REFERENCE_REGISTRY, ...IDENTITY_MERGE_TEXT_ACTOR_REGISTRY]
      .map(({ table, column, policy }) => ({ reference_key: mergeReferenceKey(table, column), policy }))
      .sort((left, right) => left.reference_key.localeCompare(right.reference_key));
    expect(rows.map(({ reference_key, policy }) => ({ reference_key, policy }))
      .sort((left, right) => left.reference_key.localeCompare(right.reference_key))).toEqual(expected);
  });
});
