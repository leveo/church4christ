// Guest registration continuation with the event builder: ticket types and per-person answers ride in the
// immutable party_json, conditions are re-applied when the guest verifies (a required question that is
// hidden must not invalidate the continuation), and a paid party is billed one line item per ticket type.
// Self-skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: async () => null,
}));

import { PgAdapter } from '../../src/lib/pgAdapter';
import { beginRegistrationContinuation, completeRegistrationContinuation } from '../../src/lib/identityBusinessContinuation';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import { listQuestions, listTicketTypesAdmin, saveEventForm, TERMS_ACCEPTED } from '../../src/lib/regDb';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('guest registration continuation with the event builder (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);
  const env = {
    IDENTITY_VERIFICATION_SECRET: 'pg-builder-verification-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_SECRET: 'pg-builder-source-key-secret-at-least-thirty-two-characters',
    IDENTITY_SOURCE_KEY_ID: 'v1',
  };

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  const builtEvent = async (title: string, price: number) => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events(starts_at,capacity,price_cents,currency,closes_at,active,max_party_size)
      VALUES('2032-02-01 00:00:00',20,9999,'usd','2032-01-31 00:00:00',1,5) RETURNING id`);
    await sql.unsafe("INSERT INTO reg_event_i18n(event_id,locale,title) VALUES($1,'en',$2)", [event.id, title]);
    const saved = await saveEventForm(db, event.id, {
      questions: [
        { key: 'meal', type: 'select', labels: { en: 'Meal' }, options: [{ key: 'veg', labels: { en: 'Veg' } }, { key: 'other', labels: { en: 'Other' } }] },
        // required, but only shown for "other": hidden here, so it must not block the continuation
        { type: 'text', required: true, labels: { en: 'Which meal?' }, condition: { q: 'meal', op: 'eq', value: 'other' } },
        { type: 'terms', required: true, labels: { en: 'Agree' } },
        { type: 'text', scope: 'attendee', required: true, labels: { en: 'Shirt' } },
      ],
      tickets: [{ labels: { en: 'Adult' }, price_cents: price }, { labels: { en: 'Child' }, price_cents: price / 2 }],
    }, { backend: 'supabase' });
    expect(saved).toEqual({ ok: true });
    const questions = await listQuestions(db, 'en', event.id);
    const types = await listTicketTypesAdmin(db, event.id);
    return { id: event.id as number, questions, types };
  };
  const begin = async (eventId: number, title: string, price: number, answers: Array<[number, string]>, party: Parameters<typeof beginRegistrationContinuation>[2]['party'], ip: string) => {
    const intentId = crypto.randomUUID();
    const begun = await beginRegistrationContinuation(db, env, {
      campusId: 1, intentId,
      event: { id: eventId, title, starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00', price_cents: 9999, currency: 'usd', active: 1, max_party_size: 5 },
      name: `Builder Guest ${intentId.slice(0, 8)}`, email: `builder-${intentId}@example.test`, locale: 'en', answers, party,
      now: '2032-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': ip }), intentId),
    });
    expect(begun.status).toBe('verification_required');
    if (begun.status !== 'verification_required') throw new Error('expected verification');
    return { intentId, begun };
  };

  it('a free ticket-typed party keeps types and per-person answers, re-applies conditions, and stamps the terms time', async () => {
    const { id, questions, types } = await builtEvent('PG Free Typed Party', 0);
    const by = (label: string) => questions.find((q) => q.label === label)!.id;
    const [adult, child] = types.map((t) => t.id);
    const answers: Array<[number, string]> = [[by('Meal'), 'veg'], [by('Agree'), TERMS_ACCEPTED]];
    const party = { phone: null, attendees: [
      { name: 'Guest Owner', ticketTypeId: adult, answers: [[by('Shirt'), 'M']] as Array<[number, string]> },
      { name: 'Kid', ticketTypeId: child, answers: [[by('Shirt'), 'S']] as Array<[number, string]> },
    ] };
    const { intentId, begun } = await begin(id, 'PG Free Typed Party', 0, answers, party, '203.0.113.201');
    const [stored] = await sql.unsafe('SELECT amount_cents, party_json FROM identity_registration_continuations WHERE intent_id = $1', [intentId]);
    expect(stored.amount_cents).toBe(0);
    expect(JSON.parse(stored.party_json).attendees).toEqual(party.attendees);
    const result = await completeRegistrationContinuation(db, env, {
      campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
    });
    expect(result).toMatchObject({ status: 'done', registrationStatus: 'confirmed' });
    const attendees = await sql.unsafe(
      `SELECT a.name, a.ticket_type_id, aa.question_id, aa.value FROM reg_attendees a
       JOIN identity_registration_continuations c ON c.registration_id = a.registration_id
       LEFT JOIN reg_attendee_answers aa ON aa.attendee_id = a.id WHERE c.intent_id = $1 ORDER BY a.sort`, [intentId]);
    expect(attendees.map((a) => [a.name, Number(a.ticket_type_id), Number(a.question_id), a.value])).toEqual([
      ['Guest Owner', adult, by('Shirt'), 'M'], ['Kid', child, by('Shirt'), 'S'],
    ]);
    const [terms] = await sql.unsafe(
      `SELECT a.value FROM reg_answers a JOIN identity_registration_continuations c ON c.registration_id = a.registration_id WHERE c.intent_id = $1 AND a.question_id = $2`, [intentId, by('Agree')]);
    expect(terms.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('refuses at begin a party without ticket types on a typed event, and answers that break the rules', async () => {
    const { id, questions, types } = await builtEvent('PG Refused Typed Party', 0);
    const by = (label: string) => questions.find((q) => q.label === label)!.id;
    const attempt = (party: Parameters<typeof beginRegistrationContinuation>[2]['party'], answers: Array<[number, string]>, ip: string) => {
      const intentId = crypto.randomUUID();
      return beginRegistrationContinuation(db, env, {
        campusId: 1, intentId,
        event: { id, title: 'PG Refused Typed Party', starts_at: '2032-02-01 00:00:00', closes_at: '2032-01-31 00:00:00', price_cents: 9999, currency: 'usd', active: 1, max_party_size: 5 },
        name: 'Guest Owner', email: `refuse-${intentId}@example.test`, locale: 'en', answers, party, now: '2032-01-01 00:00:00',
        requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': ip }), intentId),
      });
    };
    const ok: Array<[number, string]> = [[by('Meal'), 'veg'], [by('Agree'), TERMS_ACCEPTED]];
    await expect(attempt(undefined, ok, '203.0.113.202')).rejects.toThrow('ticket_type_required');
    await expect(attempt({ phone: null, attendees: [{ name: 'A', ticketTypeId: types[0].id + 9999 }] }, ok, '203.0.113.203')).rejects.toThrow('ticket_type_invalid');
    // a per-person required answer missing, and a stale value for the hidden question
    await expect(attempt({ phone: null, attendees: [{ name: 'A', ticketTypeId: types[0].id }] }, ok, '203.0.113.204')).rejects.toThrow('identity_continuation_answers_invalid');
    await expect(attempt({ phone: null, attendees: [{ name: 'A', ticketTypeId: types[0].id, answers: [[by('Shirt'), 'M']] }] }, [...ok, [by('Which meal?'), 'stale']], '203.0.113.205'))
      .rejects.toThrow('identity_continuation_answers_invalid');
  });

  it('a paid typed party is billed one Checkout line item per ticket type and the registration holds the sum', async () => {
    const { id, questions, types } = await builtEvent('PG Paid Typed Party', 2000);
    const by = (label: string) => questions.find((q) => q.label === label)!.id;
    const [adult, child] = types.map((t) => t.id);
    const paidEnv = { ...env, STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_builder', APP_ORIGIN: 'https://church.example' };
    const party = { phone: null, attendees: [
      { name: 'Guest Owner', ticketTypeId: adult, answers: [[by('Shirt'), 'L']] as Array<[number, string]> },
      { name: 'Kid One', ticketTypeId: child, answers: [[by('Shirt'), 'S']] as Array<[number, string]> },
      { name: 'Kid Two', ticketTypeId: child, answers: [[by('Shirt'), 'XS']] as Array<[number, string]> },
    ] };
    const { intentId, begun } = await begin(id, 'PG Paid Typed Party', 2000, [[by('Meal'), 'veg'], [by('Agree'), TERMS_ACCEPTED]], party, '203.0.113.206');
    const sent: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', (async (_url: unknown, init?: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      sent.push(body);
      return new Response(JSON.stringify({
        id: 'cs_test_typedparty', url: 'https://checkout.stripe.com/c/pay/cs_test_typedparty', mode: 'payment', livemode: false,
        status: 'open', payment_status: 'unpaid', payment_intent: null, amount_total: 4000, currency: 'usd',
        metadata: { kind: 'registration', registration_id: body['metadata[registration_id]'], request_id: body['metadata[request_id]'] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    let result: Awaited<ReturnType<typeof completeRegistrationContinuation>>;
    try {
      result = await completeRegistrationContinuation(db, paidEnv, {
        campusId: 1, intentId, publicId: begun.delivery.publicId, code: begun.delivery.code, appOrigin: 'https://church.example', now: '2032-01-01 00:01:00',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.status).toBe('redirect');
    expect(sent).toHaveLength(1);
    expect([sent[0]['line_items[0][quantity]'], sent[0]['line_items[0][price_data][unit_amount]'], sent[0]['line_items[0][price_data][product_data][name]']]).toEqual(['1', '2000', 'PG Paid Typed Party - Adult']);
    expect([sent[0]['line_items[1][quantity]'], sent[0]['line_items[1][price_data][unit_amount]'], sent[0]['line_items[1][price_data][product_data][name]']]).toEqual(['2', '1000', 'PG Paid Typed Party - Child']);
    const [registration] = await sql.unsafe(
      `SELECT r.status, r.amount_cents, r.party_size, r.stripe_checkout_session_id FROM registrations r WHERE r.event_id = $1`, [id]);
    expect(registration).toMatchObject({ status: 'pending', amount_cents: 4000, party_size: 3, stripe_checkout_session_id: 'cs_test_typedparty' });
    const rows = await sql.unsafe(
      `SELECT a.name, a.ticket_type_id, aa.value FROM reg_attendees a LEFT JOIN reg_attendee_answers aa ON aa.attendee_id = a.id
       JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = $1 ORDER BY a.sort`, [id]);
    expect(rows.map((r) => [r.name, Number(r.ticket_type_id), r.value])).toEqual([['Guest Owner', adult, 'L'], ['Kid One', child, 'S'], ['Kid Two', child, 'XS']]);
  });
});
