import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  buildRegistrationCheckoutParams,
  parseCheckoutRequestId,
  registrationCheckoutIdempotencyKey,
  registrationCheckoutRequestDigest,
  resolveRegistrationCheckoutRequest,
  type RegistrationCheckoutRequestInput,
} from '../../src/lib/stripeCheckoutRequests';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const REQUEST_A = '00000000-0000-4000-8000-000000000801';
const REQUEST_B = '00000000-0000-4000-8000-000000000802';
const REQUEST_C = '00000000-0000-4000-8000-000000000803';

describe.skipIf(!hasPg)('durable registration Checkout requests (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    execFileSync('node', ['scripts/db/seed-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE church_private.stripe_checkout_requests,
        reg_answers, registrations, reg_question_i18n, reg_questions,
        reg_event_i18n, reg_events RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await sql?.end();
  });

  const event = async (capacity: number | null = null) => {
    const [row] = await sql.unsafe(
      `INSERT INTO reg_events (starts_at, capacity, price_cents, currency)
       VALUES (datetime('now', '+1 day'), $1, 2500, 'usd') RETURNING id`,
      [capacity],
    );
    await sql.unsafe(`INSERT INTO reg_event_i18n (event_id, locale, title) VALUES ($1, 'en', 'Summer Retreat')`, [row.id]);
    return row.id as number;
  };

  const question = async (eventId: number) => {
    const [row] = await sql.unsafe(
      `INSERT INTO reg_questions (event_id, sort, type, required) VALUES ($1, 1, 'text', 0) RETURNING id`,
      [eventId],
    );
    return row.id as number;
  };

  const input = (
    requestId: string,
    eventId: number,
    overrides: Partial<RegistrationCheckoutRequestInput> = {},
  ): RegistrationCheckoutRequestInput => ({
    requestId,
    eventId,
    personId: null,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    amountCents: 2500,
    currency: 'usd',
    answers: [],
    eventTitle: 'Summer Retreat',
    locale: 'en',
    appOrigin: 'https://church.example',
    ...overrides,
  });

  it('strictly accepts only canonical RFC 4122 version-4 request UUIDs', () => {
    expect(parseCheckoutRequestId(REQUEST_A)).toBe(REQUEST_A);
    expect(parseCheckoutRequestId('abcdefab-cdef-4abc-8abc-abcdefabcdef')).toBe('abcdefab-cdef-4abc-8abc-abcdefabcdef');
    for (const value of [
      undefined,
      null,
      '',
      ` ${REQUEST_A}`,
      'ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF',
      '00000000-0000-1000-8000-000000000801',
      '00000000-0000-4000-7000-000000000801',
      '00000000000040008000000000000801',
    ]) {
      expect(() => parseCheckoutRequestId(value)).toThrow('checkout_request_id_invalid');
    }
  });

  it('hashes one stable normalized event/identity/amount/currency/sorted-answer representation', async () => {
    const base = input(REQUEST_A, 7, {
      personId: 42,
      name: '  Ada Lovelace  ',
      email: ' ADA@Example.COM ',
      currency: ' USD ',
      answers: [[2, 'yes'], [1, ' Blue ']],
    });
    const digest = await registrationCheckoutRequestDigest(base);
    expect(digest).toBe('980a620ea5cecc4516ed95d05c907cad5aa24557f883f188ea6461408e8c475d');
    expect(await registrationCheckoutRequestDigest({
      ...base,
      answers: [[1, 'Blue'], [2, 'yes']],
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      currency: 'usd',
      eventTitle: 'A renamed event does not alter a submitted identity',
      locale: 'zh',
      appOrigin: 'https://new-origin.example',
    })).toBe(digest);
  });

  it('persists registration, answers, and the minimal reproducible request in one atomic pair', async () => {
    const eventId = await event();
    const questionId = await question(eventId);
    const result = await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId, {
      answers: [[questionId, '  Blue  ']],
    }));

    expect(result.kind).toBe('create');
    if (result.kind !== 'create') throw new Error('expected create');
    expect(result.requestId).toBe(REQUEST_A);
    expect(registrationCheckoutIdempotencyKey(result.requestId)).toBe(`church4christ:registration:${REQUEST_A}`);
    expect(result.requestJson).toEqual(buildRegistrationCheckoutParams({
      ...input(REQUEST_A, eventId),
      registrationId: result.registrationId,
    }));
    expect(result.requestJson).toMatchObject({
      mode: 'payment',
      customer_email: 'ada@example.com',
      metadata: { kind: 'registration', registration_id: String(result.registrationId), request_id: REQUEST_A },
      payment_intent_data: {
        metadata: { kind: 'registration', registration_id: String(result.registrationId), request_id: REQUEST_A },
      },
    });
    expect(result.requestJson).not.toHaveProperty('expires_at');

    const [registration] = await sql.unsafe(
      `SELECT event_id, name, email, status, amount_cents, currency FROM registrations WHERE id=$1`,
      [result.registrationId],
    );
    expect(registration).toMatchObject({
      event_id: eventId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      status: 'pending',
      amount_cents: 2500,
      currency: 'usd',
    });
    expect(await sql.unsafe(`SELECT question_id, value FROM reg_answers WHERE registration_id=$1`, [result.registrationId]))
      .toEqual([{ question_id: questionId, value: 'Blue' }]);

    const [request] = await sql.unsafe(
      `SELECT request_id, request_sha256, registration_id, request_json, state, session_url
       FROM church_private.stripe_checkout_requests WHERE request_id=$1`,
      [REQUEST_A],
    );
    expect(request).toMatchObject({
      request_id: REQUEST_A,
      registration_id: result.registrationId,
      state: 'creating',
      session_url: null,
      request_json: JSON.stringify(result.requestJson),
    });
    expect(request.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(request.request_json).not.toMatch(/secret|signature|authorization|card|headers/i);
  });

  it('returns conflict for the same UUID with a different digest and changes neither row', async () => {
    const eventId = await event();
    const first = await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId));
    expect(first.kind).toBe('create');
    const before = await sql.unsafe(
      `SELECT r.id, r.name, r.email, r.status, q.request_sha256, q.request_json, q.state, q.session_url
       FROM registrations r JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
       WHERE q.request_id=$1`,
      [REQUEST_A],
    );

    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId, { name: 'Grace Hopper' })))
      .toEqual({ kind: 'conflict' });
    expect(await sql.unsafe(
      `SELECT r.id, r.name, r.email, r.status, q.request_sha256, q.request_json, q.state, q.session_url
       FROM registrations r JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
       WHERE q.request_id=$1`,
      [REQUEST_A],
    )).toEqual(before);
  });

  it('checks capacity in the pair transaction and rolls back registration, answers, and request together', async () => {
    const eventId = await event(1);
    const questionId = await question(eventId);
    await sql.unsafe(
      `INSERT INTO registrations (event_id, name, email, status, amount_cents, currency)
       VALUES ($1, 'Existing', 'existing@example.com', 'pending', 2500, 'usd')`,
      [eventId],
    );

    await expect(resolveRegistrationCheckoutRequest(db, input(REQUEST_B, eventId, {
      answers: [[questionId, 'Answer']],
    }))).rejects.toThrow('event_full');
    expect((await sql.unsafe(`SELECT count(*)::int AS count FROM registrations WHERE event_id=$1`, [eventId]))[0].count).toBe(1);
    expect((await sql.unsafe(`SELECT count(*)::int AS count FROM reg_answers`))[0].count).toBe(0);
    expect((await sql.unsafe(
      `SELECT count(*)::int AS count FROM church_private.stripe_checkout_requests WHERE request_id=$1`,
      [REQUEST_B],
    ))[0].count).toBe(0);
  });

  it('reloads the uniqueness-race winner and applies the same digest/state matrix', async () => {
    const eventId = await event();
    const [left, right] = await Promise.all([
      resolveRegistrationCheckoutRequest(db, input(REQUEST_C, eventId)),
      resolveRegistrationCheckoutRequest(db, input(REQUEST_C, eventId)),
    ]);
    expect(left.kind).toBe('create');
    expect(right.kind).toBe('create');
    if (left.kind !== 'create' || right.kind !== 'create') throw new Error('expected create');
    expect(right.registrationId).toBe(left.registrationId);
    expect(right.requestJson).toEqual(left.requestJson);
    expect((await sql.unsafe(`SELECT count(*)::int AS count FROM registrations WHERE event_id=$1`, [eventId]))[0].count).toBe(1);
    expect((await sql.unsafe(
      `SELECT count(*)::int AS count FROM church_private.stripe_checkout_requests WHERE request_id=$1`,
      [REQUEST_C],
    ))[0].count).toBe(1);
  });

  it('applies the exact pending reuse matrix without a second registration', async () => {
    const eventId = await event();
    const created = await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId));
    if (created.kind !== 'create') throw new Error('expected create');
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId))).toEqual(created);

    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET state='attached', request_json=NULL, session_url=$2 WHERE request_id=$1`,
      [REQUEST_A, 'https://checkout.stripe.test/c/pay/cs_test_one'],
    );
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId))).toEqual({
      kind: 'redirect', registrationId: created.registrationId, checkoutUrl: 'https://checkout.stripe.test/c/pay/cs_test_one',
    });

    await sql.unsafe(`UPDATE church_private.stripe_checkout_requests SET session_url=NULL WHERE request_id=$1`, [REQUEST_A]);
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId))).toEqual({
      kind: 'waiting', registrationId: created.registrationId,
    });

    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET state='manual_review', request_json=NULL, session_url=NULL WHERE request_id=$1`,
      [REQUEST_A],
    );
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId))).toEqual({
      kind: 'review', registrationId: created.registrationId, reason: 'manual_review',
    });
    expect((await sql.unsafe(`SELECT count(*)::int AS count FROM registrations WHERE event_id=$1`, [eventId]))[0].count).toBe(1);
  });

  it('converges confirmed/cancelled terminal cleanup and never exposes retained request JSON or URL', async () => {
    const eventId = await event();
    const done = await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId));
    const expired = await resolveRegistrationCheckoutRequest(db, input(REQUEST_B, eventId, { email: 'second@example.com' }));
    if (done.kind !== 'create' || expired.kind !== 'create') throw new Error('expected create');

    await sql.unsafe(`UPDATE registrations SET status='confirmed' WHERE id=$1`, [done.registrationId]);
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET state='attached', request_json=NULL, session_url='https://checkout.test/done' WHERE request_id=$1`,
      [REQUEST_A],
    );
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_A, eventId))).toEqual({
      kind: 'done', registrationId: done.registrationId,
    });

    await sql.unsafe(`UPDATE registrations SET status='cancelled' WHERE id=$1`, [expired.registrationId]);
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET state='attached', request_json=NULL, session_url='https://checkout.test/expired' WHERE request_id=$1`,
      [REQUEST_B],
    );
    expect(await resolveRegistrationCheckoutRequest(db, input(REQUEST_B, eventId, { email: 'second@example.com' })))
      .toEqual({ kind: 'expired' });

    expect(await sql.unsafe(
      `SELECT request_id, state, request_json, session_url
       FROM church_private.stripe_checkout_requests WHERE request_id IN ($1,$2) ORDER BY request_id`,
      [REQUEST_A, REQUEST_B],
    )).toEqual([
      { request_id: REQUEST_A, state: 'resolved', request_json: null, session_url: null },
      { request_id: REQUEST_B, state: 'resolved', request_json: null, session_url: null },
    ]);
  });
});
