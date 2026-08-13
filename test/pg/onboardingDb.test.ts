import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acknowledgeOnboardingCheck, listOnboardingReadiness } from '../../src/lib/onboardingDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('onboarding acknowledgements (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = new PgAdapter(sql);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    await sql.unsafe("INSERT INTO people (id,display_name,email,role,super_admin) VALUES (9901,'Release admin','release@example.test','admin',1)");
  });
  afterAll(async () => { await sql?.end(); });

  it('matches D1 version and restore-expiry behavior', async () => {
    await acknowledgeOnboardingCheck(db, { checkId: 'restore-drill', actorPersonId: 9901, now: '2026-01-01 00:00:00' });
    const rows = await listOnboardingReadiness(db, new Set(['people', 'newcomers', 'attendance', 'children']), '2026-04-02 00:00:01');
    expect(rows.find((row) => row.checkId === 'restore-drill')).toMatchObject({ status: 'manual', acknowledged: false });
    expect((await sql`SELECT definition_version FROM onboarding_acknowledgements WHERE check_id='restore-drill'`)[0]).toEqual({ definition_version: 1 });
  });
});
