import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';
import { claimSignupSessionDelivery } from '../src/lib/identityAccount';
import { IDENTITY_CONTINUATION_COOKIE, sealIdentityContinuationCookie } from '../src/lib/identityContinuationCookie';
import * as continuation from '../src/lib/identityBusinessContinuation';
import { POST as completeContinuationRoute } from '../src/pages/api/identity/continuation/complete';
import {
  beginRegistrationContinuation,
  continuationPayloadDigest,
  beginGivingContinuation,
  completeGivingContinuation,
  completeRegistrationContinuation,
  expireIdentityBusinessContinuations,
  normalizeGivingContinuationInput,
  normalizeRegistrationContinuationInput,
} from '../src/lib/identityBusinessContinuation';

const continuationEnv = {
  IDENTITY_VERIFICATION_SECRET: 'test-identity-verification-secret-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
  STRIPE_MODE: 'test',
};

async function replayThroughCompletionRoute(input: {
  kind: 'giving' | 'registration'; intentId: string; publicId: string; code: string; returnPath: string;
}): Promise<Response> {
  const sealed = await sealIdentityContinuationCookie(continuationEnv.IDENTITY_VERIFICATION_SECRET, {
    intentId: input.intentId,
    operationId: input.intentId,
    publicId: input.publicId,
    kind: input.kind,
    locale: 'en',
    returnPath: input.returnPath,
  });
  const request = new Request('http://localhost/api/identity/continuation/complete', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${IDENTITY_CONTINUATION_COOKIE}=${encodeURIComponent(sealed)}`,
    },
    body: new URLSearchParams({ locale: 'en', code: input.code }),
  });
  return completeContinuationRoute({
    request,
    locals: { locale: 'en', campusMode: 'single', rawDb: env.DB },
  } as never) as Promise<Response>;
}

async function createD1RegistrationSchema(eventId: number, capacity: number | null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_events (
      id INTEGER PRIMARY KEY, starts_at TEXT NOT NULL, ends_at TEXT, location TEXT,
      capacity INTEGER, price_cents INTEGER, currency TEXT NOT NULL DEFAULT 'usd',
      opens_at TEXT, closes_at TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_event_i18n (
      event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
      locale TEXT NOT NULL, title TEXT NOT NULL, description TEXT, PRIMARY KEY(event_id,locale)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_questions (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
      sort INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0, options TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_question_i18n (
      question_id INTEGER NOT NULL REFERENCES reg_questions(id) ON DELETE CASCADE,
      locale TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(question_id,locale)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
      person_id INTEGER REFERENCES people(id), name TEXT NOT NULL, email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd', stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_answers (
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES reg_questions(id) ON DELETE CASCADE,
      value TEXT NOT NULL, PRIMARY KEY(registration_id,question_id)
    )`),
  ]);
  await env.DB.prepare(`INSERT INTO reg_events(id,starts_at,capacity,price_cents,currency,closes_at,active)
    VALUES(?1,'2032-02-01 00:00:00',?2,0,'usd','2032-01-31 00:00:00',1)`).bind(eventId, capacity).run();
  await env.DB.prepare("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES(?1,'en','Free Event')").bind(eventId).run();
}

function freeEvent(id: number) {
  return { id, title: 'Free Event', price_cents: 0, currency: 'usd', active: 1,
    closes_at: '2032-01-31 00:00:00', starts_at: '2032-02-01 00:00:00' };
}

async function beginFreeRegistration(intentId: string, eventId: number, email: string, answers: Array<[number, string]> = []) {
  return beginRegistrationContinuation(env.DB, continuationEnv, {
    campusId: 1, intentId, event: freeEvent(eventId), name: `Free ${intentId}`, email,
    locale: 'en', answers, now: '2032-01-01 00:00:00',
    requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.120' }), intentId),
  });
}

class WrappedStatement implements AppStatement {
  constructor(readonly sqlText: string, readonly inner: AppStatement) {}
  bind(...values: unknown[]): AppStatement { return new WrappedStatement(this.sqlText, this.inner.bind(...values)); }
  first<T = unknown>(colName?: string): Promise<T | null> { return this.inner.first<T>(colName); }
  all<T = unknown>(): Promise<AppDbResult<T>> { return this.inner.all<T>(); }
  run<T = unknown>(): Promise<AppDbResult<T>> { return this.inner.run<T>(); }
}

function bindingCasLossDb(base: AppDb, intentId: string): AppDb {
  let injected = false;
  return {
    prepare(sql: string) { return new WrappedStatement(sql, base.prepare(sql)); },
    async batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
      const wrapped = statements as WrappedStatement[];
      const inner = wrapped.map((statement) => statement.inner);
      if (!injected && wrapped.some((statement) => statement.sqlText.includes('identity_business_signup_binding_assertions'))) {
        injected = true;
        inner.unshift(base.prepare(`UPDATE identity_business_intents SET signup_issuance_token='injected-cas-loss'
          WHERE intent_id=?1`).bind(intentId));
      }
      return base.batch<T>(inner);
    },
  };
}

describe('identity business continuations', () => {
  it('atomically completes a free registration with its exact receipt on real D1', async () => {
    const eventId = 810_001;
    const intentId = crypto.randomUUID();
    await createD1RegistrationSchema(eventId, 5);
    const begun = await beginFreeRegistration(intentId, eventId, `free-${intentId}@example.test`);
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;

    const result = await completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    });

    expect(result.status).toBe('done');
    const saved = await env.DB.prepare(`SELECT r.id registration_id,r.event_id,r.status,
      c.state child_state,i.state intent_state,i.business_record_key,receipt.business_record_key receipt_key
      FROM registrations r
      JOIN identity_registration_continuations c ON c.registration_id=r.id
      JOIN identity_business_intents i ON i.intent_id=c.intent_id
      JOIN identity_business_intent_receipts receipt ON receipt.intent_id=i.intent_id
      WHERE c.intent_id=?1`).bind(intentId).first<Record<string, unknown>>();
    expect(saved).toMatchObject({ event_id: eventId, status: 'confirmed', child_state: 'consumed', intent_state: 'consumed' });
    expect(saved?.business_record_key).toBe(String(saved?.registration_id));
    expect(saved?.receipt_key).toBe(String(saved?.registration_id));
  });

  it('serializes concurrent free registrations at capacity one on real D1', async () => {
    const eventId = 810_002;
    const intents = [crypto.randomUUID(), crypto.randomUUID()];
    await createD1RegistrationSchema(eventId, 1);
    const begun = await Promise.all(intents.map((intentId, index) => beginFreeRegistration(
      intentId, eventId, `capacity-${index}-${intentId}@example.test`,
    )));
    expect(begun.every((item) => item.status === 'verification_required')).toBe(true);
    if (begun.some((item) => item.status !== 'verification_required')) return;

    const results = await Promise.all(begun.map((item, index) => completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId: intents[index], publicId: item.delivery.publicId, code: item.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })));

    expect(results.map((result) => result.status).sort()).toEqual(['done', 'invalid']);
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations WHERE event_id=?1 AND status='confirmed'`)
      .bind(eventId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_business_intent_receipts WHERE intent_id IN (?1,?2)`)
      .bind(...intents).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_business_intents WHERE intent_id IN (?1,?2) AND state='consumed'`)
      .bind(...intents).first<number>('n')).toBe(1);
  });

  it('revalidates every persisted answer by question id, including checkbox and custom display order, on real D1', async () => {
    const eventId = 810_003;
    const intentId = crypto.randomUUID();
    const questionIds = { text: 811_101, yesno: 811_102, select: 811_103, checkbox: 811_104 };
    await createD1RegistrationSchema(eventId, 5);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,30,'text',1,NULL)`).bind(questionIds.text, eventId),
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,20,'yesno',1,NULL)`).bind(questionIds.yesno, eventId),
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,10,'select',1,?3)`).bind(questionIds.select, eventId, JSON.stringify(['Morning', 'Evening'])),
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,0,'checkbox',1,?3)`).bind(questionIds.checkbox, eventId, JSON.stringify(['Meal', 'Ride'])),
      ...Object.values(questionIds).map((questionId) => env.DB.prepare(
        `INSERT INTO reg_question_i18n(question_id,locale,label) VALUES(?1,'en',?2)`,
      ).bind(questionId, `Question ${questionId}`)),
    ]);
    const answers: Array<[number, string]> = [
      [questionIds.checkbox, JSON.stringify(['Meal', 'Ride'])],
      [questionIds.select, 'Evening'],
      [questionIds.yesno, 'yes'],
      [questionIds.text, 'Needs a seat'],
    ];
    const begun = await beginFreeRegistration(intentId, eventId, `answers-${intentId}@example.test`, answers);
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;

    await expect(completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })).resolves.toMatchObject({ status: 'done' });
    const saved = await env.DB.prepare(`SELECT a.question_id,a.value FROM reg_answers a
      JOIN identity_registration_continuations c ON c.registration_id=a.registration_id
      WHERE c.intent_id=?1 ORDER BY a.question_id`).bind(intentId).all<{ question_id: number; value: string }>();
    expect(saved.results).toEqual([...answers].sort(([left], [right]) => left - right)
      .map(([question_id, value]) => ({ question_id, value })));
  });

  it('fails closed when the current question definition no longer accepts a persisted answer', async () => {
    const eventId = 810_004;
    const questionId = 811_201;
    const intentId = crypto.randomUUID();
    await createD1RegistrationSchema(eventId, 5);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,0,'select',1,?3)`).bind(questionId, eventId, JSON.stringify(['Original'])),
      env.DB.prepare("INSERT INTO reg_question_i18n(question_id,locale,label) VALUES(?1,'en','Choice')").bind(questionId),
    ]);
    const begun = await beginFreeRegistration(intentId, eventId, `drift-${intentId}@example.test`, [[questionId, 'Original']]);
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await env.DB.prepare('UPDATE reg_questions SET options=?1 WHERE id=?2')
      .bind(JSON.stringify(['Replacement']), questionId).run();

    await expect(completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })).resolves.toEqual({ status: 'invalid' });
    expect(await env.DB.prepare('SELECT count(*) n FROM registrations WHERE event_id=?1')
      .bind(eventId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_business_intent_receipts WHERE intent_id=?1')
      .bind(intentId).first<number>('n')).toBe(0);
  });

  it('fails closed when a question type changes even if its old answer is valid text', async () => {
    const eventId = 810_006;
    const questionId = 811_301;
    const intentId = crypto.randomUUID();
    await createD1RegistrationSchema(eventId, 5);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO reg_questions(id,event_id,sort,type,required,options)
        VALUES(?1,?2,0,'select',1,?3)`).bind(questionId, eventId, JSON.stringify(['Original'])),
      env.DB.prepare("INSERT INTO reg_question_i18n(question_id,locale,label) VALUES(?1,'en','Choice')").bind(questionId),
    ]);
    const begun = await beginFreeRegistration(intentId, eventId, `type-drift-${intentId}@example.test`, [[questionId, 'Original']]);
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await env.DB.prepare("UPDATE reg_questions SET type='text',options=NULL WHERE id=?1").bind(questionId).run();

    await expect(completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })).resolves.toEqual({ status: 'invalid' });
    expect(await env.DB.prepare('SELECT count(*) n FROM registrations WHERE event_id=?1')
      .bind(eventId).first<number>('n')).toBe(0);
  });

  it('rolls back a prepared signup operation and challenge when the parent binding CAS loses, then converges on retry', async () => {
    const intentId = crypto.randomUUID();
    const challengeCountBefore = await env.DB.prepare('SELECT count(*) n FROM identity_challenges').first<number>('n');
    const input = {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once' as const, locale: 'en' as const, name: 'Atomic Binder',
      email: `atomic-${intentId}@example.test`, now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.121' }), intentId),
    };

    await expect(beginGivingContinuation(bindingCasLossDb(env.DB, intentId), continuationEnv, input))
      .rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_account_operations WHERE operation_id=?1')
      .bind(intentId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_challenges').first<number>('n')).toBe(challengeCountBefore);
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_observations WHERE source='signup' AND source_key=?1")
      .bind(intentId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_business_signup_binding_assertions').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT signup_operation_id FROM identity_business_intents WHERE intent_id=?1')
      .bind(intentId).first<string>('signup_operation_id')).toBeNull();

    const retry = await beginGivingContinuation(env.DB, continuationEnv, input);
    expect(retry.status).toBe('verification_required');
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_account_operations WHERE operation_id=?1')
      .bind(intentId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_business_signup_binding_assertions').first<number>('n')).toBe(0);
  });

  it('reauthenticates a consumed Giving replay and never grants session delivery twice', async () => {
    const intentId = crypto.randomUUID();
    const begun = await beginGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'Replay Owner',
      email: `replay-${intentId}@example.test`, now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.122' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    const authenticated = await completeGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00',
    });
    expect(authenticated.status).not.toBe('review');
    const intent = await env.DB.prepare('SELECT result_person_id,source_record_id,source_version,source_digest FROM identity_business_intents WHERE intent_id=?1')
      .bind(intentId).first<{ result_person_id: number; source_record_id: number; source_version: number; source_digest: string }>();
    const child = await env.DB.prepare('SELECT checkout_request_id FROM identity_giving_checkout_continuations WHERE intent_id=?1')
      .bind(intentId).first<{ checkout_request_id: string }>();
    expect(intent?.result_person_id).toBeTypeOf('number');
    expect(child?.checkout_request_id).toBeTypeOf('string');
    if (!intent || !child) return;
    await env.DB.batch([
      env.DB.prepare(`UPDATE identity_giving_checkout_continuations SET state='creating',claim_token_hash=?1,
        claim_expires_at='2032-01-01 00:06:00' WHERE intent_id=?2 AND state='ready'`).bind('a'.repeat(64), intentId),
      env.DB.prepare(`UPDATE identity_giving_checkout_continuations SET state='attached',stripe_session_id='cs_test_replay',
        stripe_session_url='https://checkout.stripe.com/c/pay/replay',claim_token_hash=NULL,claim_expires_at=NULL
        WHERE intent_id=?1 AND state='creating'`).bind(intentId),
      env.DB.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,
        source_version,source_digest,person_id,business_record_key) VALUES(?1,1,?2,?3,?4,?5,?6,?7)`)
        .bind(crypto.randomUUID(), intentId, intent.source_record_id, intent.source_version, intent.source_digest,
          intent.result_person_id, child.checkout_request_id),
      env.DB.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1 WHERE intent_id=?2 AND state='ready'`)
        .bind(child.checkout_request_id, intentId),
      env.DB.prepare("UPDATE identity_giving_checkout_continuations SET state='consumed' WHERE intent_id=?1 AND state='attached'")
        .bind(intentId),
    ]);

    const firstClaim = await claimSignupSessionDelivery(env.DB, continuationEnv, {
      campusId: 1, operationId: intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2032-01-01 00:02:00',
    });
    expect(firstClaim).not.toBeNull();
    const wrongCode = begun.delivery.code === '000000' ? '000001' : '000000';
    await expect(completeGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: wrongCode, now: '2032-01-01 00:02:00',
    })).resolves.toEqual({ status: 'invalid' });
    const replay = await replayThroughCompletionRoute({
      kind: 'giving', intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, returnPath: '/en/give',
    });
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/replay');
    expect(replay.headers.get('set-cookie')).toContain(`${IDENTITY_CONTINUATION_COOKIE}=;`);
    expect(replay.headers.get('set-cookie')).not.toContain('c4c_session=');
    const duplicateClaim = await claimSignupSessionDelivery(env.DB, continuationEnv, {
      campusId: 1, operationId: intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2032-01-01 00:02:00',
    });
    expect(duplicateClaim).toBeNull();
  });

  it('marks a correct consumed Registration replay after the production session-delivery order without minting twice', async () => {
    const eventId = 810_005;
    const intentId = crypto.randomUUID();
    await createD1RegistrationSchema(eventId, 5);
    const begun = await beginFreeRegistration(intentId, eventId, `registration-replay-${intentId}@example.test`);
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await expect(completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })).resolves.toMatchObject({ status: 'done' });
    expect(await claimSignupSessionDelivery(env.DB, continuationEnv, {
      campusId: 1, operationId: intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2032-01-01 00:01:00',
    })).not.toBeNull();

    const wrongCode = begun.delivery.code === '000000' ? '000001' : '000000';
    await expect(completeRegistrationContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: wrongCode,
      appOrigin: 'https://church.example', now: '2032-01-01 00:02:00',
    })).resolves.toEqual({ status: 'invalid' });
    const replay = await replayThroughCompletionRoute({
      kind: 'registration', intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      returnPath: `/en/register/${eventId}`,
    });
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/en/register/done?ok=1');
    expect(replay.headers.get('set-cookie')).toContain(`${IDENTITY_CONTINUATION_COOKIE}=;`);
    expect(replay.headers.get('set-cookie')).not.toContain('c4c_session=');
    await expect(claimSignupSessionDelivery(env.DB, continuationEnv, {
      campusId: 1, operationId: intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2032-01-01 00:02:00',
    })).resolves.toBeNull();
  });

  it('atomically exhausts the strict consumed-OTP failure budget under concurrent wrong guesses', async () => {
    const intentId = crypto.randomUUID();
    const begun = await beginGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'Replay Budget Owner',
      email: `replay-budget-${intentId}@example.test`, now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.123' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await completeGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00',
    });
    const wrongCode = begun.delivery.code === '000000' ? '000001' : '000000';
    const guesses = await Promise.all(Array.from({ length: 12 }, () => completeGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: wrongCode, now: '2032-01-01 00:02:00',
    })));
    expect(guesses.every((result) => result.status === 'invalid')).toBe(true);
    const challenge = await env.DB.prepare(`SELECT c.attempts,c.max_attempts,c.requester_bucket_hash
      FROM identity_account_operations o JOIN identity_challenges c ON c.id=o.challenge_id
      WHERE o.operation_id=?1`).bind(intentId)
      .first<{ attempts: number; max_attempts: number; requester_bucket_hash: string }>();
    expect(challenge).toMatchObject({ attempts: 5, max_attempts: 5 });
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_otp_failure_claims
      WHERE challenge_id=(SELECT challenge_id FROM identity_account_operations WHERE operation_id=?1)`)
      .bind(intentId).first<number>('n')).toBe(5);
    expect(await env.DB.prepare(`SELECT count FROM identity_rate_limits
      WHERE campus_id=1 AND bucket_hash=?1 AND scope='otp_failure' ORDER BY window_started_at DESC LIMIT 1`)
      .bind(challenge?.requester_bucket_hash ?? '').first<number>('count')).toBe(5);
    await expect(completeGivingContinuation(env.DB, continuationEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:03:00',
    })).resolves.toEqual({ status: 'invalid' });
  });
  it('attaches an anonymous continuation with the raw intent id, not the persisted source HMAC', async () => {
    const intentId = crypto.randomUUID();
    const begun = await beginGivingContinuation(env.DB, {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1',
      STRIPE_MODE: 'test',
    }, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'Exact Owner',
      email: `continuation-${intentId}@example.test`,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.91' }), intentId),
      now: '2032-01-01 00:00:00',
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;

    await completeGivingContinuation(env.DB, {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1',
      STRIPE_MODE: 'test',
    }, { campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00' });

    const binding = await env.DB.prepare(`SELECT i.source_record_id,s.linked_person_id,s.source_record_key
      FROM identity_business_intents i JOIN identity_source_records s ON s.id=i.source_record_id
      WHERE i.intent_id=?1`).bind(intentId).first<{ source_record_id: number; linked_person_id: number | null; source_record_key: string }>();
    expect(binding?.linked_person_id).not.toBeNull();
    expect(binding?.source_record_key).toMatch(/^[0-9a-f]{64}$/u);
    expect(binding?.source_record_key).not.toBe(intentId);
  });

  it('reuses one pending challenge with a bounded, rate-accounted resend policy', async () => {
    const intentId = crypto.randomUUID();
    const input = {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once' as const, locale: 'en' as const, name: 'Retry Owner',
      email: `retry-${intentId}@example.test`,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.92' }), intentId),
      now: '2032-01-01 00:00:00',
    };
    const vars = {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test',
    };
    const first = await beginGivingContinuation(env.DB, vars, input);
    const immediate = await beginGivingContinuation(env.DB, vars, input);
    const retry = await beginGivingContinuation(env.DB, vars, { ...input, now: '2032-01-01 00:01:01' });
    const finalRetry = await beginGivingContinuation(env.DB, vars, { ...input, now: '2032-01-01 00:02:02' });
    const exhausted = await beginGivingContinuation(env.DB, vars, { ...input, now: '2032-01-01 00:03:03' });
    expect(first.status).toBe('verification_required');
    expect(immediate.status).toBe('pending');
    expect(retry.status).toBe('verification_required');
    expect(finalRetry.status).toBe('verification_required');
    expect(exhausted.status).toBe('pending');
    if (first.status !== 'verification_required' || retry.status !== 'verification_required'
      || finalRetry.status !== 'verification_required') return;
    expect(retry.delivery).toEqual(first.delivery);
    expect(finalRetry.delivery).toEqual(first.delivery);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_account_operations WHERE operation_id=?1`)
      .bind(intentId).first<number>('n')).toBe(1);
    const ciphertext = await env.DB.prepare('SELECT signup_delivery_ciphertext FROM identity_business_intents WHERE intent_id=?1')
      .bind(intentId).first<string>('signup_delivery_ciphertext');
    expect(ciphertext).toMatch(/^v2\.[A-Za-z0-9_-]+$/u);
    expect(ciphertext).not.toContain(first.delivery.code);
    expect(ciphertext).not.toContain(first.delivery.to);
    expect(await env.DB.prepare(`SELECT signup_delivery_count FROM identity_business_intents WHERE intent_id=?1`)
      .bind(intentId).first<number>('signup_delivery_count')).toBe(3);
    expect(await env.DB.prepare(`SELECT count FROM identity_rate_limits WHERE scope='otp_request_contact' ORDER BY count DESC LIMIT 1`)
      .first<number>('count')).toBe(3);
  });

  it('allows only one concurrent resend claimant after cooldown', async () => {
    const intentId = crypto.randomUUID();
    const vars = {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test',
    };
    const input = {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once' as const, locale: 'en' as const, name: 'Concurrent Retry',
      email: `retry-race-${intentId}@example.test`,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.93' }), intentId),
      now: '2032-01-01 01:00:00',
    };
    expect((await beginGivingContinuation(env.DB, vars, input)).status).toBe('verification_required');
    const results = await Promise.all(Array.from({ length: 8 }, () => beginGivingContinuation(env.DB, vars, {
      ...input, now: '2032-01-01 01:01:01',
    })));
    expect(results.filter((result) => result.status === 'verification_required')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT signup_delivery_count FROM identity_business_intents WHERE intent_id=?1')
      .bind(intentId).first<number>('signup_delivery_count')).toBe(2);
  });

  it('fails pending retry closed after verification-secret rotation without changing the stable source key', async () => {
    const intentId = crypto.randomUUID();
    const input = {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once' as const, locale: 'en' as const, name: 'Rotate Owner',
      email: `rotate-${intentId}@example.test`,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.94' }), intentId),
      now: '2032-01-01 02:00:00',
    };
    const stable = { IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters', IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test' };
    expect((await beginGivingContinuation(env.DB, { ...stable,
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters' }, input)).status).toBe('verification_required');
    expect((await beginGivingContinuation(env.DB, { ...stable,
      IDENTITY_VERIFICATION_SECRET: 'rotated-verification-secret-at-least-thirty-two-characters' }, {
      ...input, now: '2032-01-01 02:01:01',
    })).status).toBe('pending');
    const sourceKey = await env.DB.prepare(`SELECT s.source_record_key FROM identity_business_intents i
      JOIN identity_source_records s ON s.id=i.source_record_id WHERE i.intent_id=?1`).bind(intentId).first<string>('source_record_key');
    expect(sourceKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('requires child-terminal state and ciphertext erasure when a continuation reviews or expires', async () => {
    const vars = {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test',
    };
    const begin = async (intentId: string, now: string) => beginGivingContinuation(env.DB, vars, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'Terminal Owner',
      email: `terminal-${intentId}@example.test`, now,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.95' }), intentId),
    });

    const reviewedId = crypto.randomUUID();
    expect((await begin(reviewedId, '2032-01-01 03:00:00')).status).toBe('verification_required');
    await expect(env.DB.prepare(`UPDATE identity_business_intents SET state='review',signup_delivery_ciphertext=NULL,
      signup_delivery_count=0,signup_delivery_not_before=NULL WHERE intent_id=?1`).bind(reviewedId).run()).rejects.toThrow();
    await env.DB.batch([
      env.DB.prepare("UPDATE identity_giving_checkout_continuations SET state='review' WHERE intent_id=?1").bind(reviewedId),
      env.DB.prepare(`UPDATE identity_business_intents SET state='review',signup_delivery_ciphertext=NULL,
        signup_delivery_count=0,signup_delivery_not_before=NULL WHERE intent_id=?1`).bind(reviewedId),
    ]);
    expect(await env.DB.prepare(`SELECT i.state intent_state,g.state child_state,i.signup_delivery_ciphertext
      FROM identity_business_intents i JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id
      WHERE i.intent_id=?1`).bind(reviewedId).first()).toMatchObject({
      intent_state: 'review', child_state: 'review', signup_delivery_ciphertext: null,
    });

    const expiredId = crypto.randomUUID();
    const begun = await begin(expiredId, '2032-01-01 04:00:00');
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    expect(await completeGivingContinuation(env.DB, vars, {
      campusId: 1, intentId: expiredId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2032-01-01 04:31:00',
    })).toEqual({ status: 'invalid' });
    expect(await env.DB.prepare(`SELECT i.state intent_state,g.state child_state,i.signup_delivery_ciphertext,
      i.signup_delivery_count,i.signup_delivery_not_before FROM identity_business_intents i
      JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id WHERE i.intent_id=?1`)
      .bind(expiredId).first()).toMatchObject({
      intent_state: 'expired', child_state: 'expired', signup_delivery_ciphertext: null,
      signup_delivery_count: 0, signup_delivery_not_before: null,
    });
  });

  it('hourly sweep expires abandoned delivery ciphertext in bounded, idempotent batches', async () => {
    const vars = {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test',
    };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, intentId] of ids.entries()) {
      expect((await beginGivingContinuation(env.DB, vars, {
        campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
        currency: 'usd', frequency: 'once', locale: 'en', name: 'Abandoned Owner',
        email: `abandoned-${intentId}@example.test`, now: `2020-01-01 0${6 + index}:00:00`,
        requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': `203.0.113.${100 + index}` }), intentId),
      })).status).toBe('verification_required');
    }

    await expect(expireIdentityBusinessContinuations(env.DB, {
      now: '2020-01-01 08:00:00', limit: 1,
    })).resolves.toEqual({ scanned: 1, expired: 1 });
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_business_intents
      WHERE intent_id IN (?1,?2) AND state='expired' AND signup_delivery_ciphertext IS NULL
      AND signup_delivery_count=0 AND signup_delivery_not_before IS NULL`).bind(...ids).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_giving_checkout_continuations
      WHERE intent_id IN (?1,?2) AND state='expired'`).bind(...ids).first<number>('n')).toBe(1);

    await expect(expireIdentityBusinessContinuations(env.DB, {
      now: '2020-01-01 08:00:00', limit: 1,
    })).resolves.toEqual({ scanned: 1, expired: 1 });
    await expect(expireIdentityBusinessContinuations(env.DB, {
      now: '2020-01-01 08:00:00', limit: 1,
    })).resolves.toEqual({ scanned: 0, expired: 0 });
  });

  it('hourly sweep preserves an active checkout lease and expires it only after the lease lapses', async () => {
    const vars = {
      IDENTITY_VERIFICATION_SECRET: 'continuation-verification-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_SECRET: 'test-stable-identity-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'v1', STRIPE_MODE: 'test',
    };
    const intentId = crypto.randomUUID();
    const begun = await beginGivingContinuation(env.DB, vars, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'Leased Owner',
      email: `leased-${intentId}@example.test`, now: '2021-01-01 10:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.103' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await completeGivingContinuation(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      now: '2021-01-01 10:01:00',
    });
    expect(await env.DB.prepare(`UPDATE identity_giving_checkout_continuations SET state='creating',
      claim_token_hash=?1,claim_expires_at=?2 WHERE intent_id=?3 AND state='ready'`)
      .bind('a'.repeat(64), '2021-01-01 10:40:00', intentId).run()).toMatchObject({ meta: { changes: 1 } });

    await expect(expireIdentityBusinessContinuations(env.DB, {
      now: '2021-01-01 10:31:00', limit: 1,
    })).resolves.toEqual({ scanned: 0, expired: 0 });
    expect(await env.DB.prepare('SELECT state FROM identity_business_intents WHERE intent_id=?1')
      .bind(intentId).first<string>('state')).toBe('ready');
    await expect(expireIdentityBusinessContinuations(env.DB, {
      now: '2021-01-01 10:40:00', limit: 1,
    })).resolves.toEqual({ scanned: 1, expired: 1 });
    expect(await env.DB.prepare(`SELECT i.state intent_state,g.state child_state,g.claim_token_hash
      FROM identity_business_intents i JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id
      WHERE i.intent_id=?1`).bind(intentId).first()).toMatchObject({
      intent_state: 'expired', child_state: 'expired', claim_token_hash: null,
    });
  });
  it.each([
    ['giving', 'identity_giving_checkout_continuations', 'stripe_session_id', 'registration_id'],
    ['registration', 'identity_registration_continuations', 'registration_id', 'stripe_session_id'],
  ] as const)('queries only the %s child schema when claiming work', async (kind, table, resultColumn, foreignColumn) => {
    const api = continuation as unknown as {
      claimContinuationChild?: (db: unknown, kind: 'giving' | 'registration', intentId: string, now?: string) => Promise<unknown>;
    };
    expect(api.claimContinuationChild).toBeTypeOf('function');
    if (!api.claimContinuationChild) return;
    const sql: string[] = [];
    const statement = {
      bind() { return this; },
      async first() { return { state: 'ready', result_id: null, claim_expires_at: null }; },
      async run() { return { results: [], meta: { changes: 0 } }; },
      async all() { return { results: [], meta: { changes: 0 } }; },
    };
    const db = {
      prepare(query: string) { sql.push(query); return statement; },
      async batch() { return []; },
    };

    await api.claimContinuationChild(db, kind, '11111111-1111-4111-8111-111111111111', '2026-08-23 06:00:00');

    expect(sql[0]).toContain(`FROM ${table}`);
    expect(sql[0]).toContain(`${resultColumn} AS result_id`);
    expect(sql[0]).not.toContain(foreignColumn);
  });

  it('normalizes one-time giving without accepting recurring anonymous identity', async () => {
    await expect(normalizeGivingContinuationInput({
      fundId: 4, fundName: 'General', amountCents: 2500, currency: 'USD', frequency: 'month',
      locale: 'en', name: ' Ada ', email: 'ADA@example.test',
    })).rejects.toThrow('identity_continuation_frequency_invalid');

    const normalized = await normalizeGivingContinuationInput({
      fundId: 4, fundName: 'General', amountCents: 2500, currency: 'USD', frequency: 'once',
      locale: 'en', name: ' Ada ', email: 'ADA@example.test',
    });
    expect(normalized).toMatchObject({ frequency: 'once', donorName: 'Ada', donorEmail: 'ada@example.test' });
    expect(normalized).not.toHaveProperty('customerId');
  });

  it('canonicalizes registration payload and binds answers into a stable digest', async () => {
    const one = await normalizeRegistrationContinuationInput({
      eventId: 9, name: ' Ada ', email: 'ADA@example.test', amountCents: 0, currency: 'USD',
      locale: 'zh', answers: [[3, ' b '], [1, 'a']],
    });
    const two = await normalizeRegistrationContinuationInput({
      eventId: 9, name: 'Ada', email: 'ada@example.test', amountCents: 0, currency: 'usd',
      locale: 'zh', answers: [[1, 'a'], [3, 'b']],
    });
    expect(one).toEqual(two);
    expect(await continuationPayloadDigest(one)).toMatch(/^[0-9a-f]{64}$/);
  });
});
