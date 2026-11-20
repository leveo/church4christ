// Registration event-builder behavior on Postgres: the shared cases (test/shared/regBuilderCases.ts,
// also run on D1) plus what only Postgres can do - paid ticket types (Stripe line items, amounts,
// per-type capacity in the paid writer) and true two-connection concurrency for the last seat of a
// ticket type. Self-skips without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import type { AppDb } from '../../src/lib/appDb';
import {
  createRegistration,
  listTicketTypes,
  listTicketTypesAdmin,
  saveEvent,
  saveEventForm,
  type EventFormPayload,
} from '../../src/lib/regDb';
import {
  buildRegistrationCheckoutParams,
  checkoutParamsTotal,
  registrationCheckoutRequestDigest,
  resolveRegistrationCheckoutRequest,
  type RegistrationCheckoutRequestInput,
} from '../../src/lib/stripeCheckoutRequests';
import { sha256Utf8 } from '../../src/lib/stripeWebhookInbox';
import { defineRegBuilderCases, tsAt } from '../shared/regBuilderCases';

const DAY = 24 * 3600_000;

describe.skipIf(!hasPg)('registration builder (Postgres)', () => {
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

  defineRegBuilderCases('Postgres', () => db, 'supabase');
  defineRegBuilderCases('Postgres, campus-scoped', () => scopeDatabase(db, 1), 'supabase');

  const save = async (eventId: number, payload: EventFormPayload) => {
    expect(await saveEventForm(db, eventId, payload, { backend: 'supabase' })).toEqual({ ok: true });
  };
  const typedEvent = async (tickets: NonNullable<EventFormPayload['tickets']>, over: Partial<Parameters<typeof saveEvent>[1]> = {}) => {
    const id = await saveEvent(db, { title_en: 'Paid Camp', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 6, price_cents: 9999, ...over });
    await save(id, { tickets });
    return { id, types: await listTicketTypesAdmin(db, id) };
  };
  const adult = { labels: { en: 'Adult' }, price_cents: 2500 };
  const child = { labels: { en: 'Child' }, price_cents: 1000 };
  const freebie = { labels: { en: 'Toddler' }, price_cents: 0 };

  let requestSeq = 900;
  const requestId = () => `00000000-0000-4000-8000-${String(++requestSeq).padStart(12, '0')}`;
  const checkoutInput = (eventId: number, over: Partial<RegistrationCheckoutRequestInput> = {}): RegistrationCheckoutRequestInput => ({
    requestId: requestId(), eventId, personId: null, name: 'Ada Lovelace', email: 'ada@example.com', amountCents: 2500, currency: 'usd',
    answers: [], eventTitle: 'Paid Camp', locale: 'en', appOrigin: 'http://localhost:4321', ...over,
  });

  describe('paid ticket types', () => {
    it('amount is the sum of the type prices (the event price is ignored); Checkout gets one line item per paid type', async () => {
      const { id, types } = await typedEvent([adult, child, freebie]);
      const tickets = (await listTicketTypes(db, 'en', id, { activeOnly: true })).map((t) => ({ ticketTypeId: t.id, unitAmountCents: t.price_cents, label: t.label }));
      const [a, c, f] = types;
      const resolution = await resolveRegistrationCheckoutRequest(db, checkoutInput(id, {
        tickets,
        party: { phone: null, attendees: [
          { name: 'Ada', personId: null, ticketTypeId: a.id }, { name: 'Bo', personId: null, ticketTypeId: c.id },
          { name: 'Cy', personId: null, ticketTypeId: c.id }, { name: 'Di', personId: null, ticketTypeId: f.id },
        ] },
      }));
      expect(resolution.kind).toBe('create');
      if (resolution.kind !== 'create') return;
      const lines = resolution.requestJson.line_items;
      expect(lines.map((l) => [l.quantity, l.price_data.unit_amount, l.price_data.product_data.name])).toEqual([
        [1, 2500, 'Paid Camp - Adult'], [2, 1000, 'Paid Camp - Child'],
      ]);
      expect(checkoutParamsTotal(resolution.requestJson)).toBe(4500);
      const [row] = await sql.unsafe('SELECT amount_cents, party_size, status FROM registrations WHERE id = $1', [resolution.registrationId]);
      expect([row.amount_cents, row.party_size, row.status]).toEqual([4500, 4, 'pending']);
      const attendees = await sql.unsafe('SELECT name, ticket_type_id FROM reg_attendees WHERE registration_id = $1 ORDER BY sort', [resolution.registrationId]);
      expect(attendees.map((x) => [x.name, Number(x.ticket_type_id)])).toEqual([['Ada', a.id], ['Bo', c.id], ['Cy', c.id], ['Di', f.id]]);
      // a retry converges on the same pair; the stored request is accepted as it was built
      const retry = await resolveRegistrationCheckoutRequest(db, checkoutInput(id, {
        requestId: (resolution as { requestId: string }).requestId, tickets,
        party: { phone: null, attendees: [
          { name: 'Ada', personId: null, ticketTypeId: a.id }, { name: 'Bo', personId: null, ticketTypeId: c.id },
          { name: 'Cy', personId: null, ticketTypeId: c.id }, { name: 'Di', personId: null, ticketTypeId: f.id },
        ] },
      }));
      expect(retry).toMatchObject({ kind: 'create', registrationId: resolution.registrationId });
    });

    it('the digest includes the types and prices; a plain (untyped) request digests exactly as before', async () => {
      const { id, types } = await typedEvent([adult, child]);
      const [a, c] = types;
      const party = (ticket: number) => ({ phone: null, attendees: [{ name: 'Ada', personId: null, ticketTypeId: ticket }] });
      const typed = checkoutInput(id, { requestId: '00000000-0000-4000-8000-0000000000aa', tickets: [{ ticketTypeId: a.id, unitAmountCents: 2500, label: 'Adult' }, { ticketTypeId: c.id, unitAmountCents: 1000, label: 'Child' }], party: party(a.id) });
      const base = await registrationCheckoutRequestDigest(typed);
      expect(await registrationCheckoutRequestDigest({ ...typed, party: party(c.id) })).not.toBe(base);
      expect(await registrationCheckoutRequestDigest({ ...typed, tickets: [{ ticketTypeId: a.id, unitAmountCents: 2600, label: 'Adult' }, { ticketTypeId: c.id, unitAmountCents: 1000, label: 'Child' }] })).not.toBe(base);
      // regression: single-person and party digests without types are byte-identical to the pre-builder algorithm
      const plain = checkoutInput(id, { answers: [[7, 'b'], [3, 'a']] });
      expect(await registrationCheckoutRequestDigest(plain)).toBe(await sha256Utf8(JSON.stringify({
        eventId: id, personId: null, name: 'Ada Lovelace', email: 'ada@example.com', amountCents: 2500, currency: 'usd', answers: [[3, 'a'], [7, 'b']],
      })));
      const party2 = checkoutInput(id, { party: { phone: ' 555 ', attendees: [{ name: 'Ada', personId: null }, { name: 'Bo', personId: 5 }] } });
      expect(await registrationCheckoutRequestDigest(party2)).toBe(await sha256Utf8(JSON.stringify({
        eventId: id, personId: null, name: 'Ada Lovelace', email: 'ada@example.com', amountCents: 2500, currency: 'usd', answers: [],
        party: { phone: '555', attendees: [{ name: 'Ada', personId: null }, { name: 'Bo', personId: 5 }] },
      })));
      // and an untyped request still builds the single party line item
      expect(buildRegistrationCheckoutParams({ ...party2, registrationId: 5 }).line_items).toEqual([
        { quantity: 2, price_data: { currency: 'usd', unit_amount: 2500, product_data: { name: 'Paid Camp' } } },
      ]);
    });

    it('refuses a ticket the event does not sell, a missing ticket, and a price that changed since the form was read', async () => {
      const { id, types } = await typedEvent([adult]);
      const other = await typedEvent([child]);
      const mk = (ticketTypeId: number | null, unit = 2500, forEvent = id) => checkoutInput(forEvent, {
        tickets: [{ ticketTypeId: types[0].id, unitAmountCents: unit, label: 'Adult' }],
        party: { phone: null, attendees: [{ name: 'Ada', personId: null, ...(ticketTypeId !== null ? { ticketTypeId } : {}) }] },
      });
      await expect(resolveRegistrationCheckoutRequest(db, mk(null))).rejects.toThrow('checkout_ticket_invalid');
      await expect(resolveRegistrationCheckoutRequest(db, mk(other.types[0].id))).rejects.toThrow('checkout_ticket_invalid');
      await expect(resolveRegistrationCheckoutRequest(db, mk(types[0].id, 2400))).rejects.toThrow('ticket_type_invalid');
      expect((await sql.unsafe('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1', [id]))[0].n).toBe(0);
    });

    it('a paid type over its limit throws event_full from the paid writer and the free-path writer, and holds no seat', async () => {
      const { id, types } = await typedEvent([{ ...adult, capacity: 1 }, child]);
      const [a, c] = types;
      const tickets = [{ ticketTypeId: a.id, unitAmountCents: 2500, label: 'Adult' }, { ticketTypeId: c.id, unitAmountCents: 1000, label: 'Child' }];
      const attendee = (ticketTypeId: number) => ({ phone: null, attendees: [{ name: 'Ada', personId: null, ticketTypeId }] });
      const first = await resolveRegistrationCheckoutRequest(db, checkoutInput(id, { tickets, party: attendee(a.id) }));
      expect(first.kind).toBe('create');
      // the pending adult seat is held: a second adult is refused, a child still fits
      await expect(resolveRegistrationCheckoutRequest(db, checkoutInput(id, { tickets, party: attendee(a.id) }))).rejects.toThrow('event_full');
      await expect(createRegistration(db, {
        eventId: id, personId: null, name: 'Bo', email: 'bo@example.com', status: 'pending', amountCents: 2500, currency: 'usd', answers: [],
        attendees: [{ name: 'Bo', ticketTypeId: a.id }],
      })).rejects.toThrow('event_full');
      const second = await resolveRegistrationCheckoutRequest(db, checkoutInput(id, { tickets, party: attendee(c.id) }));
      expect(second.kind).toBe('create');
      expect((await sql.unsafe('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1', [id]))[0].n).toBe(2);
      expect((await listTicketTypes(db, 'en', id)).map((t) => [t.taken, t.seats_left])).toEqual([[1, 0], [1, null]]);
    });

    it('createRegistration derives the amount from the types and a paid party never waitlists', async () => {
      const { id, types } = await typedEvent([{ ...adult, capacity: 1 }], { capacity: 5 });
      const made = await createRegistration(db, {
        eventId: id, personId: null, name: 'Ada', email: 'ada@example.com', status: 'pending', amountCents: 1, currency: 'usd', answers: [],
        attendees: [{ name: 'Ada', ticketTypeId: types[0].id }],
      });
      expect(made.status).toBe('pending');
      const [row] = await sql.unsafe('SELECT amount_cents FROM registrations WHERE id = $1', [made.id]);
      expect(row.amount_cents).toBe(2500);
      await expect(createRegistration(db, {
        eventId: id, personId: null, name: 'Bo', email: 'bo@example.com', status: 'pending', amountCents: 2500, currency: 'usd', answers: [],
        attendees: [{ name: 'Bo', ticketTypeId: types[0].id }],
      })).rejects.toThrow('event_full');
    });
  });

  describe('concurrent registrations for the last seat of a ticket type', () => {
    const contend = async (contenders: number, limit: number, waitlistEnabled: 0 | 1) => {
      const eventId = await saveEvent(db, { title_en: 'Type race', starts_at: tsAt(30 * DAY), active: 1, waitlist_enabled: waitlistEnabled });
      await save(eventId, { tickets: [{ labels: { en: 'Limited' }, capacity: limit }, { labels: { en: 'Open' } }] });
      const [limited, open] = (await listTicketTypesAdmin(db, eventId)).map((t) => t.id);
      const clients = Array.from({ length: contenders }, () => pgClient());
      try {
        const outcomes = await Promise.allSettled(
          clients.map((client, i) =>
            createRegistration(new PgAdapter(client), {
              eventId, personId: null, name: `P${i}`, email: `p${i}@example.com`, status: 'confirmed', amountCents: 0, currency: 'usd',
              answers: [], submissionKey: `type-race-${eventId}-${i}`,
              // every contender also brings an unlimited-type guest, which must not be affected
              attendees: [{ name: `P${i}`, ticketTypeId: limited }, { name: `G${i}`, ticketTypeId: open }],
            }),
          ),
        );
        return { eventId, limited, outcomes };
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    };

    it('two parallel connections for one seat of a type: exactly one confirmed, one waitlisted', async () => {
      const { eventId, outcomes } = await contend(2, 1, 1);
      expect(outcomes.map((o) => (o.status === 'fulfilled' ? o.value.status : `error:${o.reason}`)).sort()).toEqual(['confirmed', 'waitlist']);
      const [held] = await sql.unsafe(
        `SELECT count(*)::int AS n FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         JOIN reg_ticket_types t ON t.id = a.ticket_type_id
         WHERE r.event_id = $1 AND r.status = 'confirmed' AND a.status = 'active' AND t.capacity IS NOT NULL`,
        [eventId],
      );
      expect(held.n).toBe(1);
    });

    it('six contenders for two seats: exactly two confirmed, the rest waitlisted, none oversold', async () => {
      const { eventId, outcomes } = await contend(6, 2, 1);
      const statuses = outcomes.map((o) => (o.status === 'fulfilled' ? o.value.status : `error:${o.reason}`));
      expect(statuses.filter((s) => s === 'confirmed')).toHaveLength(2);
      expect(statuses.filter((s) => s === 'waitlist')).toHaveLength(4);
      const types = await listTicketTypes(db, 'en', eventId);
      expect(types[0].taken).toBe(2);
    });

    it('with the waitlist off, the losers get event_full and insert nothing', async () => {
      const { eventId, outcomes } = await contend(3, 1, 0);
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      const failed = outcomes.filter((o) => o.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed.map((o) => String((o as PromiseRejectedResult).reason.message))).toEqual(['event_full', 'event_full']);
      expect((await sql.unsafe('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1', [eventId]))[0].n).toBe(1);
    });
  });
});
