import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { beginContactChange, beginSignup, beginStepUp, recentStepUpContext } from '../../src/lib/identityAccount';
import { consumeEmailOtpChallenge, identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, post } from './helpers';

const identityEnv = env as unknown as { IDENTITY_VERIFICATION_SECRET: string; SESSION_SECRET: string };
let sequence = 970_000;

async function sessionFor(personId: number): Promise<string> {
  const epoch = await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(personId).first<number>('session_epoch');
  return `${SESSION_COOKIE}=${await mintSession(identityEnv.SESSION_SECRET, { id: personId, sessionEpoch: epoch! }, { authMethod: 'magic_link' })}`;
}

async function verifiedOwner(): Promise<{ personId: number; email: string }> {
  const id = ++sequence; const contactId = ++sequence; const email = `security-e2e-${id}@example.test`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people(id,display_name,email,role,active,identity_state) VALUES(?1,'Security E2E',?2,'member',1,'active')").bind(id, email),
    env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)").bind(contactId, email),
    env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled) VALUES(?1,?2,'email','e2e',1,1)").bind(id, contactId),
    env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(contactId, id),
  ]);
  return { personId: id, email };
}

describe('member Security Center built-worker boundary', () => {
  it('requires an owner-bound one-time OTP step-up and permits only a safe next path', async () => {
    const owner = await verifiedOwner(); const cookie = await sessionFor(owner.personId);
    const begun = await beginStepUp(env.DB, identityEnv, { campusId: 1, personId: owner.personId,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.201' }), `security-${owner.personId}`), source: 'web' });
    const base = '/en/reauth?next=%2Fen%2Fsettings%2Fsecurity';
    const wrong = await post(base, new URLSearchParams({ _action: 'complete', public_id: begun.delivery.publicId, code: begun.delivery.code === '000000' ? '111111' : '000000' }).toString(), { cookie });
    expect(wrong.status).toBe(200);
    expect(wrong.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
    const completed = await post(base, new URLSearchParams({ _action: 'complete', public_id: begun.delivery.publicId, code: begun.delivery.code }).toString(), { cookie });
    expect(completed.status).toBe(303);
    expect(completed.headers.get('location')).toBe('/en/settings/security');
    expect(completed.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
    const replay = await post(base, new URLSearchParams({ _action: 'complete', public_id: begun.delivery.publicId, code: begun.delivery.code }).toString(), { cookie });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
    const unsafe = await get('/en/reauth?next=https%3A%2F%2Fevil.example', { cookie });
    expect(unsafe.status).toBe(200);
    expect(await unsafe.text()).toContain('Verify your identity');
  });

  it('completes a clean contact change, revokes the session epoch, clears the cookie, and alerts the old owner', async () => {
    const owner = await verifiedOwner(); const now = Math.floor(Date.now() / 1000);
    const epoch = await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(owner.personId).first<number>('session_epoch');
    const cookie = `${SESSION_COOKIE}=${await mintSession(identityEnv.SESSION_SECRET, { id: owner.personId, sessionEpoch: epoch! }, { authMethod: 'email_otp', authTime: now, stepUpTime: now })}`;
    const proof = recentStepUpContext(owner.personId, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp', authTime: now, stepUpTime: now }, now);
    const begun = await beginContactChange(env.DB, identityEnv, { campusId: 1, personId: owner.personId, newEmail: `new-security-${owner.personId}@example.test`, recentStepUp: proof,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.202' }), `change-${owner.personId}`), source: 'web' });
    const response = await post('/en/settings/security', new URLSearchParams({ _action: 'completeChange', operation_id: begun.public.operationId, public_id: begun.delivery.publicId, code: begun.delivery.code }).toString(), { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/en/signin?changed=1');
    expect(response.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
    expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
    expect(await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(owner.personId).first<number>('session_epoch')).toBe((epoch ?? 0) + 1);
    expect(await env.DB.prepare('SELECT kind,detail FROM email_log ORDER BY id DESC LIMIT 1').first<{ kind: string; detail: string | null }>())
      .toEqual({ kind: 'identityOldContactNotice', detail: null });
  });

  it('requires step-up to sign out every device and supersedes outstanding identity challenges', async () => {
    const owner = await verifiedOwner(); const now = Math.floor(Date.now() / 1000);
    const epoch = await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(owner.personId).first<number>('session_epoch');
    const cookie = `${SESSION_COOKIE}=${await mintSession(identityEnv.SESSION_SECRET, { id: owner.personId, sessionEpoch: epoch! }, { authMethod: 'email_otp', authTime: now, stepUpTime: now })}`;
    const outstanding = await beginStepUp(env.DB, identityEnv, { campusId: 1, personId: owner.personId,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.203' }), `signout-${owner.personId}`), source: 'web' });
    const response = await post('/en/settings/security', '_action=signoutAll', { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/en/signin?signed_out=1');
    expect(response.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
    expect(await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(owner.personId).first<number>('session_epoch')).toBe((epoch ?? 0) + 1);
    expect(await env.DB.prepare('SELECT superseded_at FROM identity_challenges WHERE public_id=?1').bind(outstanding.delivery.publicId).first<string>('superseded_at')).not.toBeNull();
  });

  it('cannot replay a consumed-but-unclaimed owner signup into a session after global sign-out', async () => {
    const owner = await verifiedOwner(); const now = Math.floor(Date.now() / 1000);
    const epoch = await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(owner.personId).first<number>('session_epoch');
    const cookie = `${SESSION_COOKIE}=${await mintSession(identityEnv.SESSION_SECRET, { id: owner.personId, sessionEpoch: epoch! }, { authMethod: 'email_otp', authTime: now, stepUpTime: now })}`;
    const signup = await beginSignup(env.DB, identityEnv, { campusId: 1, email: owner.email, displayName: 'Ignored',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.204' }), `unclaimed-${owner.personId}`), source: 'web' });
    expect((await consumeEmailOtpChallenge(env.DB, identityEnv, { campusId: 1, publicId: signup.delivery.publicId, purpose: 'signup', code: signup.delivery.code })).ok).toBe(true);
    expect((await post('/en/settings/security', '_action=signoutAll', { cookie })).status).toBe(303);
    const replay = await post('/en/signup', new URLSearchParams({ action: 'verify', operation_id: signup.public.operationId, public_id: signup.delivery.publicId, code: signup.delivery.code }).toString());
    expect(replay.status).toBe(200);
    expect(replay.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });
});
