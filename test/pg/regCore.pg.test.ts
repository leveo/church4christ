// Registration core behavior on Postgres (the same cases as test/regCore.d1.test.ts),
// plus true two-connection concurrency for the last seat. Self-skips without
// DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import type { AppDb } from '../../src/lib/appDb';
import { cancelRegistrationPromoting, createRegistration, saveEvent, listRegistrations } from '../../src/lib/regDb';
import { defineRegCoreCases, ts } from '../shared/regCoreCases';

const DAY = 24 * 3600_000;

describe.skipIf(!hasPg)('registration core (Postgres)', () => {
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

  defineRegCoreCases('Postgres', () => db);
  defineRegCoreCases('Postgres, campus-scoped', () => scopeDatabase(db, 1));

  describe('concurrent submissions for the last seat', () => {
    // Every contender gets its OWN connection (a separate postgres.js client), so
    // the batches genuinely overlap in the database.
    const contend = async (waitlistEnabled: 0 | 1, contenders: number, capacity: number) => {
      const eventId = await saveEvent(db, {
        title_en: 'Last seat', starts_at: ts(30 * DAY), active: 1, capacity, waitlist_enabled: waitlistEnabled,
      });
      const clients = Array.from({ length: contenders }, () => pgClient());
      try {
        const outcomes = await Promise.allSettled(
          clients.map((client, i) =>
            createRegistration(new PgAdapter(client), {
              eventId, personId: null, name: `P${i}`, email: `p${i}@example.com`, status: 'confirmed',
              amountCents: 0, currency: 'usd', answers: [], submissionKey: `race-${eventId}-${i}`,
            }),
          ),
        );
        return { eventId, outcomes };
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    };

    it('two parallel connections for one seat: exactly one confirmed, one waitlisted', async () => {
      const { eventId, outcomes } = await contend(1, 2, 1);
      const statuses = outcomes.map((o) => (o.status === 'fulfilled' ? o.value.status : `error:${o.reason}`)).sort();
      expect(statuses).toEqual(['confirmed', 'waitlist']);
      const numbers = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value.confirmationNo] : []));
      expect(new Set(numbers).size).toBe(2);
      const roster = await listRegistrations(db, 'en', eventId);
      expect(roster.filter((r) => r.status === 'confirmed')).toHaveLength(1);
    });

    it('two parallel connections for one seat with the waitlist off: one confirmed, one event_full, one row', async () => {
      const { eventId, outcomes } = await contend(0, 2, 1);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('event_full');
      expect(await listRegistrations(db, 'en', eventId)).toHaveLength(1);
    });

    it('six parallel connections for two seats: exactly two confirmed, four waitlisted, no oversell', async () => {
      const { eventId, outcomes } = await contend(1, 6, 2);
      expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
      const roster = await listRegistrations(db, 'en', eventId);
      expect(roster.filter((r) => r.status === 'confirmed')).toHaveLength(2);
      expect(roster.filter((r) => r.status === 'waitlist')).toHaveLength(4);
      expect(new Set(roster.map((r) => r.confirmation_no)).size).toBe(6);
    });

  describe('concurrent cancellations on a free event', () => {
    const seed = async (capacity: number, seated: number, waiting: number) => {
      const eventId = await saveEvent(db, { title_en: 'Cancel race', starts_at: ts(30 * DAY), active: 1, capacity, waitlist_enabled: 1 });
      const make = (i: number) => createRegistration(db, {
        eventId, personId: null, name: `P${i}`, email: `p${i}@example.com`, status: 'confirmed',
        amountCents: 0, currency: 'usd', answers: [], submissionKey: `cancel-race-${eventId}-${i}`,
      });
      const seats = [];
      for (let i = 0; i < seated; i++) seats.push(await make(i));
      const queue = [];
      for (let i = 0; i < waiting; i++) queue.push(await make(100 + i));
      expect(queue.every((q) => q.status === 'waitlist')).toBe(true);
      return { eventId, seats, queue };
    };
    const cancelConcurrently = async (ids: number[]) => {
      const clients = ids.map(() => pgClient());
      try {
        return await Promise.all(ids.map((id, i) => cancelRegistrationPromoting(new PgAdapter(clients[i]), id)));
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    };

    it('two parallel cancels promote each waitlisted registration exactly once', async () => {
      const { eventId, seats, queue } = await seed(2, 2, 2);
      const results = await cancelConcurrently(seats.map((s) => s.id));
      expect(results.every((r) => r.cancelled)).toBe(true);
      const promoted = results.flatMap((r) => r.promoted).sort((a, b) => a - b);
      expect(promoted).toEqual(queue.map((q) => q.id).sort((a, b) => a - b));
      const roster = await listRegistrations(db, 'en', eventId);
      expect(roster.filter((r) => r.status === 'confirmed').map((r) => r.id).sort()).toEqual(queue.map((q) => q.id).sort());
    });

    it('never promotes more than the seats freed, however the cancels interleave', async () => {
      const { eventId, seats, queue } = await seed(3, 3, 4);
      const results = await cancelConcurrently(seats.slice(0, 2).map((s) => s.id));
      const promoted = results.flatMap((r) => r.promoted);
      expect(promoted).toHaveLength(2);
      expect(new Set(promoted).size).toBe(2);
      const roster = await listRegistrations(db, 'en', eventId);
      expect(roster.filter((r) => r.status === 'confirmed')).toHaveLength(3);
      // the oldest two waiters were the ones promoted
      expect(promoted.sort((a, b) => a - b)).toEqual(queue.slice(0, 2).map((q) => q.id).sort((a, b) => a - b));
    });
  });

    it('two parallel requests with the same submission key create one registration', async () => {
      const eventId = await saveEvent(db, { title_en: 'Double click', starts_at: ts(30 * DAY), active: 1 });
      const clients = [pgClient(), pgClient()];
      try {
        const results = await Promise.all(
          clients.map((client) =>
            createRegistration(new PgAdapter(client), {
              eventId, personId: null, name: 'Same', email: 's@example.com', status: 'confirmed',
              amountCents: 0, currency: 'usd', answers: [], submissionKey: 'double-click-key',
            }),
          ),
        );
        expect(results[0].id).toBe(results[1].id);
        expect(await listRegistrations(db, 'en', eventId)).toHaveLength(1);
        const attendees = await sql`SELECT count(*)::int AS n FROM reg_attendees WHERE registration_id = ${results[0].id}`;
        expect(attendees[0].n).toBe(1);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });
  });
});
