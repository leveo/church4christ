import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: async () => null,
}));

import { PgAdapter } from '../../src/lib/pgAdapter';
import { claimContinuationChild } from '../../src/lib/identityBusinessContinuation';
import {
  beginGivingContinuation,
  beginRegistrationContinuation,
  completeGivingContinuation,
  completeRegistrationContinuation,
  expireIdentityBusinessContinuations,
} from '../../src/lib/identityBusinessContinuation';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { registerIdentitySource } from '../../src/lib/identityGateway';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('identity business continuation claims (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);
  const identityEnv = {
    IDENTITY_VERIFICATION_SECRET: 'pg-continuation-verification-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_SECRET: 'pg-continuation-source-key-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_ID: 'v1',
  };

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  it('projects only the result column that exists on each continuation child table', async () => {
    for (const kind of ['giving', 'registration'] as const) {
      const intentId = crypto.randomUUID();
      const source = await registerIdentitySource(db, identityEnv, {
        campusId: 1,
        source: kind,
        sourceRecordKey: intentId,
        email: `${kind}-${intentId}@example.test`,
        name: `PG ${kind}`,
        attachmentPolicy: 'signed_in_or_claim',
        sourceDigest: 'a'.repeat(64),
      });
      await sql.unsafe(`INSERT INTO identity_business_intents(intent_id,campus_id,kind,source_record_id,source_version,
        source_digest,payload_digest,signup_reservation_id,expires_at)
        VALUES($1,1,$2,$3,$4,$5,$6,$1,'2032-01-01 00:30:00')`, [
        intentId, kind === 'giving' ? 'giving_checkout' : 'registration', source.sourceRecordId,
        source.version, source.sourceDigest, 'b'.repeat(64),
      ]);
      if (kind === 'giving') {
        await sql.unsafe(`INSERT INTO identity_giving_checkout_continuations
          (intent_id,fund_id,amount_cents,currency,locale,checkout_request_id)
          VALUES($1,1,100,'usd','en',$2)`, [intentId, crypto.randomUUID()]);
      } else {
        await sql.unsafe(`INSERT INTO identity_registration_continuations
          (intent_id,event_id,amount_cents,currency,locale,answers_json,question_digest)
          VALUES($1,1,0,'usd','en','[]',$2)`, [intentId, 'a'.repeat(64)]);
      }
      await expect(claimContinuationChild(db, kind, intentId, '2032-01-01 00:00:00'))
        .resolves.toEqual({ status: 'busy' });
    }
  });

  it('attaches the exact raw intent source key after OTP without double-HMAC lookup', async () => {
    const intentId = crypto.randomUUID();
    const [fund] = await sql.unsafe(`INSERT INTO funds(fund_number,active,sort) VALUES($1,0,0) RETURNING id`, [`pg-${intentId}`]);
    await sql.unsafe(`INSERT INTO fund_i18n(fund_id,locale,name) VALUES($1,'en','Inactive PG Fund')`, [fund.id]);
    const begun = await beginGivingContinuation(db, { ...identityEnv, STRIPE_MODE: 'test' }, {
      campusId: 1, intentId, fundId: fund.id, fundName: 'Inactive PG Fund', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'PG Exact Owner',
      email: `pg-exact-${intentId}@example.test`, now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.93' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;
    await expect(completeGivingContinuation(db, { ...identityEnv, STRIPE_MODE: 'test' }, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00',
    })).resolves.toEqual({ status: 'invalid' });
    const [source] = await sql.unsafe(`SELECT s.id,s.linked_person_id,s.source_record_key,i.source_record_id,
      i.state intent_state,i.signup_delivery_ciphertext,g.state child_state,g.claim_token_hash
      FROM identity_business_intents i JOIN identity_source_records s ON s.id=i.source_record_id
      JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id WHERE i.intent_id=$1`, [intentId]);
    expect(source.linked_person_id).not.toBeNull();
    expect(source.id).toBe(source.source_record_id);
    expect(source.source_record_key).toMatch(/^[0-9a-f]{64}$/u);
    expect(source.source_record_key).not.toBe(intentId);
    expect(source).toMatchObject({ intent_state: 'ready', child_state: 'ready', signup_delivery_ciphertext: null, claim_token_hash: null });
  });

  it('serializes bounded resend claims and enforces terminal ciphertext erasure in PostgreSQL', async () => {
    const intentId = crypto.randomUUID();
    const input = {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once' as const, locale: 'en' as const, name: 'PG Retry Owner',
      email: `pg-retry-${intentId}@example.test`, now: '2032-01-01 05:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.96' }), intentId),
    };
    expect((await beginGivingContinuation(db, { ...identityEnv, STRIPE_MODE: 'test' }, input)).status).toBe('verification_required');
    const retries = await Promise.all(Array.from({ length: 6 }, () => beginGivingContinuation(db,
      { ...identityEnv, STRIPE_MODE: 'test' }, { ...input, now: '2032-01-01 05:01:01' })));
    expect(retries.filter((result) => result.status === 'verification_required')).toHaveLength(1);
    const [delivery] = await sql.unsafe(`SELECT signup_delivery_count,signup_delivery_ciphertext
      FROM identity_business_intents WHERE intent_id=$1`, [intentId]);
    expect(delivery.signup_delivery_count).toBe(2);
    expect(delivery.signup_delivery_ciphertext).toMatch(/^v2\./u);

    await expect(sql.unsafe(`UPDATE identity_business_intents SET state='expired',signup_delivery_ciphertext=NULL,
      signup_delivery_count=0,signup_delivery_not_before=NULL WHERE intent_id=$1`, [intentId])).rejects.toThrow();
    await sql.begin(async (tx) => {
      await tx.unsafe("UPDATE identity_giving_checkout_continuations SET state='expired' WHERE intent_id=$1", [intentId]);
      await tx.unsafe(`UPDATE identity_business_intents SET state='expired',signup_delivery_ciphertext=NULL,
        signup_delivery_count=0,signup_delivery_not_before=NULL WHERE intent_id=$1`, [intentId]);
    });
    const [terminal] = await sql.unsafe(`SELECT i.state intent_state,g.state child_state,i.signup_delivery_ciphertext,
      i.signup_delivery_count,i.signup_delivery_not_before FROM identity_business_intents i
      JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id WHERE i.intent_id=$1`, [intentId]);
    expect(terminal).toMatchObject({ intent_state: 'expired', child_state: 'expired', signup_delivery_ciphertext: null,
      signup_delivery_count: 0, signup_delivery_not_before: null });
  });

  it('hourly sweep atomically expires abandoned pending ciphertext in PostgreSQL', async () => {
    const intentId = crypto.randomUUID();
    expect((await beginGivingContinuation(db, { ...identityEnv, STRIPE_MODE: 'test' }, {
      campusId: 1, intentId, fundId: 1, fundName: 'General', amountCents: 2500,
      currency: 'usd', frequency: 'once', locale: 'en', name: 'PG Abandoned Owner',
      email: `pg-abandoned-${intentId}@example.test`, now: '2020-01-01 06:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.97' }), intentId),
    })).status).toBe('verification_required');

    await expect(expireIdentityBusinessContinuations(db, {
      now: '2020-01-01 06:31:00', limit: 1,
    })).resolves.toEqual({ scanned: 1, expired: 1 });
    const [saved] = await sql.unsafe(`SELECT i.state intent_state,g.state child_state,i.signup_delivery_ciphertext,
      i.signup_delivery_count,i.signup_delivery_not_before FROM identity_business_intents i
      JOIN identity_giving_checkout_continuations g ON g.intent_id=i.intent_id WHERE i.intent_id=$1`, [intentId]);
    expect(saved).toMatchObject({ intent_state: 'expired', child_state: 'expired', signup_delivery_ciphertext: null,
      signup_delivery_count: 0, signup_delivery_not_before: null });
    await expect(expireIdentityBusinessContinuations(db, {
      now: '2020-01-01 06:31:00', limit: 1,
    })).resolves.toEqual({ scanned: 0, expired: 0 });
  });

  it('serializes concurrent free registration completion at capacity one in PostgreSQL', async () => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events(starts_at,capacity,price_cents,currency,closes_at,active,waitlist_enabled)
      VALUES('2032-02-01 00:00:00',1,0,'usd','2032-01-31 00:00:00',1,0) RETURNING id`);
    await sql.unsafe("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES($1,'en','PG Free Event')", [event.id]);
    // Widen the INSERT statement snapshot window. Without the event-row mutex,
    // both transactions evaluate capacity before either insert commits.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION identity_test_delay_registration_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END; $$;
      CREATE TRIGGER identity_test_delay_registration_insert BEFORE INSERT ON registrations
      FOR EACH ROW EXECUTE FUNCTION identity_test_delay_registration_insert()`);
    try {
      const intents = [crypto.randomUUID(), crypto.randomUUID()];
      const begun = await Promise.all(intents.map((intentId, index) => beginRegistrationContinuation(db, identityEnv, {
        campusId: 1, intentId,
        event: { id: event.id, title: 'PG Free Event', starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00',
          price_cents: 0, currency: 'usd', active: 1 },
        name: `PG Capacity ${index}`, email: `pg-capacity-${index}-${intentId}@example.test`, locale: 'en', answers: [],
        now: '2032-01-01 00:00:00',
        requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': `203.0.113.${140 + index}` }), intentId),
      })));
      expect(begun.every((result) => result.status === 'verification_required')).toBe(true);
      const verificationRequired = begun.filter(
        (result): result is Extract<(typeof begun)[number], { status: 'verification_required' }> =>
          result.status === 'verification_required',
      );
      if (verificationRequired.length !== begun.length) return;

      const results = await Promise.all(verificationRequired.map((result, index) => completeRegistrationContinuation(db, identityEnv, {
        campusId: 1, intentId: intents[index], publicId: result.delivery.publicId, code: result.delivery.code,
        appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
      })));
      expect(results.map((result) => result.status).sort()).toEqual(['done', 'invalid']);
      const [{ registrations }] = await sql.unsafe(`SELECT count(*)::int registrations FROM registrations
        WHERE event_id=$1 AND status IN ('pending','confirmed')`, [event.id]);
      expect(registrations).toBe(1);
      const [{ receipts }] = await sql.unsafe(`SELECT count(*)::int receipts FROM identity_business_intent_receipts
        WHERE intent_id IN ($1,$2)`, intents);
      expect(receipts).toBe(1);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS identity_test_delay_registration_insert ON registrations');
      await sql.unsafe('DROP FUNCTION IF EXISTS identity_test_delay_registration_insert()');
    }
  });

  it('waitlists the second of two concurrent free guest completions at capacity one in PostgreSQL', async () => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events(starts_at,capacity,price_cents,currency,closes_at,active,waitlist_enabled)
      VALUES('2032-02-01 00:00:00',1,0,'usd','2032-01-31 00:00:00',1,1) RETURNING id`);
    await sql.unsafe("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES($1,'en','PG Waitlist Event')", [event.id]);
    const intents = [crypto.randomUUID(), crypto.randomUUID()];
    const begun = await Promise.all(intents.map((intentId, index) => beginRegistrationContinuation(db, identityEnv, {
      campusId: 1, intentId,
      event: { id: event.id, title: 'PG Waitlist Event', starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00',
        price_cents: 0, currency: 'usd', active: 1 },
      name: `PG Waitlist ${index}`, email: `pg-waitlist-${index}-${intentId}@example.test`, locale: 'en', answers: [],
      now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': `203.0.113.${160 + index}` }), intentId),
    })));
    const ready = begun.filter(
      (result): result is Extract<(typeof begun)[number], { status: 'verification_required' }> => result.status === 'verification_required',
    );
    expect(ready).toHaveLength(2);
    const results = await Promise.all(ready.map((result, index) => completeRegistrationContinuation(db, identityEnv, {
      campusId: 1, intentId: intents[index], publicId: result.delivery.publicId, code: result.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })));
    expect(results.map((r) => r.status)).toEqual(['done', 'done']);
    expect(results.map((r) => r.registrationStatus).sort()).toEqual(['confirmed', 'waitlist']);
    const rows = await sql.unsafe(`SELECT status,confirmation_no,
      (SELECT count(*)::int FROM reg_attendees a WHERE a.registration_id=r.id) attendees
      FROM registrations r WHERE event_id=$1 ORDER BY id`, [event.id]);
    expect(rows.map((r) => [r.status, r.attendees]).sort()).toEqual([['confirmed', 1], ['waitlist', 1]]);
    expect(new Set(rows.map((r) => r.confirmation_no)).size).toBe(2);
    const [{ receipts }] = await sql.unsafe(`SELECT count(*)::int receipts FROM identity_business_intent_receipts WHERE intent_id IN ($1,$2)`, intents);
    expect(receipts).toBe(2);
  });

  it('charges a guest party the per-person price times the party through the paid continuation in PostgreSQL', async () => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events(starts_at,capacity,price_cents,currency,closes_at,active,max_party_size)
      VALUES('2032-02-01 00:00:00',20,2500,'usd','2032-01-31 00:00:00',1,5) RETURNING id`);
    await sql.unsafe("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES($1,'en','PG Paid Party')", [event.id]);
    const paidEnv = { ...identityEnv, STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_party', APP_ORIGIN: 'https://church.example' };
    const intentId = crypto.randomUUID();
    const party = { phone: '555 0100', attendees: [{ name: 'Paid Guest' }, { name: 'Bob' }, { name: 'Cy' }] };
    const begun = await beginRegistrationContinuation(db, paidEnv, {
      campusId: 1, intentId,
      event: { id: event.id, title: 'PG Paid Party', starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00',
        price_cents: 2500, currency: 'usd', active: 1, max_party_size: 5 },
      name: 'Paid Guest', email: `pg-paid-party-${intentId}@example.test`, locale: 'en', answers: [], party,
      now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.180' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;

    const sent: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', (async (_url: unknown, init?: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      sent.push(body);
      const total = Number(body['line_items[0][price_data][unit_amount]']) * Number(body['line_items[0][quantity]']);
      return new Response(JSON.stringify({
        id: 'cs_test_paidparty', url: 'https://checkout.stripe.com/c/pay/cs_test_paidparty', mode: 'payment', livemode: false,
        status: 'open', payment_status: 'unpaid', payment_intent: null, amount_total: total, currency: 'usd',
        metadata: { kind: 'registration', registration_id: body['metadata[registration_id]'], request_id: body['metadata[request_id]'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    let result: Awaited<ReturnType<typeof completeRegistrationContinuation>>;
    try {
      result = await completeRegistrationContinuation(db, paidEnv, {
        campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
        appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.status).toBe('redirect');
    expect(sent).toHaveLength(1);
    expect(sent[0]['line_items[0][quantity]']).toBe('3');
    expect(sent[0]['line_items[0][price_data][unit_amount]']).toBe('2500');
    const [registration] = await sql.unsafe(
      `SELECT r.status,r.amount_cents,r.party_size,r.phone,r.locale,r.manage_token_hash,r.stripe_checkout_session_id,
              (SELECT count(*)::int FROM reg_attendees a WHERE a.registration_id=r.id) attendees,
              (SELECT a.person_id FROM reg_attendees a WHERE a.registration_id=r.id AND a.sort=0) first_person,r.person_id
       FROM registrations r WHERE r.event_id=$1`, [event.id]);
    expect(registration).toMatchObject({ status: 'pending', amount_cents: 7500, party_size: 3, phone: '555 0100', locale: 'en',
      manage_token_hash: null, stripe_checkout_session_id: 'cs_test_paidparty', attendees: 3 });
    expect(registration.first_person).toBe(registration.person_id);
    const [child] = await sql.unsafe(`SELECT state,party_json FROM identity_registration_continuations WHERE intent_id=$1`, [intentId]);
    expect(child.state).toBe('consumed');
    expect(JSON.parse(child.party_json)).toEqual(party);
  });

  it('revalidates checkbox, select, yes/no, and text answers by question id instead of display order in PostgreSQL', async () => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events(starts_at,capacity,price_cents,currency,closes_at,active)
      VALUES('2032-02-01 00:00:00',5,0,'usd','2032-01-31 00:00:00',1) RETURNING id`);
    await sql.unsafe("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES($1,'en','PG Answers Event')", [event.id]);
    const questions = [
      { id: 1_691_101, sort: 30, type: 'text', required: 1, options: null, answer: 'Needs a seat' },
      { id: 1_691_102, sort: 20, type: 'yesno', required: 1, options: null, answer: 'yes' },
      { id: 1_691_103, sort: 10, type: 'select', required: 1, options: ['Morning', 'Evening'], answer: 'Evening' },
      { id: 1_691_104, sort: 0, type: 'checkbox', required: 1, options: ['Meal', 'Ride'], answer: JSON.stringify(['Meal', 'Ride']) },
    ] as const;
    for (const question of questions) {
      await sql.unsafe(`INSERT INTO reg_questions(id,event_id,sort,type,required,options) VALUES($1,$2,$3,$4,$5,$6)`,
        [question.id, event.id, question.sort, question.type, question.required,
          question.options === null ? null : JSON.stringify(question.options)]);
      await sql.unsafe("INSERT INTO reg_question_i18n(question_id,locale,label) VALUES($1,'en',$2)",
        [question.id, `Question ${question.id}`]);
    }
    const intentId = crypto.randomUUID();
    const answers = questions.map((question) => [question.id, question.answer] as [number, string]);
    const begun = await beginRegistrationContinuation(db, identityEnv, {
      campusId: 1, intentId,
      event: { id: event.id, title: 'PG Answers Event', starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00',
        price_cents: 0, currency: 'usd', active: 1 },
      name: 'PG Answers Owner', email: `pg-answers-${intentId}@example.test`, locale: 'en', answers,
      now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.150' }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') return;

    await expect(completeRegistrationContinuation(db, identityEnv, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code,
      appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    })).resolves.toMatchObject({ status: 'done' });
    const saved = await sql.unsafe(`SELECT a.question_id,a.value FROM reg_answers a
      JOIN identity_registration_continuations c ON c.registration_id=a.registration_id
      WHERE c.intent_id=$1 ORDER BY a.question_id`, [intentId]);
    expect(saved).toEqual([...answers].sort(([left], [right]) => left - right)
      .map(([question_id, value]) => ({ question_id, value })));
  });
});
