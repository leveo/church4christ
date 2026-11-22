// Member app (PWA) against the BUILT worker on the D1 e2e seed: the app shell and
// its tabs, the manifest and service worker, the language-neutral /app entry, the
// group rules shared with the website (anti-enumeration, roster for members), and
// the Settings -> Member app panel that chooses the tabs. Giving is Supabase-only,
// so on D1 the bottom bar has three tabs and /app/give 404s.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function appBody(entries: Record<string, string>): string {
  return new URLSearchParams({ action: 'app', ...entries }).toString();
}

const ALL_ON = { 'app.enabled': '1', 'app.tab.home': '1', 'app.tab.events': '1', 'app.tab.groups': '1', 'app.tab.giving': '1' };

describe('member app shell', () => {
  it('serves Main with three tabs on D1 (no Giving), the manifest link and the menu', async () => {
    const res = await get('/en/app');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('rel="manifest" href="/en/app/manifest.webmanifest"');
    expect(html).toContain('data-app-tab="home"');
    expect(html).toContain('data-app-tab="events"');
    expect(html).toContain('data-app-tab="groups"');
    expect(html).not.toContain('data-app-tab="giving"');
    expect(html).toContain('>Main<');
    expect(html).toContain('data-app-menu');
    expect(html).toContain('data-app-signin');
    expect(html).toContain('/zh/app?setlang=zh');
    expect(html).toContain('name="robots" content="noindex"');
    expect((await get('/en/app/give')).status).toBe(404);
  });

  it('renders the Chinese app from the same data', async () => {
    const html = await (await get('/zh/app/events')).text();
    expect(html).toContain('主页');
    expect(html).toContain('aria-current="page" data-app-tab="events"');
  });

  it('opens /app in the default language, or the one this device chose', async () => {
    const plain = await get('/app');
    expect(plain.status).toBe(302);
    expect(plain.headers.get('location')).toBe('/en/app');
    const chosen = await get('/app', { cookie: 'c4c_locale=zh' });
    expect(chosen.headers.get('location')).toBe('/zh/app');
  });

  it('serves a per-locale manifest and service worker', async () => {
    const manifest = await get('/zh/app/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    const json = (await manifest.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ start_url: '/zh/app/', scope: '/zh/app/', display: 'standalone' });

    const sw = await get('/en/app/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toContain('javascript');
    expect(await sw.text()).toContain('"scope":"/en/app/"');

    expect((await get('/en/app/offline')).status).toBe(200);
  });
});

describe('member app groups', () => {
  it('lists public groups and follows the website visibility rules', async () => {
    const list = await (await get('/en/app/groups')).text();
    expect(list).toContain('Young Adults');
    expect(list).not.toContain('Prayer Partners');

    expect((await get('/en/app/groups/1')).status).toBe(200);
    const missing = await get('/en/app/groups/999999');
    const priv = await get('/en/app/groups/2');
    expect(missing.status).toBe(404);
    expect(priv.status).toBe(404);
  });

  it('shows a private group and its roster to a member, and only names to everyone', async () => {
    const faithful = await sessionCookie(6, 'faithful.wang@example.com');
    const res = await get('/en/app/groups/2', { cookie: faithful });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Esther Lin');
    expect(html).toContain('data-app-group-roster');
    expect(res.headers.get('cache-control')).toContain('no-store');

    const anon = await (await get('/en/app/groups/1')).text();
    expect(anon).not.toContain('data-app-group-roster');
    expect(anon).not.toContain('(555) 010-7777');
  });
});

describe('Settings -> Member app', () => {
  afterEach(async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await post('/admin/settings', appBody(ALL_ON), { cookie: admin });
  });

  it('shows the panel to the site admin', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const html = await (await get('/admin/settings', { cookie: admin })).text();
    expect(html).toContain('id="settings-app"');
    expect(html).toContain('data-app-tab-toggle="giving"');
  });

  it('hides a tab the admin turns off, and turning the app off 404s it', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const off = await post('/admin/settings', appBody({ 'app.enabled': '1', 'app.tab.home': '1', 'app.tab.groups': '1' }), { cookie: admin });
    expect(off.status).toBe(303);
    expect((await get('/en/app/events')).status).toBe(404);
    const html = await (await get('/en/app')).text();
    expect(html).not.toContain('data-app-tab="events"');

    await post('/admin/settings', appBody({ 'app.tab.home': '1' }), { cookie: admin });
    expect((await get('/en/app')).status).toBe(404);
    expect((await get('/en/app/manifest.webmanifest')).status).toBe(404);
  });

  it('opens the first visible tab when Main is turned off', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await post('/admin/settings', appBody({ 'app.enabled': '1', 'app.tab.groups': '1' }), { cookie: admin });
    const res = await get('/en/app');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/app/groups');
  });

  it('refuses a save with no tab chosen', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await post('/admin/settings', appBody({ 'app.enabled': '1' }), { cookie: admin });
    expect(res.headers.get('location')).toContain('appErr=noTabs');
  });

  it('is not writable by a non-admin', async () => {
    const member = await sessionCookie(6, 'faithful.wang@example.com');
    const res = await post('/admin/settings', appBody({ 'app.enabled': '0', 'app.tab.home': '1' }), { cookie: member });
    expect(res.status).toBe(403);
    expect((await get('/en/app')).status).toBe(200);
  });
});
