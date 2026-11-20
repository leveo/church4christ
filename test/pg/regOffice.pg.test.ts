// Registration back office behavior on Postgres (the same cases as test/regOffice.d1.test.ts), plus what only
// Postgres can show: true two-connection concurrency for the version guard, the last seat, a double
// check-in and overlapping outbox claims. Self-skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { resolveRegistrationCheckoutRequest } from '../../src/lib/stripeCheckoutRequests';
import { adminAddPerson, adminSetNote, adminUpdateRegistration, decideRegistration, listActivity } from '../../src/lib/regAdmin';
import { checkIn, checkInParty } from '../../src/lib/regCheckin';
import { claimOutbox, claimReminder, enqueueOutbox, recordRefund } from '../../src/lib/regOutbox';
import { defineRegOfficeCases, tsAt } from '../shared/regOfficeCases';

const DAY = 24 * 3600_000;

describe.skipIf(!hasPg)('registration back office (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  defineRegOfficeCases('Postgres', () => db, 'supabase');
  defineRegOfficeCases('Postgres, campus-scoped', () => scopeDatabase(db, 1), 'supabase');

  // Every contender gets its OWN connection (a separate postgres.js client), so the batches genuinely overlap.
  async function withClients<T>(n: number, run: (dbs: AppDb[]) => Promise<T>): Promise<T> {
    const clients = Array.from({ length: n }, () => pgClient());
    try {
      return await run(clients.map((c) => new PgAdapter(c)));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }
  const newReg = async (over: Partial<Parameters<typeof saveEvent>[1]> = {}, names = ['Ann']) => {
    const eventId = await saveEvent(db, { title_en: 'Race', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 6, ...over });
    const reg = await createRegistration(db, {
      eventId, personId: null, name: names[0], email: 'ann@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [],
      attendees: names.map((name) => ({ name })), submissionKey: `race-${Date.now()}-${Math.random()}`,
    });
    return { eventId, reg };
  };

  it('two parallel writers with the same version: exactly one wins, the loser changes nothing', async () => {
    const { reg } = await newReg();
    const outcomes = await withClients(6, (dbs) => Promise.all(dbs.map((d, i) => adminSetNote(d, reg.id, { version: 1, note: `note ${i}` }, { actor: null }))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual(Array(5).fill({ ok: false, code: 'version_conflict' }));
    const row = (await sql.unsafe('SELECT version, admin_note FROM registrations WHERE id = $1', [reg.id]))[0];
    expect(row.version).toBe(2);
    expect(row.admin_note).toMatch(/^note \d$/);
    expect(await listActivity(db, reg.id)).toHaveLength(1); // only the winner's history row
  });

  it('a decision racing an edit: one of them wins, never both', async () => {
    const { reg } = await newReg({ requires_approval: 1 });
    const [decided, edited] = await withClients(2, (dbs) => Promise.all([
      decideRegistration(dbs[0], reg.id, 'accept', null, { version: 1 }),
      adminUpdateRegistration(dbs[1], reg.id, { version: 1, contact: { name: 'Anna' } }, { actor: null }),
    ]));
    expect([decided.ok, edited.ok].sort()).toEqual([false, true]);
    expect((await sql.unsafe('SELECT version FROM registrations WHERE id = $1', [reg.id]))[0].version).toBe(2);
  });

  it('two staff adding the last seat: exactly one fits, the other must confirm', async () => {
    const { eventId, reg } = await newReg({ capacity: 3 }); // Ann + Ben hold two seats, one is left
    const other = await createRegistration(db, {
      eventId, personId: null, name: 'Ben', email: 'ben@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], submissionKey: `race-b-${Date.now()}`,
    });
    const outcomes = await withClients(2, (dbs) => Promise.all([
      adminAddPerson(dbs[0], reg.id, { version: 1, name: 'Zed' }, { actor: null }),
      adminAddPerson(dbs[1], other.id, { version: 1, name: 'Yan' }, { actor: null }),
    ]));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => !o.ok)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: expect.stringMatching(/^(event_full|capacity)$/) });
    const taken = (await sql.unsafe(`SELECT COALESCE(SUM(party_size), 0)::int AS n FROM registrations WHERE event_id = $1`, [eventId]))[0].n;
    expect(taken).toBe(3); // exactly one more person fit; the loser was asked to confirm instead of overbooking
  });

  it('two desks checking the same person in at once produce one row and one history entry', async () => {
    const { reg } = await newReg({}, ['Ann', 'Tim']);
    const attendees = await sql.unsafe('SELECT id FROM reg_attendees WHERE registration_id = $1 ORDER BY sort', [reg.id]);
    const outcomes = await withClients(8, (dbs) => Promise.all(dbs.map((d) => checkIn(d, attendees[0].id, null))));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.filter((o) => o.ok && !o.already)).toHaveLength(1);
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM reg_checkins WHERE attendee_id = $1', [attendees[0].id]))[0].n).toBe(1);
    expect((await listActivity(db, reg.id)).filter((a) => a.action === 'checkin')).toHaveLength(1);
    // party check-in racing the single check-in: still one row per person
    const party = await withClients(4, (dbs) => Promise.all(dbs.map((d) => checkInParty(d, reg.id, null))));
    expect(party.every((o) => o.ok)).toBe(true);
    const total = party.reduce((sum, o) => sum + (o.ok ? o.checkedIn : 0), 0);
    expect(total).toBe(1); // only Tim was still outside
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id WHERE a.registration_id = $1', [reg.id]))[0].n).toBe(2);
  });

  it('overlapping outbox claims never return the same row twice', async () => {
    const eventId = await saveEvent(db, { title_en: 'Mail', starts_at: tsAt(30 * DAY), active: 1 });
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await createRegistration(db, { eventId, personId: null, name: `G${i}`, email: `g${i}@example.com`, status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], submissionKey: `mail-${eventId}-${i}` });
      ids.push(r.id);
    }
    expect(await enqueueOutbox(db, { eventId, kind: 'bulk', subject: 'S', body: 'B', registrationIds: ids, createdBy: null })).toEqual({ ok: true, queued: 40 });
    const claims = await withClients(4, (dbs) => Promise.all(dbs.map((d) => claimOutbox(d, { limit: 25, eventId }))));
    const all = claims.flat().map((r) => r.id);
    expect(new Set(all).size).toBe(all.length); // no row claimed twice
    expect(all.length).toBeLessThanOrEqual(40);
    expect(all.length).toBeGreaterThan(0);
    claims.forEach((c) => expect(c.every((r) => r.attempts === 1)).toBe(true));
    // whatever was left unclaimed by the losers is claimable now, and nothing is claimed twice overall
    const rest = await claimOutbox(db, { limit: 100, eventId });
    const everything = [...all, ...rest.map((r) => r.id)];
    expect(new Set(everything).size).toBe(everything.length);
    expect(everything).toHaveLength(40);
  });

  it('two crons claiming the same reminder: exactly one wins', async () => {
    const { reg } = await newReg({ reminder_days: 3, starts_at: tsAt(DAY) });
    const wins = await withClients(6, (dbs) => Promise.all(dbs.map((d) => claimReminder(d, reg.id))));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('racing refunds can never pass what was paid', async () => {
    const { reg } = await newReg();
    await sql.unsafe(`UPDATE registrations SET amount_cents = 1000, payment_method = 'stripe' WHERE id = $1`, [reg.id]);
    const outcomes = await withClients(6, (dbs) => Promise.all(dbs.map((d) => recordRefund(d, reg.id, 400, 'stripe'))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2); // 400 + 400 fits, a third does not
    expect(outcomes.filter((o) => !o.ok)).toEqual(Array(4).fill({ ok: false, code: 'exceeds_paid' }));
    expect((await sql.unsafe('SELECT refunded_cents FROM registrations WHERE id = $1', [reg.id]))[0].refunded_cents).toBe(800);
  });

  it('the paid Checkout writer refuses an event that requires approval, before reserving anything', async () => {
    const eventId = await saveEvent(db, { title_en: 'Approval', starts_at: tsAt(30 * DAY), active: 1, requires_approval: 1 });
    await expect(resolveRegistrationCheckoutRequest(db, {
      requestId: `00000000-0000-4000-8000-000000009999`, eventId, personId: null, name: 'Ada', email: 'ada@example.com',
      amountCents: 2500, currency: 'usd', answers: [], eventTitle: 'Approval', locale: 'en', appOrigin: 'http://localhost:4321',
    })).rejects.toThrow('approval_requires_free');
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1', [eventId]))[0].n).toBe(0);
  });

  it('a card-paid registration is recorded as stripe once a Checkout session is attached', async () => {
    const eventId = await saveEvent(db, { title_en: 'Paid', starts_at: tsAt(30 * DAY), active: 1, price_cents: 2500 });
    const reg = await createRegistration(db, { eventId, personId: null, name: 'Ada', email: 'ada@example.com', status: 'pending', amountCents: 2500, currency: 'usd', answers: [] });
    expect((await sql.unsafe('SELECT payment_method FROM registrations WHERE id = $1', [reg.id]))[0].payment_method).toBeNull();
    const { attachCheckoutSession } = await import('../../src/lib/regDb');
    await attachCheckoutSession(db, reg.id, `cs_test_${Date.now()}`);
    expect((await sql.unsafe('SELECT payment_method FROM registrations WHERE id = $1', [reg.id]))[0].payment_method).toBe('stripe');
  });
});
