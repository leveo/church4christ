// Registration on D1, against the BUILT worker: the public list and detail pages by
// lifecycle phase, members registering until a capacity-limited free event fills and
// the next one lands on the waitlist, the admin roster with confirmation numbers, and
// the admin event actions (lifecycle, duplicate, the D1 price rule, same-origin guard).
// Uses the seeded D1 events: 920 (open, capacity 3, two questions) and 930 (preview).
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
}

const ADMIN = () => sessionCookie(1, 'admin@example.com');
const MEMBERS: Array<[number, string]> = [
  [3, 'sarah.johnson@example.com'],
  [4, 'grace.lin@example.com'],
  [2, 'pastor.david@example.com'],
  [5, 'mark.liu@example.com'],
];

/** The Modules panel body with every module on (busts the per-isolate cache). */
function allModulesOn(): string {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) body.append(`module.${key}`, '1');
  return body.toString();
}

async function enableRegistration(): Promise<void> {
  const res = await post('/admin/settings', allModulesOn(), { cookie: await ADMIN() });
  expect(res.status).toBe(303);
}

/** Put the seeded events and their data back to the seed state (worker writes are not rolled back between tests). */
async function resetRegistrationData(): Promise<void> {
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(`DELETE FROM reg_answers`);
  await run(`DELETE FROM reg_attendees`);
  await run(`DELETE FROM registrations`);
  await run(`DELETE FROM reg_question_i18n WHERE question_id NOT IN (921, 922)`);
  await run(`DELETE FROM reg_questions WHERE event_id NOT IN (920, 930)`);
  await run(`DELETE FROM reg_event_i18n WHERE event_id NOT IN (920, 930) OR locale NOT IN ('en', 'zh')`);
  await run(`DELETE FROM reg_events WHERE id NOT IN (920, 930)`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1,
    confirmation_prefix = NULL, visible_from = NULL, starts_at = datetime('now','+14 days','start of day','+18 hours'),
    opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1,
    confirmation_prefix = NULL, visible_from = NULL, starts_at = datetime('now','+45 days','start of day','+10 hours'),
    opens_at = datetime('now','+10 days','start of day','+9 hours'), closes_at = NULL WHERE id = 930`);
}

beforeEach(resetRegistrationData);

async function register(personId: number, email: string, eventId = 920): Promise<Response> {
  const body = new URLSearchParams({
    locale: 'en',
    event_id: String(eventId),
    checkoutRequestId: crypto.randomUUID(),
    '921': 'Main dish',
  });
  return post('/api/register/submit', body.toString(), { cookie: await sessionCookie(personId, email) });
}

describe('Registration on D1: public pages by phase', () => {
  it('lists the open event and the preview event, and renders each detail page for its phase', async () => {
    await enableRegistration();

    const list = await (await get('/en/register')).text();
    expect(list).toContain('Neighbors Potluck Night');
    expect(list).toContain('Community Picnic');
    expect(list).toContain('Registration opens');

    const preview = await (await get('/en/register/930')).text();
    expect(preview).toContain('Registration is not open yet');
    expect(preview).not.toContain('name="event_id"');

    const open = await (await get('/en/register/920')).text();
    expect(open).toContain('What will you bring?');
    expect(open).toContain('name="event_id"');
  });

  it('shows a closed event as closed and hides an inactive one', async () => {
    await enableRegistration();
    await env.DB.prepare(`UPDATE reg_events SET closes_at = datetime('now','-1 hour') WHERE id = 920`).run();
    const closed = await (await get('/en/register/920')).text();
    expect(closed).toContain('Registration is closed.');
    expect(closed).not.toContain('name="event_id"');
    expect(await (await get('/en/register')).text()).not.toContain('Neighbors Potluck Night');

    await env.DB.prepare(`UPDATE reg_events SET active = 0 WHERE id = 930`).run();
    expect(await (await get('/en/register/930')).text()).not.toContain('Community Picnic');
  });

  it('serves the waitlist message on the done page', async () => {
    await enableRegistration();
    const waitlist = await (await get('/en/register/done?ok=1&status=waitlist')).text();
    expect(waitlist).toContain('You’re on the waitlist');
    expect(waitlist).toContain('if a place opens up');
    const confirmed = await (await get('/en/register/done?ok=1')).text();
    expect(confirmed).toContain('You’re registered!');
    expect(confirmed).not.toContain('on the waitlist');
  });
});

describe('Registration on D1: filling an event', () => {
  it('confirms members until the event is full, then waitlists, and the roster shows confirmation numbers', async () => {
    await enableRegistration();

    for (const [id, email] of MEMBERS.slice(0, 3)) {
      const res = await register(id, email);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/en/register/done?ok=1');
    }
    const waitlisted = await register(...MEMBERS[3]);
    expect(waitlisted.headers.get('location')).toBe('/en/register/done?ok=1&status=waitlist');

    const rows = (
      await env.DB.prepare(`SELECT status, confirmation_no FROM registrations WHERE event_id = 920 ORDER BY id`).all<{
        status: string;
        confirmation_no: string;
      }>()
    ).results;
    expect(rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed', 'waitlist']);
    expect(new Set(rows.map((r) => r.confirmation_no)).size).toBe(4);

    // A full free event with a waitlist invites people to join it.
    const detail = await (await get('/en/register/920')).text();
    expect(detail).toContain('Join the waitlist');
    expect(detail).toContain('This event is full');
    expect(await (await get('/en/register')).text()).toContain('Join the waitlist');

    const roster = await (await get('/admin/registration/920', { cookie: await ADMIN() })).text();
    for (const row of rows) expect(roster).toContain(row.confirmation_no);
    expect(roster).toContain('Waitlist');
    expect(roster).toContain('Confirmed');

    const csv = await (await get('/admin/registration/920/export.csv', { cookie: await ADMIN() })).text();
    for (const row of rows) expect(csv).toContain(row.confirmation_no);

    const list = await (await get('/admin/registration', { cookie: await ADMIN() })).text();
    expect(list).toContain('1 on waitlist');

    // A member sees the waitlist place on their own events page.
    const mine = await (await get('/en/my/events', { cookie: await sessionCookie(...MEMBERS[3]) })).text();
    expect(mine).toContain('On the waitlist');
  });

  it('with the waitlist off, a full event refuses the next registration', async () => {
    await enableRegistration();
    await env.DB.prepare(`UPDATE reg_events SET waitlist_enabled = 0 WHERE id = 920`).run();
    for (const [id, email] of MEMBERS.slice(0, 3)) await register(id, email);
    const res = await register(...MEMBERS[3]);
    expect(res.headers.get('location')).toBe('/en/register/920?error=full');
    expect(await (await get('/en/register/920')).text()).not.toContain('Join the waitlist');
  });
});

describe('Registration on D1: admin event actions', () => {
  const act = async (fields: Record<string, string>) =>
    post('/admin/registration', new URLSearchParams({ action: 'event', ...fields }).toString(), { cookie: await ADMIN() });

  it('rejects an admin POST that is not same-origin', async () => {
    await enableRegistration();
    const res = await SELF.fetch(`${ORIGIN}/admin/registration`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: await ADMIN() },
      body: 'action=event&id=920&op=hide',
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare(`SELECT active FROM reg_events WHERE id = 920`).first<number>('active')).toBe(1);
  });

  it('shows a phase badge per event and applies Hide, Show, Close now and Open now', async () => {
    await enableRegistration();
    const list = await (await get('/admin/registration', { cookie: await ADMIN() })).text();
    expect(list).toMatch(/data-phase="open"/);
    expect(list).toMatch(/data-phase="preview"/);

    expect((await act({ id: '920', op: 'hide' })).headers.get('location')).toBe('/admin/registration?updated=1');
    expect(await (await get('/admin/registration', { cookie: await ADMIN() })).text()).toMatch(/data-event-id="920"[\s\S]*?data-phase="hidden"/);
    expect(await (await get('/en/register')).text()).not.toContain('Neighbors Potluck Night');
    await act({ id: '920', op: 'show' });
    expect(await (await get('/en/register')).text()).toContain('Neighbors Potluck Night');

    await act({ id: '920', op: 'close_now' });
    expect(await (await get('/en/register/920')).text()).toContain('Registration is closed.');

    // The closing time is in the past, so Open now needs a new one.
    const refused = await act({ id: '920', op: 'open_now' });
    expect(refused.headers.get('location')).toBe('/admin/registration?error=close_required&row=920');
    const banner = await (await get('/admin/registration?error=close_required&row=920', { cookie: await ADMIN() })).text();
    expect(banner).toContain('closing time has already passed');

    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16);
    const reopened = await act({ id: '920', op: 'open_now', closes_at: future });
    expect(reopened.headers.get('location')).toBe('/admin/registration?updated=1');
    expect(await (await get('/en/register/920')).text()).toContain('name="event_id"');
  });

  it('duplicates an event into a hidden copy and lands on its editor', async () => {
    await enableRegistration();
    const res = await act({ id: '920', op: 'duplicate' });
    const location = res.headers.get('location') ?? '';
    const newId = Number(/edit=(\d+)&duplicated=1/.exec(location)?.[1]);
    expect(newId).toBeGreaterThan(920);
    const copy = await env.DB.prepare(`SELECT active, next_confirmation FROM reg_events WHERE id = ?1`).bind(newId).first<{
      active: number;
      next_confirmation: number;
    }>();
    expect(copy).toEqual({ active: 0, next_confirmation: 1 });
    const editor = await (await get(location, { cookie: await ADMIN() })).text();
    expect(editor).toContain('Neighbors Potluck Night');
    expect(editor).toContain('The copy is hidden');
    expect(await env.DB.prepare(`SELECT count(*) n FROM reg_questions WHERE event_id = ?1`).bind(newId).first<number>('n')).toBe(2);
  });

  it('saves every language, the waitlist switch and the prefix, and refuses a price on D1', async () => {
    await enableRegistration();
    const base = {
      action: 'save', id: '930', title_en: 'Community Picnic', title_zh: '社区野餐', title_de: 'Gemeindepicknick',
      description_en: 'Fun', starts_at: '2030-06-01T10:00', waitlist_enabled: '0', confirmation_prefix: 'pic1',
    };
    const saved = await post('/admin/registration', new URLSearchParams(base).toString(), { cookie: await ADMIN() });
    expect(saved.headers.get('location')).toBe('/admin/registration?saved=1');
    expect(
      await env.DB.prepare(`SELECT title FROM reg_event_i18n WHERE event_id = 930 AND locale = 'de'`).first<string>('title'),
    ).toBe('Gemeindepicknick');
    expect(
      await env.DB.prepare(`SELECT waitlist_enabled AS w, confirmation_prefix AS p FROM reg_events WHERE id = 930`).first(),
    ).toEqual({ w: 0, p: 'PIC1' });

    const priced = await post('/admin/registration', new URLSearchParams({ ...base, price: '25' }).toString(), { cookie: await ADMIN() });
    expect(priced.status).toBe(200);
    expect(await priced.text()).toContain('Paid events need the Postgres (Supabase) database');
    expect(await env.DB.prepare(`SELECT price_cents FROM reg_events WHERE id = 930`).first<number | null>('price_cents')).toBeNull();

    const badPrefix = await post('/admin/registration', new URLSearchParams({ ...base, confirmation_prefix: 'toolong1' }).toString(), { cookie: await ADMIN() });
    expect(badPrefix.status).toBe(200);
  });

  it('sends a priced event on D1 back to the form with paid_unavailable (member and guest)', async () => {
    await enableRegistration();
    await env.DB.prepare(`UPDATE reg_events SET price_cents = 2500 WHERE id = 920`).run();

    const member = await register(...MEMBERS[0]);
    expect(member.headers.get('location')).toBe('/en/register/920?error=paid_unavailable');

    const guest = await post(
      '/api/identity/continuation/start',
      new URLSearchParams({
        locale: 'en', flow: 'registration', event_id: '920', name: 'Guest Person', email: 'guest@example.com',
        identityIntentId: crypto.randomUUID(), '921': 'Main dish',
      }).toString(),
    );
    expect(guest.status).toBe(303);
    expect(guest.headers.get('location')).toBe('/en/register/920?error=paid_unavailable');

    const detail = await (await get('/en/register/920?error=paid_unavailable')).text();
    expect(detail).toContain('Paid registration isn’t available on this site yet');
  });
});
