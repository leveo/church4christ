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
  await run(`DELETE FROM reg_outbox`);
  await run(`DELETE FROM reg_activity`);
  await run(`DELETE FROM reg_event_access`);
  await run(`DELETE FROM reg_ticket_types WHERE event_id IN (920, 930)`);
  await run(`DELETE FROM reg_answers`);
  await run(`DELETE FROM reg_attendees`);
  await run(`DELETE FROM registrations`);
  await run(`DELETE FROM reg_question_i18n WHERE question_id NOT IN (921, 922)`);
  await run(`DELETE FROM reg_questions WHERE event_id NOT IN (920, 930)`);
  await run(`DELETE FROM reg_event_i18n WHERE event_id NOT IN (920, 930) OR locale NOT IN ('en', 'zh')`);
  await run(`DELETE FROM reg_events WHERE id NOT IN (920, 930)`);
  await run(`DELETE FROM email_log`);
  await run(`DELETE FROM newcomer_rate_limits`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1, capacity = 3,
    max_party_size = 4, allow_self_edit = 1, requires_approval = 0, reminder_days = NULL,
    confirmation_prefix = NULL, visible_from = NULL, starts_at = datetime('now','+14 days','start of day','+18 hours'),
    opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1,
    confirmation_prefix = NULL, visible_from = NULL, starts_at = datetime('now','+45 days','start of day','+10 hours'),
    opens_at = datetime('now','+10 days','start of day','+9 hours'), closes_at = NULL WHERE id = 930`);
}

beforeEach(resetRegistrationData);

/** A free registration lands on its manage page; the token is in the fragment only. */
const MANAGE_LOCATION = /^\/en\/register\/manage\?new=1&campus=[a-z0-9-]+#t=[A-Za-z0-9_-]{43}$/;
const tokenOf = (location: string | null): string => /#t=([A-Za-z0-9_-]{43})$/.exec(location ?? '')?.[1] ?? '';

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
      expect(res.headers.get('location')).toMatch(MANAGE_LOCATION);
    }
    const waitlisted = await register(...MEMBERS[3]);
    expect(waitlisted.headers.get('location')).toMatch(MANAGE_LOCATION);

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

  it('lists a typed event as full when every active ticket type is at its limit, on /register and /my/events', async () => {
    await enableRegistration();
    // Capacity 3, never reached; one limited type that is used up.
    const type = await env.DB.prepare(`INSERT INTO reg_ticket_types (event_id, price_cents, capacity) VALUES (920, 0, 1) RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES (?1, 'en', 'Adult')`).bind(type!.id).run();
    const cell = (html: string) => html.slice(html.indexOf('Neighbors Potluck Night') > -1 ? html.indexOf('Neighbors Potluck Night') : 0);
    expect(cell(await (await get('/en/register')).text())).not.toContain('Join the waitlist');
    const reg = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key, party_size, status) VALUES (920, 'A', 'a@example.com', 'typed-full-1', 1, 'confirmed') RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO reg_attendees (registration_id, name, ticket_type_id) VALUES (?1, 'A', ?2)`).bind(reg!.id, type!.id).run();
    expect(await (await get('/en/register')).text()).toContain('Join the waitlist');
    const mine = await (await get('/en/my/events', { cookie: await sessionCookie(...MEMBERS[3]) })).text();
    expect(mine).toContain('Join the waitlist');
    await env.DB.prepare(`UPDATE reg_events SET waitlist_enabled = 0 WHERE id = 920`).run();
    expect(await (await get('/en/register')).text()).toContain('>Full<');
    await env.DB.prepare(`DELETE FROM reg_ticket_types WHERE event_id = 920`).run();
  });

  it('emails each registrant, serves the QR image, and an admin cancel promotes the waitlist and mails both', async () => {
    await enableRegistration();
    await env.DB.prepare(`DELETE FROM email_log`).run();
    for (const [id, email] of MEMBERS) await register(id, email);
    const mails = async () =>
      (await env.DB.prepare(`SELECT to_email, kind, status, detail FROM email_log ORDER BY id`).all<{ to_email: string; kind: string; status: string; detail: string }>()).results;
    let logged = await mails();
    expect(logged.map((m) => m.kind)).toEqual(['regConfirm', 'regConfirm', 'regConfirm', 'regConfirm']);
    expect(logged.map((m) => m.to_email)).toEqual(MEMBERS.map(([, email]) => email));
    const sent = await env.DB.prepare(`SELECT count(*) AS n FROM registrations WHERE event_id = 920 AND confirmation_sent_at IS NOT NULL`).first<number>('n');
    expect(sent).toBe(4);
    expect(JSON.stringify(logged)).not.toMatch(/[A-Za-z0-9_-]{43}/); // no manage token in the log

    // The QR image is public, immutable, and cacheable even for a signed-in viewer.
    const first = await env.DB.prepare(`SELECT id, confirmation_no FROM registrations WHERE event_id = 920 ORDER BY id`).first<{ id: number; confirmation_no: string }>();
    const png = await SELF.fetch(`${ORIGIN}/register/qr/920/${first!.confirmation_no}.png`, { headers: { cookie: await sessionCookie(...MEMBERS[0]) } });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await SELF.fetch(`${ORIGIN}/register/qr/920/R99-9999.png`)).status).toBe(404);

    // Admin cancel frees a seat: the waitlisted member is promoted and both are emailed.
    await env.DB.prepare(`DELETE FROM email_log`).run();
    const res = await post('/admin/registration/920', new URLSearchParams({ action: 'cancel', registration_id: String(first!.id) }).toString(), { cookie: await ADMIN() });
    expect(res.status).toBe(303);
    logged = await mails();
    expect(logged.map((m) => [m.kind, m.to_email])).toEqual([
      ['regCancelled', MEMBERS[0][1]],
      ['regPromoted', MEMBERS[3][1]],
    ]);
    const statuses = (await env.DB.prepare(`SELECT status FROM registrations WHERE event_id = 920 ORDER BY id`).all<{ status: string }>()).results.map((r) => r.status);
    expect(statuses).toEqual(['cancelled', 'confirmed', 'confirmed', 'confirmed']);
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


/** The hidden inputs of the first <form> that posts to `action` in a page. */
function hiddenFieldsOf(html: string, action: string): Array<[string, string]> {
  const start = html.indexOf(`action="${action}"`);
  const form = html.slice(start, html.indexOf('</form>', start));
  const fields: Array<[string, string]> = [];
  for (const tag of form.match(/<input[^>]*>/g) ?? []) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = /name="([^"]*)"/.exec(tag)?.[1];
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (name) fields.push([name, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")]);
  }
  return fields;
}

const formBody = (entries: Array<[string, string]>) => new URLSearchParams(entries).toString();

/** The manage API as the manage page's script calls it: same-origin JSON. */
type Reply = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function manage(token: string, action: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = { origin: ORIGIN }): Promise<Reply> {
  return SELF.fetch(`${ORIGIN}/api/register/manage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token, locale: 'en', action, ...extra }),
    redirect: 'manual',
  });
}

describe('Registration on D1: a family signs up, reviews, manages and cancels one person', () => {
  const SARAH = MEMBERS[0];
  const GRACE = MEMBERS[1];

  it('reviews a party, confirms it, opens the private manage page, and a cancel promotes the waitlist with mail and CSV', async () => {
    await enableRegistration();

    // The form: contact, phone, three person rows (max 4), questions, one hidden submission key.
    const formPage = await (await get('/en/register/920', { cookie: await sessionCookie(...SARAH) })).text();
    expect(formPage).toContain('name="phone"');
    expect(formPage).toContain('name="person_name_1"');
    expect(formPage).toContain('name="person_name_3"');
    expect(formPage).not.toContain('name="person_name_4"');
    expect(formPage).toMatch(/name="submission_key" value="[A-Za-z0-9_-]{16,64}"/);
    expect(formPage).toContain('data-add-person');
    // Household chips come from the signed-in person's household (Sarah has none; David's has Amy). The old check on the
    // bare attribute matched a CSS rule that used to be inlined in the page; this one looks for the element itself.
    expect(await (await get('/en/register/920', { cookie: await sessionCookie(2, 'pastor.david@example.com') })).text()).toContain('<div data-household hidden>');

    // Review: nothing is written, the page shows the party and carries every id through.
    const cookie = await sessionCookie(...SARAH);
    const reviewBody = formBody([
      ...hiddenFieldsOf(formPage, '/en/register/920').filter(([n]) => n !== 'step'),
      ['step', 'review'], ['phone', '555 0100'], ['person_name_1', 'Mia Johnson'], ['person_name_2', 'Noah Johnson'], ['921', 'Main dish'],
    ]);
    const review = await post('/en/register/920', reviewBody, { cookie });
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain('Check your registration');
    expect(reviewHtml).toContain('Mia Johnson');
    expect(reviewHtml).toContain('Noah Johnson');
    expect(reviewHtml).toContain('Back to edit');
    expect(reviewHtml).toContain('Main dish');
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations`).first<number>('n')).toBe(0);

    // Back to edit keeps what was typed.
    const back = await post('/en/register/920', formBody([...hiddenFieldsOf(reviewHtml, '/api/register/submit').filter(([n]) => n !== 'step'), ['step', 'edit']]), { cookie });
    const backHtml = await back.text();
    expect(backHtml).toContain('value="Mia Johnson"');
    expect(backHtml).toContain('value="555 0100"');
    expect(backHtml).not.toContain('id="f-summary"');
    expect(backHtml).not.toMatch(/id="f-[a-z0-9-]+-err"/);

    // Confirm posts to the real endpoint with the same fields.
    const confirmFields = hiddenFieldsOf(reviewHtml, '/api/register/submit').filter(([n]) => n !== 'step');
    expect(confirmFields.map(([n]) => n)).toEqual(expect.arrayContaining(['submission_key', 'checkoutRequestId', 'person_name_1', 'person_name_2', 'phone', '921']));
    const confirmed = await post('/api/register/submit', formBody([...confirmFields, ['step', 'confirm']]), { cookie });
    expect(confirmed.status).toBe(303);
    const location = confirmed.headers.get('location');
    expect(location).toMatch(MANAGE_LOCATION);
    const token = tokenOf(location);

    // A double submit is the same registration, lands on the member's own page, no second mail.
    const replay = await post('/api/register/submit', formBody([...confirmFields, ['step', 'confirm']]), { cookie });
    const reg = await env.DB.prepare(`SELECT id, party_size, phone, status FROM registrations`).first<{ id: number; party_size: number; phone: string; status: string }>();
    expect(replay.headers.get('location')).toBe(`/en/my/events/${reg!.id}?new=1`);
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations`).first<number>('n')).toBe(1);
    expect(reg).toMatchObject({ party_size: 3, phone: '555 0100', status: 'confirmed' });

    // The manage page carries no personal data; its script asks the API.
    const page = await get('/en/register/manage?new=1');
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const pageHtml = await page.text();
    expect(pageHtml).toContain('id="reg-manage"');
    expect(pageHtml).toContain('noindex');
    expect(pageHtml).not.toMatch(/Sarah|Mia Johnson|sarah\.johnson|rel="canonical"|hreflang/);
    expect(pageHtml).not.toContain(token);

    const view = await (await manage(token, 'view')).json();
    expect(view.view.registration).toMatchObject({ status: 'confirmed', partySize: 3, phone: '555 0100' });
    expect(view.view.attendees.map((a: { name: string }) => a.name)).toEqual([expect.any(String), 'Mia Johnson', 'Noah Johnson']);
    expect(JSON.stringify(view)).not.toContain(token);

    // The API is held to same-origin like every other POST, and a wrong token reveals nothing.
    expect((await manage(token, 'view', {}, {})).status).toBe(403);
    expect((await manage(token, 'view', {}, { origin: 'https://evil.example' })).status).toBe(403);
    const unknown = await manage('A'.repeat(43), 'view');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('{"error":"not_found"}');

    // A waitlisted single (the event is full at 3) ...
    const waitlisted = await register(...GRACE);
    expect(waitlisted.headers.get('location')).toMatch(MANAGE_LOCATION);
    expect(await env.DB.prepare(`SELECT status FROM registrations WHERE person_id = ?1`).bind(GRACE[0]).first<string>('status')).toBe('waitlist');
    // Each registration was mailed its confirmation once (the double submit sent nothing more), with no token in the log.
    const confirmations = (await env.DB.prepare(`SELECT kind, to_email FROM email_log ORDER BY id`).all<{ kind: string; to_email: string }>()).results;
    expect(confirmations.map((m) => [m.kind, m.to_email])).toEqual([
      ['regConfirm', SARAH[1]],
      ['regConfirm', GRACE[1]],
    ]);
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations WHERE confirmation_sent_at IS NOT NULL`).first<number>('n')).toBe(2);
    await env.DB.prepare(`DELETE FROM email_log`).run();

    // ... is promoted when Sarah says one person cannot come.
    const noah = view.view.attendees[2];
    const cancelled = await manage(token, 'cancel_attendee', { attendee_id: noah.id });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).view.registration.partySize).toBe(2);
    expect(await env.DB.prepare(`SELECT status FROM registrations WHERE person_id = ?1`).bind(GRACE[0]).first<string>('status')).toBe('confirmed');
    const mails = (await env.DB.prepare(`SELECT kind, to_email FROM email_log ORDER BY id`).all<{ kind: string; to_email: string }>()).results;
    expect(mails.map((m) => [m.kind, m.to_email])).toEqual([
      ['regCancelled', SARAH[1]],
      ['regPromoted', GRACE[1]],
    ]);
    expect(JSON.stringify(mails)).not.toContain(token);

    // The roster and CSV show the people and the phone, appended at the END of the columns.
    const roster = await (await get('/admin/registration/920', { cookie: await ADMIN() })).text();
    expect(roster).toContain('Mia Johnson');
    expect(roster).toContain('555 0100');
    const csv = await (await get('/admin/registration/920/export.csv', { cookie: await ADMIN() })).text();
    const [header, ...lines] = csv.split('\r\n');
    expect(header).toMatch(/^Confirmation,Name,Email,Status,Party size,Amount,Registered,.*,People,Phone$/);
    const sarahLine = lines.find((l) => l.includes(SARAH[1]))!;
    expect(sarahLine).toContain('Mia Johnson');
    expect(sarahLine).not.toContain('Noah Johnson');
    expect(sarahLine).toMatch(/555 0100$/);
  });

  it('shows every problem inline with the first one focusable, and a posted submit bounces back with the body (307)', async () => {
    await enableRegistration();
    const cookie = await sessionCookie(...SARAH);
    const formPage = await (await get('/en/register/920', { cookie })).text();
    const base = hiddenFieldsOf(formPage, '/en/register/920').filter(([n]) => n !== 'step');
    const bad = formBody([...base, ['step', 'review'], ['phone', 'call me'], ['person_name_1', 'x'.repeat(130)]]);
    const review = await post('/en/register/920', bad, { cookie });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain('id="f-summary"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true" aria-describedby="f-phone-err"');
    expect(html).toContain('Please enter a valid phone number.');
    expect(html).toContain('aria-describedby="f-person-1-err"');
    expect(html).toContain('Please answer this question.'); // the required question was left blank
    expect(html).toContain('value="call me"'); // nothing typed is lost
    expect(html).not.toContain('Check your registration');

    // A confirm that fails validation goes back to the form unchanged (no write, no query string).
    const bounced = await post('/api/register/submit', formBody([...base, ['step', 'confirm'], ['phone', 'call me'], ['921', 'Main dish']]), { cookie });
    expect(bounced.status).toBe(307);
    expect(bounced.headers.get('location')).toBe('/en/register/920');
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations`).first<number>('n')).toBe(0);

    const guest = await post('/api/identity/continuation/start', formBody([
      ['locale', 'en'], ['flow', 'registration'], ['event_id', '920'], ['name', 'Guest'], ['email', 'not-an-email'],
      ['identityIntentId', crypto.randomUUID()], ['921', 'Main dish'],
    ]));
    expect(guest.status).toBe(307);
    expect(guest.headers.get('location')).toBe('/en/register/920');
  });

  it('tells the whole party it joins the waitlist when it does not fit the seats left', async () => {
    await enableRegistration();
    await register(...MEMBERS[2]); // one of three seats gone, two left
    await register(...MEMBERS[3]);
    const cookie = await sessionCookie(...SARAH);
    const formPage = await (await get('/en/register/920', { cookie })).text();
    expect(formPage).toContain('Only 1 place left.');
    const base = hiddenFieldsOf(formPage, '/en/register/920').filter(([n]) => n !== 'step');
    const review = await (await post('/en/register/920', formBody([...base, ['step', 'review'], ['person_name_1', 'Mia'], ['921', 'Main dish']]), { cookie })).text();
    expect(review).toContain('data-waitlist-party');
    expect(review).toContain('Your whole group will join the waitlist together');

    // Without a waitlist the same party gets an inline error instead of a bounced submit.
    await env.DB.prepare(`UPDATE reg_events SET waitlist_enabled = 0 WHERE id = 920`).run();
    const noRoom = await (await post('/en/register/920', formBody([...base, ['step', 'review'], ['person_name_1', 'Mia'], ['921', 'Main dish']]), { cookie })).text();
    expect(noRoom).toContain('There aren’t enough places left for this many people');
    expect(noRoom).not.toContain('Check your registration');
  });

  it('serves /my/events/<id> only to its owner, and runs the same actions from a plain form', async () => {
    await enableRegistration();
    const cookie = await sessionCookie(...SARAH);
    const formPage = await (await get('/en/register/920', { cookie })).text();
    const base = hiddenFieldsOf(formPage, '/en/register/920').filter(([n]) => n !== 'step');
    const created = await post('/api/register/submit', formBody([...base, ['person_name_1', 'Mia Johnson'], ['phone', '555 0100'], ['921', 'Main dish']]), { cookie });
    expect(created.status).toBe(303);
    const id = (await env.DB.prepare(`SELECT id FROM registrations`).first<number>('id'))!;

    const mine = await get(`/en/my/events/${id}?new=1`, { cookie });
    expect(mine.status).toBe(200);
    const html = await mine.text();
    expect(html).toContain('Mia Johnson');
    expect(html).toContain('Neighbors Potluck Night');
    expect(html).toContain('data-banner="confirmed"');
    expect(await (await get('/en/my/events', { cookie })).text()).toContain(`/en/my/events/${id}`);

    // Someone else's id, an unknown id and a signed-out visitor all get nothing.
    expect((await get(`/en/my/events/${id}`, { cookie: await sessionCookie(...GRACE) })).status).toBe(404);
    expect((await get(`/en/my/events/99999`, { cookie })).status).toBe(404);
    expect((await get(`/en/my/events/${id}`)).status).toBeGreaterThanOrEqual(300);

    // Edit through the form, then the calendar file, then cancel everyone.
    const attendees = (await env.DB.prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(id).all<{ id: number }>()).results;
    const edit = await post(`/en/my/events/${id}`, formBody([
      ['action', 'update'], ['name', 'Sarah J.'], ['phone', '555 0199'],
      [`attendee_${attendees[0].id}`, 'Sarah J.'], [`attendee_${attendees[1].id}`, 'Mia J.'], ['a_921', 'Dessert'],
    ]), { cookie });
    expect(edit.status).toBe(303);
    expect(edit.headers.get('location')).toBe(`/en/my/events/${id}?saved=1`);
    expect(await env.DB.prepare(`SELECT name FROM reg_attendees WHERE id = ?1`).bind(attendees[1].id).first<string>('name')).toBe('Mia J.');

    const ics = await post(`/en/my/events/${id}`, formBody([['action', 'ics']]), { cookie });
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    expect(await ics.text()).toContain('BEGIN:VEVENT');

    await env.DB.prepare(`DELETE FROM email_log`).run();
    const cancel = await post(`/en/my/events/${id}`, formBody([['action', 'cancel_all']]), { cookie });
    expect(cancel.headers.get('location')).toBe(`/en/my/events/${id}?cancelled=1`);
    expect(await env.DB.prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(id).first<string>('status')).toBe('cancelled');
    expect((await env.DB.prepare(`SELECT kind FROM email_log`).all<{ kind: string }>()).results.map((m) => m.kind)).toEqual(['regCancelled']);
    // A cancelled registration is still viewable, with nothing left to do.
    const after = await (await get(`/en/my/events/${id}?cancelled=1`, { cookie })).text();
    expect(after).toContain('Your registration has been cancelled.');
    expect(after).not.toContain('data-confirm="');
  });

  it('saves Max people, self-service and notes from the admin editor, and shows the notes to registrants', async () => {
    await enableRegistration();
    const saved = await post('/admin/registration', new URLSearchParams({
      action: 'save', id: '930', title_en: 'Community Picnic', title_zh: '社区野餐', starts_at: '2030-06-01T10:00',
      max_party_size: '6', allow_self_edit: '0', notes_en: 'Bring sunscreen.', notes_zh: '请带防晒霜。',
    }).toString(), { cookie: await ADMIN() });
    expect(saved.headers.get('location')).toBe('/admin/registration?saved=1');
    expect(await env.DB.prepare(`SELECT max_party_size AS m, allow_self_edit AS a FROM reg_events WHERE id = 930`).first()).toEqual({ m: 6, a: 0 });
    expect(await env.DB.prepare(`SELECT notes FROM reg_event_i18n WHERE event_id = 930 AND locale = 'zh'`).first<string>('notes')).toBe('请带防晒霜。');

    const bad = await post('/admin/registration', new URLSearchParams({ action: 'save', id: '930', title_en: 'Community Picnic', starts_at: '2030-06-01T10:00', max_party_size: '25' }).toString(), { cookie: await ADMIN() });
    expect(bad.status).toBe(200);
    expect(await env.DB.prepare(`SELECT max_party_size FROM reg_events WHERE id = 930`).first<number>('max_party_size')).toBe(6);

    const editor = await (await get('/admin/registration?edit=930', { cookie: await ADMIN() })).text();
    expect(editor).toContain('name="max_party_size"');
    expect(editor).toContain('name="allow_self_edit"');
    expect(editor).toContain('name="notes_en"');
    expect(editor).toContain('Bring sunscreen.');
  });
});

describe('Registration on D1: the form builder and templates', () => {
  const jsonPost = async (path: string, payload: unknown, cookie: string, origin: string = ORIGIN): Promise<Response> =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(payload),
      redirect: 'manual',
    });

  async function newEvent(title: string): Promise<number> {
    const saved = await post('/admin/registration', new URLSearchParams({ action: 'save', title_en: title, starts_at: '2030-06-01T10:00' }).toString(), { cookie: await ADMIN() });
    expect(saved.headers.get('location')).toBe('/admin/registration?saved=1');
    return (await env.DB.prepare(`SELECT id FROM reg_events WHERE id NOT IN (920, 930) ORDER BY id DESC LIMIT 1`).first<number>('id'))!;
  }

  const PAYLOAD = {
    questions: [
      { key: 'kids', type: 'yesno', labels: { en: 'Need childcare?' } },
      { key: 'allergy', type: 'text', scope: 'attendee', max_length: 40, labels: { en: 'Child allergies' }, condition: { q: 'kids', op: 'eq', value: 'yes' } },
    ],
    tickets: [{ price_cents: 0, capacity: 5, active: true, labels: { en: 'Adult' }, descriptions: { en: 'Ages 13 and up' } }],
  };

  it('mounts the builder island, saves a per-person question with a condition and a ticket type, and re-renders them', async () => {
    await enableRegistration();
    const id = await newEvent('Builder Camp');
    const page = await get(`/admin/registration/${id}`, { cookie: await ADMIN() });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Registration form');
    expect(html).toMatch(/<astro-island[^>]*RegFormBuilder/);
    expect(html).toContain('Registrations');

    const res = await jsonPost(`/admin/registration/${id}`, PAYLOAD, await ADMIN());
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; questions: Array<{ id: number; scope: string; condition: { q: number; op: string; value: string } | null }>; tickets: Array<{ capacity: number }> }>();
    expect(body.ok).toBe(true);
    expect(body.questions.map((q) => q.scope)).toEqual(['registration', 'attendee']);
    expect(body.questions[1].condition).toEqual({ q: body.questions[0].id, op: 'eq', value: 'yes' });
    expect(body.tickets[0].capacity).toBe(5);

    const stored = await env.DB.prepare(`SELECT q.scope AS scope, q.max_length AS max_length FROM reg_questions q WHERE q.event_id = ?1 ORDER BY q.sort`).bind(id).all<{ scope: string; max_length: number | null }>();
    expect(stored.results).toEqual([{ scope: 'registration', max_length: null }, { scope: 'attendee', max_length: 40 }]);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_ticket_types WHERE event_id = ?1`).bind(id).first<number>('n')).toBe(1);

    // the admin page now carries the stored form in the island props (serialized into the page HTML)
    const again = await (await get(`/admin/registration/${id}`, { cookie: await ADMIN() })).text();
    expect(again).toContain('Child allergies');
    expect(again).toContain('Ages 13 and up');
    // the events list says the event price is ignored while a ticket type is active
    const editor = await (await get(`/admin/registration?edit=${id}`, { cookie: await ADMIN() })).text();
    expect(editor).toContain('data-testid="price-ignored"');
  });

  it('returns validation errors by field path and writes nothing', async () => {
    await enableRegistration();
    const id = await newEvent('Builder Errors');
    const res = await jsonPost(`/admin/registration/${id}`, { questions: [{ type: 'select', labels: {} }], tickets: [{ price_cents: 500, labels: { en: 'VIP' } }] }, await ADMIN());
    expect(res.status).toBe(422);
    const body = await res.json<{ ok: boolean; errors: Array<{ path: string; code: string }> }>();
    expect(body.errors.map((e) => `${e.path}:${e.code}`)).toEqual([
      'questions.0.labels.en:required', 'questions.0.options:required', 'tickets.0.price_cents:paid_unavailable',
    ]);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_questions WHERE event_id = ?1`).bind(id).first<number>('n')).toBe(0);
  });

  it('refuses a cross-origin save, a signed-out save and a member without the registration area', async () => {
    await enableRegistration();
    const id = await newEvent('Builder Guard');
    expect((await jsonPost(`/admin/registration/${id}`, PAYLOAD, await ADMIN(), 'https://evil.example')).status).toBe(403);
    const anon = await SELF.fetch(`${ORIGIN}/admin/registration/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(PAYLOAD), redirect: 'manual' });
    expect([302, 303, 401, 403]).toContain(anon.status);
    const member = await jsonPost(`/admin/registration/${id}`, PAYLOAD, await sessionCookie(3, 'sarah.johnson@example.com'));
    expect([302, 303, 403, 404]).toContain(member.status);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_questions WHERE event_id = ?1`).bind(id).first<number>('n')).toBe(0);
  });

  it('saves an event as a template, builds a new event from it, and only ever deletes templates', async () => {
    await enableRegistration();
    const id = await newEvent('Template Source');
    await jsonPost(`/admin/registration/${id}`, PAYLOAD, await ADMIN());
    const action = async (target: number, op: string) =>
      post('/admin/registration', new URLSearchParams({ action: 'event', id: String(target), op }).toString(), { cookie: await ADMIN() });

    const saved = await action(id, 'save_template');
    expect(saved.headers.get('location')).toBe('/admin/registration?template_saved=1#reg-templates');
    const templateId = (await env.DB.prepare(`SELECT id FROM reg_events WHERE is_template = 1 ORDER BY id DESC LIMIT 1`).first<number>('id'))!;

    // the list shows it under Templates, not among the events, and the template page has no roster
    const list = await (await get('/admin/registration', { cookie: await ADMIN() })).text();
    const templatesPart = list.slice(list.indexOf('data-testid="templates-table"'));
    expect(templatesPart).toContain(`data-template-id="${templateId}"`);
    expect(list.slice(0, list.indexOf('data-testid="templates-table"'))).not.toContain(`data-event-id="${templateId}"`);
    const templatePage = await (await get(`/admin/registration/${templateId}`, { cookie: await ADMIN() })).text();
    expect(templatePage).toMatch(/<astro-island[^>]*RegFormBuilder/);
    expect(templatePage).not.toContain('Export CSV');
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM registrations`).first<number>('n')).toBe(0);

    // lifecycle buttons are refused for a template
    const refused = await action(templateId, 'hide');
    expect(refused.headers.get('location')).toBe(`/admin/registration?error=invalid&row=${templateId}`);

    // a new regular event comes from it, hidden, with the questions and ticket type
    const created = await action(templateId, 'from_template');
    const newId = (await env.DB.prepare(`SELECT id FROM reg_events WHERE is_template = 0 ORDER BY id DESC LIMIT 1`).first<number>('id'))!;
    expect(created.headers.get('location')).toBe(`/admin/registration?edit=${newId}&from_template=1`);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_questions WHERE event_id = ?1`).bind(newId).first<number>('n')).toBe(2);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_ticket_types WHERE event_id = ?1`).bind(newId).first<number>('n')).toBe(1);

    // a regular event is never deleted, a template is
    expect((await action(newId, 'delete_template')).headers.get('location')).toBe(`/admin/registration?error=not_found&row=${newId}`);
    expect((await action(templateId, 'delete_template')).headers.get('location')).toBe('/admin/registration?template_deleted=1#reg-templates');
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM reg_events WHERE id IN (?1, ?2)`).bind(newId, templateId).first<number>('n')).toBe(1);
  });
});

describe('Registration on D1: ticket types, per-person questions and show-if', () => {
  const SARAH = MEMBERS[0];
  const GRACE = MEMBERS[1];
  const jsonPost = async (path: string, payload: unknown, cookie: string): Promise<Response> =>
    SELF.fetch(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify(payload),
      redirect: 'manual',
    });

  /** An open event with Adult / Child (limit 1) tickets, a yes/no, three per-person questions (one shown only when the yes/no is Yes) and a terms question. */
  async function ticketEvent() {
    const saved = await post('/admin/registration', new URLSearchParams({ action: 'save', title_en: 'Ticket Camp', starts_at: '2030-06-01T10:00' }).toString(), { cookie: await ADMIN() });
    expect(saved.headers.get('location')).toBe('/admin/registration?saved=1');
    const id = (await env.DB.prepare(`SELECT id FROM reg_events WHERE id NOT IN (920, 930) ORDER BY id DESC LIMIT 1`).first<number>('id'))!;
    await env.DB.prepare(`UPDATE reg_events SET active = 1, waitlist_enabled = 1, max_party_size = 4, price_cents = NULL, capacity = NULL, closes_at = NULL WHERE id = ?1`).bind(id).run();
    const res = await jsonPost(`/admin/registration/${id}`, {
      questions: [
        { key: 'care', type: 'yesno', labels: { en: 'Need childcare?' } },
        { type: 'section', scope: 'attendee', labels: { en: 'About each person' }, help: { en: 'Tell us a little about everyone.' } },
        { type: 'select', scope: 'attendee', required: true, labels: { en: 'Shirt size' }, help: { en: 'Unisex sizing.' },
          options: [{ key: 'sm', labels: { en: 'Small' } }, { key: 'md', labels: { en: 'Medium' } }] },
        { type: 'text', scope: 'attendee', max_length: 40, labels: { en: 'Allergies' }, placeholder: { en: 'e.g. peanuts' }, condition: { q: 'care', op: 'eq', value: 'yes' } },
        { type: 'terms', required: true, labels: { en: 'Photo release' }, help: { en: 'We may share group photos.' } },
      ],
      tickets: [
        { price_cents: 0, active: true, labels: { en: 'Adult' }, descriptions: { en: 'Ages 13 and up' } },
        { price_cents: 0, capacity: 1, active: true, labels: { en: 'Child' }, descriptions: { en: 'Ages 3 to 12' } },
      ],
    }, await ADMIN());
    expect(res.status).toBe(200);
    const q = Object.fromEntries((await env.DB.prepare(`SELECT q.id AS id, i.label AS label FROM reg_questions q JOIN reg_question_i18n i ON i.question_id = q.id AND i.locale = 'en' WHERE q.event_id = ?1`).bind(id).all<{ id: number; label: string }>()).results.map((r) => [r.label, r.id]));
    const t = Object.fromEntries((await env.DB.prepare(`SELECT t.id AS id, i.label AS label FROM reg_ticket_types t JOIN reg_ticket_type_i18n i ON i.ticket_type_id = t.id AND i.locale = 'en' WHERE t.event_id = ?1`).bind(id).all<{ id: number; label: string }>()).results.map((r) => [r.label, r.id]));
    return { id, q, adult: t.Adult, child: t.Child };
  }

  it('shows the form, reviews each person with their type and answers, registers a family, and lists it in the manage view, roster and CSV', async () => {
    await enableRegistration();
    const { id, q, adult, child } = await ticketEvent();
    const cookie = await sessionCookie(...SARAH);
    const path = `/en/register/${id}`;

    const formPage = await (await get(path, { cookie })).text();
    expect(formPage).toContain('name="ticket_0"');
    expect(formPage).toContain('name="ticket_1"');
    expect(formPage).toContain('name="ticket_3"');
    expect(formPage).toContain(`name="pq_0_${q['Shirt size']}"`);
    expect(formPage).toContain(`name="pq_2_${q['Shirt size']}"`);
    expect(formPage).toContain('Ages 3 to 12');
    expect(formPage).toContain('1 left');
    expect(formPage).toContain('About each person');
    expect(formPage).toContain('Tell us a little about everyone.');
    expect(formPage).toContain('Unisex sizing.');
    expect(formPage).toContain('<details class="reg-help">');
    expect(formPage).toContain('placeholder="e.g. peanuts"');
    expect(formPage).toContain('maxlength="40"');
    expect(formPage).toContain('We may share group photos.');
    expect(formPage).toMatch(/<script type="application\/json" data-reg-conditions>/);
    // Without the script everything shows (the conditional question is in the page), but only person 1 is natively required.
    expect(formPage).toContain(`name="pq_0_${q.Allergies}"`);
    expect(formPage).toMatch(new RegExp(`name="ticket_0" value="${adult}" data-req required`));
    expect(formPage).toMatch(new RegExp(`name="ticket_1" value="${adult}" data-req(?! required)`));

    const base = hiddenFieldsOf(formPage, path).filter(([n]) => n !== 'step');
    const fields = (over: Array<[string, string]>): Array<[string, string]> => [
      ...base, ['step', 'review'], ['phone', '555 0100'], ['person_name_1', 'Mia Johnson'],
      ['ticket_0', String(adult)], ['ticket_1', String(child)],
      [`pq_0_${q['Shirt size']}`, 'md'], [`pq_1_${q['Shirt size']}`, 'sm'],
      [String(q['Need childcare?']), 'yes'], [`pq_0_${q.Allergies}`, 'peanuts'], [`pq_1_${q.Allergies}`, 'dairy'], [String(q['Photo release']), 'on'],
      ...over,
    ];

    // A person without a ticket type, and a missing terms box, bounce back with the problem shown at the field.
    const noTicket = await post(path, formBody(fields([]).filter(([n]) => n !== 'ticket_1')), { cookie });
    const noTicketHtml = await noTicket.text();
    expect(noTicketHtml).toContain('Please choose a ticket type.');
    expect(noTicketHtml).toContain('id="f-ticket-1"');
    const noTerms = await post(path, formBody(fields([]).filter(([n]) => n !== String(q['Photo release']))), { cookie });
    expect(await noTerms.text()).toContain('Please tick the box to agree.');

    // Show-if on the server: with childcare = No the Allergies answers are not part of the review.
    const hidden = await (await post(path, formBody(fields([]).map(([n, v]) => (n === String(q['Need childcare?']) ? [n, 'no'] as [string, string] : [n, v]))), { cookie })).text();
    expect(hidden).toContain('Check your registration');
    expect(hidden).not.toContain('<dt>Allergies</dt>');

    // Review: each person with their type and answers (labels, not keys); sections are left out; nothing is written yet.
    const review = await post(path, formBody(fields([])), { cookie });
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain('Check your registration');
    expect(reviewHtml).toMatch(/data-review-person[\s\S]*Mia Johnson[\s\S]*data-review-ticket> · Child/);
    expect(reviewHtml).toContain('data-review-ticket> · Adult');
    expect(reviewHtml).toContain('Medium');
    expect(reviewHtml).toContain('Small');
    expect(reviewHtml).toContain('<dt>Allergies</dt><dd>peanuts</dd>');
    expect(reviewHtml).toContain('<dt>Allergies</dt><dd>dairy</dd>');
    expect(reviewHtml).toContain('Accepted');
    expect(reviewHtml).not.toContain('About each person');
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations`).first<number>('n')).toBe(0);

    // Back to edit keeps the ticket picks and answers.
    const back = await (await post(path, formBody([...hiddenFieldsOf(reviewHtml, '/api/register/submit').filter(([n]) => n !== 'step'), ['step', 'edit']]), { cookie })).text();
    expect(back).toMatch(new RegExp(`value="${child}" data-req[^>]*checked`));
    expect(back).toContain('value="peanuts"');

    // Confirm carries every field through the review round trip.
    const confirmFields = hiddenFieldsOf(reviewHtml, '/api/register/submit').filter(([n]) => n !== 'step');
    expect(confirmFields.map(([n]) => n)).toEqual(expect.arrayContaining(['ticket_0', 'ticket_1', `pq_0_${q['Shirt size']}`, `pq_1_${q.Allergies}`, String(q['Photo release'])]));
    const confirmed = await post('/api/register/submit', formBody([...confirmFields, ['step', 'confirm']]), { cookie });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get('location')).toMatch(MANAGE_LOCATION);
    const token = tokenOf(confirmed.headers.get('location'));
    const registration = (await env.DB.prepare(`SELECT id, status, party_size FROM registrations`).first<{ id: number; status: string; party_size: number }>())!;
    expect(registration).toMatchObject({ status: 'confirmed', party_size: 2 });
    expect((await env.DB.prepare(`SELECT value FROM reg_answers WHERE question_id = ?1`).bind(q['Photo release']).first<string>('value'))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The private manage view: type and answers per person; the type is read-only; "Can't come" frees the Child seat.
    const view = (await (await manage(token, 'view')).json()).view;
    expect(view.attendees.map((a: { name: string; ticketText: string }) => [a.name, a.ticketText])).toEqual([[expect.any(String), 'Adult'], ['Mia Johnson', 'Child']]);
    expect(view.attendees[1].answers.map((a: { label: string; value: string }) => `${a.label}=${a.value}`)).toEqual(['Shirt size=Small', 'Allergies=dairy']);
    const [ada, mia] = view.attendees as Array<{ id: number }>;
    const edit = await manage(token, 'update', { fields: {
      name: ['Sarah Johnson'], [`attendee_${ada.id}`]: ['Sarah Johnson'], [`attendee_${mia.id}`]: ['Mia Johnson'],
      [`pa_${ada.id}`]: ['1'], [`pa_${ada.id}_${q['Shirt size']}`]: ['sm'], [`pa_${mia.id}`]: ['1'], [`pa_${mia.id}_${q['Shirt size']}`]: ['md'],
      [`pa_${mia.id}_${q.Allergies}`]: ['none'], [`a_${q['Need childcare?']}`]: ['yes'], [`a_${q['Photo release']}`]: ['on'],
      ticket_0: [String(child)],
    } });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()).view;
    expect(edited.attendees[1].answers.map((a: { value: string }) => a.value)).toEqual(['Medium', 'none']);
    expect(edited.attendees.map((a: { ticketText: string }) => a.ticketText)).toEqual(['Adult', 'Child']);
    // The member's own page shows the same (plain forms, server-rendered).
    const mine = await (await get(`/en/my/events/${registration.id}`, { cookie })).text();
    expect(mine).toContain('data-ticket-text>Child</span>');
    expect(mine).toContain(`name="pa_${mia.id}_${q['Shirt size']}"`);
    expect(mine).toMatch(/<script type="application\/json" data-reg-conditions>/);

    // The roster shows each person with their type, and the CSV appends the new columns at the END.
    const roster = await (await get(`/admin/registration/${id}`, { cookie: await ADMIN() })).text();
    expect(roster).toMatch(/data-ticket> · Child/);
    // The people's answers are in the registration's detail panel (?reg=), not in the roster rows.
    const regId = (await env.DB.prepare(`SELECT id FROM registrations WHERE event_id = ?1 ORDER BY id LIMIT 1`).bind(id).first<number>('id'))!;
    const detail = await (await get(`/admin/registration/${id}?reg=${regId}`, { cookie: await ADMIN() })).text();
    expect(detail).toContain('Shirt size: Medium');
    const csv = (await (await get(`/admin/registration/${id}/export.csv`, { cookie: await ADMIN() })).text()).split('\r\n');
    expect(csv[0]).toBe('Confirmation,Name,Email,Status,Party size,Amount,Registered,Need childcare?,Photo release,People,Phone,Ticket types,Shirt size,Allergies');
    expect(csv[1]).toContain('Sarah Johnson: Adult; Mia Johnson: Child,Sarah Johnson: Small; Mia Johnson: Medium,Mia Johnson: none');

    // A second family that needs the one Child seat that is gone joins the waitlist TOGETHER (the event has no overall limit).
    const graceCookie = await sessionCookie(...GRACE);
    const graceForm = await (await get(path, { cookie: graceCookie })).text();
    expect(graceForm).toContain('Sold out. Your group will join the waitlist.');
    expect(graceForm).not.toMatch(new RegExp(`value="${child}"[^>]*disabled`));
    const graceBase = hiddenFieldsOf(graceForm, path).filter(([n]) => n !== 'step');
    const graceFields: Array<[string, string]> = [
      ...graceBase, ['step', 'review'], ['person_name_1', 'Leo Lin'], ['ticket_0', String(adult)], ['ticket_1', String(child)],
      [`pq_0_${q['Shirt size']}`, 'sm'], [`pq_1_${q['Shirt size']}`, 'sm'], [String(q['Photo release']), 'on'],
    ];
    const graceReview = await (await post(path, formBody(graceFields), { cookie: graceCookie })).text();
    expect(graceReview).toContain('data-waitlist-party');
    const graceConfirm = hiddenFieldsOf(graceReview, '/api/register/submit').filter(([n]) => n !== 'step');
    const waitlisted = await post('/api/register/submit', formBody([...graceConfirm, ['step', 'confirm']]), { cookie: graceCookie });
    expect(waitlisted.status).toBe(303);
    expect(await env.DB.prepare(`SELECT status FROM registrations WHERE person_id = ?1`).bind(GRACE[0]).first<string>('status')).toBe('waitlist');
    // Adults-only registrations are unaffected by the Child limit.
    const adultsOnly = await post(path, formBody([...graceBase, ['step', 'review'], ['ticket_0', String(adult)], [`pq_0_${q['Shirt size']}`, 'sm'], [String(q['Photo release']), 'on']]), { cookie: await sessionCookie(...MEMBERS[3]) });
    expect(await adultsOnly.text()).not.toContain('data-waitlist-party');
  });

  it('marks a sold-out Child card unavailable when the event cannot waitlist', async () => {
    await enableRegistration();
    const { id, child, adult, q } = await ticketEvent();
    await env.DB.prepare(`UPDATE reg_events SET waitlist_enabled = 0 WHERE id = ?1`).bind(id).run();
    const cookie = await sessionCookie(...SARAH);
    const path = `/en/register/${id}`;
    const base = hiddenFieldsOf(await (await get(path, { cookie })).text(), path);
    const submit = async (c: string, ticket: number) => post('/api/register/submit', formBody([
      ...base.filter(([n]) => n !== 'step' && n !== 'submission_key' && n !== 'checkoutRequestId'),
      ['submission_key', crypto.randomUUID().replaceAll('-', '')], ['checkoutRequestId', crypto.randomUUID()], ['ticket_0', String(ticket)], [`pq_0_${q['Shirt size']}`, 'sm'], [String(q['Photo release']), 'on'],
    ]), { cookie: c });
    expect((await submit(cookie, child)).status).toBe(303); // takes the only Child seat
    const form = await (await get(path, { cookie: await sessionCookie(...GRACE) })).text();
    expect(form).toMatch(new RegExp(`value="${child}"[^>]*disabled data-locked`));
    expect(form).toContain('Sold out');
    // A forged POST for the gone seat does not register (the writer refuses, nothing is oversold).
    const forged = await submit(await sessionCookie(...GRACE), child);
    expect(forged.headers.get('location')).toContain('error=full');
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations WHERE event_id = ?1`).bind(id).first<number>('n')).toBe(1);
    expect(adult).toBeGreaterThan(0);
  });
});
