import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { beginRecovery, beginSignin, beginSignup, completeRecoveryRequest } from '../../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { approveIdentityRecovery } from '../../src/lib/identityRecovery';
import type { IdentityRecoveryKeyEnv } from '../../src/lib/identityRecoveryKey';
import { mintSession, verifySession, SESSION_COOKIE } from '../../src/lib/session';
import { cookiePair, get, post } from './helpers';

const IDENTITY_ENV = env as unknown as { IDENTITY_VERIFICATION_SECRET?: string } & IdentityRecoveryKeyEnv;
const SESSION_SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function seedVerifiedOwner(personId: number, email: string, id: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)
    ON CONFLICT(kind,normalized_value) DO NOTHING`).bind(id, email).run();
  const contactPointId = await env.DB.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?1")
    .bind(email).first<number>('id');
  if (!contactPointId) throw new Error('seed contact point unavailable');
  await env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary)
    SELECT ?1,?2,'email','e2e',1 WHERE NOT EXISTS (
      SELECT 1 FROM person_contact_links WHERE person_id=?1 AND contact_point_id=?2 AND ended_at IS NULL
    )`).bind(personId, contactPointId).run();
  await env.DB.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
    SELECT ?1,?2,'admin_review' WHERE NOT EXISTS (
      SELECT 1 FROM verified_contact_owners WHERE contact_point_id=?1
    )`).bind(contactPointId, personId).run();
  const owner = await env.DB.prepare('SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1')
    .bind(contactPointId).first<number>('person_id');
  if (owner !== personId) throw new Error('seed contact point belongs to a different person');
}

describe('verified signup route', () => {
  it('idempotently reuses a migration-backfilled verified contact owner', async () => {
    await seedVerifiedOwner(6, 'faithful.wang@example.com', 98050);
    await seedVerifiedOwner(6, 'faithful.wang@example.com', 98050);
    expect(await env.DB.prepare(`SELECT count(*) n FROM contact_points
      WHERE kind='email' AND normalized_value='faithful.wang@example.com'`).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM verified_contact_owners o JOIN contact_points cp ON cp.id=o.contact_point_id
      WHERE cp.kind='email' AND cp.normalized_value='faithful.wang@example.com' AND o.person_id=6`).first<number>('n')).toBe(1);
  });

  it('does not create a person before the emailed OTP is verified', async () => {
    const email = 'route-preperson@example.test';
    const response = await post('/en/signup', `action=begin&first_name=Route&last_name=Signup&email=${encodeURIComponent(email)}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="operation_id"');
    expect(html).toContain('name="public_id"');
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(0);
  });

  it('completes a clean signup, creates one profile, and mints an email_otp session', async () => {
    const email = 'route-complete@example.test';
    const begun = await beginSignup(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email,
      displayName: 'Route Complete',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.211' }), 'e2e-signup-device'),
    });
    const response = await post('/en/signup', new URLSearchParams({
      action: 'verify',
      operation_id: begun.public.operationId,
      public_id: begun.delivery.publicId,
      code: begun.delivery.code,
    }).toString());
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    const token = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
    expect((await verifySession(SESSION_SECRET, token))?.assurance.authMethod).toBe('email_otp');
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(1);

    const replay = await post('/en/signup', new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code,
    }).toString());
    expect(replay.status).toBe(200);
    expect(replay.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
    expect(await replay.text()).toContain('invalid, expired, or already used');
  });

  it('allows only one concurrent signup completion to deliver a session', async () => {
    const begun = await beginSignup(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email: 'route-concurrent-delivery@example.test',
      displayName: 'Concurrent Delivery',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.217' }), 'e2e-concurrent-delivery'),
    });
    const body = new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code,
    }).toString();
    const responses = await Promise.all([post('/en/signup', body), post('/en/signup', body)]);
    expect(responses.filter((response) => response.status === 303)).toHaveLength(1);
    expect(responses.filter((response) => (response.headers.get('set-cookie') ?? '').includes(`${SESSION_COOKIE}=`))).toHaveLength(1);
  });

  it('authenticates an existing verified owner without creating or renaming a profile', async () => {
    const email = 'faithful.wang@example.com';
    await seedVerifiedOwner(6, email, 98050);
    const begun = await beginSignup(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email,
      displayName: 'Attacker Supplied Name',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.215' }), 'e2e-owner-signup-device'),
    });
    const response = await post('/en/signup', new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code,
    }).toString());
    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT display_name FROM people WHERE id=6').first<string>('display_name')).toBe('Faithful Wang 王信实');
  });

  it('preserves the bound operation after a wrong code so the correct code can be retried', async () => {
    const email = 'route-retry@example.test';
    const begun = await beginSignup(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email,
      displayName: 'Route Retry',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.216' }), 'e2e-retry-device'),
    });
    const wrongCode = begun.delivery.code === '000000' ? '111111' : '000000';
    const wrong = await post('/en/signup', new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: wrongCode,
    }).toString());
    const html = await wrong.text();
    expect(html).toContain(begun.public.operationId);
    expect(html).toContain(begun.delivery.publicId);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(0);

    const retried = await post('/en/signup', new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code,
    }).toString());
    expect(retried.status).toBe(303);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(1);
  });

  it('renders a neutral review state without leaking case or person identifiers', async () => {
    const email = 'route-review@example.test';
    await env.DB.prepare("INSERT INTO people(id,display_name,email,role,active) VALUES(98001,'Prior Record',?1,'member',1)").bind(email).run();
    const begun = await beginSignup(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email,
      displayName: 'Different Person',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.212' }), 'e2e-review-device'),
    });
    const response = await post('/en/signup', new URLSearchParams({
      action: 'verify', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code,
    }).toString());
    const html = await response.text();
    const review = await env.DB.prepare('SELECT id FROM identity_account_review_cases WHERE operation_id=?1')
      .bind(begun.public.operationId).first<number>('id');
    expect(response.status).toBe(200);
    expect(html).toContain('review');
    expect(html).not.toContain(begun.public.operationId);
    expect(html).not.toContain(begun.delivery.publicId);
    expect(html).not.toContain(String(review));
  });
});

describe('verified-owner signin route', () => {
  it('keeps known and unknown public status, body, and headers identical', async () => {
    await seedVerifiedOwner(3, 'sarah.johnson@example.com', 98100);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const primed = await post('/en/signin', 'email=prime-device%40example.test');
    const signedDevice = cookiePair(primed.headers.get('set-cookie'));
    expect(signedDevice).toMatch(/^c4c_identity_device=v1\.[0-9a-f-]{36}\.[0-9a-f]{64}$/u);
    const known = await post('/en/signin', 'email=sarah.johnson%40example.com', { cookie: signedDevice });
    const unknown = await post('/en/signin', 'email=unknown-route%40example.test', { cookie: signedDevice });
    spy.mockRestore();
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(Object.fromEntries(known.headers)).toEqual(Object.fromEntries(unknown.headers));
    expect(await known.text()).toBe(await unknown.text());
  });

  it('rotates a forged device cookie instead of using the attacker-selected bucket', async () => {
    const attackerId = '11111111-1111-4111-8111-111111111111';
    const forged = `c4c_identity_device=v1.${attackerId}.${'0'.repeat(64)}`;
    const response = await post('/en/signin', 'email=forged-device%40example.test', { cookie: forged });
    const replacement = response.headers.get('set-cookie') ?? '';
    expect(replacement).toMatch(/c4c_identity_device=v1\.[0-9a-f-]{36}\.[0-9a-f]{64}/u);
    expect(replacement).not.toContain(attackerId);
    expect(replacement).toContain('HttpOnly');
    expect(replacement).toContain('Secure');
    expect(replacement).toContain('SameSite=Lax');
  });

  it('peeks a campus-bound modern link on GET and consumes it once on POST', async () => {
    await seedVerifiedOwner(4, 'grace.lin@example.com', 98200);
    const begun = await beginSignin(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email: 'grace.lin@example.com',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.213' }), 'e2e-signin-device'),
    });
    expect(begun.delivery).not.toBeNull();
    const delivery = begun.delivery!;
    const path = `/auth/${delivery.publicId}.${delivery.token}?campus=main`;

    const peek = await get(path);
    expect(peek.status).toBe(200);
    expect(peek.headers.get('cache-control')).toBe('no-store');
    expect(peek.headers.get('referrer-policy')).toBe('no-referrer');
    expect(peek.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await peek.text();
    expect(html).not.toContain(delivery.publicId);
    expect(html).not.toContain(delivery.token);
    expect(html).not.toContain(path);
    expect(await env.DB.prepare('SELECT consumed_at FROM identity_challenges WHERE public_id=?1')
      .bind(delivery.publicId).first<string>('consumed_at')).toBeNull();

    const consumed = await post(path, '');
    expect(consumed.status).toBe(303);
    expect(consumed.headers.get('cache-control')).toBe('no-store');
    expect(consumed.headers.get('referrer-policy')).toBe('no-referrer');
    expect(consumed.headers.get('x-content-type-options')).toBe('nosniff');
    expect(consumed.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
    const replay = await post(path, '');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });

  it('rejects a modern link when the required campus query is absent', async () => {
    await seedVerifiedOwner(5, 'mark.liu@example.com', 98300);
    const begun = await beginSignin(env.DB, IDENTITY_ENV, {
      campusId: 1,
      email: 'mark.liu@example.com',
      requestContext: identityTrustedRequestContext(new Headers(), 'e2e-campus-device'),
    });
    const delivery = begun.delivery!;
    const response = await post(`/auth/${delivery.publicId}.${delivery.token}`, '');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });
});

describe('high-risk recovery route', () => {
  it('keeps known and unknown claimed targets visibly neutral', async () => {
    const known = await post('/en/recover', 'action=begin&account_email=mark.liu%40example.com&reachable_email=known-reachable%40example.test',
      { 'CF-Connecting-IP': '203.0.113.221' });
    const unknown = await post('/en/recover', 'action=begin&account_email=no-such-person%40example.test&reachable_email=unknown-reachable%40example.test',
      { 'CF-Connecting-IP': '203.0.113.222' });
    const normalizeOpaque = (html: string) => html.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gu, 'OPAQUE-ID');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(normalizeOpaque(await known.text())).toBe(normalizeOpaque(await unknown.text()));
  });

  it('verifies the reachable mailbox once and makes a retried completion idempotent', async () => {
    const begun = await beginRecovery(env.DB, IDENTITY_ENV, {
      campusId: 1,
      accountEmail: 'mark.liu@example.com',
      reachableEmail: 'reachable-e2e-recovery@example.test',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.219' }), 'e2e-recovery-device'),
    });
    const wrongCode = begun.delivery.code === '000000' ? '111111' : '000000';
    const wrong = await post('/en/recover', new URLSearchParams({ action: 'verify', operation_id: begun.public.operationId,
      public_id: begun.delivery.publicId, code: wrongCode }).toString());
    expect(await wrong.text()).toContain('invalid, expired, or already used');
    const accepted = await post('/en/recover', new URLSearchParams({ action: 'verify', operation_id: begun.public.operationId,
      public_id: begun.delivery.publicId, code: begun.delivery.code }).toString());
    expect(await accepted.text()).toContain('Request received');
    expect(await env.DB.prepare('SELECT state FROM identity_account_operations WHERE operation_id=?1').bind(begun.public.operationId).first<string>('state')).toBe('review');
    const replay = await post('/en/recover', new URLSearchParams({ action: 'verify', operation_id: begun.public.operationId,
      public_id: begun.delivery.publicId, code: begun.delivery.code }).toString());
    expect(await replay.text()).toContain('Request received');
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_recovery_cases WHERE source_operation_id=?1')
      .bind(begun.public.operationId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_recovery_notification_outbox
      WHERE case_id=(SELECT result_case_id FROM identity_account_operations WHERE operation_id=?1)
        AND category='request_old_contact' AND state='sent'`).bind(begun.public.operationId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM email_log WHERE kind='identityRecoveryRequested' AND to_email='mark.liu@example.com'")
      .first<number>('n')).toBe(1);
  });

  it('executes the second approval through the admin route with a different fresh super admin', async () => {
    const targetId = 98501; const firstAdminId = 98502; const secondAdminId = 98503;
    const targetEmail = 'admin-route-recovery-target@example.test';
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,active) VALUES(?1,'Admin Route Target',?2,'member',1)").bind(targetId, targetEmail),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin,active) VALUES(?1,'First Route Admin','first-route-admin@example.test','admin',1,1)").bind(firstAdminId),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin,active) VALUES(?1,'Second Route Admin','second-route-admin@example.test','admin',1,1)").bind(secondAdminId),
    ]);
    await seedVerifiedOwner(targetId, targetEmail, 98510);
    const now = Date.now();
    const format = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
    const begunAt = format(now - 24 * 60 * 60_000 - 4 * 60_000);
    const completedAt = format(now - 24 * 60 * 60_000 - 3 * 60_000);
    const approvedAt = format(now - 24 * 60 * 60_000 - 2 * 60_000);
    const begun = await beginRecovery(env.DB, IDENTITY_ENV, { campusId: 1, accountEmail: targetEmail,
      reachableEmail: 'admin-route-reachable@example.test', requestContext: identityTrustedRequestContext(new Headers(), 'admin-route-recovery'), now: begunAt });
    const completed = await completeRecoveryRequest(env.DB, IDENTITY_ENV, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: completedAt });
    if (completed.status !== 'review') throw new Error('recovery case not created');
    const firstEpoch = Math.floor(Date.parse(`${approvedAt.replace(' ', 'T')}Z`) / 1000);
    expect((await approveIdentityRecovery(env.DB, IDENTITY_ENV, { campusId: 1, caseId: completed.recoveryCaseId,
      actorPersonId: firstAdminId, assurance: { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp', authTime: firstEpoch, stepUpTime: firstEpoch },
      now: approvedAt })).status).toBe('holding');
    const session = await mintSession(SESSION_SECRET, { id: secondAdminId, sessionEpoch: 0 }, { authMethod: 'email_otp' });
    const missingConfirmation = await post(`/admin/people/identity/recovery/${completed.recoveryCaseId}`, '', { cookie: `${SESSION_COOKIE}=${session}` });
    expect(missingConfirmation.status).toBe(200);
    expect(await env.DB.prepare('SELECT state FROM identity_recovery_cases WHERE id=?1').bind(completed.recoveryCaseId).first<string>('state')).toBe('open');
    const response = await post(`/admin/people/identity/recovery/${completed.recoveryCaseId}`, 'confirm_review=confirmed', { cookie: `${SESSION_COOKIE}=${session}` });
    expect(response.status).toBe(200);
    const completedHtml = await response.text();
    expect(completedHtml).toContain('Recovery completed');
    expect(completedHtml).toContain('Admin Route Target');
    expect(completedHtml).toContain('Verified contact categories');
    expect(await env.DB.prepare('SELECT state FROM identity_recovery_cases WHERE id=?1').bind(completed.recoveryCaseId).first<string>('state')).toBe('approved');
    expect(await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(targetId).first<number>('session_epoch')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_recovery_notification_outbox
      WHERE case_id=?1 AND category='completed_old_contact' AND state='sent'`).bind(completed.recoveryCaseId).first<number>('n')).toBe(1);
    const sentBeforeReplay = await env.DB.prepare("SELECT count(*) n FROM email_log WHERE kind='identityRecoveryCompleted'").first<number>('n');
    await post(`/admin/people/identity/recovery/${completed.recoveryCaseId}`, 'confirm_review=confirmed', { cookie: `${SESSION_COOKIE}=${session}` });
    expect(await env.DB.prepare("SELECT count(*) n FROM email_log WHERE kind='identityRecoveryCompleted'").first<number>('n')).toBe(sentBeforeReplay);
  });

  it('keeps veto GET mutation-free and requires an explicit replay-safe POST', async () => {
    const targetId = 98601; const firstAdminId = 98602;
    const targetEmail = 'veto-route-recovery-target@example.test';
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,active) VALUES(?1,'Veto Route Target',?2,'member',1)").bind(targetId, targetEmail),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin,active) VALUES(?1,'Veto Route Admin','veto-route-admin@example.test','admin',1,1)").bind(firstAdminId),
    ]);
    await seedVerifiedOwner(targetId, targetEmail, 98610);
    const now = new Date();
    const format = (value: Date) => value.toISOString().slice(0, 19).replace('T', ' ');
    const begun = await beginRecovery(env.DB, IDENTITY_ENV, { campusId: 1, accountEmail: targetEmail,
      reachableEmail: 'veto-route-reachable@example.test', requestContext: identityTrustedRequestContext(
        new Headers({ 'CF-Connecting-IP': '203.0.113.229' }), 'veto-route-recovery'), now: format(now) });
    const completed = await completeRecoveryRequest(env.DB, IDENTITY_ENV, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: format(new Date(now.getTime() + 60_000)) });
    if (completed.status !== 'review') throw new Error('recovery case not created');
    const approvedAt = new Date(now.getTime() + 2 * 60_000);
    const approvedEpoch = Math.floor(approvedAt.getTime() / 1000);
    const first = await approveIdentityRecovery(env.DB, IDENTITY_ENV, { campusId: 1, caseId: completed.recoveryCaseId,
      actorPersonId: firstAdminId, assurance: { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp', authTime: approvedEpoch, stepUpTime: approvedEpoch },
      now: format(approvedAt) });
    if (first.status !== 'holding') throw new Error('hold not created');
    const path = `/en/recovery-veto/${first.vetoToken}`;

    const peek = await get(path);
    expect(peek.status).toBe(200);
    expect(peek.headers.get('cache-control')).toBe('no-store');
    expect(peek.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await peek.text()).not.toContain(first.vetoToken);
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'")
      .bind(completed.recoveryCaseId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT state FROM identity_recovery_cases WHERE id=?1')
      .bind(completed.recoveryCaseId).first<string>('state')).toBe('open');

    const vetoed = await post(path, '');
    expect(vetoed.status).toBe(200);
    expect(await vetoed.text()).toContain('The recovery request is blocked.');
    const replay = await post(path, '');
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('The recovery request is blocked.');
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'")
      .bind(completed.recoveryCaseId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT state FROM identity_recovery_cases WHERE id=?1')
      .bind(completed.recoveryCaseId).first<string>('state')).toBe('rejected');
  });
});
