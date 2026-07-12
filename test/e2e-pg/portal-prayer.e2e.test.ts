// Postgres-backed member-portal Prayer Wall coverage. These tests deliberately
// use the seeded public-groups rows: Esther (9) belongs to private group 2 and
// Faithful (6) is its group admin; Lydia (11) is an admin but not a super admin
// or a member of that group. That makes the route-level authority boundary
// explicit: an ordinary limited admin must not become a church-wide moderator
// merely by holding other admin-area grants.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Query through the same Postgres adapter the worker uses, then release the
 * request-scoped client. The rendered routes above remain the behavior under
 * test; this only proves the moderation status persisted after each PRG action. */
async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}

async function prayerItem(body: string): Promise<{ id: number; status: string }> {
  const row = await withDb((db) =>
    db.prepare('SELECT id, status FROM prayer_items WHERE body = ?1').bind(body).first<{ id: number; status: string }>(),
  );
  expect(row).not.toBeNull();
  return row!;
}

const ALEX = { id: 1, email: 'admin@example.com' }; // seeded super admin
const LYDIA = { id: 11, email: 'lydia.kwan@example.com' }; // limited admin (groups,events grants only)
const FAITHFUL = { id: 6, email: 'faithful.wang@example.com' }; // group 2 admin
const ESTHER = { id: 9, email: 'esther.lin@example.com' }; // group 2 member
const BEN = { id: 8, email: 'ben.wu@example.com' }; // not a group 2 member

describe('Postgres-backed worker: /my/prayer moderation authority', () => {
  it('keeps church prayers pending when a limited admin tries to moderate them, then lets the super admin approve', async () => {
    const body = 'PG-PORTAL-PRAYER-CHURCH-LIMITED-ADMIN';
    const authorCookie = await sessionCookie(ESTHER.id, ESTHER.email);

    const posted = await post('/en/my/prayer', `_action=post&scope=church&body=${encodeURIComponent(body)}&tab=church`, {
      cookie: authorCookie,
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('/en/my/prayer?tab=church&ok=posted');

    const pending = await prayerItem(body);
    expect(pending.status).toBe('pending');

    const lydiaCookie = await sessionCookie(LYDIA.id, LYDIA.email);
    const lydiaPending = await (await get('/en/my/prayer?tab=pending', { cookie: lydiaCookie })).text();
    expect(lydiaPending).not.toContain(body);

    const denied = await post('/en/my/prayer', `_action=approve&item_id=${pending.id}&tab=pending`, { cookie: lydiaCookie });
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/en/my/prayer?tab=pending&err=generic');
    expect((await prayerItem(body)).status).toBe('pending');

    const alexCookie = await sessionCookie(ALEX.id, ALEX.email);
    const adminPending = await (await get('/en/my/prayer?tab=pending', { cookie: alexCookie })).text();
    expect(adminPending).toContain(body);

    const approved = await post('/en/my/prayer', `_action=approve&item_id=${pending.id}&tab=pending`, { cookie: alexCookie });
    expect(approved.status).toBe(303);
    expect(approved.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');
    expect((await prayerItem(body)).status).toBe('approved');

    const benChurch = await (await get('/en/my/prayer?tab=church', { cookie: await sessionCookie(BEN.id, BEN.email) })).text();
    expect(benChurch).toContain(body);
  });

  it('lets only the prayer group admin approve a group prayer and limits its approved visibility to group members', async () => {
    const body = 'PG-PORTAL-PRAYER-GROUP-SCOPE';
    const estherCookie = await sessionCookie(ESTHER.id, ESTHER.email);

    const posted = await post(
      '/en/my/prayer',
      `_action=post&scope=group&group_id=2&body=${encodeURIComponent(body)}&tab=groups`,
      { cookie: estherCookie },
    );
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('/en/my/prayer?tab=groups&ok=posted');

    const pending = await prayerItem(body);
    expect(pending.status).toBe('pending');

    const lydiaCookie = await sessionCookie(LYDIA.id, LYDIA.email);
    const denied = await post('/en/my/prayer', `_action=approve&item_id=${pending.id}&tab=pending`, { cookie: lydiaCookie });
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/en/my/prayer?tab=pending&err=generic');
    expect((await prayerItem(body)).status).toBe('pending');

    const faithfulCookie = await sessionCookie(FAITHFUL.id, FAITHFUL.email);
    const leaderPending = await (await get('/en/my/prayer?tab=pending', { cookie: faithfulCookie })).text();
    expect(leaderPending).toContain(body);

    const approved = await post('/en/my/prayer', `_action=approve&item_id=${pending.id}&tab=pending`, { cookie: faithfulCookie });
    expect(approved.status).toBe(303);
    expect(approved.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');
    expect((await prayerItem(body)).status).toBe('approved');

    const estherGroups = await (await get('/en/my/prayer?tab=groups', { cookie: estherCookie })).text();
    expect(estherGroups).toContain(body);
    const benGroups = await (await get('/en/my/prayer?tab=groups', { cookie: await sessionCookie(BEN.id, BEN.email) })).text();
    expect(benGroups).not.toContain(body);
  });
});
