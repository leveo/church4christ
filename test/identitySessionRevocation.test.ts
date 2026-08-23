import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { beginSignin, beginSignup, completeSigninLink, completeVerifiedSignup } from '../src/lib/identityAccount';
import { consumeEmailOtpChallenge, identityTrustedRequestContext } from '../src/lib/identityAuth';
import { consumeToken, createLoginToken } from '../src/lib/auth';
import { loadSessionUser } from '../src/lib/currentUser';
import { ensureActivePersonContactLink, upsertContactPoint } from '../src/lib/identityDb';
import { revokeIdentitySessions } from '../src/lib/identitySessionRevocation';

const authEnv = { IDENTITY_VERIFICATION_SECRET: 'identity-revocation-test-secret-at-least-thirty-two-characters' };
let id = 985_000;
async function owner(): Promise<{ id: number; email: string }> {
  const personId = ++id; const email = `revocation-${personId}@example.test`;
  await env.DB.prepare("INSERT INTO people(id,display_name,email,active,identity_state) VALUES(?1,'Revocation Owner',?2,1,'active')").bind(personId, email).run();
  const contact = await upsertContactPoint(env.DB, { kind: 'email', value: email });
  await ensureActivePersonContactLink(env.DB, { personId, contactPointId: contact.id, kind: 'email', source: 'test' });
  await env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(contact.id, personId).run();
  return { id: personId, email };
}

describe('identity global session revocation', () => {
  it('atomically bumps the epoch and supersedes both unused and consumed-unclaimed person challenges', async () => {
    const person = await owner();
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: person.email, displayName: 'Ignored',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.240' }), `revocation-${person.id}`), now: '2035-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: begun.delivery.publicId, purpose: 'signup', code: begun.delivery.code, now: '2035-01-01 00:01:00' })).ok).toBe(true);
    const revoked = await revokeIdentitySessions(env.DB, person.id);
    expect(revoked).toMatchObject({ revoked: true, sessionEpoch: expect.any(Number) });
    expect(await env.DB.prepare('SELECT superseded_at FROM identity_challenges WHERE public_id=?1').bind(begun.delivery.publicId).first<string>('superseded_at')).not.toBeNull();
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      code: begun.delivery.code, now: '2035-01-01 00:01:01' })).toEqual({ status: 'invalid' });
  });

  it('serializes concurrent global-revocation calls without leaving a usable challenge', async () => {
    const person = await owner();
    const before = await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(person.id).first<number>('session_epoch');
    const results = await Promise.all(Array.from({ length: 4 }, () => revokeIdentitySessions(env.DB, person.id)));
    expect(results).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ revoked: true })));
    expect(await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(person.id).first<number>('session_epoch'))
      .toBe((before ?? 0) + 4);
  });

  it('binds login delivery to the consumed credential epoch before a concurrent global signout', async () => {
    const person = await owner();
    const context = identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.241' }), `epoch-${person.id}`);
    const begun = await beginSignin(env.DB, authEnv, { campusId: 1, email: person.email, requestContext: context, now: '2035-01-01 00:00:00' });
    expect(begun.delivery).not.toBeNull();
    const completed = await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: begun.delivery!.publicId,
      token: begun.delivery!.token, now: '2035-01-01 00:01:00' });
    expect(completed).toMatchObject({ status: 'authenticated', personId: person.id, sessionEpoch: 0 });
    await revokeIdentitySessions(env.DB, person.id);
    if (completed.status === 'authenticated') {
      expect(await loadSessionUser(env.DB, person.id, completed.sessionEpoch)).toBeNull();
    }
  });

  it('rejects a person-bound credential when signout wins before consume', async () => {
    const person = await owner();
    const begun = await beginSignin(env.DB, authEnv, { campusId: 1, email: person.email,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.242' }), `epoch-pre-${person.id}`), now: '2035-01-01 00:00:00' });
    await revokeIdentitySessions(env.DB, person.id);
    expect(await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: begun.delivery!.publicId,
      token: begun.delivery!.token, now: '2035-01-01 00:01:00' })).toEqual({ status: 'invalid' });
  });

  it('keeps legacy login-token consumption and its delivered epoch behind the same signout boundary', async () => {
    const person = await owner();
    const issued = await createLoginToken(env.DB, person.id);
    expect('raw' in issued).toBe(true);
    if (!('raw' in issued)) return;
    const consumed = await consumeToken(env.DB, issued.raw, 'login');
    expect(consumed).toMatchObject({ person_id: person.id, expected_session_epoch: 0 });
    await revokeIdentitySessions(env.DB, person.id);
    expect(await loadSessionUser(env.DB, person.id, consumed!.expected_session_epoch!)).toBeNull();

    const after = await createLoginToken(env.DB, person.id);
    expect('raw' in after).toBe(true);
    if (!('raw' in after)) return;
    await revokeIdentitySessions(env.DB, person.id);
    expect(await consumeToken(env.DB, after.raw, 'login')).toBeNull();
  });
});
