import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  consumeEmailOtpChallenge,
  hmacIdentityValue,
  issueEmailOtpChallenge,
  issueEmailLinkChallenge,
  peekEmailLinkChallenge,
  consumeEmailLinkChallenge,
  verifyConsumedEmailOtpChallenge,
  identityTrustedRequestContext,
} from '../src/lib/identityAuth';

const authEnv = { IDENTITY_VERIFICATION_SECRET: 'identity-test-secret-that-is-at-least-thirty-two-characters' };
let n = 97500;
const requestContext = (ip: string | null = null, device = `device-${++n}`) => identityTrustedRequestContext(
  new Headers(ip ? { 'CF-Connecting-IP': ip } : {}),
  device,
);
async function verifiedLoginEmail(label: string): Promise<string> {
  const personId = ++n; const email = `${label}-${personId}@example.test`;
  await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Link Owner',?2)").bind(personId, email).run();
  const point = await env.DB.prepare("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email',?1,?1) RETURNING id").bind(email).first<number>('id');
  await env.DB.batch([
    env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(?1,?2,'email','test')").bind(personId, point),
    env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(point, personId),
  ]);
  return email;
}

describe('identity email authentication', () => {
  it.each(['short', `${'x'.repeat(31)} `, `${'x'.repeat(31)}\n`, `${'x'.repeat(31)}\u00a0`, `${'x'.repeat(31)}\u0000`])('fails closed for an invalid verification secret', async (secret) => {
    await expect(issueEmailOtpChallenge(env.DB, { IDENTITY_VERIFICATION_SECRET: secret }, {
      campusId: 1, email: 'missing-secret@example.test', purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00',
    })).rejects.toThrow('identity_verification_unavailable');
  });

  it('rejects request metadata that did not cross the trusted header boundary', async () => {
    await expect(issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email: `untrusted-${++n}@example.test`, purpose: 'login',
      requestContext: { cfConnectingIp: '203.0.113.1', deviceId: 'forged' }, now: '2030-01-01 00:00:00',
    } as never)).rejects.toThrow('identity_challenge_invalid');
  });

  it('issues a public UUID and six digit OTP while storing only its HMAC', async () => {
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email: `otp-${++n}@example.test`, purpose: 'login', requestContext: requestContext('203.0.113.4', 'device-a'), now: '2030-01-01 00:00:00',
    });
    expect(issued).toMatchObject({ publicId: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/), code: expect.stringMatching(/^\d{6}$/) });
    const row = await env.DB.prepare('SELECT code_hash,token_hash,normalized_value FROM identity_challenges c JOIN contact_points p ON p.id=c.contact_point_id WHERE c.public_id=?1')
      .bind(issued.publicId).first<{ code_hash: string; token_hash: string | null; normalized_value: string }>();
    expect(row?.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row).toMatchObject({ token_hash: null });
    expect(JSON.stringify(row)).not.toContain(issued.code);
  });

  it('binds OTP verification to its purpose and consumes it exactly once', async () => {
    const email = `verify-${++n}@example.test`;
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'signup', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'login', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'login', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
  });

  it('can revalidate the same secret only for a consumed OTP so account mutations can recover after faults', async () => {
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `recover-proof-${++n}@example.test`, purpose: 'signup', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await verifyConsumedEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'signup', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'signup', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    expect((await verifyConsumedEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'signup', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    expect((await verifyConsumedEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'signup', code: '000000', now: '2030-01-01 00:01:00' })).ok).toBe(false);
  });

  it('binds an OTP to its bounded request source', async () => {
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `source-${++n}@example.test`, purpose: 'login', source: 'kiosk', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'login', source: 'web', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'login', source: 'kiosk', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
  });

  it('allows exactly one concurrent OTP consumer', async () => {
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `race-${++n}@example.test`, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    const results = await Promise.all([1, 2].map(() => consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'login', code: issued.code, now: '2030-01-01 00:01:00' })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('does not reset shared failed-code budget when a challenge is reissued', async () => {
    const email = `failure-${++n}@example.test`;
    const context = requestContext();
    const first = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:00:00' });
    for (let i = 0; i < 5; i++) await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: first.publicId, purpose: 'login', code: '000000', now: '2030-01-01 00:01:00' });
    const next = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:02:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: next.publicId, purpose: 'login', code: next.code, now: '2030-01-01 00:02:00' })).ok).toBe(false);
  });

  it('atomically shares exactly five failed guesses across parallel challenges', async () => {
    const email = `parallel-failure-${++n}@example.test`; const context = requestContext();
    const login = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:00:00' });
    const signup = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'signup', requestContext: context, now: '2030-01-01 00:00:00' });
    await Promise.all(Array.from({ length: 12 }, (_, index) => consumeEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, publicId: index % 2 ? login.publicId : signup.publicId, purpose: index % 2 ? 'login' : 'signup',
      code: `9${String(index).padStart(5, '0')}`, now: '2030-01-01 00:01:00',
    })));
    const bucket = await env.DB.prepare('SELECT requester_bucket_hash FROM identity_challenges WHERE public_id=?1')
      .bind(login.publicId).first<string>('requester_bucket_hash');
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_otp_failure_claims
      WHERE campus_id=1 AND bucket_hash=?1 AND window_started_at='2030-01-01 00:00:00'`).bind(bucket).first<number>('n')).toBe(5);
    expect(await env.DB.prepare('SELECT sum(attempts) n FROM identity_challenges WHERE public_id IN (?1,?2)')
      .bind(login.publicId, signup.publicId).first<number>('n')).toBe(5);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: login.publicId, purpose: 'login', code: login.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: signup.publicId, purpose: 'signup', code: signup.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
  });

  it('writes opaque rate buckets and applies the contact issuance limit', async () => {
    const email = `limit-${++n}@example.test`;
    for (let i = 0; i < 3; i++) expect((await issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email, purpose: 'login', requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.90' }), 'opaque-device'), now: '2030-01-01 00:00:00',
    })).limited).toBe(false);
    expect((await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.90' }), 'opaque-device'), now: '2030-01-01 00:00:00' })).limited).toBe(true);
    const buckets = await env.DB.prepare("SELECT bucket_hash FROM identity_rate_limits WHERE scope LIKE 'otp_request_%'").all<{ bucket_hash: string }>();
    expect(buckets.results.every(({ bucket_hash }) => /^[a-f0-9]{64}$/.test(bucket_hash) && !bucket_hash.includes(email))).toBe(true);
  });

  it('issues high entropy email links with a safe GET peek primitive', async () => {
    const email = await verifiedLoginEmail('link');
    const link = await issueEmailLinkChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.91' })), now: '2030-01-01 00:00:00' });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await peekEmailLinkChallenge(env.DB, authEnv, { campusId: 1, publicId: link.publicId, purpose: 'login', token: link.token, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    expect((await consumeEmailLinkChallenge(env.DB, authEnv, { campusId: 1, publicId: link.publicId, purpose: 'login', token: link.token, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    expect((await consumeEmailLinkChallenge(env.DB, authEnv, { campusId: 1, publicId: link.publicId, purpose: 'login', token: link.token, now: '2030-01-01 00:01:00' })).ok).toBe(false);
  });

  it('rejects an oversized link token before any database lookup', async () => {
    const noDatabase: AppDb = { prepare: () => { throw new Error('database_must_not_be_touched'); }, batch: async () => [] };
    expect(await consumeEmailLinkChallenge(noDatabase, authEnv, {
      campusId: 1, publicId: '123e4567-e89b-42d3-a456-426614174999', purpose: 'login', token: 'a'.repeat(257), now: '2030-01-01 00:01:00',
    })).toEqual({ ok: false });
  });

  it('keeps 15-minute request buckets alive through the fixed window boundary', async () => {
    const email = `boundary-${++n}@example.test`;
    const context = requestContext();
    for (let i = 0; i < 3; i++) await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:14:59' });
    expect((await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:14:59' })).limited).toBe(true);
    expect((await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: context, now: '2030-01-01 00:15:00' })).limited).toBe(false);
  });

  it('binds contact-change proof to the trusted target and rejects target substitution', async () => {
    const target = ++n;
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Target',?2)").bind(target, `target-${target}@example.test`).run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Attacker',?2)").bind(target + 1, `attacker-${target}@example.test`).run();
    const email = `new-contact-${target}@example.test`;
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email, purpose: 'contact_change', targetPersonId: target, requestContext: requestContext(), now: '2030-01-01 00:00:00',
    });
    const row = await env.DB.prepare('SELECT person_id,context_json FROM identity_challenges WHERE public_id=?1').bind(issued.publicId)
      .first<{ person_id: number; context_json: string }>();
    expect(row?.person_id).toBe(target);
    expect(JSON.parse(row!.context_json)).toEqual({ binding: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'contact_change', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    const point = await env.DB.prepare('SELECT contact_point_id FROM identity_challenges WHERE public_id=?1').bind(issued.publicId).first<number>('contact_point_id');
    await env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(?1,?2,'email','test')").bind(target, point).run();
    const { assignVerifiedContactOwner } = await import('../src/lib/identityDb');
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point!, personId: target + 1, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'contact_change', reasonCode: 'verified_email' } }))
      .rejects.toThrow('identity_owner_proof_invalid');
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point!, personId: target, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'contact_change', reasonCode: 'verified_email' } });
    const tampered = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `tampered-${target}@example.test`, purpose: 'contact_change', targetPersonId: target, requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    await env.DB.prepare('UPDATE identity_challenges SET person_id=?1 WHERE public_id=?2').bind(target + 1, tampered.publicId).run();
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: tampered.publicId, purpose: 'contact_change', code: tampered.code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
    await expect(issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `bad-target-${target}@example.test`, purpose: 'login', targetPersonId: target, requestContext: requestContext(), now: '2030-01-01 00:00:00' } as never)).rejects.toThrow('identity_challenge_invalid');
  });

  it('uses the same database operation categories for known and unknown contacts', async () => {
    const owner = ++n;
    const knownEmail = `known-ops-${owner}@example.test`;
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Known',?2)").bind(owner, knownEmail).run();
    const point = await env.DB.prepare("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email',?1,?1) RETURNING id").bind(knownEmail).first<number>('id');
    await env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(?1,?2,'email','test')").bind(owner, point).run();
    await env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(point, owner).run();
    const trace = (operations: string[]): AppDb => ({
      prepare(sql: string) { operations.push(`${/^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase()}:${/\b(?:FROM|INTO|UPDATE)\s+(\w+)/i.exec(sql)?.[1] ?? 'unknown'}`); return env.DB.prepare(sql); },
      batch(statements) { return (env.DB as unknown as AppDb).batch(statements); },
    });
    const knownOps: string[] = []; const unknownOps: string[] = [];
    await issueEmailOtpChallenge(trace(knownOps), authEnv, { campusId: 1, email: knownEmail, purpose: 'login', requestContext: requestContext('198.51.100.200', 'known-ops'), now: '2032-01-01 00:00:00' });
    await issueEmailOtpChallenge(trace(unknownOps), authEnv, { campusId: 1, email: `unknown-ops-${owner}@example.test`, purpose: 'login', requestContext: requestContext('198.51.100.201', 'unknown-ops'), now: '2032-01-01 00:00:00' });
    expect(unknownOps).toEqual(knownOps);
  });

  it('allows step-up targeting only when the verified contact already owns that person', async () => {
    const owner = ++n; const other = ++n; const email = `step-up-${owner}@example.test`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Step Owner',?2)").bind(owner, `step-owner-${owner}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Step Other',?2)").bind(other, `step-other-${other}@example.test`),
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)").bind(owner, email),
      env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(?1,?1,'email','test')").bind(owner),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?1,'admin_review')").bind(owner),
    ]);
    await expect(issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'step_up', targetPersonId: other, requestContext: requestContext(), now: '2030-01-01 00:00:00' }))
      .rejects.toThrow('identity_challenge_invalid');
    expect((await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'step_up', targetPersonId: owner, requestContext: requestContext(), now: '2030-01-01 00:00:00' })).limited).toBe(false);
  });

  it.each(['contact_change', 'step_up'] as const)('requires a positive trusted target for %s issuance', async (purpose) => {
    await expect(issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email: `missing-target-${purpose}-${++n}@example.test`, purpose, requestContext: requestContext(), now: '2030-01-01 00:00:00',
    } as never)).rejects.toThrow('identity_challenge_invalid');
    await expect(issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email: `invalid-target-${purpose}-${++n}@example.test`, purpose, targetPersonId: 0, requestContext: requestContext(), now: '2030-01-01 00:00:00',
    })).rejects.toThrow('identity_challenge_invalid');
  });

  it.each(['contact_change', 'step_up'] as const)('refuses a correctly signed but unbound %s challenge', async (purpose) => {
    const publicId = `123e4567-e89b-42d3-a456-${String(++n).padStart(12, '0')}`;
    const code = '314159'; const email = `legacy-unbound-${purpose}-${n}@example.test`;
    const point = await env.DB.prepare("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email',?1,?1) RETURNING id").bind(email).first<number>('id');
    const codeHash = await hmacIdentityValue(authEnv.IDENTITY_VERIFICATION_SECRET, `otp:${purpose}:web`, `${publicId}\0${0}\0${code}`);
    const binding = await hmacIdentityValue(authEnv.IDENTITY_VERIFICATION_SECRET, 'challenge:context', `${publicId}\0${1}\0${purpose}\0web\0${point}\0${0}`);
    await env.DB.prepare(`INSERT INTO identity_challenges(public_id,campus_id,purpose,request_source,person_id,contact_point_id,code_hash,requester_bucket_hash,expires_at,context_json)
      VALUES(?1,1,?2,'web',NULL,?3,?4,?5,'2030-01-01 00:10:00',?6)`).bind(publicId, purpose, point, codeHash, 'f'.repeat(64), JSON.stringify({ binding })).run();
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId, purpose, code, now: '2030-01-01 00:01:00' })).ok).toBe(false);
  });

  it('enforces expiry, max attempts, supersession, and exactly one concurrent link consumer', async () => {
    const context = requestContext();
    const expired = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `expired-${++n}@example.test`, purpose: 'login', requestContext: context, now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: expired.publicId, purpose: 'login', code: expired.code, now: '2030-01-01 00:10:00' })).ok).toBe(false);
    const limitedAttempts = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email: `attempts-${++n}@example.test`, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    for (let i = 0; i < 5; i++) await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: limitedAttempts.publicId, purpose: 'login', code: '999999', now: '2030-01-01 00:01:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: limitedAttempts.publicId, purpose: 'login', code: limitedAttempts.code, now: '2030-01-01 00:02:00' })).ok).toBe(false);
    const email = `superseded-${++n}@example.test`;
    const superseded = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    const replacement = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:01:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: superseded.publicId, purpose: 'login', code: superseded.code, now: '2030-01-01 00:02:00' })).ok).toBe(false);
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: replacement.publicId, purpose: 'login', code: replacement.code, now: '2030-01-01 00:02:00' })).ok).toBe(true);
    const linkEmail = await verifiedLoginEmail('link-race');
    const link = await issueEmailLinkChallenge(env.DB, authEnv, { campusId: 1, email: linkEmail, purpose: 'login', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    const results = await Promise.all([1, 2].map(() => consumeEmailLinkChallenge(env.DB, authEnv, { campusId: 1, publicId: link.publicId, purpose: 'login', token: link.token, now: '2030-01-01 00:01:00' })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('enforces trusted-IP, unknown-IP, and device request budgets independently', async () => {
    const issueDistinct = (label: string, index: number, context: ReturnType<typeof requestContext>) => issueEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, email: `${label}-${++n}-${index}@example.test`, purpose: 'login', requestContext: context, now: '2031-01-01 00:00:00',
    });
    for (let i = 0; i < 20; i++) expect((await issueDistinct('trusted-ip', i, requestContext('203.0.113.101', `trusted-device-${i}`))).limited).toBe(false);
    expect((await issueDistinct('trusted-ip', 21, requestContext('203.0.113.101', 'trusted-device-last'))).limited).toBe(true);
    for (let i = 0; i < 8; i++) expect((await issueDistinct('unknown-ip', i, requestContext(null, `unknown-device-${i}`))).limited).toBe(false);
    expect((await issueDistinct('unknown-ip', 9, requestContext(null, 'unknown-device-last'))).limited).toBe(true);
    for (let i = 0; i < 12; i++) expect((await issueDistinct('device', i, requestContext(`198.51.100.${i + 1}`, 'one-device'))).limited).toBe(false);
    expect((await issueDistinct('device', 13, requestContext('198.51.100.99', 'one-device'))).limited).toBe(true);
  });

  it('accepts only the trusted CF-Connecting-IP header at the request boundary', () => {
    expect(identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.5', 'X-Forwarded-For': '1.1.1.1' }), 'opaque-a'))
      .toEqual({ cfConnectingIp: '203.0.113.5', deviceId: 'opaque-a' });
    expect(identityTrustedRequestContext(new Headers({ 'X-Forwarded-For': '1.1.1.1' }), 'opaque-a').cfConnectingIp).toBeNull();
  });
});
