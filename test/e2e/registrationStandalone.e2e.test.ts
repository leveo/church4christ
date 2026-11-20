// Registration on its own, as the `event-registration` preset installs it: every other module is off, on D1,
// against the BUILT worker. The public pages, the admin pages and the check-in desk link only to pages that
// exist; the home page lists what people can sign up for; a member's repeated submit does not land on the
// Member Portal; a super admin can hand the Registration area to a staff member; and the Stripe page stays
// away on D1, where every event is free. Uses the seeded D1 events 920 (open) and 930 (preview).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string, recent = false): Promise<string> {
  const jwt = await mintSession(
    SECRET,
    { id, email, sessionEpoch: 0 },
    recent ? { authMethod: 'email_otp', authTime: Math.floor(Date.now() / 1000) } : {},
  );
  return `${SESSION_COOKIE}=${jwt}`;
}
const ADMIN = (recent = false) => sessionCookie(1, 'admin@example.com', recent);
const SARAH: [number, string] = [3, 'sarah.johnson@example.com'];

async function setModules(enabled: readonly string[]): Promise<void> {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) if (enabled.includes(key)) body.append(`module.${key}`, '1');
  expect((await post('/admin/settings', body.toString(), { cookie: await ADMIN() })).status).toBe(303);
}

beforeEach(async () => {
  const run = (sql: string) => env.DB.prepare(sql).run();
  for (const table of ['reg_checkins', 'reg_outbox', 'reg_activity', 'reg_event_access', 'reg_answers', 'reg_attendees', 'registrations', 'email_log', 'newcomer_rate_limits']) await run(`DELETE FROM ${table}`);
  await run(`DELETE FROM reg_ticket_types WHERE event_id IN (920, 930)`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1, capacity = 3, max_party_size = 4,
    allow_self_edit = 1, requires_approval = 0, reminder_days = NULL, confirmation_prefix = NULL, visible_from = NULL,
    starts_at = datetime('now','+14 days','start of day','+18 hours'), opens_at = NULL, closes_at = datetime('now','+12 days','start of day','+23 hours') WHERE id = 920`);
  await run(`UPDATE reg_events SET active = 1, price_cents = NULL, waitlist_enabled = 1, next_confirmation = 1,
    confirmation_prefix = NULL, visible_from = NULL, starts_at = datetime('now','+45 days','start of day','+10 hours'),
    opens_at = datetime('now','+10 days','start of day','+9 hours'), closes_at = NULL WHERE id = 930`);
  await run(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
    VALUES (52, 'Rita', 'Registrar', 'Rita Registrar', 'rita.registrar@example.com', 'admin', 0, '')
    ON CONFLICT(id) DO UPDATE SET role = 'admin', super_admin = 0, admin_areas = ''`);
  await setModules(['registration']);
});

// Restore every module so a failure here never leaves the rest of the suite with modules switched off.
afterEach(async () => setModules(MODULE_KEYS));

/** Same-origin links on a page, without language switches or mail links. */
function linksOf(html: string): string[] {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));
  return [...new Set(hrefs.filter((h) => h.startsWith('/') && !h.startsWith('//') && !h.includes('setlang=') && !/\.(css|js|svg|png|ico|webmanifest|woff2?)(\?|$)/.test(h)))];
}

describe('Registration alone on D1', () => {
  it('links only to pages that exist, on the public site, in the admin area and at the desk', async () => {
    const admin = await ADMIN();
    const pages: Array<[string, Record<string, string>]> = [
      ['/en/', {}], ['/zh/', {}], ['/en/register', {}], ['/en/register/920', {}], ['/en/register/930', {}],
      ['/en/register/done?ok=1', {}], ['/en/register/manage', {}],
      ['/admin', { cookie: admin }], ['/admin/registration', { cookie: admin }], ['/admin/registration/920', { cookie: admin }],
      ['/admin/registration/920/checkin', { cookie: admin }], ['/admin/people', { cookie: admin }],
    ];
    const broken: string[] = [];
    for (const [page, headers] of pages) {
      const res = await get(page, headers);
      expect(res.status, page).toBe(200);
      for (const link of linksOf(await res.text())) {
        if (link.startsWith('/auth/') || link.includes('signout')) continue;
        const status = (await get(link, headers)).status;
        if (status >= 400) broken.push(`${page} -> ${link} (${status})`);
      }
    }
    expect(broken).toEqual([]);
  }, 60_000);

  it('shows the events people can sign up for on the home page, and none of the switched-off sections', async () => {
    const home = await (await get('/en/')).text();
    expect(home).toContain('data-home-registration');
    expect(home).toContain('href="/en/register/920"');
    expect(home).toContain('href="/en/register"');
    for (const off of ['/en/events', '/en/sermons', '/en/groups', '/en/serve', '/en/ministries']) expect(home).not.toContain(`href="${off}"`);
    // With the Events module on, its own upcoming-events section keeps the spot.
    await setModules(['registration', 'events']);
    expect(await (await get('/en/')).text()).not.toContain('data-home-registration');
  });

  it('opens Registration from the dashboard and keeps the Stripe page away on D1', async () => {
    const admin = await ADMIN();
    const dashboard = await (await get('/admin', { cookie: admin })).text();
    expect(dashboard).toContain('href="/admin/registration"');
    expect(dashboard).not.toContain('/admin/stripe-events');
    expect((await get('/admin/stripe-events', { cookie: admin })).status).toBe(404);
  });

  it('lands a repeated member submit on the done page instead of the Member Portal', async () => {
    const body = new URLSearchParams({ locale: 'en', event_id: '920', checkoutRequestId: crypto.randomUUID(), submission_key: 'standalone-replay-key-0001', '921': 'Main dish' });
    const cookie = await sessionCookie(...SARAH);
    const first = await post('/api/register/submit', body.toString(), { cookie });
    expect(first.headers.get('location')).toMatch(/^\/en\/register\/manage\?new=1/);
    const replay = await post('/api/register/submit', body.toString(), { cookie });
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('/en/register/done?ok=1');
    expect((await get('/en/register/done?ok=1')).status).toBe(200);
    expect(await env.DB.prepare(`SELECT count(*) n FROM registrations`).first<number>('n')).toBe(1);
  });

  it('lets a super admin give a staff member the Registration area, who then runs the back office', async () => {
    const superAdmin = await ADMIN(true);
    const page = await (await get('/admin/people/52', { cookie: superAdmin })).text();
    const box = /<input[^>]*value="registration"[^>]*>/.exec(page)?.[0] ?? '';
    expect(box).toContain('data-backend-disabled="false"');
    expect(box).not.toMatch(/\sdisabled(=|\s|>)/);
    // Payment operations need Postgres and Stripe, so D1 does not offer them.
    expect(page).not.toMatch(/<input[^>]*value="payment-operations"/);

    const rita = await sessionCookie(52, 'rita.registrar@example.com');
    expect((await get('/admin/registration', { cookie: rita })).status).toBe(403);
    const grant = new URLSearchParams({ action: 'flags', role: 'admin', active: 'on' });
    grant.append('areas', 'registration');
    expect((await post('/admin/people/52', grant.toString(), { cookie: superAdmin })).status).toBe(303);
    for (const path of ['/admin/registration', '/admin/registration/920', '/admin/registration/920/checkin']) {
      expect((await get(path, { cookie: rita })).status, path).toBe(200);
    }
  });
});
