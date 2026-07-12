// Person-scoped readers added on top of the (Supabase-only) regDb/givingDb
// modules: a signed-in member's own registrations and their own gifts. Both new
// functions are dialect-neutral SQL (no RETURNING/currval/PG-only ON CONFLICT),
// so — like groupDb.test.ts — they're exercised here against the live D1 unit
// harness rather than test/pg's real-Postgres suite. reg_events/reg_event_i18n/
// registrations and funds/fund_i18n/gifts have no D1 migration counterpart (the
// full schemas live in migrations-supabase/0003_registration.sql and
// migrations-supabase/0002_giving.sql), so per groupDb.test.ts's documented
// fallback we CREATE TABLE IF NOT EXISTS them here, matching the PG DDL minus
// identity (plain INTEGER PRIMARY KEY). households/household_members already
// exist in the D1 schema (migrations/0003_people.sql).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listRegistrationsForPerson } from '../src/lib/regDb';
import { listPersonGifts, personYearTotals } from '../src/lib/givingDb';

await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS reg_events (
     id INTEGER PRIMARY KEY,
     starts_at TEXT NOT NULL,
     ends_at TEXT,
     location TEXT,
     capacity INTEGER,
     price_cents INTEGER,
     currency TEXT NOT NULL DEFAULT 'usd',
     opens_at TEXT,
     closes_at TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS reg_event_i18n (
     event_id INTEGER NOT NULL REFERENCES reg_events(id),
     locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
     title TEXT NOT NULL,
     description TEXT,
     PRIMARY KEY (event_id, locale)
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS registrations (
     id INTEGER PRIMARY KEY,
     event_id INTEGER NOT NULL REFERENCES reg_events(id),
     person_id INTEGER REFERENCES people(id),
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
     amount_cents INTEGER NOT NULL DEFAULT 0,
     currency TEXT NOT NULL DEFAULT 'usd',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS funds (
     id INTEGER PRIMARY KEY,
     fund_number TEXT NOT NULL UNIQUE,
     active INTEGER NOT NULL DEFAULT 1,
     sort INTEGER NOT NULL DEFAULT 0
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS fund_i18n (
     fund_id INTEGER NOT NULL REFERENCES funds(id),
     locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
     name TEXT NOT NULL,
     PRIMARY KEY (fund_id, locale)
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS gifts (
     id INTEGER PRIMARY KEY,
     person_id INTEGER REFERENCES people(id),
     donor_name TEXT,
     donor_email TEXT,
     fund_id INTEGER NOT NULL REFERENCES funds(id),
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL DEFAULT 'usd',
     method TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     received_on TEXT,
     check_number TEXT,
     note TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM registrations'),
    env.DB.prepare('DELETE FROM reg_event_i18n'),
    env.DB.prepare('DELETE FROM reg_events'),
    env.DB.prepare('DELETE FROM gifts'),
    env.DB.prepare('DELETE FROM fund_i18n'),
    env.DB.prepare('DELETE FROM funds'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const rows = [1, 2, 3].map((id) =>
    env.DB
      .prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)')
      .bind(id, `Person ${id}`, `p${id}@example.com`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

describe('listRegistrationsForPerson', () => {
  async function seedEvent(id: number, title: string, startsAt: string): Promise<void> {
    await env.DB.prepare(`INSERT INTO reg_events (id, starts_at) VALUES (?, ?)`).bind(id, startsAt).run();
    await env.DB.prepare(`INSERT INTO reg_event_i18n (event_id, locale, title) VALUES (?, 'en', ?)`).bind(id, title).run();
  }

  it('matches by person_id, by case-insensitive email, excludes cancelled and other people', async () => {
    await seedEvent(1, 'Retreat', '2026-09-01 09:00:00');
    await seedEvent(2, 'Picnic', '2026-08-01 09:00:00');
    await seedEvent(3, 'Gala', '2026-10-01 09:00:00');

    // person_id hit (email deliberately different from the account's).
    await env.DB
      .prepare(
        `INSERT INTO registrations (event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (1, 1, 'Person 1', 'other@example.com', 'confirmed', 1000, 'usd')`,
      )
      .run();
    // email-only hit, case-insensitive, no person_id linked.
    await env.DB
      .prepare(
        `INSERT INTO registrations (event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (2, NULL, 'Person 1', 'P1@EXAMPLE.COM', 'pending', 0, 'usd')`,
      )
      .run();
    // cancelled — excluded even though person_id matches.
    await env.DB
      .prepare(
        `INSERT INTO registrations (event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (3, 1, 'Person 1', 'p1@example.com', 'cancelled', 500, 'usd')`,
      )
      .run();
    // another person entirely — excluded.
    await env.DB
      .prepare(
        `INSERT INTO registrations (event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (1, 2, 'Person 2', 'p2@example.com', 'confirmed', 1000, 'usd')`,
      )
      .run();

    const mine = await listRegistrationsForPerson(env.DB, 'en', 1, 'p1@example.com');
    expect(mine.map((r) => r.event_title).sort()).toEqual(['Picnic', 'Retreat']);
    expect(mine.map((r) => r.status).sort()).toEqual(['confirmed', 'pending']);
    // newest event first (starts_at DESC): Retreat (09-01) before Picnic (08-01).
    expect(mine.map((r) => r.event_title)).toEqual(['Retreat', 'Picnic']);
  });

  it('returns [] for a person with no registrations', async () => {
    await seedEvent(1, 'Retreat', '2026-09-01 09:00:00');
    expect(await listRegistrationsForPerson(env.DB, 'en', 99, 'nobody@example.com')).toEqual([]);
  });
});

describe('listPersonGifts / personYearTotals', () => {
  async function seedFund(id: number, name: string): Promise<void> {
    await env.DB.prepare(`INSERT INTO funds (id, fund_number) VALUES (?, ?)`).bind(id, `F${id}`).run();
    await env.DB.prepare(`INSERT INTO fund_i18n (fund_id, locale, name) VALUES (?, 'en', ?)`).bind(id, name).run();
  }
  async function household(id: number, memberPersonIds: number[]): Promise<void> {
    await env.DB.prepare(`INSERT INTO households (id, name) VALUES (?, 'Fam')`).bind(id).run();
    for (const pid of memberPersonIds) {
      await env.DB
        .prepare(`INSERT INTO household_members (household_id, person_id, display_name) VALUES (?, ?, 'M')`)
        .bind(id, pid)
        .run();
    }
  }

  it('is person-scoped: excludes a household member\'s gift even though they share a household', async () => {
    await seedFund(1, 'General');
    await household(1, [1, 2]);
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (1, 1, 1000, 'cash', 'succeeded', '2026-01-01')`)
      .run();
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (2, 1, 2000, 'cash', 'succeeded', '2026-01-02')`)
      .run();

    const mine = await listPersonGifts(env.DB, 'en', 1);
    expect(mine).toHaveLength(1);
    expect(mine[0].amount_cents).toBe(1000);
    expect(mine[0].person_id).toBe(1);
  });

  it('includes refunded gifts in the ledger and resolves fund_name/giver_name', async () => {
    await seedFund(1, 'General');
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (1, 1, 500, 'card', 'refunded', '2026-01-01')`)
      .run();
    const mine = await listPersonGifts(env.DB, 'en', 1);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('refunded');
    expect(mine[0].fund_name).toBe('General');
    expect(mine[0].giver_name).toBe('Person 1');
  });

  it('personYearTotals sums succeeded-only money per year, scoped to the person', async () => {
    await seedFund(1, 'General');
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (1, 1, 1000, 'cash', 'succeeded', '2025-06-01')`)
      .run();
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (1, 1, 2000, 'cash', 'succeeded', '2026-01-01')`)
      .run();
    // refunded — excluded from the total.
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (1, 1, 9999, 'card', 'refunded', '2026-02-01')`)
      .run();
    // another person's gift — must not bleed into this total.
    await env.DB
      .prepare(`INSERT INTO gifts (person_id, fund_id, amount_cents, method, status, received_on) VALUES (2, 1, 5000, 'cash', 'succeeded', '2026-01-01')`)
      .run();

    const totals = await personYearTotals(env.DB, 1);
    const byYear = Object.fromEntries(totals.map((t) => [t.year, t.total_cents]));
    expect(byYear['2025']).toBe(1000);
    expect(byYear['2026']).toBe(2000);
  });
});
