// Children's check-in e2e against the BUILT worker (SELF.fetch): the kiosk is
// gated by the token in the URL (no session — a bad token 404s), the search →
// household → check-in flow issues a pickup code, /admin/children is
// adminOnly (anon 303 signin, editor 403, admin 200 with the seeded chart
// non-empty), and the children module gate 404s both surfaces when off.
//
// Seed anchors: the fixed dev kiosk token 'devkiosk1234567890abcdef12345678'
// (seed/dev-seed.sql), household 2 (Lin Family) with children Noah Lin (member
// id 8) and Lily Lin (member id 9), checkin_events id 1 ('Sunday Kids 主日儿童',
// weekday=0). Because that seeded event only offers on real Sundays, the
// search→checkin test inserts its own weekday-agnostic event directly so the
// flow is deterministic regardless of which day the suite runs.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const KIOSK_TOKEN = 'devkiosk1234567890abcdef12345678';

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

describe('children check-in kiosk', () => {
  it('kiosk 404s on a bad token', async () => {
    const res = await get('/kiosk/wrongtoken12345');
    expect(res.status).toBe(404);
  });

  it('kiosk search → household → check-in shows a pickup code', async () => {
    // The seeded event only offers on real Sundays (weekday=0); insert a
    // weekday-agnostic event directly so this test passes on any day.
    const ev = await env.DB
      .prepare(`INSERT INTO checkin_events (name, weekday, active) VALUES ('E2E Nursery', NULL, 1) RETURNING id`)
      .first<{ id: number }>();
    const eventId = ev!.id;

    // Search by child name (household 2's Lin children) surfaces the household.
    const search = await get(`/kiosk/${KIOSK_TOKEN}/?lang=en&q=Lin`);
    expect(search.status).toBe(200);
    const searchBody = await search.text();
    expect(searchBody).toContain('Lin Family');
    expect(searchBody).toContain(`/kiosk/${KIOSK_TOKEN}/household/2`);

    // Check in Noah Lin (household_member id 8) to the freshly created event.
    const body = new URLSearchParams();
    body.append('action', 'checkin');
    body.append('lang', 'en');
    body.append('member', '8');
    body.append('event', String(eventId));
    const checkin = await post(`/kiosk/${KIOSK_TOKEN}/household/2`, body.toString());
    expect(checkin.status).toBe(200);
    const checkinBody = await checkin.text();
    expect(checkinBody).toContain('Noah Lin 林诺亚');
    expect(checkinBody).toMatch(/[A-HJ-NP-Z2-9]{4}/);
  });
});

describe('children admin console access', () => {
  it('anonymous /admin/children redirects to signin', async () => {
    const res = await get('/admin/children');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('editor gets 403 for /admin/children', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const res = await get('/admin/children', { cookie: editor });
    expect(res.status).toBe(403);
  });

  it('admin sees the children console', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await get('/admin/children', { cookie: admin });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Children check-in');
    // The dashboard tab (default) renders the weekly chart; the seeded
    // historical checkins (6 recent Sundays) keep it out of the empty state.
    expect(body).not.toContain('No check-ins yet. The chart fills in as families use the kiosk.');
  });
});

describe('children module off', () => {
  // Restore every module ON (and bust the per-isolate cache) after each test,
  // mirroring modules.e2e.test.ts / people-admin.e2e.test.ts.
  afterEach(async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await post('/admin/settings', modulesBody([]), { cookie: admin });
  });

  it('disabling the children module 404s both /kiosk/<token> and /admin/children', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');

    // Baseline: children on → both surfaces serve.
    expect((await get(`/kiosk/${KIOSK_TOKEN}`)).status).toBe(200);
    expect((await get('/admin/children', { cookie: admin })).status).toBe(200);

    const off = await post('/admin/settings', modulesBody(['children']), { cookie: admin });
    expect(off.status).toBe(303);

    expect((await get(`/kiosk/${KIOSK_TOKEN}`)).status).toBe(404);
    expect((await get('/admin/children', { cookie: admin })).status).toBe(404);

    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    expect((await get(`/kiosk/${KIOSK_TOKEN}`)).status).toBe(200);
    expect((await get('/admin/children', { cookie: admin })).status).toBe(200);
  });
});
