import { env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import seedSql from '../seed/dev-seed.sql?raw';
import { bootstrapFirstAdmin, isBootstrapAdminReady } from '../src/lib/setupDb.mjs';
import { beginSignin, completeSigninLink } from '../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';

beforeAll(async () => {
  const statements = seedSql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
    .split(';').map((statement) => statement.trim()).filter(Boolean);
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
});

it('keeps seeded identities and permits the custom setup administrator to sign in with demo content', async () => {
  const email = 'custom-demo-admin@setup.test';
  const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
  const seededOwners = await env.DB.prepare('SELECT count(*) n FROM verified_contact_owners').first<number>('n');
  await bootstrapFirstAdmin(env.DB, { email, displayName: 'Custom demo owner', locale: 'en' });
  expect(await isBootstrapAdminReady(env.DB, email)).toBe(true);
  expect(await isBootstrapAdminReady(env.DB, 'admin@example.com')).toBe(true);
  expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before! + 1);
  expect(await env.DB.prepare('SELECT count(*) n FROM verified_contact_owners').first<number>('n')).toBe(seededOwners! + 1);
  expect(await env.DB.prepare("SELECT value FROM settings WHERE key='site.demo_content'").first<string>('value')).toBe('true');
  const authEnv = { IDENTITY_VERIFICATION_SECRET: 'setup-demo-signin-secret-at-least-thirty-two-characters' };
  const begun = await beginSignin(env.DB, authEnv, { campusId: 1, email, now: '2035-01-01 00:00:00',
    requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.45' }), 'setup-demo') });
  expect(begun.delivery?.to).toBe(email);
  const personId = await env.DB.prepare('SELECT id FROM people WHERE email=?').bind(email).first<number>('id');
  await expect(completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: begun.delivery!.publicId,
    token: begun.delivery!.token, now: '2035-01-01 00:01:00' })).resolves.toEqual({ status: 'authenticated', personId, sessionEpoch: 0 });
});
