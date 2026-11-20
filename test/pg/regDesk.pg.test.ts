// The check-in desk's request logic on Postgres: the cases of test/regDesk.d1.test.ts. Self-skips without
// DATABASE_URL.
import { afterAll, beforeAll, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { defineRegDeskCases } from '../shared/regDeskCases';

describe.skipIf(!hasPg)('check-in desk (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  defineRegDeskCases('Postgres', () => db);
});
