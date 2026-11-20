// The registration back office on D1, against the BUILT worker: an approval event end to end (sign-up lands in
// review, a registrar accepts, the decision mail is logged), a manual walk-in, roster search and filters, the bulk
// email composer (preview, queue, drain), CSV (BOM, per person), badges, event settings, and what a per-event
// viewer / desk volunteer can and cannot reach. Uses the seeded D1 event 920 (open, capacity 3).
import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';
import { grantEventRole } from '../../src/lib/regAccess';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const sessionCookie = async (id: number, email: string) => `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
const ADMIN = () => sessionCookie(1, 'admin@example.com');
const SARAH: [number, string] = [3, 'sarah.johnson@example.com'];
const GRACE: [number, string] = [4, 'grace.lin@example.com'];
const MARK: [number, string] = [5, 'mark.liu@example.com'];

async function enableRegistration(): Promise<void> {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) body.append(`module.${key}`, '1');
  expect((await post('/admin/settings', body.toString(), { cookie: await ADMIN() })).status).toBe(303);
}

async function reset(): Promise<void> {
  const run = (sql: string) => env.DB.prepare(sql).run();
  for (const table of ['reg_outbox', 'reg_activity', 'reg_event_access', 'reg_answers', 'reg_attendees', 'registrations', 'email_log', 'newcomer_rate_limits']) await run(`DELETE FROM ${table}`);
  await run(`DELETE FROM reg_ticket_types WHERE event_id IN (920, 930)`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1, capacity = 3, max_party_size = 4,
    allow_self_edit = 1, requires_approval = 0, reminder_days = NULL, confirmation_prefix = NULL, visible_from = NULL,
    starts_at = datetime('now','+14 days','start of day','+18 hours'), opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
}
beforeEach(reset);

async function signUp([id, email]: [number, string], eventId = 920): Promise<Response> {
  const body = new URLSearchParams({ locale: 'en', event_id: String(eventId), checkoutRequestId: crypto.randomUUID(), '921': 'Main dish' });
  return post('/api/register/submit', body.toString(), { cookie: await sessionCookie(id, email) });
}
const regOf = async (email: string) => (await env.DB.prepare(`SELECT id, status, version FROM registrations WHERE email = ?1`).bind(email).first<{ id: number; status: string; version: number }>())!;
const act = async (fields: Record<string, string>, cookie: string, eventId = 920) =>
  post(`/admin/registration/${eventId}`, new URLSearchParams(fields).toString(), { cookie });
const page = async (path: string, cookie: string) => (await get(path, { cookie })).text();

describe('Registration back office on D1', () => {
  it('approval event: a sign-up lands in review, the registrar sees the actions, accepts it, and the decision mail is logged', async () => {
    await enableRegistration();
    await env.DB.prepare(`UPDATE reg_events SET requires_approval = 1 WHERE id = 920`).run();
    expect((await signUp(SARAH)).status).toBe(303);
    const reg = await regOf(SARAH[1]);
    expect(reg.status).toBe('review');

    const admin = await ADMIN();
    const overview = await page('/admin/registration/920', admin);
    expect(overview).toContain('data-testid="reg-overview"');
    expect(overview).toContain('In review');
    expect(overview).toContain('Awaiting a decision');

    const drawer = await page(`/admin/registration/920?reg=${reg.id}`, admin);
    expect(drawer).toContain('data-testid="approval-actions"');
    for (const decision of ['accept', 'waitlist', 'decline']) expect(drawer).toContain(`data-decision="${decision}"`);
    expect(drawer).toContain('data-testid="reg-history"');

    await env.DB.prepare(`DELETE FROM email_log`).run();
    const res = await act({ action: 'decide', registration_id: String(reg.id), decision: 'accept', version: String(reg.version), back: '' }, admin);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/registration/920?reg=${reg.id}&notice=decided_accept#reg-drawer`);
    expect((await regOf(SARAH[1])).status).toBe('confirmed');
    const mails = (await env.DB.prepare(`SELECT kind, to_email FROM email_log`).all<{ kind: string; to_email: string }>()).results;
    expect(mails).toEqual([{ kind: 'regDecision', to_email: SARAH[1] }]);
    const after = await page(res.headers.get('location')!, admin);
    expect(after).toContain('data-notice="decided_accept"');
    expect(after).toContain('Accepted'); // the history row
    expect(after).not.toContain('data-testid="approval-actions"'); // already decided

    // A stale form is refused with the "someone else changed this" notice and changes nothing.
    const stale = await act({ action: 'note', registration_id: String(reg.id), version: String(reg.version), note: 'late' }, admin);
    expect(stale.headers.get('location')).toBe(`/admin/registration/920?reg=${reg.id}&notice=conflict#reg-drawer`);
    expect(await page(stale.headers.get('location')!, admin)).toContain('Someone else changed this registration');
  });

  it('the soft confirm re-renders the page with the reason and a "Do it anyway" form that replays the request', async () => {
    await enableRegistration();
    await env.DB.prepare(`UPDATE reg_events SET capacity = 1 WHERE id = 920`).run();
    expect((await signUp(SARAH)).status).toBe(303);
    expect((await signUp(GRACE)).status).toBe(303); // waitlist
    const grace = await regOf(GRACE[1]);
    expect(grace.status).toBe('waitlist');
    const admin = await ADMIN();
    const asked = await act({ action: 'move', registration_id: String(grace.id), to: 'confirmed', version: String(grace.version) }, admin);
    expect(asked.status).toBe(409);
    const html = await asked.text();
    expect(html).toContain('data-testid="needs-confirm"');
    expect(html).toContain('The event is full. Do it anyway?');
    expect(html).toContain('name="confirm" value="1"');
    expect(html).toContain(`name="registration_id" value="${grace.id}"`);
    expect((await regOf(GRACE[1])).status).toBe('waitlist');
    const done = await act({ action: 'move', registration_id: String(grace.id), to: 'confirmed', version: String(grace.version), confirm: '1' }, admin);
    expect(done.status).toBe(303);
    expect((await regOf(GRACE[1])).status).toBe('confirmed');
  });

  it('adds a walk-in by hand, then finds it by search; filters and sort come from the query string', async () => {
    await enableRegistration();
    const admin = await ADMIN();
    const form = await page('/admin/registration/920', admin);
    expect(form).toContain('data-testid="manual-add"');
    const res = await act({
      action: 'create', contact_name: 'Walter Walkin', contact_email: 'walter@example.com', contact_phone: '555 0111',
      p0_name: '', p1_name: 'Wanda Walkin', send_confirmation: '1',
    }, admin);
    expect(res.status).toBe(303);
    const created = await env.DB.prepare(`SELECT id, status, party_size FROM registrations WHERE email = 'walter@example.com'`).first<{ id: number; status: string; party_size: number }>();
    expect(created).toMatchObject({ status: 'confirmed', party_size: 2 });
    expect(res.headers.get('location')).toBe(`/admin/registration/920?reg=${created!.id}&notice=created#reg-drawer`);
    expect(await env.DB.prepare(`SELECT kind FROM email_log WHERE to_email = 'walter@example.com'`).first<string>('kind')).toBe('regConfirm');

    await signUp(SARAH);
    const hit = await page('/admin/registration/920?q=wanda', admin);
    expect(hit).toContain('Walter Walkin');
    expect(hit).not.toContain('sarah.johnson@example.com');
    expect(await page('/admin/registration/920?q=zzzz-nobody', admin)).toContain('No registrations yet');
    expect(await page('/admin/registration/920?status=waitlist', admin)).not.toContain('Walter Walkin');
    const byPerson = await page('/admin/registration/920?view=person&sort=name', admin);
    expect(byPerson).toContain('data-person-row');
    expect(byPerson.indexOf('Sarah')).toBeGreaterThan(-1);
    expect(byPerson.indexOf('Wanda Walkin')).toBeGreaterThan(byPerson.indexOf('Walter Walkin'));
    // Status chips carry the counts.
    expect(await page('/admin/registration/920', admin)).toMatch(/data-status="confirmed">Confirmed: 2/);
  });

  it('the bulk email composer previews the recipient count, queues, drains the first rows and shows the outbox counts', async () => {
    await enableRegistration();
    await signUp(SARAH);
    await signUp(GRACE);
    const admin = await ADMIN();
    await env.DB.prepare(`DELETE FROM email_log`).run();
    const base = { audience_status: 'confirmed', subject: 'See you soon, {name}', body: 'The {event} starts soon.' };
    const preview = await act({ action: 'bulk_preview', ...base }, admin);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('This will go to 2 registrations.');
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log`).first<number>('n')).toBe(0);

    const sent = await act({ action: 'bulk_send', ...base }, admin);
    expect(sent.status).toBe(303);
    expect(sent.headers.get('location')).toBe('/admin/registration/920?notice=bulk_queued&queued=2&sent=2#email');
    const logged = (await env.DB.prepare(`SELECT kind, to_email FROM email_log ORDER BY id`).all<{ kind: string; to_email: string }>()).results;
    expect(logged.map((m) => m.kind)).toEqual(['regBulk', 'regBulk']);
    expect(logged.map((m) => m.to_email).sort()).toEqual([GRACE[1], SARAH[1]]);
    const html = await page(sent.headers.get('location')!, admin);
    expect(html).toContain('2 queued, 2 sent so far');
    expect(html).toContain('data-testid="outbox-counts"');
    expect(html).toMatch(/sent 2/);
  });

  it('exports the roster CSV behind a UTF-8 BOM (columns unchanged) and one row per person; prints badges and the sign-in sheet', async () => {
    await enableRegistration();
    await signUp(SARAH);
    await act({ action: 'create', contact_name: 'Zoë Ünal', contact_email: 'zoe@example.com', p1_name: '=HYPERLINK("x")' }, await ADMIN());
    const admin = await ADMIN();
    // Response.text() drops a BOM while decoding, so read the raw bytes.
    const body = async (res: Response) => {
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    };
    const csv = await body(await get('/admin/registration/920/export.csv', { cookie: admin }));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).startsWith('Confirmation,Name,Email,Status,Party size,Amount,Registered,')).toBe(true);
    const people = await get('/admin/registration/920/export-people.csv', { cookie: admin });
    expect(people.headers.get('content-disposition')).toContain('church4christ-people-920.csv');
    const peopleCsv = await body(people);
    expect(peopleCsv.charCodeAt(0)).toBe(0xfeff);
    const lines = peopleCsv.slice(1).split('\r\n');
    expect(lines[0]).toMatch(/^Confirmation,Person,Ticket type,Status,Contact name,Email,Phone,Checked in,Registered/);
    expect(lines).toHaveLength(4); // header + Sarah + Zoë + the second person
    expect(peopleCsv).toContain("'=HYPERLINK");

    const badges = await page('/admin/registration/920/badges', admin);
    expect(badges).toContain('data-testid="badge-sheet"');
    expect((badges.match(/data-badge/g) ?? []).length).toBe(3);
    expect(badges).toContain('Zoë Ünal');
    expect(badges).toContain('Neighbors Potluck Night');
    expect(badges).toContain('@media print');
    const sheet = await page('/admin/registration/920/sign-in-sheet', admin);
    expect(sheet).toContain('data-testid="sign-in-sheet"');
    expect(sheet).toContain('Signature');
    // Waitlisted people stay off the default badge filter.
    await env.DB.prepare(`UPDATE registrations SET status = 'waitlist' WHERE email = ?1`).bind(SARAH[1]).run();
    expect((await page('/admin/registration/920/badges', admin)).match(/data-badge/g)?.length ?? 0).toBe(2);
    expect((await page('/admin/registration/920/badges?status=waitlist', admin)).match(/data-badge/g)?.length ?? 0).toBe(1);
  });

  it('event settings: requires approval and reminder days save; approval is refused (with the reason) on a priced event', async () => {
    await enableRegistration();
    const admin = await ADMIN();
    const fields = { action: 'save', id: '920', title_en: 'Neighbors Potluck Night', starts_at: '2031-06-01T10:00', requires_approval: '1', reminder_days: '3' };
    const saved = await post('/admin/registration', new URLSearchParams({ ...fields }).toString(), { cookie: admin });
    expect(saved.headers.get('location')).toBe('/admin/registration?saved=1');
    expect(await env.DB.prepare(`SELECT requires_approval AS a, reminder_days AS d FROM reg_events WHERE id = 920`).first()).toEqual({ a: 1, d: 3 });
    const editor = await page('/admin/registration?edit=920', admin);
    expect(editor).toContain('data-testid="requires-approval"');
    expect(editor).toMatch(/name="reminder_days"[^>]*value="3"/);
    // Blank reminder clears it; an out-of-range one is refused.
    await post('/admin/registration', new URLSearchParams({ ...fields, reminder_days: '' }).toString(), { cookie: admin });
    expect(await env.DB.prepare(`SELECT reminder_days AS d FROM reg_events WHERE id = 920`).first<number>('d')).toBeNull();
    const bad = await post('/admin/registration', new URLSearchParams({ ...fields, reminder_days: '45' }).toString(), { cookie: admin });
    expect(bad.status).toBe(200);
    // An active priced ticket type blocks approval: the checkbox is disabled with the reason, and the writer refuses it.
    await env.DB.prepare(`INSERT INTO reg_ticket_types (event_id, price_cents, capacity) VALUES (920, 500, NULL)`).run();
    const blocked = await page('/admin/registration?edit=920', admin);
    expect(blocked).toContain('Approval is only for free events');
    expect(blocked).toMatch(/data-testid="requires-approval"[^>]*disabled|disabled[^>]*data-testid="requires-approval"/);
    const refused = await post('/admin/registration', new URLSearchParams({ ...fields, requires_approval: '1' }).toString(), { cookie: admin });
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain('Approval is only for free events');
  });

  it('per-event roles: a viewer sees the roster but no controls and cannot post; a desk volunteer is kept off the event page; roles never cross events', async () => {
    await enableRegistration();
    await signUp(MARK);
    const reg = await regOf(MARK[1]);
    const sarah = await sessionCookie(...SARAH);
    const grace = await sessionCookie(...GRACE);
    await grantEventRole(env.DB, 920, SARAH[0], 'viewer');
    await grantEventRole(env.DB, 920, GRACE[0], 'desk');

    // The viewer: read-only roster, no forms, no builder, no access panel, no settings link.
    const view = await get('/admin/registration/920', { cookie: sarah });
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain('data-testid="reg-roster"');
    expect(html).toContain('mark.liu@example.com');
    for (const absent of ['data-testid="manual-add"', 'data-testid="bulk-email"', 'data-testid="form-builder"', 'data-testid="event-access"', 'RegFormBuilder', 'data-testid="event-settings-link"']) {
      expect(html, absent).not.toContain(absent);
    }
    const drawer = await page(`/admin/registration/920?reg=${reg.id}`, sarah);
    expect(drawer).toContain('data-testid="reg-drawer"');
    expect(drawer).not.toContain('data-testid="edit-form"');
    expect(drawer).not.toContain('name="action" value="cancel"');
    // Read-only exports and print pages are open to the viewer.
    expect((await get('/admin/registration/920/export.csv', { cookie: sarah })).status).toBe(200);
    expect((await get('/admin/registration/920/badges', { cookie: sarah })).status).toBe(200);
    // Every write is refused, and nothing changed.
    const writes: Array<Record<string, string>> = [
      { action: 'cancel', registration_id: String(reg.id) },
      { action: 'note', registration_id: String(reg.id), version: String(reg.version), note: 'hi' },
      { action: 'decide', registration_id: String(reg.id), decision: 'decline' },
      { action: 'create', contact_name: 'X', contact_email: 'x@example.com' },
      { action: 'bulk_send', audience_status: 'confirmed', subject: 's', body: 'b' },
      { action: 'refund', registration_id: String(reg.id), amount: '1.00' },
      { action: 'grant_role', person_id: '5', role: 'registrar' },
    ];
    for (const fields of writes) {
      expect((await act(fields, sarah)).status, fields.action).toBe(403);
    }
    expect((await SELF.fetch(`${ORIGIN}/admin/registration/920`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: sarah }, body: JSON.stringify({ questions: [], tickets: [] }), redirect: 'manual' })).status).toBe(403);
    expect((await regOf(MARK[1])).status).toBe('confirmed');
    // A viewer of 920 reaches nothing of event 930, and no CSV of it.
    expect((await get('/admin/registration/930', { cookie: sarah })).status).toBe(403);
    expect((await get('/admin/registration/930/export.csv', { cookie: sarah })).status).toBe(403);
    expect((await get('/admin/registration', { cookie: sarah })).status).toBe(403);

    // The desk volunteer: no event page, no CSV, no write.
    for (const path of ['/admin/registration/920', '/admin/registration/920/export.csv', '/admin/registration/920/export-people.csv', '/admin/registration/920/badges', '/admin/registration/920/sign-in-sheet']) {
      expect((await get(path, { cookie: grace })).status, path).toBe(403);
    }
    expect((await act({ action: 'cancel', registration_id: String(reg.id) }, grace)).status).toBe(403);
    expect((await regOf(MARK[1])).status).toBe('confirmed');
  });

  it('a per-event registrar manages registrations but gets no builder, no access panel and cannot grant roles or refund', async () => {
    await enableRegistration();
    await signUp(MARK);
    const reg = await regOf(MARK[1]);
    await grantEventRole(env.DB, 920, SARAH[0], 'registrar');
    const sarah = await sessionCookie(...SARAH);
    const html = await page('/admin/registration/920', sarah);
    expect(html).toContain('data-testid="manual-add"');
    expect(html).toContain('data-testid="bulk-email"');
    for (const absent of ['data-testid="form-builder"', 'data-testid="event-access"', 'RegFormBuilder', 'data-testid="event-settings-link"']) expect(html, absent).not.toContain(absent);
    expect((await act({ action: 'note', registration_id: String(reg.id), version: String(reg.version), note: 'Gluten free' }, sarah)).status).toBe(303);
    expect(await env.DB.prepare(`SELECT admin_note FROM registrations WHERE id = ?1`).bind(reg.id).first<string>('admin_note')).toBe('Gluten free');
    expect((await act({ action: 'grant_role', person_id: '5', role: 'viewer' }, sarah)).status).toBe(403);
    expect((await act({ action: 'refund', registration_id: String(reg.id), amount: '1.00' }, sarah)).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/admin/registration/920`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: sarah }, body: JSON.stringify({ questions: [], tickets: [] }), redirect: 'manual' })).status).toBe(403);
    // Cross-event: another event's registration id on this event's page is a 404.
    const other = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key, party_size, status) VALUES (930, 'Other', 'other@example.com', 'other-key', 1, 'confirmed') RETURNING id`).first<{ id: number }>();
    expect((await act({ action: 'cancel', registration_id: String(other!.id) }, sarah)).status).toBe(404);
    expect((await act({ action: 'cancel', registration_id: String(other!.id) }, await ADMIN())).status).toBe(404);
    expect((await get(`/admin/registration/920?reg=${other!.id}`, { cookie: sarah })).status).toBe(404);
    expect((await get(`/admin/registration/920?reg=${other!.id}`, { cookie: await ADMIN() })).status).toBe(404);
    expect(await env.DB.prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(other!.id).first<string>('status')).toBe('confirmed');
  });

  it('an administrator grants and revokes per-event access from the event page (search, then grant)', async () => {
    await enableRegistration();
    const admin = await ADMIN();
    const search = await page('/admin/registration/920?people=sarah', admin);
    expect(search).toContain('data-testid="event-access"');
    expect(search).toContain('data-testid="access-candidates"');
    expect(search).toContain('Sarah Johnson');
    const granted = await act({ action: 'grant_role', person_id: String(SARAH[0]), role: 'desk' }, admin);
    expect(granted.headers.get('location')).toBe('/admin/registration/920?notice=role_granted#access');
    expect(await env.DB.prepare(`SELECT role FROM reg_event_access WHERE event_id = 920 AND person_id = ?1`).bind(SARAH[0]).first<string>('role')).toBe('desk');
    expect(await page('/admin/registration/920', admin)).toContain(`data-access-person="${SARAH[0]}"`);
    expect((await act({ action: 'revoke_role', person_id: String(SARAH[0]) }, admin)).status).toBe(303);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM reg_event_access`).first<number>('n')).toBe(0);
  });
});
