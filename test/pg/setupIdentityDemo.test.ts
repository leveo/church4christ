import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openPostgresSetupDb } from '../../scripts/setup/providers/postgres.mjs';
import { bootstrapFirstAdmin, isBootstrapAdminReady } from '../../src/lib/setupDb.mjs';
import { beginSignin, completeSigninLink } from '../../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: () => { throw new Error('unexpected recovery notification'); },
}));

describe.skipIf(!hasPg)('demo administrator identity on the PostgreSQL setup adapter', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let connection: ReturnType<typeof openPostgresSetupDb>;
  beforeAll(async () => {
    await resetSchema(sql);
    for (const script of ['scripts/db/migrate-supabase.mjs', 'scripts/db/seed-supabase.mjs']) {
      execFileSync(process.execPath, [script], { env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8' });
    }
    connection = openPostgresSetupDb(DATABASE_URL);
  });
  afterAll(async () => { await connection?.close(); await sql?.end(); });

  it('allows a custom admin to complete real sign-in after the full demo seed', async () => {
    const db = connection.db;
    const email = 'custom-demo-admin@setup.test';
    const before = await db.prepare('SELECT count(*) n FROM people').first('n');
    const seededOwners = await db.prepare('SELECT count(*) n FROM verified_contact_owners').first('n');
    await bootstrapFirstAdmin(db, { email, displayName: 'Custom demo owner', locale: 'en' });
    expect(await isBootstrapAdminReady(db, email)).toBe(true);
    expect(await isBootstrapAdminReady(db, 'admin@example.com')).toBe(true);
    expect(await db.prepare('SELECT count(*) n FROM people').first('n')).toBe(before + 1);
    expect(await db.prepare('SELECT count(*) n FROM verified_contact_owners').first('n')).toBe(seededOwners + 1);
    expect(await db.prepare("SELECT value FROM settings WHERE key='site.demo_content'").first('value')).toBe('true');
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'setup-demo-pg-signin-secret-at-least-thirty-two-characters' };
    const begun = await beginSignin(db, authEnv, { campusId: 1, email, now: '2035-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.46' }), 'setup-demo-pg') });
    expect(begun.delivery?.to).toBe(email);
    const personId = await db.prepare('SELECT id FROM people WHERE email=?').bind(email).first('id');
    await expect(completeSigninLink(db, authEnv, { campusId: 1, publicId: begun.delivery!.publicId,
      token: begun.delivery!.token, now: '2035-01-01 00:01:00' })).resolves.toEqual({ status: 'authenticated', personId, sessionEpoch: 0 });
  });
});
