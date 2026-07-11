// Postgres-backed e2e for the member portal's read models across giving,
// the dashboard, events, and serving (Member Portal Phase 3, Task 4): owner
// vs. non-owner household giving scope, the /my dashboard's portal card row,
// /my/events' email-match registration path (also surfaced on the
// dashboard), and /my/serving. seed/dev-seed.sql + seed/portal-seed.sql carry
// no giving/registration rows (see test/e2e-pg/setup.ts's header — the giving
// and registration seed files are deliberately NOT loaded here), so this file
// fabricates a fund + two gifts + a reg_event + a registration directly
// through the library writers (saveFund/recordManualGift/saveEvent/
// createRegistration) in a beforeAll — the SAME writers the admin console and
// Stripe webhooks use — rather than hand-rolled SQL.
//
// Seed anchors reused from portal-household.test.ts / portal-groups.test.ts:
// David Chen (person 2) owns the Chen household (id 1, 'Chen Family 陈家', 4
// members: David, Amy, and dependents Ethan + Mia) and leads group 1 (Young
// Adults Fellowship); Amy Chen (person 7) is a non-owner adult in the same
// household. Sarah Johnson (person 3) has one seeded PENDING application to
// group 1, so David's dashboard pending-applications card has a real
// applicant. David also has a seeded CONFIRMED roster_assignments row (plan
// 9, position 1 'Worship Leader' on the Worship Team, Chinese Sunday
// Worship) landing on this week's Sunday — plan_date is always >= today
// regardless of timezone, since todayInTz's America/Chicago clock always
// lags the seed's UTC 'weekday 0' date — the concrete /my/serving assertion.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import { saveFund } from '../../src/lib/fundDb';
import { recordManualGift } from '../../src/lib/givingDb';
import { saveEvent, createRegistration } from '../../src/lib/regDb';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Open a request-scoped Postgres AppDb (same factory the worker uses), run
 *  `fn`, then drain the client — mirrors portal-household.test.ts. */
async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}

const DAVID_ID = 2;
const DAVID_EMAIL = 'pastor.david@example.com';
const AMY_ID = 7;
const AMY_EMAIL = 'amy.chen@example.com';
const ADMIN_ID = 1;

beforeAll(async () => {
  // A fund + two succeeded gifts against the SAME household (David and Amy,
  // both seeded members of household 1) so the owner/non-owner giving-scope
  // test has real household data to diverge on. Same calendar year (2026) so
  // the household year-total assertion sums both gifts in one row.
  const fundId = await withDb((db) =>
    saveFund(db, { fund_number: 'E2E-GIVE', name_en: 'E2E Giving Fund', name_zh: '', active: 1, sort: 99 }),
  );
  await withDb((db) =>
    recordManualGift(db, {
      personId: DAVID_ID,
      fundId,
      amountCents: 5000,
      method: 'cash',
      receivedOn: '2026-01-15',
      recordedBy: ADMIN_ID,
      currency: 'usd',
    }),
  );
  await withDb((db) =>
    recordManualGift(db, {
      personId: AMY_ID,
      fundId,
      amountCents: 2500,
      method: 'cash',
      receivedOn: '2026-02-20',
      recordedBy: ADMIN_ID,
      currency: 'usd',
    }),
  );

  // A far-future, always-open reg_event, plus a registration for Amy made by
  // email only (person_id NULL) — the email-match half of
  // listRegistrationsForPerson's `person_id = ? OR email = ?` match.
  const eventId = await withDb((db) =>
    saveEvent(db, {
      title_en: 'E2E Fixture Retreat',
      title_zh: '',
      starts_at: '2099-06-01 10:00:00',
      active: 1,
    }),
  );
  await withDb((db) =>
    createRegistration(db, {
      eventId,
      personId: null,
      name: 'Amy Chen',
      email: AMY_EMAIL,
      status: 'confirmed',
      amountCents: 0,
      currency: 'usd',
      answers: [],
    }),
  );
});

describe('Postgres-backed worker: /my/giving (owner vs. non-owner scope)', () => {
  it("owner (David) GETs /en/my/giving: 200, household ledger shows BOTH his and Amy's gifts", async () => {
    const res = await get('/en/my/giving', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('陈大卫 David Chen'); // David's own gift row (giver_name)
    expect(body).toContain('Amy Chen 陈爱美'); // Amy's gift, visible to the household owner
    expect(body).toContain('E2E Giving Fund');
    expect(body).toContain('$50.00'); // David's gift
    expect(body).toContain('$25.00'); // Amy's gift
    expect(body).toContain('$75.00'); // household year total: 5000 + 2500 cents
    expect(body).not.toContain('Showing your own giving.'); // owner never sees the own-scope explainer
  });

  it("non-owner (Amy) GETs /en/my/giving: 200, own-only scope + explainer note, David's gift absent", async () => {
    const res = await get('/en/my/giving', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Showing your own giving.'); // portal.giving.ownScopeNote
    expect(body).toContain('Amy Chen 陈爱美');
    expect(body).toContain('$25.00'); // her own gift + her own year total
    expect(body).not.toContain('陈大卫 David Chen'); // David's gift row never appears
    expect(body).not.toContain('$50.00'); // David's amount never appears
    expect(body).not.toContain('$75.00'); // the household total never appears to a non-owner
  });
});

describe('Postgres-backed worker: /my (dashboard portal cards)', () => {
  it('David GETs /en/my: 200, household/groups/pending-application cards + PortalNav', async () => {
    const res = await get('/en/my', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('My Portal'); // PortalNav aria-label — proves the nav renders
    expect(body).toContain('Chen Family 陈家'); // household card: household.name
    expect(body).toContain('4 members'); // portal.dashboard.memberCount — David, Amy, Ethan, Mia
    expect(body).toContain('1 groups'); // portal.dashboard.groupCount — David leads group 1 only
    expect(body).toContain('Young Adults Fellowship'); // myGroups name preview
    expect(body).toContain('Pending approvals'); // portal.dashboard.pendingApprovals card heading
    expect(body).toContain('1 applications'); // portal.dashboard.pendingApplications: leader of group 1, Sarah's seeded pending app
  });
});

describe('Postgres-backed worker: /my/events (registration, email-match path)', () => {
  it("Amy GETs /en/my/events: 200, her email-matched registration (person_id NULL) is listed", async () => {
    const res = await get('/en/my/events', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('My registrations'); // portal.events.mine
    expect(body).toContain('E2E Fixture Retreat');
    expect(body).toContain('Confirmed'); // portal.events.status.confirmed
  });

  it("Amy GETs /en/my: 200, the dashboard's upcoming-events card also shows the registration", async () => {
    const res = await get('/en/my', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Upcoming events'); // portal.dashboard.upcomingEvents
    expect(body).toContain('E2E Fixture Retreat');
  });
});

describe('Postgres-backed worker: /my/serving', () => {
  it("David GETs /en/my/serving: 200, sections render, his seeded confirmed Worship Leader assignment shows", async () => {
    const res = await get('/en/my/serving', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('My Portal'); // PortalNav
    // Seeded roster_assignments (plan 9, position 1, person 2, status 'C'):
    // David is confirmed as Worship Leader on the Chinese Sunday Worship plan.
    expect(body).toContain('Worship Leader');
    expect(body).toContain('Worship Team');
    expect(body).toContain('Confirmed'); // serve.status.C via StatusBadge
    expect(body).toContain('My teams'); // portal.serving.myTeams section heading
    expect(body).toContain('Serving history'); // portal.serving.history section heading
  });
});
