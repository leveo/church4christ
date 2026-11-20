// Registration mail on Postgres: the same cases as test/regNotify.d1.test.ts. Self-skips
// without DATABASE_URL. `cloudflare:email` cannot load in plain Node, so src/lib/email is
// replaced by the capturing stand-in.
import { afterAll, beforeAll, describe, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/lib/email', async () => (await import('../shared/regMail')).mockEmailModule());

import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { defineRegNotifyCases } from '../shared/regNotifyCases';

describe.skipIf(!hasPg)('registration mail (Postgres)', () => {
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

  defineRegNotifyCases('Postgres', () => db, 'supabase');
});
