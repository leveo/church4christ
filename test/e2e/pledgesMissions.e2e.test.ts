// Pledges and Missions on D1, against the BUILT worker: the module switch (public and admin 404),
// the public date window (public 404 and hidden menu link, admin still open), who reaches the admin
// pages (limited admin without the grant, with it, an editor), and a real public pledge POST with its
// idempotent replay. Giving is always off on D1, so no fund link or gift amounts appear here; that path
// is covered by test/pg/pledgeGiving.test.ts and the canSeePledgeGiving unit tests.
import { env } from 'cloudflare:test';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const cookie = async (id: number, email: string) => `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
const ADMIN = () => cookie(1, 'admin@example.com');
const EDITOR = () => cookie(2, 'pastor.david@example.com');
const LYDIA = () => cookie(11, 'lydia.kwan@example.com');

async function saveModules(opts: { off?: string[]; window?: Record<string, [string, string]> } = {}): Promise<void> {
  const body = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) if (!opts.off?.includes(key)) body.append(`module.${key}`, '1');
  for (const key of ['pledges', 'missions']) {
    const [start, end] = opts.window?.[key] ?? ['', ''];
    body.append(`moduleWindow.${key}.start`, start);
    body.append(`moduleWindow.${key}.end`, end);
  }
  const res = await post('/admin/settings', body.toString(), { cookie: await ADMIN() });
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe('/admin/settings?saved=1');
}

// A limited admin's grants come from their campus membership (campusAuth), so both copies move together.
async function setLydiaAreas(areas: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE people SET admin_areas = ?1 WHERE id = 11').bind(areas),
    env.DB.prepare('UPDATE campus_memberships SET admin_areas = ?1 WHERE person_id = 11').bind(areas),
  ]);
}

beforeEach(async () => {
  await setLydiaAreas('groups,events');
  await saveModules();
});
afterAll(async () => {
  await saveModules();
});

describe('module switch', () => {
  it('serves both modules when on and 404s public and admin pages when off', async () => {
    const admin = await ADMIN();
    const missions = await get('/en/missions');
    expect(missions.status).toBe(200);
    expect(await missions.text()).toContain('A clinic by the sea');
    expect((await get('/en/missions/next-summer')).status).toBe(404); // a draft is never public
    expect((await get('/en/pledge/room-to-grow')).status).toBe(200);
    expect((await get('/admin/pledges/1', { cookie: admin })).status).toBe(200);

    await saveModules({ off: ['pledges', 'missions'] });
    expect((await get('/en/pledge/room-to-grow')).status).toBe(404);
    expect((await get('/admin/pledges', { cookie: admin })).status).toBe(404);
    expect((await get('/en/missions')).status).toBe(404);
    expect((await get('/admin/missions', { cookie: admin })).status).toBe(404);
  });
});

describe('public date window', () => {
  it('hides public pages and the menu link before the start, keeps admin pages open', async () => {
    const admin = await ADMIN();
    await saveModules({ window: { missions: ['2099-01-01', ''] } });
    expect((await get('/en/missions')).status).toBe(404);
    expect((await get('/en/missions/coastal-clinic')).status).toBe(404);
    expect(await (await get('/en/')).text()).not.toContain('href="/en/missions"');
    expect((await get('/admin/missions', { cookie: admin })).status).toBe(200);
    // Pledges has no window, so it stays public.
    expect((await get('/en/pledge/room-to-grow')).status).toBe(200);
  });

  it('hides public pages after the end date and shows them again when the dates are cleared', async () => {
    await saveModules({ window: { pledges: ['', '2000-01-01'] } });
    expect((await get('/en/pledge/room-to-grow')).status).toBe(404);
    expect((await get('/admin/pledges/1', { cookie: await ADMIN() })).status).toBe(200);
    await saveModules();
    expect((await get('/en/pledge/room-to-grow')).status).toBe(200);
    expect(await (await get('/en/')).text()).toContain('href="/en/missions"');
  });

  it('refuses a window that ends before it starts and keeps the stored dates', async () => {
    const body = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) body.append(`module.${key}`, '1');
    body.append('moduleWindow.missions.start', '2027-05-01');
    body.append('moduleWindow.missions.end', '2027-04-01');
    const res = await post('/admin/settings', body.toString(), { cookie: await ADMIN() });
    expect(res.headers.get('location')).toBe('/admin/settings?windowErr=missions-order#settings-modules');
    expect((await get('/en/missions')).status).toBe(200);
  });
});

describe('admin access', () => {
  it('needs the pledges grant for a limited admin, and lets editors manage missions only', async () => {
    expect((await get('/admin/pledges', { cookie: await LYDIA() })).status).toBe(403);
    await setLydiaAreas('groups,events,pledges');
    expect((await get('/admin/pledges', { cookie: await LYDIA() })).status).toBe(200);
    expect((await get('/admin/pledges/1/export.csv', { cookie: await LYDIA() })).status).toBe(200);
    const editor = await EDITOR();
    expect((await get('/admin/missions', { cookie: editor })).status).toBe(200);
    expect((await get('/admin/pledges', { cookie: editor })).status).toBe(403);
  });
});

describe('public pledge form', () => {
  it('stores a pledge with its schedule and shows the same pledge again on a replay', async () => {
    await env.DB.prepare(`DELETE FROM pledges WHERE email = 'ruth.e2e@example.com'`).run();
    const fields = new URLSearchParams({
      idempotency_key: '7c1e2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b', website: '', pledge_type: 'initial', name: 'Ruth Park',
      email: 'ruth.e2e@example.com', mode: 'total', amount: '1200', frequency: 'monthly', duration_months: '12',
      start_date: (await env.DB.prepare(`SELECT giving_start AS d FROM pledge_campaigns WHERE id = 1`).first<{ d: string }>())!.d,
      giving_method: 'online', giving_note: '', signer_name: 'Ruth Park', consent: 'on',
    });
    const first = await post('/en/pledge/room-to-grow', fields.toString());
    expect(first.status).toBe(200);
    const html = await first.text();
    const codeOf = (page: string) => /data-pledge-code[^>]*>([A-Z]{8})</.exec(page)?.[1];
    const code = codeOf(html);
    expect(code).toBeTruthy();
    const row = await env.DB.prepare(`SELECT id, total_cents FROM pledges WHERE code = ?1`).bind(code).first<{ id: number; total_cents: number }>();
    expect(row?.total_cents).toBe(120000);
    const gifts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pledge_installments WHERE pledge_id = ?1`).bind(row!.id).first<{ n: number }>();
    expect(gifts?.n).toBe(12);
    // Personal details are not echoed back on the confirmation.
    expect(html).not.toContain('ruth.e2e@example.com');

    const again = await post('/en/pledge/room-to-grow', fields.toString());
    expect(codeOf(await again.text())).toBe(code);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pledges WHERE email = 'ruth.e2e@example.com'`).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('rejects a signature that does not match the name without saving anything', async () => {
    const fields = new URLSearchParams({
      idempotency_key: '0b2f3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', website: '', pledge_type: 'initial', name: 'Ruth Park',
      email: 'ruth.sig@example.com', mode: 'total', amount: '100', frequency: 'once', duration_months: '1',
      start_date: (await env.DB.prepare(`SELECT giving_start AS d FROM pledge_campaigns WHERE id = 1`).first<{ d: string }>())!.d,
      giving_method: 'online', signer_name: 'Someone Else', consent: 'on',
    });
    const res = await post('/en/pledge/room-to-grow', fields.toString());
    expect(await res.text()).toContain('Type your full name exactly as entered above.');
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pledges WHERE email = 'ruth.sig@example.com'`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
