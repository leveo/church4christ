// Volunteer console + email/report e2e against the BUILT worker (SELF.fetch,
// EMAIL_DEV_LOG=1 so mail is devlogged). Covers: the console access gate
// (anon/member/editor/leader/admin), an assign writing a request devlog row, the
// new-ministry wizard POST surfacing on the public ministries index, the email
// rules toggle, and CSV formula-injection neutralization.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('/admin/ministries access gate', () => {
  it('anon→303, member→403, editor(no team)→403, leader→200, admin→200', async () => {
    const anon = await get('/admin/ministries');
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('/signin');

    // Person 5 (mark) is a plain member of Worship Team (not a leader).
    expect((await get('/admin/ministries', { cookie: await sessionCookie(5, 'mark.liu@example.com') })).status).toBe(403);
    // Person 2 (pastor.david) is an editor but leads no team → 403 on this console.
    expect((await get('/admin/ministries', { cookie: await sessionCookie(2, 'pastor.david@example.com') })).status).toBe(403);
    // Person 3 (sarah) leads Worship Team.
    expect((await get('/admin/ministries', { cookie: await sessionCookie(3, 'sarah.johnson@example.com') })).status).toBe(200);
    // Admin.
    expect((await get('/admin/ministries', { cookie: await sessionCookie(1, 'admin@example.com') })).status).toBe(200);
  });
});

describe('assign → scheduling-request devlog row', () => {
  it('an admin assign on a plan writes a request email_log devlog row', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    // Plan 2 (English service, the second upcoming Sunday), position 1 (Worship Leader), assign mark (5).
    const res = await post('/en/serve/plans/2', '_action=assign&position_id=1&person_id=5', { cookie });
    expect(res.status).toBe(303);
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM email_log WHERE kind = 'request' AND status = 'devlog' AND to_email = 'mark.liu@example.com'`)
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThanOrEqual(1);
  });
});

describe('new-ministry wizard POST', () => {
  it('creates a ministry that shows on the public /en/ministries index', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await post(
      '/admin/ministries?tab=new',
      '_action=createMinistry&name_en=E2E+Outreach&name_zh=%E5%A4%96%E5%B1%95&category=missions&frequency=irregular&pos_name_en=Helper&pos_name_zh=&pos_needed=1&pos_open=0',
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('created=');

    const page = await (await get('/en/ministries')).text();
    expect(page).toContain('E2E Outreach');
  });
});

describe('email rules toggle POST', () => {
  it('flips a rule and persists it', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    // Seed default remind3 = 0 → toggle it on.
    const res = await post('/admin/ministries?tab=email', '_action=toggleRule&rule_key=remind3&enabled=1', { cookie });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare(`SELECT enabled FROM email_rules WHERE rule_key = 'remind3'`).first<{ enabled: number }>();
    expect(row?.enabled).toBe(1);
  });
});

describe('/admin/reports.csv neutralization', () => {
  it('prefixes a single quote on a formula-like display name', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES (500, '=SUM(A1)', 'danger@example.com')`),
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (2, 5, 500, 'C')`),
    ]);
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await get('/admin/reports.csv', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain("'=SUM(A1)");
  });
});
