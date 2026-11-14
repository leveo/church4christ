// Service Planning against the BUILT worker: the main pages and their access
// rules (200 / 303 / 403 / 404), the module gate, run-sheet and session writes,
// and what a member's calendar feed exposes. Demo seed: event 31000 "Christmas
// Service" (Sarah coordinates; Mark is called to a rehearsal; Joshua is not involved).
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';
import { generateCalendarToken } from '../../src/lib/ical';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
}
const admin = () => sessionCookie(1, 'admin@example.com');
const sarah = () => sessionCookie(3, 'sarah.johnson@example.com'); // event coordinator
const mark = () => sessionCookie(5, 'mark.liu@example.com'); // called to a rehearsal, Worship team
const joshua = () => sessionCookie(10, 'joshua.zhao@example.com'); // AV team: owns no item, not called
const lydia = () => sessionCookie(11, 'lydia.kwan@example.com'); // limited admin without planning

const CUE = 'Start with the piano intro only.';

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

describe('planning pages and access', () => {
  it('sends anonymous visitors to sign in', async () => {
    const res = await get('/en/planning/31000');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/en/signin');
  });

  it.each(['', '/manage', '/sessions', '/calendar', '/print', '/print?leader=1'])(
    'serves /planning/31000%s to the event coordinator',
    async (suffix) => {
      const res = await get(`/en/planning/31000${suffix}`, { cookie: await sarah() });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Christmas Service');
    },
  );

  it('shows cue notes to coordinators and the leader print only', async () => {
    const view = await (await get('/en/planning/31000', { cookie: await sarah() })).text();
    expect(view).toContain(CUE);
    const plain = await (await get('/en/planning/31000/print', { cookie: await sarah() })).text();
    expect(plain).not.toContain(CUE);
    const leader = await (await get('/en/planning/31000/print?leader=1', { cookie: await sarah() })).text();
    expect(leader).toContain(CUE);
  });

  it('shows a called member the run sheet with their items highlighted and no cue notes', async () => {
    const res = await get('/en/planning/31000', { cookie: await mark() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Opening carol');
    expect(html).toContain('Yours'); // Worship team items are Mark's
    expect(html).toContain('Worship team rehearsal');
    expect(html).not.toContain(CUE);
    // A participant gets the plain print only; leader=1 is ignored for them.
    const print = await (await get('/en/planning/31000/print?leader=1', { cookie: await mark() })).text();
    expect(print).not.toContain(CUE);
  });

  it('keeps participants out of the coordinator pages and outsiders out of the event', async () => {
    for (const suffix of ['/manage', '/sessions', '/calendar']) {
      expect((await get(`/en/planning/31000${suffix}`, { cookie: await mark() })).status).toBe(404);
    }
    for (const suffix of ['', '/manage', '/print']) {
      expect((await get(`/en/planning/31000${suffix}`, { cookie: await joshua() })).status).toBe(404);
    }
    expect((await get('/en/planning/999999', { cookie: await sarah() })).status).toBe(404);
    expect((await get('/en/planning/abc', { cookie: await sarah() })).status).toBe(404);
  });

  it('serves the admin list to the super admin and rejects members and admins without the area', async () => {
    const list = await get('/admin/planning', { cookie: await admin() });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('Christmas Service');
    expect((await get('/admin/planning', { cookie: await sarah() })).status).toBe(403);
    expect((await get('/admin/planning', { cookie: await lydia() })).status).toBe(403);
    expect((await get('/en/planning/31000/manage', { cookie: await admin() })).status).toBe(200);
  });

  it('renders the availability page and saves a window for the signed-in member only', async () => {
    const cookie = await mark();
    expect((await get('/en/my/availability', { cookie })).status).toBe(200);
    const body = new URLSearchParams({ _action: 'add', mode: 'once', starts_on: '2031-03-01', start_time: '18:00', end_time: '20:00', note: 'mine' });
    const saved = await post('/en/my/availability', body.toString(), { cookie });
    expect(saved.status).toBe(303);
    const rows = await env.DB.prepare('SELECT person_id, ends_on, weekdays FROM availability_windows WHERE starts_on = ?').bind('2031-03-01').all<{ person_id: number; ends_on: string; weekdays: string }>();
    expect(rows.results).toEqual([{ person_id: 5, ends_on: '2031-03-01', weekdays: '' }]);
    const bad = await post('/en/my/availability', 'mode=once&_action=add&starts_on=2031-03-01&start_time=20:00&end_time=18:00', { cookie });
    expect(bad.status).toBe(200);
  });
});

describe('planning writes', () => {
  it('adds a run-sheet item and rejects a stale revision', async () => {
    const cookie = await sarah();
    const form = (rev: number, title: string) => new URLSearchParams({ _action: 'add_item', rev: String(rev), title_en: title, kind: 'segment', duration_min: '5' }).toString();
    const ok = await post('/en/planning/31000/manage', form(1, 'Testimony'), { cookie });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/en/planning/31000/manage?saved=1');
    const stale = await post('/en/planning/31000/manage', form(1, 'Stale item'), { cookie });
    expect(stale.headers.get('location')).toBe('/en/planning/31000/manage?error=conflict');
    const titles = await env.DB.prepare('SELECT title_en FROM planning_items WHERE event_id = 31000').all<{ title_en: string }>();
    expect(titles.results.map((r) => r.title_en)).toContain('Testimony');
    expect(titles.results.map((r) => r.title_en)).not.toContain('Stale item');
  });

  it('does not let a participant write', async () => {
    const res = await post('/en/planning/31000/manage', 'rev=1&_action=add_item&title_en=Hack', { cookie: await mark() });
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM planning_items WHERE title_en = 'Hack'").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('schedules a draft rehearsal only after the unknown people are acknowledged, and emails them', async () => {
    const cookie = await sarah();
    const first = await post('/en/planning/31000/sessions', '_action=schedule&session_id=31101', { cookie });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('have not shared availability');
    const still = await env.DB.prepare('SELECT status FROM planning_sessions WHERE id = 31101').first<{ status: string }>();
    expect(still?.status).toBe('draft');

    const second = await post('/en/planning/31000/sessions', '_action=schedule&session_id=31101&ack=1', { cookie });
    expect(second.status).toBe(303);
    const done = await env.DB.prepare('SELECT status, acknowledged_unknown FROM planning_sessions WHERE id = 31101').first();
    expect(done).toEqual({ status: 'scheduled', acknowledged_unknown: 1 });
    const mail = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'planningPublish'").first<{ n: number }>();
    expect(mail?.n).toBe(3);
  });

  it('ignores a session id that belongs to another event', async () => {
    const other = await env.DB.prepare(
      `INSERT INTO planning_events (title_en, event_date, start_time) VALUES ('Other', '2031-01-01', '09:00') RETURNING id`,
    ).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO planning_sessions (id, event_id, title_en, session_date, start_time, end_time) VALUES (31900, ?, 'Other rehearsal', '2031-01-01', '19:00', '20:00')`,
    ).bind(other!.id).run();
    const res = await post('/en/planning/31000/sessions', '_action=cancel&session_id=31900', { cookie: await sarah() });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM planning_sessions WHERE id = 31900').first<{ status: string }>();
    expect(row?.status).toBe('draft');
  });
});

describe('planning admin', () => {
  it('creates an event and sends the admin to its coordinator page', async () => {
    const body = new URLSearchParams({ _action: 'create', title_en: 'Easter Service', event_date: '2031-04-20', start_time: '09:30', end_time: '11:00' });
    const res = await post('/admin/planning', body.toString(), { cookie: await admin() });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("SELECT id, status, revision, created_by FROM planning_events WHERE title_en = 'Easter Service'").first<{ id: number; status: string; revision: number; created_by: number }>();
    expect(row).toMatchObject({ status: 'draft', revision: 1, created_by: 1 });
    expect(res.headers.get('location')).toBe(`/en/planning/${row!.id}/manage`);
    const invalid = await post('/admin/planning', 'title_en=&_action=create&event_date=bad&start_time=09:30', { cookie: await admin() });
    expect(invalid.status).toBe(200);
  });

  it('saves the notification rules through the campus-scoped database', async () => {
    const body = new URLSearchParams({ _action: 'rules', enabled_publish: '1', enabled_remind: '1', lead_remind: '48' });
    const res = await post('/admin/planning', body.toString(), { cookie: await admin() });
    expect(res.status).toBe(303);
    const rules = await env.DB.prepare('SELECT rule_key, enabled, lead_hours FROM planning_notification_rules WHERE campus_id = 1 ORDER BY rule_key').all<{ rule_key: string; enabled: number; lead_hours: number }>();
    expect(rules.results).toEqual([
      { rule_key: 'cancel', enabled: 0, lead_hours: 24 },
      { rule_key: 'change', enabled: 0, lead_hours: 24 },
      { rule_key: 'publish', enabled: 1, lead_hours: 24 },
      { rule_key: 'remind', enabled: 1, lead_hours: 48 },
    ]);
  });
});

describe('planning in the calendar feed', () => {
  it('exports a member rehearsal and duties without cue notes or private notes', async () => {
    const token = await generateCalendarToken(env.DB, 5);
    const res = await get(`/cal/${token}.ics`);
    expect(res.status).toBe(200);
    const ics = await res.text();
    expect(ics).toContain('SUMMARY:Worship team rehearsal — Christmas Service');
    expect(ics).toContain('UID:c4c-planning-session-31100@');
    expect(ics).toContain('UID:c4c-planning-duty-31000-');
    expect(ics).not.toContain(CUE);
    expect(ics).not.toContain('Prefers evenings'); // Mark's own private window note
  });
});

describe('module gate', () => {
  afterEach(async () => {
    await post('/admin/settings', modulesBody([]), { cookie: await admin() });
  });

  it('404s every planning route when the module is off and restores them when it is on', async () => {
    const off = await post('/admin/settings', modulesBody(['planning']), { cookie: await admin() });
    expect(off.status).toBe(303);
    for (const path of ['/admin/planning', '/en/planning/31000', '/en/planning/31000/manage', '/en/my/availability']) {
      expect((await get(path, { cookie: await admin() })).status, path).toBe(404);
    }
    // The volunteer calendar still works without the module.
    expect((await get('/en/my/calendar', { cookie: await mark() })).status).toBe(200);
    await post('/admin/settings', modulesBody([]), { cookie: await admin() });
    expect((await get('/en/planning/31000', { cookie: await mark() })).status).toBe(200);
  });
});
