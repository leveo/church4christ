// The check-in desk on D1, against the BUILT worker: a desk volunteer finds a party by the confirmation number a
// scanned QR sends, checks them in (plain form and in-page JSON), the counts and the polling marker move, and the
// page never shows contact details. A viewer cannot open the desk, and a desk volunteer cannot open the roster.
// Uses the seeded D1 event 920 (open, capacity 3).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';
import { grantEventRole } from '../../src/lib/regAccess';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const sessionCookie = async (id: number, email: string) => `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
const ADMIN = () => sessionCookie(1, 'admin@example.com');
const SARAH: [number, string] = [3, 'sarah.johnson@example.com'];
const GRACE: [number, string] = [4, 'grace.lin@example.com'];
const MARK: [number, string] = [5, 'mark.liu@example.com'];
const DESK = '/admin/registration/920/checkin';

async function enableRegistration(): Promise<void> {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) body.append(`module.${key}`, '1');
  expect((await post('/admin/settings', body.toString(), { cookie: await ADMIN() })).status).toBe(303);
}

beforeEach(async () => {
  const run = (sql: string) => env.DB.prepare(sql).run();
  for (const table of ['reg_checkins', 'reg_outbox', 'reg_activity', 'reg_event_access', 'reg_answers', 'reg_attendees', 'registrations', 'email_log', 'newcomer_rate_limits']) await run(`DELETE FROM ${table}`);
  await run(`DELETE FROM reg_ticket_types WHERE event_id IN (920, 930)`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1, capacity = 3, max_party_size = 4,
    allow_self_edit = 1, requires_approval = 0, reminder_days = NULL, confirmation_prefix = NULL, visible_from = NULL,
    starts_at = datetime('now','+14 days','start of day','+18 hours'), opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
});

describe('Check-in desk on D1', () => {
  it('a desk volunteer finds a party by confirmation number, checks them in, and the counts and poll marker move', async () => {
    await enableRegistration();
    const signup = new URLSearchParams({ locale: 'en', event_id: '920', checkoutRequestId: crypto.randomUUID(), '921': 'Main dish' });
    expect((await post('/api/register/submit', signup.toString(), { cookie: await sessionCookie(...SARAH) })).status).toBe(303);
    const reg = (await env.DB.prepare(`SELECT id, confirmation_no FROM registrations WHERE email = ?1`).bind(SARAH[1]).first<{ id: number; confirmation_no: string }>())!;
    const attendee = (await env.DB.prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1`).bind(reg.id).first<{ id: number }>())!;
    await grantEventRole(env.DB, 920, GRACE[0], 'desk');
    const desk = await sessionCookie(...GRACE);

    const empty = await (await get(DESK, { cookie: desk })).text();
    expect(empty).toContain('data-reg-desk');
    // Grace's language is Chinese in the seed. A desk-only volunteer has no event page to go back to.
    expect(empty).toContain('已报到 0 / 1 人');
    expect(empty).not.toContain('/admin/registration/920"');

    // What a scanned QR sends: the confirmation number.
    const found = await (await get(`${DESK}?q=${encodeURIComponent(reg.confirmation_no.toLowerCase())}`, { cookie: desk })).text();
    expect(found).toContain(`data-party="${reg.id}"`);
    expect(found).not.toContain(SARAH[1]);

    const poll = async () => (await (await get(`${DESK}?poll=1`, { cookie: desk })).json()) as { version: string; checkedIn: number; expected: number };
    const before = await poll();
    expect(before).toMatchObject({ checkedIn: 0, expected: 1 });

    // Plain form: 303 back to the search with a notice.
    const res = await post(DESK, new URLSearchParams({ op: 'checkin', attendee_id: String(attendee.id), q: reg.confirmation_no }).toString(), { cookie: desk });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${DESK}?q=${encodeURIComponent(reg.confirmation_no)}&done=checkin`);
    const after = await poll();
    expect(after).toMatchObject({ checkedIn: 1, expected: 1 });
    expect(after.version).not.toBe(before.version);
    const shown = await (await get(res.headers.get('location')!, { cookie: desk })).text();
    expect(shown).toContain('已报到。');
    expect(shown).toContain('已报到 1 / 1 人');

    // In-page JSON (what the desk script sends): a repeat is idempotent.
    const json = await post(DESK, new URLSearchParams({ op: 'checkin', attendee_id: String(attendee.id) }).toString(), { cookie: desk, accept: 'application/json' });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ ok: true, done: 'already' });
  });

  it('a viewer cannot open the desk, a desk volunteer cannot open the roster, and nobody else can act', async () => {
    await enableRegistration();
    await grantEventRole(env.DB, 920, GRACE[0], 'desk');
    await grantEventRole(env.DB, 920, MARK[0], 'viewer');
    expect((await get(DESK, { cookie: await sessionCookie(...MARK) })).status).toBe(403);
    expect((await get('/admin/registration/920', { cookie: await sessionCookie(...GRACE) })).status).toBe(403);
    expect((await post(DESK, new URLSearchParams({ op: 'party', registration_id: '1' }).toString(), { cookie: await sessionCookie(...SARAH) })).status).toBe(403);
    // A registration admin can use the desk and gets the way back to the event page.
    const adminDesk = await (await get(DESK, { cookie: await ADMIN() })).text();
    expect(adminDesk).toContain('data-reg-desk');
    expect(adminDesk).toContain('/admin/registration/920"');
  });
});
