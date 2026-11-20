// Event logistics (housing, tables, small groups) on D1, against the BUILT worker: the event settings section, the
// Housing / Tables / Groups tabs (rooms by range, confirm, keep-party-together, the soft confirm and the hard
// refusal, auto-seat preview / apply / stale stamp, auto-fill), a print with names only, the check-in desk's room
// and table, the registrant's view only when the event shows it, the cancel release, and who can reach what
// (stranger, desk volunteer, viewer, per-event registrar; module off; an area off). Uses the seeded D1 event 920.
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
const EVENT = '/admin/registration/920';
const LANGUAGE_Q = 925;

async function setModules(logistics: boolean): Promise<void> {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) if (logistics || key !== 'event-logistics') body.append(`module.${key}`, '1');
  expect((await post('/admin/settings', body.toString(), { cookie: await ADMIN() })).status).toBe(303);
}

const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();
const all = async <T>(sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
const one = async <T>(sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<T>())!;
const flags = (housing: number, seating: number, groups: number, show = 0) =>
  run(`UPDATE reg_events SET housing_enabled = ?1, seating_enabled = ?2, groups_enabled = ?3, show_assignments = ?4 WHERE id = 920`, housing, seating, groups, show);

beforeEach(async () => {
  for (const table of ['reg_room_assignments', 'reg_table_seats', 'reg_group_members', 'reg_attendee_tags', 'reg_tags', 'reg_rooms', 'reg_room_types', 'reg_venues', 'reg_tables', 'reg_groups',
    'reg_checkins', 'reg_outbox', 'reg_activity', 'reg_event_access', 'reg_attendee_answers', 'reg_answers', 'reg_attendees', 'registrations', 'email_log', 'newcomer_rate_limits']) await run(`DELETE FROM ${table}`);
  await run(`DELETE FROM reg_ticket_types WHERE event_id IN (920, 930)`);
  await run(`DELETE FROM reg_questions WHERE id = ${LANGUAGE_Q}`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1, capacity = NULL, max_party_size = 6,
    allow_self_edit = 1, requires_approval = 0, reminder_days = NULL, confirmation_prefix = NULL, visible_from = NULL,
    housing_enabled = 0, seating_enabled = 0, groups_enabled = 0, show_assignments = 0, gender_question_id = NULL, logistics_version = 0,
    starts_at = datetime('now','+14 days','start of day','+18 hours'), opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
});

const act = async (fields: Record<string, string | string[]>, cookie: string, query = '') => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  return post(`${EVENT}${query}`, body.toString(), { cookie });
};
const page = async (path: string, cookie: string) => (await get(path, { cookie })).text();

/** A walk-in party added by hand (confirmed): returns the registration and its people in order. */
async function party(admin: string, names: string[], email: string): Promise<{ id: number; people: number[] }> {
  const fields: Record<string, string> = { action: 'create', contact_name: names[0], contact_email: email, contact_phone: '', p0_name: '' };
  names.slice(1).forEach((n, i) => { fields[`p${i + 1}_name`] = n; });
  expect((await act(fields, admin)).status).toBe(303);
  const reg = await one<{ id: number }>(`SELECT id FROM registrations WHERE email = ?1`, email);
  const people = (await all<{ id: number }>(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`, reg.id)).map((r) => r.id);
  return { id: reg.id, people };
}

/** Pine Lodge (a hotel: flexible beds) with 2-bed rooms 101-103, all ready. */
async function pineLodge(admin: string): Promise<number[]> {
  expect((await act({ action: 'venue_create', name: 'Pine Lodge', kind: 'hotel', capacity_rule: '', tab: 'housing', back: 'tab=housing' }, admin)).status).toBe(303);
  const venue = await one<{ id: number }>(`SELECT id FROM reg_venues WHERE event_id = 920 AND name = 'Pine Lodge'`);
  expect((await act({ action: 'room_type_create', venue_id: String(venue.id), name: 'Double room', beds: '2' }, admin)).status).toBe(303);
  const type = await one<{ id: number }>(`SELECT id FROM reg_room_types WHERE venue_id = ?1`, venue.id);
  const added = await act({ action: 'rooms_add', venue_id: String(venue.id), labels: '101-103', room_type_id: String(type.id), beds: '', floor: '1', policy: 'any', back: 'tab=housing&lq=ana' }, admin);
  expect(added.status).toBe(303);
  expect(added.headers.get('location')).toBe(`${EVENT}?tab=housing&lq=ana&notice=lx_rooms_added&n=3&m=0#logistics`);
  const rooms = (await all<{ id: number }>(`SELECT id FROM reg_rooms WHERE venue_id = ?1 ORDER BY sort`, venue.id)).map((r) => r.id);
  expect((await act({ action: 'rooms_bulk', op: 'confirm', room_ids: rooms.map(String) }, admin)).status).toBe(303);
  return rooms;
}

describe('Event logistics on D1', () => {
  it('event settings: the Logistics section saves the switches and the room question, and is hidden with the module off', async () => {
    await setModules(true);
    const admin = await ADMIN();
    await run(`INSERT INTO reg_questions (id, event_id, sort, type, required, options, scope) VALUES (${LANGUAGE_Q}, 920, 3, 'select', 0, '["f","m"]', 'attendee')`);
    await run(`INSERT INTO reg_question_i18n (question_id, locale, label) VALUES (${LANGUAGE_Q}, 'en', 'Gender') ON CONFLICT DO NOTHING`);
    const form = await page('/admin/registration?edit=920', admin);
    expect(form).toContain('data-testid="logistics-settings"');
    expect(form).toContain(`<option value="${LANGUAGE_Q}">Gender</option>`);
    expect(form).not.toContain('<option value="921">'); // a once-per-registration question is not offered
    const fields = { action: 'save', id: '920', title_en: 'Neighbors Potluck Night', starts_at: '2031-06-01T10:00', logistics_section: '1', gender_question_id: String(LANGUAGE_Q) };
    const body = new URLSearchParams(fields);
    for (const [name, on] of [['housing_enabled', true], ['seating_enabled', false], ['groups_enabled', true], ['show_assignments', true]] as const) {
      body.append(name, '0');
      if (on) body.append(name, '1');
    }
    expect((await post('/admin/registration', body.toString(), { cookie: admin })).status).toBe(303);
    expect(await one(`SELECT housing_enabled AS h, seating_enabled AS s, groups_enabled AS g, show_assignments AS a, gender_question_id AS q FROM reg_events WHERE id = 920`))
      .toEqual({ h: 1, s: 0, g: 1, a: 1, q: LANGUAGE_Q });
    // A save without the section (another form, or the module off) leaves the switches alone.
    expect((await post('/admin/registration', new URLSearchParams({ action: 'save', id: '920', title_en: 'Neighbors Potluck Night', starts_at: '2031-06-01T10:00' }).toString(), { cookie: admin })).status).toBe(303);
    expect(await one(`SELECT housing_enabled AS h FROM reg_events WHERE id = 920`)).toEqual({ h: 1 });
    // The event page shows exactly the tabs switched on.
    const eventPage = await page(EVENT, admin);
    expect(eventPage).toContain('data-testid="logistics-tabs"');
    expect(eventPage).toContain('data-tab="housing"');
    expect(eventPage).toContain('data-tab="groups"');
    expect(eventPage).not.toContain('data-tab="tables"');
    expect(eventPage).toContain('data-testid="overview-logistics"');
    await setModules(false);
    expect(await page('/admin/registration?edit=920', admin)).not.toContain('data-testid="logistics-settings"');
    const off = await page(EVENT, admin);
    expect(off).not.toContain('data-testid="logistics-tabs"');
    expect(off).not.toContain('data-testid="overview-logistics"');
  });

  it('housing: rooms by range, keep the party together, confirm a soft limit, refuse a hard one, ask a reason for a checked-in move', async () => {
    await setModules(true);
    await flags(1, 0, 0);
    const admin = await ADMIN();
    const rooms = await pineLodge(admin);
    const lopez = await party(admin, ['Ana Lopez', 'Ben Lopez'], 'lopez@example.com');
    const kim = await party(admin, ['Dan Kim', 'Eve Kim', 'Fay Kim'], 'kim@example.com');

    const board = await page(`${EVENT}?tab=housing`, admin);
    expect(board).toContain('data-testid="lx-housing"');
    for (const id of rooms) expect(board).toContain(`data-room="${id}" data-confirmed="1"`);
    expect(board).toContain('Ana Lopez');
    expect(board).toContain('data-party-left="1"');
    expect(board).toContain('name="attendee_id" value="' + lopez.people[0] + '" form="lx-assign"');
    // The board does not load the roster.
    expect(board).not.toContain('data-testid="roster-filters"');

    // Keep party together (on by default): one choice places both Lopezes.
    const placed = await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[0]), party: ['0', '1'], tab: 'housing', back: 'tab=housing' }, admin, '?tab=housing');
    expect(placed.status).toBe(303);
    expect(placed.headers.get('location')).toBe(`${EVENT}?tab=housing&notice=lx_assigned&n=2#logistics`);
    expect((await all<{ attendee_id: number }>(`SELECT attendee_id FROM reg_room_assignments WHERE room_id = ?1 ORDER BY attendee_id`, rooms[0])).map((r) => r.attendee_id)).toEqual(lopez.people);
    expect(await page(placed.headers.get('location')!, admin)).toContain('Done: 2 people placed.');

    // Three Kims in a two-bed room of a hotel (flexible): asked first, with the reason and a checkbox; nothing written.
    const asked = await act({ action: 'room_assign', attendee_id: String(kim.people[0]), room_id: String(rooms[1]), party: ['0', '1'], tab: 'housing', back: 'tab=housing' }, admin, '?tab=housing');
    expect(asked.status).toBe(409);
    const askedHtml = await asked.text();
    expect(askedHtml).toContain('data-testid="needs-confirm"');
    expect(askedHtml).toContain('data-confirm-reason="room_over_capacity"');
    expect(askedHtml).toContain('This room would have more people than beds.');
    expect(askedHtml).toContain('name="confirm" value="1" required');
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments WHERE room_id = ?1`, rooms[1])).n)).toBe(0);
    const confirmed = await act({ action: 'room_assign', attendee_id: String(kim.people[0]), room_id: String(rooms[1]), party: ['0', '1'], tab: 'housing', back: 'tab=housing', confirm: '1' }, admin, '?tab=housing');
    expect(confirmed.status).toBe(303);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments WHERE room_id = ?1`, rooms[1])).n)).toBe(3);
    expect(await page(`${EVENT}?tab=housing`, admin)).toContain('Over capacity');

    // A dorm has fixed beds: refused outright.
    expect((await act({ action: 'venue_create', name: 'Cedar Hall', kind: 'dorm' }, admin)).status).toBe(303);
    const cedar = await one<{ id: number }>(`SELECT id FROM reg_venues WHERE name = 'Cedar Hall'`);
    expect((await act({ action: 'rooms_add', venue_id: String(cedar.id), labels: 'A1', beds: '1', policy: 'any' }, admin)).status).toBe(303);
    const a1 = await one<{ id: number }>(`SELECT id FROM reg_rooms WHERE venue_id = ?1`, cedar.id);
    expect((await act({ action: 'rooms_bulk', op: 'confirm', room_ids: String(a1.id) }, admin)).status).toBe(303);
    const moss = await party(admin, ['Gus Moss', 'Hal Moss'], 'moss@example.com');
    const full = await act({ action: 'room_assign', attendee_id: String(moss.people[0]), room_id: String(a1.id), party: ['0', '1'], tab: 'housing' }, admin, '?tab=housing');
    expect(full.status).toBe(422);
    const fullHtml = await full.text();
    expect(fullHtml).toContain('data-code="lx_ROOM_FULL"');
    expect(fullHtml).toContain('That room is full.');

    // A range written backwards is explained.
    const reversed = await act({ action: 'rooms_add', venue_id: String(cedar.id), labels: '120-101', beds: '2' }, admin, '?tab=housing');
    expect(await reversed.text()).toContain('A range runs backwards.');

    // Moving someone checked in asks for a reason, which the history keeps.
    expect((await post(`${EVENT}/checkin`, new URLSearchParams({ op: 'checkin', attendee_id: String(lopez.people[0]) }).toString(), { cookie: admin })).status).toBe(303);
    const why = await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[2]), party: '0', tab: 'housing' }, admin, '?tab=housing');
    expect(why.status).toBe(409);
    expect(await why.text()).toContain('data-testid="needs-reason"');
    expect((await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[2]), party: '0', tab: 'housing', reason: 'Needs a quiet room' }, admin)).status).toBe(303);
    const drawer = await page(`${EVENT}?reg=${lopez.id}`, admin);
    expect(drawer).toContain('Moved to another room');
    expect(drawer).toContain('103 (Pine Lodge) · Needs a quiet room');
    expect(drawer).toContain('data-person-logistics');
  });

  it('tables: auto-seat preview, apply, and a stale preview is refused with a clear message', async () => {
    await setModules(true);
    await flags(0, 1, 0);
    const admin = await ADMIN();
    const lopez = await party(admin, ['Ana Lopez', 'Ben Lopez'], 'lopez@example.com');
    const kim = await party(admin, ['Dan Kim', 'Eve Kim', 'Fay Kim'], 'kim@example.com');
    expect((await act({ action: 'tables_add', count: '2', seats: '4', prefix: 'Table', from: '1', tab: 'tables' }, admin)).status).toBe(303);
    const preview = await act({ action: 'seat_preview', start_over: '0', tab: 'tables', back: 'tab=tables' }, admin, '?tab=tables');
    expect(preview.status).toBe(200);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('data-testid="lx-seat-preview"');
    expect(previewHtml).toContain('5 people would get a new seat; 0 could not be seated.');
    const stamp = /data-stamp="([^"]+)"/.exec(previewHtml)![1];
    expect(previewHtml).toContain(`name="stamp" value="${stamp}"`);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_table_seats`)).n)).toBe(0);

    // Someone new registers after the preview: the apply is refused and writes nothing.
    await party(admin, ['Gus Late'], 'late@example.com');
    const stale = await act({ action: 'seat_apply', start_over: '0', stamp, tab: 'tables', back: 'tab=tables' }, admin, '?tab=tables');
    expect(stale.status).toBe(422);
    expect(await stale.text()).toContain('Preview again before you apply.');
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_table_seats`)).n)).toBe(0);

    const fresh = await (await act({ action: 'seat_preview', start_over: '0', tab: 'tables' }, admin, '?tab=tables')).text();
    const applied = await act({ action: 'seat_apply', start_over: '0', stamp: /data-stamp="([^"]+)"/.exec(fresh)![1], tab: 'tables', back: 'tab=tables' }, admin);
    expect(applied.status).toBe(303);
    expect(applied.headers.get('location')).toBe(`${EVENT}?tab=tables&notice=lx_seat_applied&n=6&m=0#logistics`);
    const seats = await all<{ attendee_id: number; table_id: number }>(`SELECT attendee_id, table_id FROM reg_table_seats`);
    expect(seats).toHaveLength(6);
    const tableOf = new Map(seats.map((s) => [s.attendee_id, s.table_id]));
    expect(new Set(kim.people.map((id) => tableOf.get(id))).size).toBe(1);
    expect(new Set(lopez.people.map((id) => tableOf.get(id))).size).toBe(1);
  });

  it('groups: auto-fill by a per-person question; prints show names only; the desk shows room and table', async () => {
    await setModules(true);
    await flags(1, 1, 1);
    const admin = await ADMIN();
    await run(`INSERT INTO reg_questions (id, event_id, sort, type, required, options, scope) VALUES (${LANGUAGE_Q}, 920, 3, 'select', 0, '["en","zh"]', 'attendee')`);
    await run(`INSERT INTO reg_question_i18n (question_id, locale, label) VALUES (${LANGUAGE_Q}, 'en', 'Language') ON CONFLICT DO NOTHING`);
    const lopez = await party(admin, ['Ana Lopez', 'Ben Lopez'], 'lopez@example.com');
    await run(`INSERT INTO reg_attendee_answers (attendee_id, question_id, value) VALUES (?1, ${LANGUAGE_Q}, 'en'), (?2, ${LANGUAGE_Q}, 'zh')`, lopez.people[0], lopez.people[1]);
    const filled = await act({ action: 'group_autofill', question_id: String(LANGUAGE_Q), capacity: '', tab: 'groups', back: 'tab=groups' }, admin);
    expect(filled.status).toBe(303);
    expect(filled.headers.get('location')).toBe(`${EVENT}?tab=groups&notice=lx_group_filled&n=2&m=0#logistics`);
    expect((await all<{ name: string }>(`SELECT name FROM reg_groups WHERE event_id = 920 ORDER BY sort`)).length).toBe(2);
    expect(await page(`${EVENT}?tab=groups`, admin)).toContain('data-testid="lx-groups"');

    // A room and a table for Ana, then the prints and the desk.
    const rooms = await pineLodge(admin);
    expect((await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[0]), party: '0' }, admin)).status).toBe(303);
    expect((await act({ action: 'tables_add', count: '1', seats: '6', prefix: 'Table', from: '5' }, admin)).status).toBe(303);
    const table = await one<{ id: number }>(`SELECT id FROM reg_tables WHERE event_id = 920`);
    expect((await act({ action: 'table_seat', attendee_id: String(lopez.people[0]), table_id: String(table.id), party: '0' }, admin)).status).toBe(303);
    for (const [path, testid] of [['door-signs', 'door-signs'], ['room-list', 'room-list'], ['table-list', 'table-list'], ['table-cards', 'table-cards'], ['group-list', 'group-list']]) {
      const res = await get(`${EVENT}/${path}`, { cookie: admin });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain(`data-testid="${testid}"`);
      expect(html, path).toContain('Ana Lopez');
      expect(html, path).not.toContain('lopez@example.com');
    }
    const signs = await page(`${EVENT}/door-signs`, admin);
    expect(signs).toContain('<p class="lx-sign-room">101</p>');
    expect(signs).not.toContain('<p class="lx-sign-room">102</p>'); // empty rooms are left out by default
    expect(await page(`${EVENT}/door-signs?all=1`, admin)).toContain('<p class="lx-sign-room">102</p>');

    const desk = await page(`${EVENT}/checkin?q=${encodeURIComponent('Ana Lopez')}`, admin);
    expect(desk).toMatch(/data-desk-room[^>]*>Room: 101 \(Pine Lodge\)</);
    expect(desk).toMatch(/data-desk-table[^>]*>Table: Table 5</);
    expect(desk).toContain('Table: not assigned yet'); // Ben has no table
    expect(desk).not.toContain('lopez@example.com');
  });

  it('the registrant sees room, table and group only when the event shows them; cancelling releases them', async () => {
    await setModules(true);
    await flags(1, 1, 0);
    const admin = await ADMIN();
    const signup = new URLSearchParams({ locale: 'en', event_id: '920', checkoutRequestId: crypto.randomUUID(), '921': 'Main dish' });
    expect((await post('/api/register/submit', signup.toString(), { cookie: await sessionCookie(...SARAH) })).status).toBe(303);
    const reg = await one<{ id: number }>(`SELECT id FROM registrations WHERE email = ?1`, SARAH[1]);
    const attendee = await one<{ id: number }>(`SELECT id FROM reg_attendees WHERE registration_id = ?1`, reg.id);
    const rooms = await pineLodge(admin);
    expect((await act({ action: 'room_assign', attendee_id: String(attendee.id), room_id: String(rooms[1]) }, admin)).status).toBe(303);
    const sarah = await sessionCookie(...SARAH);
    const hidden = await page(`/en/my/events/${reg.id}`, sarah);
    expect(hidden).not.toContain('data-assignments');
    expect(hidden).not.toContain('102 (Pine Lodge)');
    await flags(1, 1, 0, 1);
    const shown = await page(`/en/my/events/${reg.id}`, sarah);
    expect(shown).toContain('data-assignments');
    expect(shown).toContain('102 (Pine Lodge)');
    expect(shown).toContain('Not assigned yet'); // no table yet
    // The module off hides them again, whatever the event says.
    await setModules(false);
    expect(await page(`/en/my/events/${reg.id}`, sarah)).not.toContain('data-assignments');
    await setModules(true);

    // Cancelling the registration takes the room away, in the same change, with a history row.
    expect((await act({ action: 'cancel', registration_id: String(reg.id) }, admin)).status).toBe(303);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments`)).n)).toBe(0);
    expect(await page(`${EVENT}?reg=${reg.id}`, admin)).toContain('Room, table and group released after cancelling');
  });

  it('who can reach what: stranger and desk refused, a viewer reads without forms, a registrar changes; module or area off refuses', async () => {
    await setModules(true);
    await flags(1, 1, 1);
    const admin = await ADMIN();
    const rooms = await pineLodge(admin);
    const lopez = await party(admin, ['Ana Lopez'], 'lopez@example.com');
    await grantEventRole(env.DB, 920, GRACE[0], 'desk');
    await grantEventRole(env.DB, 920, MARK[0], 'viewer');
    const stranger = await sessionCookie(...SARAH);
    const desk = await sessionCookie(...GRACE);
    const viewer = await sessionCookie(...MARK);
    const prints = ['room-list', 'door-signs', 'table-list', 'table-cards', 'group-list'];
    for (const cookie of [stranger, desk]) {
      expect((await get(`${EVENT}?tab=housing`, { cookie })).status).toBe(403);
      for (const p of prints) expect((await get(`${EVENT}/${p}`, { cookie })).status, p).toBe(403);
      expect((await act({ action: 'venue_create', name: 'X' }, cookie)).status).toBe(403);
    }
    // The viewer sees the board and the prints, without a single form, and every write is refused.
    const view = await page(`${EVENT}?tab=housing`, viewer);
    expect(view).toContain('data-testid="lx-housing"');
    expect(view).toContain('Ana Lopez');
    for (const absent of ['value="room_assign"', 'value="rooms_bulk"', 'value="venue_create"', 'value="tag_create"', 'form="lx-assign"']) expect(view, absent).not.toContain(absent);
    for (const p of prints) expect((await get(`${EVENT}/${p}`, { cookie: viewer })).status, p).toBe(200);
    expect((await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[0]) }, viewer)).status).toBe(403);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments`)).n)).toBe(0);

    // A per-event registrar (no admin area) makes changes.
    await grantEventRole(env.DB, 920, MARK[0], 'registrar');
    expect((await act({ action: 'room_assign', attendee_id: String(lopez.people[0]), room_id: String(rooms[0]) }, viewer)).status).toBe(303);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments`)).n)).toBe(1);

    // An area switched off: its tab is gone and its actions are refused; the other tabs stay.
    await flags(1, 0, 1);
    expect(await page(`${EVENT}?tab=tables`, admin)).not.toContain('data-testid="lx-tables"');
    const refused = await act({ action: 'tables_add', count: '2', seats: '4' }, admin);
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('data-code="lx_disabled"');
    expect((await get(`${EVENT}/table-list`, { cookie: admin })).status).toBe(404);
    expect((await get(`${EVENT}/room-list`, { cookie: admin })).status).toBe(200);

    // The module off: no tabs, every logistics action and print answers 404.
    await setModules(false);
    expect(await page(`${EVENT}?tab=housing`, admin)).not.toContain('data-testid="lx-housing"');
    expect((await act({ action: 'room_unassign', attendee_id: String(lopez.people[0]) }, admin)).status).toBe(404);
    for (const p of prints) expect((await get(`${EVENT}/${p}`, { cookie: admin })).status, p).toBe(404);
    expect(Number((await one<{ n: number }>(`SELECT COUNT(*) AS n FROM reg_room_assignments`)).n)).toBe(1);
  });
});
