import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  if (/^datetime\s*\(\s*'now'::text(?:\s*,[\s\S]*)?\)$/i.test(value.trim())) return 'utc-now';
  const text = value.trim().match(/^'((?:[^']|'')*)'::text$/i);
  return text ? text[1].replaceAll("''", "'") : value.trim().replace(/^\((.*)\)$/s, '$1');
}

function quotedValues(value: string): string[] {
  return [...value.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
}

function pgIdentifierArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1);
    return body ? body.split(',').map((item) => item.replace(/^"|"$/g, '')) : [];
  }
  throw new Error(`unexpected Postgres identifier array: ${JSON.stringify(value)}`);
}

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

  it('enforces the exact status/state sets and coherent processing/sensitive states', async () => {
    const rows = await sql.unsafe(`
      SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      WHERE namespace.nspname = 'church_private' AND con.contype = 'c'
      ORDER BY rel.relname, con.oid
    `);
    const webhookChecks = rows.filter((row) => row.table_name === 'stripe_webhook_events');
    const checkoutChecks = rows.filter((row) => row.table_name === 'stripe_checkout_requests');
    expect(webhookChecks).toHaveLength(12);
    expect(checkoutChecks).toHaveLength(7);

    const status = webhookChecks.find((row) => /status\s*=\s*ANY/i.test(row.definition));
    const state = checkoutChecks.find((row) => /state\s*=\s*ANY/i.test(row.definition));
    expect(status).toBeDefined();
    expect(state).toBeDefined();
    expect(quotedValues(status!.definition)).toEqual([
      'pending', 'processing', 'processed', 'ignored', 'failed', 'dismissed',
    ]);
    expect(quotedValues(state!.definition)).toEqual([
      'creating', 'attached', 'manual_review', 'resolved',
    ]);
    expect(webhookChecks.some((row) =>
      /status\s*=\s*'processing'::text/i.test(row.definition) &&
      /lease_token IS NOT NULL/i.test(row.definition) &&
      /lease_expires_at IS NOT NULL/i.test(row.definition),
    )).toBe(true);
    expect(checkoutChecks.some((row) =>
      /state\s*<>\s*'creating'::text/i.test(row.definition) && /request_json IS NOT NULL/i.test(row.definition),
    )).toBe(true);
    expect(checkoutChecks.some((row) =>
      /manual_review/i.test(row.definition) && /resolved/i.test(row.definition) &&
      /request_json IS NULL/i.test(row.definition) && /session_url IS NULL/i.test(row.definition),
    )).toBe(true);
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
