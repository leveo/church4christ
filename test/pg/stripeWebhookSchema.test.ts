import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  if (/^datetime\s*\(\s*'now'::text\s*\)$/i.test(value.trim())) return 'utc-now';
  const text = value.trim().match(/^'((?:[^']|'')*)'::text$/i);
  return text ? text[1].replaceAll("''", "'") : value.trim().replace(/^\((.*)\)$/s, '$1');
}

function normalizeConstraintDefinition(value: string): string {
  return value.toLowerCase().replaceAll('::text', '').replaceAll(/\s+/g, '');
}

function pgIdentifierArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1);
    return body ? body.split(',').map((item) => item.replace(/^"|"$/g, '')) : [];
  }
  throw new Error(`unexpected Postgres identifier array: ${JSON.stringify(value)}`);
}

describe('private schema assertion helpers', () => {
  it('does not normalize modified datetime defaults as the approved UTC-now default', () => {
    const modified = `datetime('now'::text, '+1 day'::text)`;
    expect(normalizeDefault(modified)).toBe(modified);
  });
});

describe.skipIf(!hasPg)('private Stripe reliability schema', () => {
  const sql = hasPg ? pgClient() : (null as never);

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

  it('creates exactly the two private base tables', async () => {
    const rows = await sql.unsafe<{ table_name: string }[]>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'church_private' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(rows.map((row) => row.table_name)).toEqual([
      'stripe_checkout_requests',
      'stripe_webhook_events',
    ]);
  });

  it('has the exact approved columns, order, types, nullability, and defaults', async () => {
    const rows = await sql.unsafe(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'church_private'
      ORDER BY table_name, ordinal_position
    `);
    const actual = rows.map((row) => [
      row.table_name,
      row.column_name,
      row.data_type,
      row.is_nullable,
      normalizeDefault(row.column_default as string | null),
    ]);
    expect(actual).toEqual([
      ['stripe_checkout_requests', 'request_id', 'text', 'NO', null],
      ['stripe_checkout_requests', 'request_sha256', 'text', 'NO', null],
      ['stripe_checkout_requests', 'registration_id', 'integer', 'NO', null],
      ['stripe_checkout_requests', 'request_json', 'text', 'YES', null],
      ['stripe_checkout_requests', 'session_url', 'text', 'YES', null],
      ['stripe_checkout_requests', 'state', 'text', 'NO', 'creating'],
      ['stripe_checkout_requests', 'reconcile_attempts', 'integer', 'NO', '0'],
      ['stripe_checkout_requests', 'next_reconcile_at', 'text', 'YES', null],
      ['stripe_checkout_requests', 'last_error', 'text', 'YES', null],
      ['stripe_checkout_requests', 'last_action_by', 'integer', 'YES', null],
      ['stripe_checkout_requests', 'created_at', 'text', 'NO', 'utc-now'],
      ['stripe_checkout_requests', 'updated_at', 'text', 'NO', 'utc-now'],
      ['stripe_webhook_events', 'event_id', 'text', 'NO', null],
      ['stripe_webhook_events', 'payload_json', 'text', 'YES', null],
      ['stripe_webhook_events', 'payload_sha256', 'text', 'NO', null],
      ['stripe_webhook_events', 'event_type', 'text', 'NO', null],
      ['stripe_webhook_events', 'api_version', 'text', 'YES', null],
      ['stripe_webhook_events', 'event_created', 'integer', 'NO', null],
      ['stripe_webhook_events', 'livemode', 'integer', 'NO', null],
      ['stripe_webhook_events', 'status', 'text', 'NO', 'pending'],
      ['stripe_webhook_events', 'outcome', 'text', 'YES', null],
      ['stripe_webhook_events', 'attempt_count', 'integer', 'NO', '0'],
      ['stripe_webhook_events', 'retry_cycle_attempts', 'integer', 'NO', '0'],
      ['stripe_webhook_events', 'next_attempt_at', 'text', 'YES', null],
      ['stripe_webhook_events', 'lease_token', 'text', 'YES', null],
      ['stripe_webhook_events', 'lease_expires_at', 'text', 'YES', null],
      ['stripe_webhook_events', 'last_error', 'text', 'YES', null],
      ['stripe_webhook_events', 'last_action_by', 'integer', 'YES', null],
      ['stripe_webhook_events', 'last_action_at', 'text', 'YES', null],
      ['stripe_webhook_events', 'received_at', 'text', 'NO', 'utc-now'],
      ['stripe_webhook_events', 'last_attempt_at', 'text', 'YES', null],
      ['stripe_webhook_events', 'completed_at', 'text', 'YES', null],
      ['stripe_webhook_events', 'updated_at', 'text', 'NO', 'utc-now'],
    ]);
  });

  it('has the complete approved CHECK constraint set on each private table', async () => {
    const rows = await sql.unsafe<{ table_name: string; definition: string }[]>(`
      SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      WHERE namespace.nspname = 'church_private' AND con.contype = 'c'
      ORDER BY rel.relname, con.oid
    `);
    const definitionsFor = (table: string) => rows
      .filter((row) => row.table_name === table)
      .map((row) => normalizeConstraintDefinition(row.definition))
      .sort();
    const expected = (definitions: string[]) => definitions
      .map(normalizeConstraintDefinition)
      .sort();

    expect(definitionsFor('stripe_checkout_requests')).toEqual(expected([
      `CHECK (((octet_length(request_id) >= 1) AND (octet_length(request_id) <= 255)))`,
      `CHECK ((request_sha256 ~ '^[0-9a-f]{64}$'::text))`,
      `CHECK ((state = ANY (ARRAY['creating'::text, 'attached'::text, 'manual_review'::text, 'resolved'::text])))`,
      `CHECK ((reconcile_attempts >= 0))`,
      `CHECK (((last_error IS NULL) OR (octet_length(last_error) <= 1000)))`,
      `CHECK (((state <> 'creating'::text) OR (request_json IS NOT NULL)))`,
      `CHECK (((state <> ALL (ARRAY['manual_review'::text, 'resolved'::text])) OR ((request_json IS NULL) AND (session_url IS NULL))))`,
    ]));
    expect(definitionsFor('stripe_webhook_events')).toEqual(expected([
      `CHECK (((octet_length(event_id) >= 1) AND (octet_length(event_id) <= 255)))`,
      `CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text))`,
      `CHECK (((octet_length(event_type) >= 1) AND (octet_length(event_type) <= 255)))`,
      `CHECK (((api_version IS NULL) OR ((octet_length(api_version) >= 1) AND (octet_length(api_version) <= 64))))`,
      `CHECK ((event_created >= 0))`,
      `CHECK ((livemode = ANY (ARRAY[0, 1])))`,
      `CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'ignored'::text, 'failed'::text, 'dismissed'::text])))`,
      `CHECK (((outcome IS NULL) OR (octet_length(outcome) <= 128)))`,
      `CHECK ((attempt_count >= 0))`,
      `CHECK ((retry_cycle_attempts >= 0))`,
      `CHECK (((last_error IS NULL) OR (octet_length(last_error) <= 1000)))`,
      `CHECK (((status = 'processing'::text) = ((lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL))))`,
    ]));
  });

  it('has exactly the approved private primary-key and unique constraints', async () => {
    const rows = await sql.unsafe(`
      SELECT rel.relname AS table_name, con.contype,
        (SELECT string_agg(att.attname, ',' ORDER BY key.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum) AS columns
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      WHERE namespace.nspname = 'church_private' AND con.contype IN ('p', 'u')
      ORDER BY rel.relname, con.contype, columns
    `);
    expect(rows).toEqual([
      { table_name: 'stripe_checkout_requests', contype: 'p', columns: 'request_id' },
      { table_name: 'stripe_checkout_requests', contype: 'u', columns: 'registration_id' },
      { table_name: 'stripe_webhook_events', contype: 'p', columns: 'event_id' },
    ]);
  });

  it('has exactly the approved named non-constraint indexes', async () => {
    const rows = await sql.unsafe<{
      table_name: string;
      index_name: string;
      definition: string;
      columns: unknown;
    }[]>(`
      SELECT tbl.relname AS table_name, idx.relname AS index_name,
        pg_get_indexdef(indexes.indexrelid) AS definition,
        ARRAY(
          SELECT pg_get_indexdef(indexes.indexrelid, position, true)
          FROM generate_series(1, indexes.indnkeyatts) position
          ORDER BY position
        ) AS columns
      FROM pg_index indexes
      JOIN pg_class idx ON idx.oid = indexes.indexrelid
      JOIN pg_class tbl ON tbl.oid = indexes.indrelid
      JOIN pg_namespace namespace ON namespace.oid = tbl.relnamespace
      WHERE namespace.nspname = 'church_private'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = indexes.indexrelid)
      ORDER BY idx.relname
    `);
    const indexes = rows.map((row) => ({ ...row, columns: pgIdentifierArray(row.columns) }));
    expect(indexes).toEqual([
      expect.objectContaining({
        table_name: 'stripe_checkout_requests',
        index_name: 'stripe_checkout_requests_due_idx',
        columns: ['state', 'next_reconcile_at'],
      }),
      expect.objectContaining({
        table_name: 'stripe_checkout_requests',
        index_name: 'stripe_checkout_requests_registration_idx',
        columns: ['registration_id'],
      }),
      expect.objectContaining({
        table_name: 'stripe_webhook_events',
        index_name: 'stripe_webhook_events_due_idx',
        columns: ['status', 'next_attempt_at'],
      }),
      expect.objectContaining({
        table_name: 'stripe_webhook_events',
        index_name: 'stripe_webhook_events_lease_idx',
        columns: ['lease_expires_at'],
      }),
      expect.objectContaining({
        table_name: 'stripe_webhook_events',
        index_name: 'stripe_webhook_events_received_idx',
        columns: ['received_at', 'event_id'],
      }),
    ]);
    expect(indexes.find((row) => row.index_name === 'stripe_webhook_events_received_idx')?.definition)
      .toMatch(/\(received_at DESC, event_id DESC\)$/i);
  });

  it('has the approved public foreign keys and delete actions', async () => {
    const rows = await sql.unsafe(`
      SELECT rel.relname AS table_name,
        (SELECT string_agg(att.attname, ',' ORDER BY key.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum) AS columns,
        foreign_namespace.nspname AS foreign_schema,
        foreign_rel.relname AS foreign_table,
        (SELECT string_agg(att.attname, ',' ORDER BY key.ord)
         FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = key.attnum) AS foreign_columns,
        con.confdeltype AS delete_action
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      JOIN pg_class foreign_rel ON foreign_rel.oid = con.confrelid
      JOIN pg_namespace foreign_namespace ON foreign_namespace.oid = foreign_rel.relnamespace
      WHERE namespace.nspname = 'church_private' AND con.contype = 'f'
      ORDER BY rel.relname, columns
    `);
    expect(rows).toEqual([
      expect.objectContaining({ table_name: 'stripe_checkout_requests', columns: 'last_action_by', foreign_schema: 'public', foreign_table: 'people', foreign_columns: 'id', delete_action: 'n' }),
      expect.objectContaining({ table_name: 'stripe_checkout_requests', columns: 'registration_id', foreign_schema: 'public', foreign_table: 'registrations', foreign_columns: 'id', delete_action: 'c' }),
      expect.objectContaining({ table_name: 'stripe_webhook_events', columns: 'last_action_by', foreign_schema: 'public', foreign_table: 'people', foreign_columns: 'id', delete_action: 'n' }),
    ]);
  });

  it('denies PUBLIC and Supabase API roles while retaining owner read/write access', async () => {
    expect(await sql.unsafe(`SELECT has_schema_privilege('public', 'church_private', 'USAGE') AS ok`))
      .toEqual([expect.objectContaining({ ok: false })]);
    for (const table of ['stripe_checkout_requests', 'stripe_webhook_events']) {
      expect(await sql.unsafe(`SELECT has_table_privilege('public', 'church_private.${table}', 'SELECT') AS ok`))
        .toEqual([expect.objectContaining({ ok: false })]);
      expect(await sql.unsafe(`
        SELECT has_table_privilege(current_user, 'church_private.${table}', 'SELECT,INSERT,UPDATE,DELETE') AS ok
      `)).toEqual([expect.objectContaining({ ok: true })]);
    }
    expect(await sql.unsafe(`SELECT has_schema_privilege(current_user, 'church_private', 'USAGE,CREATE') AS ok`))
      .toEqual([expect.objectContaining({ ok: true })]);

    const roles = await sql.unsafe(`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname
    `);
    // These roles are cluster-global and optional on portable local Postgres.
    // Creating them here would require CREATEROLE; assert their revokes whenever
    // the target already provides them instead of mutating cluster role state.
    for (const { rolname } of roles) {
      expect(await sql.unsafe(`SELECT has_schema_privilege($1, 'church_private', 'USAGE') AS ok`, [rolname]))
        .toEqual([expect.objectContaining({ ok: false })]);
      for (const table of ['stripe_checkout_requests', 'stripe_webhook_events']) {
        expect(await sql.unsafe(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [rolname, `church_private.${table}`]))
          .toEqual([expect.objectContaining({ ok: false })]);
      }
    }
  });
});
