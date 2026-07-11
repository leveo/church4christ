// Postgres-backed e2e for the member portal's Prayer Wall (Member Portal Phase
// 5, Task 4): the four scoped tabs (church / groups / events / mine) plus the
// approver's pending queue, driven through the BUILT worker (SELF.fetch) over
// Postgres — exercising prayerDb.ts's authority model end to end via
// src/pages/[locale]/my/prayer.astro. The unit suite (test/prayerDb.test.ts)
// already proves every scope/eligibility/moderation edge case against the D1
// harness; this file proves the same scoped-approval matrix through real HTTP
// requests + rendered page bodies against real Postgres, per the Task 4 brief.
//
// Seed anchors reused from portal-groups.test.ts / portal-dashboard.test.ts:
// David Chen (person 2) leads group 1 (Young Adults Fellowship); Amy Chen
// (person 7) is a plain member of group 1; Ben Wu (person 8) belongs to no
// group. Person 1 (Alex Admin) is the lone role='admin' seed row — the church-
// scope moderator. reg_events/registrations/event_admins carry no seed rows
// (see portal-dashboard.test.ts's header), so the event-scope fixture (a
// far-future event, a confirmed registration for Amy, David granted
// event_admins) is fabricated in beforeAll through the same library writers
// (saveEvent/createRegistration/addEventAdmin) the admin console and Stripe
// webhook use.
//
// Each scope gets one distinctive prayer body (PRAYER-GROUP-E2E-1,
// PRAYER-CHURCH-E2E-1, PRAYER-PRIVATE-E2E-1, PRAYER-EVENT-E2E-1) so page-body
// assertions are unambiguous, plus a DB read confirming the status flip and a
// negative page-body assert for a viewer who should NOT see it yet/ever.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import { saveEvent, createRegistration } from '../../src/lib/regDb';
import { addEventAdmin } from '../../src/lib/prayerDb';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Open a request-scoped Postgres AppDb (same factory the worker uses), run
 *  `fn`, then drain the client — mirrors the other e2e-pg files. */
async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}

const ADMIN_ID = 1;
const ADMIN_EMAIL = 'admin@example.com';
const DAVID_ID = 2;
const DAVID_EMAIL = 'pastor.david@example.com';
const AMY_ID = 7;
const AMY_EMAIL = 'amy.chen@example.com';
const BEN_ID = 8;
const BEN_EMAIL = 'ben.wu@example.com';
const GROUP_1 = 1; // young-adults fellowship: David leads it, Amy is a member, Ben is not

let eventId: number;

beforeAll(async () => {
  // A far-future reg_event, a confirmed registration for Amy, and David
  // granted event_admins — the event-scope fixture (see file header; no
  // reg_events/registrations/event_admins ship in the seed).
  eventId = await withDb((db) =>
    saveEvent(db, {
      title_en: 'E2E Prayer Retreat',
      title_zh: '',
      starts_at: '2099-06-01 10:00:00',
      active: 1,
    }),
  );
  await withDb((db) =>
    createRegistration(db, {
      eventId,
      personId: AMY_ID,
      name: 'Amy Chen',
      email: AMY_EMAIL,
      status: 'confirmed',
      amountCents: 0,
      currency: 'usd',
      answers: [],
    }),
  );
  await withDb((db) => addEventAdmin(db, eventId, DAVID_ID));
});

/** Look up a fixture's id + status by its distinctive body string. */
async function findItem(body: string): Promise<{ id: number; status: string }> {
  const row = await withDb((db) =>
    db.prepare('SELECT id, status FROM prayer_items WHERE body = ?').bind(body).first<{ id: number; status: string }>(),
  );
  expect(row).not.toBeNull();
  return row!;
}

describe('Postgres-backed worker: /my/prayer — group scope', () => {
  const BODY = 'PRAYER-GROUP-E2E-1';

  it('Amy posts a group prayer to group 1: 303, lands pending, invisible on her own groups tab', async () => {
    const cookie = await sessionCookie(AMY_ID, AMY_EMAIL);
    const res = await post(
      '/en/my/prayer',
      `_action=post&scope=group&group_id=${GROUP_1}&body=${encodeURIComponent(BODY)}&tab=groups`,
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=groups&ok=posted');

    const row = await findItem(BODY);
    expect(row.status).toBe('pending');

    const body = await (await get('/en/my/prayer?tab=groups', { cookie })).text();
    expect(body).not.toContain(BODY); // still pending — group tab only shows approved items
  });

  it("David (group 1 leader) sees it on his pending tab and approves it", async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const pendingBody = await (await get('/en/my/prayer?tab=pending', { cookie })).text();
    expect(pendingBody).toContain(BODY);

    const { id } = await findItem(BODY);
    const res = await post('/en/my/prayer', `_action=approve&item_id=${id}&tab=pending`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');

    const row = await findItem(BODY);
    expect(row.status).toBe('approved');
  });

  it('approved group prayer is visible to Amy and David on the groups tab, absent for non-member Ben', async () => {
    const amyBody = await (await get('/en/my/prayer?tab=groups', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) })).text();
    expect(amyBody).toContain(BODY);

    const davidBody = await (await get('/en/my/prayer?tab=groups', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) })).text();
    expect(davidBody).toContain(BODY);

    const benBody = await (await get('/en/my/prayer?tab=groups', { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) })).text();
    expect(benBody).not.toContain(BODY); // Ben is in no group — never sees a group-scoped item
  });
});

describe('Postgres-backed worker: /my/prayer — church scope', () => {
  const BODY = 'PRAYER-CHURCH-E2E-1';

  it('Amy posts a church prayer: 303, lands pending, invisible to Ben until an admin approves', async () => {
    const amyCookie = await sessionCookie(AMY_ID, AMY_EMAIL);
    const res = await post('/en/my/prayer', `_action=post&scope=church&body=${encodeURIComponent(BODY)}&tab=church`, {
      cookie: amyCookie,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=church&ok=posted');

    const row = await findItem(BODY);
    expect(row.status).toBe('pending');

    const benBody = await (await get('/en/my/prayer?tab=church', { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) })).text();
    expect(benBody).not.toContain(BODY); // pending — church tab only shows approved items
  });

  it('admin (person 1) sees it on the pending tab and approves it; then Ben sees it on the church tab', async () => {
    const adminCookie = await sessionCookie(ADMIN_ID, ADMIN_EMAIL);
    const pendingBody = await (await get('/en/my/prayer?tab=pending', { cookie: adminCookie })).text();
    expect(pendingBody).toContain(BODY);

    const { id } = await findItem(BODY);
    const res = await post('/en/my/prayer', `_action=approve&item_id=${id}&tab=pending`, { cookie: adminCookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');

    const row = await findItem(BODY);
    expect(row.status).toBe('approved');

    const benBody = await (await get('/en/my/prayer?tab=church', { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) })).text();
    expect(benBody).toContain(BODY); // church scope is visible to everyone once approved
  });
});

describe('Postgres-backed worker: /my/prayer — private scope', () => {
  const BODY = 'PRAYER-PRIVATE-E2E-1';

  it('Amy posts a private prayer: 303, immediately approved, visible only on her own mine tab', async () => {
    const amyCookie = await sessionCookie(AMY_ID, AMY_EMAIL);
    const res = await post('/en/my/prayer', `_action=post&scope=private&body=${encodeURIComponent(BODY)}&tab=mine`, {
      cookie: amyCookie,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=mine&ok=posted');

    const row = await findItem(BODY);
    expect(row.status).toBe('approved'); // private auto-approves, no moderation

    const mineBody = await (await get('/en/my/prayer?tab=mine', { cookie: amyCookie })).text();
    expect(mineBody).toContain(BODY);
  });

  it('the private item never appears on the church tab or in an admin/leader pending queue', async () => {
    const churchBody = await (await get('/en/my/prayer?tab=church', { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) })).text();
    expect(churchBody).not.toContain(BODY);

    const adminPendingBody = await (
      await get('/en/my/prayer?tab=pending', { cookie: await sessionCookie(ADMIN_ID, ADMIN_EMAIL) })
    ).text();
    expect(adminPendingBody).not.toContain(BODY); // private never enters moderation
  });
});

describe('Postgres-backed worker: /my/prayer — event scope', () => {
  const BODY = 'PRAYER-EVENT-E2E-1';

  it('Amy (registered) posts an event prayer: 303, pending, invisible on her own events tab', async () => {
    const amyCookie = await sessionCookie(AMY_ID, AMY_EMAIL);
    const res = await post(
      '/en/my/prayer',
      `_action=post&scope=event&reg_event_id=${eventId}&body=${encodeURIComponent(BODY)}&tab=events`,
      { cookie: amyCookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=events&ok=posted');

    const row = await findItem(BODY);
    expect(row.status).toBe('pending');

    const eventsBody = await (await get('/en/my/prayer?tab=events', { cookie: amyCookie })).text();
    expect(eventsBody).not.toContain(BODY); // still pending
  });

  it('David (event admin) sees it on the pending tab and approves it; visible to both on the events tab', async () => {
    const davidCookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const pendingBody = await (await get('/en/my/prayer?tab=pending', { cookie: davidCookie })).text();
    expect(pendingBody).toContain(BODY);

    const { id } = await findItem(BODY);
    const res = await post('/en/my/prayer', `_action=approve&item_id=${id}&tab=pending`, { cookie: davidCookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');

    const row = await findItem(BODY);
    expect(row.status).toBe('approved');

    const amyEventsBody = await (await get('/en/my/prayer?tab=events', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) })).text();
    expect(amyEventsBody).toContain(BODY);

    const davidEventsBody = await (await get('/en/my/prayer?tab=events', { cookie: davidCookie })).text();
    expect(davidEventsBody).toContain(BODY); // David is an event admin, not a registrant, and still sees it
  });

  it("Ben (not registered, not an event admin) has an empty events tab", async () => {
    const benCookie = await sessionCookie(BEN_ID, BEN_EMAIL);
    const benBody = await (await get('/en/my/prayer?tab=events', { cookie: benCookie })).text();
    expect(benBody).not.toContain(BODY);
    expect(benBody).toContain('No event prayer requests yet.'); // portal.prayer.emptyEvents
  });
});
