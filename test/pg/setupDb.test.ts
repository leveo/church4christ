import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { MODULE_KEYS } from '../../src/lib/modules';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { bootstrapFirstAdmin, initializeModuleSettings } from '../../src/lib/setupDb.mjs';
import { beginSignin, completeSigninLink } from '../../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { setupIdentityContracts } from '../helpers/setupIdentityContracts';

// Recovery delivery uses the Worker-only email binding; sign-in below exercises
// the real identity functions and never calls this unrelated notification path.
vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: () => { throw new Error('unexpected recovery notification'); },
}));

describe.skipIf(!hasPg)('setup database operations on Postgres', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe("DELETE FROM settings WHERE key LIKE 'module.%'");
  });

  afterAll(async () => {
    await sql?.end();
  });

  setupIdentityContracts(() => db);

  it('writes every module setting explicitly in one portable statement', async () => {
    await initializeModuleSettings(db, MODULE_KEYS, ['sermons', 'people']);
    const rows = await sql.unsafe("SELECT key, value FROM settings WHERE key LIKE 'module.%' ORDER BY key");
    expect(rows).toHaveLength(MODULE_KEYS.length);
    expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toMatchObject({
      'module.sermons': '1',
      'module.people': '1',
      'module.portal': '0',
    });
  });

  it('creates and reruns the same administrator idempotently', async () => {
    const input = { email: ' Admin@Setup.Test ', displayName: '  Setup Admin  ', locale: 'zh' as const };
    expect(await bootstrapFirstAdmin(db, input)).toEqual({ status: 'created', email: 'admin@setup.test' });
    expect(await bootstrapFirstAdmin(db, input)).toEqual({ status: 'already-admin', email: 'admin@setup.test' });
    const [row] = await sql.unsafe("SELECT display_name, lang FROM people WHERE email='admin@setup.test'");
    expect(row).toMatchObject({ display_name: 'Setup Admin', lang: 'zh' });
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'setup-pg-signin-regression-secret-at-least-thirty-two-characters' };
    const begun = await beginSignin(db, authEnv, {
      campusId: 1, email: 'admin@setup.test', now: '2035-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.44' }), 'setup-no-demo-pg'),
    });
    expect(begun.delivery).not.toBeNull();
    const result = await completeSigninLink(db, authEnv, {
      campusId: 1, publicId: begun.delivery!.publicId, token: begun.delivery!.token, now: '2035-01-01 00:01:00',
    });
    expect(result).toMatchObject({ status: 'authenticated', sessionEpoch: 0 });
    expect(await sql.unsafe('SELECT email FROM people WHERE id=$1', [(result as { personId: number }).personId]))
      .toMatchObject([{ email: 'admin@setup.test' }]);
  });

  it('requires explicit promotion and refuses inactive or deleted people', async () => {
    await sql.unsafe(
      "INSERT INTO people (display_name,email,role,active) VALUES ('Member','member@setup.test','member',1),('Inactive','inactive@setup.test','member',0),('Deleted','deleted@setup.test','member',1)",
    );
    await sql.unsafe("UPDATE people SET deleted_at=datetime('now') WHERE email='deleted@setup.test'");

    await expect(bootstrapFirstAdmin(db, { email: 'member@setup.test', displayName: 'Member', locale: 'en' }))
      .resolves.toEqual({ status: 'promotion-required', email: 'member@setup.test' });
    await expect(bootstrapFirstAdmin(db, { email: 'member@setup.test', displayName: 'Member', locale: 'en', promoteExisting: true }))
      .resolves.toEqual({ status: 'promoted', email: 'member@setup.test' });
    await expect(bootstrapFirstAdmin(db, { email: 'inactive@setup.test', displayName: 'Inactive', locale: 'en' }))
      .resolves.toEqual({ status: 'inactive', email: 'inactive@setup.test' });
    await expect(bootstrapFirstAdmin(db, { email: 'deleted@setup.test', displayName: 'Deleted', locale: 'en' }))
      .resolves.toEqual({ status: 'reactivation-required', email: 'deleted@setup.test' });
  });

  it('rejects invalid email and locale before querying', async () => {
    const before = await sql.unsafe("SELECT count(*)::int AS count FROM people WHERE email LIKE '%@setup.test'");
    await expect(bootstrapFirstAdmin(db, { email: 'bad', displayName: 'Admin', locale: 'en' }))
      .rejects.toThrow(/email/i);
    await expect(bootstrapFirstAdmin(db, { email: 'a@setup.test', displayName: 'Admin', locale: 'fr' as never }))
      .rejects.toThrow(/locale/i);
    expect(await sql.unsafe("SELECT count(*)::int AS count FROM people WHERE email LIKE '%@setup.test'"))
      .toEqual(before);
  });
});
