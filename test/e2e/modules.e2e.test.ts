// Module gating against the BUILT worker (SELF.fetch): an admin toggles modules
// through the Settings → Modules panel (a real POST, which busts the per-isolate
// enabled-set cache IN-PROCESS — the only way to flip state on a long-lived e2e
// isolate; a raw SQL write + 60s TTL would not take effect). Tests still assert
// the toggle-back inline where restore IS the behavior under test; the afterEach
// re-posts the all-on baseline so a mid-test failure can never leave a stale
// "off" cache behind for subsequent assertions. NOTE: afterEach runs outside the
// per-test isolated-storage frame, so its all-'1' rows persist within this file —
// semantically identical to the absent-row default (enabled), and later tests
// must not assume module.* rows are absent.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { createLoginToken } from '../../src/lib/auth';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** The Modules panel POST body: `action=modules` + a checked `module.<key>=1`
 *  for every key NOT in `disabled` (unchecked boxes are absent → written '0'). */
function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) {
    if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  }
  return body.toString();
}

function rawOf(res: { raw: string } | { rateLimited: true }): string {
  if ('rateLimited' in res) throw new Error('expected a token, got rateLimited');
  return res.raw;
}

describe('Modules panel gates routes, nav, and home sections', () => {
  // Safety net: restore every module ON (and bust the cache) even when a test
  // failed mid-toggle, so no stale disabled set leaks into the next test.
  afterEach(async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await post('/admin/settings', modulesBody([]), { cookie: admin });
  });

  it('disabling sermons 404s its public + admin routes and strips it from the home page; re-enabling restores', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');

    // Baseline: sermons on → public route serves and the home page links to it.
    expect((await get('/en/sermons')).status).toBe(200);

    // Toggle sermons OFF via the admin settings POST (busts the cache in-process).
    const off = await post('/admin/settings', modulesBody(['sermons']), { cookie: admin });
    expect(off.status).toBe(303);

    // Public + admin routes owned by the sermons module now 404 (module gate runs
    // before the route policy, so /admin/sermons 404s even for the admin).
    expect((await get('/en/sermons')).status).toBe(404);
    expect((await get('/admin/sermons', { cookie: admin })).status).toBe(404);

    // The home page still renders (it is core) but carries no sermons cross-link:
    // header nav, footer quick link, hero CTA, and the latest-sermon section are
    // all gone, so the /en/sermons href never appears.
    const homeOff = await (await get('/en/')).text();
    expect(homeOff).not.toContain('/en/sermons');
    expect(homeOff).not.toContain('Latest Sermon');

    // Toggle back ON → route serves again and the home cross-links return.
    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    expect((await get('/en/sermons')).status).toBe(200);
    const homeOn = await (await get('/en/')).text();
    expect(homeOn).toContain('/en/sermons');
    expect(homeOn).toContain('Latest Sermon');
  });

  it('disabling groups 404s its public routes (directory, detail, signup); re-enabling restores', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');

    // Baseline: groups on → the directory, a seeded detail page, and signup all serve.
    expect((await get('/en/groups')).status).toBe(200);
    expect((await get('/en/groups/1')).status).toBe(200);
    expect((await get('/en/signup')).status).toBe(200);

    const off = await post('/admin/settings', modulesBody(['groups']), { cookie: admin });
    expect(off.status).toBe(303);

    // Every route the groups module owns 404s — public and self-service alike.
    expect((await get('/en/groups')).status).toBe(404);
    expect((await get('/en/groups/1')).status).toBe(404);
    expect((await get('/en/signup')).status).toBe(404);

    // The home page still renders but carries no Groups cross-link.
    const homeOff = await (await get('/en/')).text();
    expect(homeOff).not.toContain('/en/groups');

    // Restore → routes + home cross-link return.
    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    expect((await get('/en/groups')).status).toBe(200);
    expect((await get('/en/signup')).status).toBe(200);
    expect(await (await get('/en/')).text()).toContain('/en/groups');
  });

  it('disabling serve 404s /serve, /my, and /ministries and drops the Ministries nav link; re-enabling restores', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const member = await sessionCookie(3, 'sarah.johnson@example.com');

    // Baseline: serve on → the directory serves and home links to it.
    expect((await get('/en/serve')).status).toBe(200);
    expect((await get('/en/ministries')).status).toBe(200);

    const off = await post('/admin/settings', modulesBody(['serve']), { cookie: admin });
    expect(off.status).toBe(303);

    // /serve (public), /my (serve-owned, normally authed), and the ministries
    // directory (spec §A: it belongs to serve) all 404 — the module gate
    // short-circuits before the route policy would redirect the member.
    expect((await get('/en/serve')).status).toBe(404);
    expect((await get('/en/my', { cookie: member })).status).toBe(404);
    expect((await get('/en/ministries')).status).toBe(404);
    expect((await get('/en/ministries/worship')).status).toBe(404);
    // The opportunity board lives under /serve, so it 404s with the module too.
    expect((await get('/en/serve/opportunities')).status).toBe(404);

    // Home still renders but every serve cross-link is gone: the Ministries nav
    // item (nav.ministries now belongs to serve) and the ministries preview
    // section, so the /en/ministries href never appears.
    const homeOff = await (await get('/en/')).text();
    expect(homeOff).not.toContain('/en/ministries');
    expect(homeOff).not.toContain('/en/serve');

    // Restore serve on → routes + home cross-links return.
    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    expect((await get('/en/serve')).status).toBe(200);
    expect((await get('/en/ministries')).status).toBe(200);
    expect((await get('/en/serve/opportunities')).status).toBe(200);
    expect(await (await get('/en/')).text()).toContain('/en/ministries');
  });

  it('post-signin lands on /profile when serve is off (not the 404ing /my), and back on /my when serve is on', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');

    // Serve OFF (the POST busts the per-isolate cache in-process): /my is
    // serve-owned and 404s, so a magic-link consume must land the member on
    // their core /profile instead of stranding them.
    const off = await post('/admin/settings', modulesBody(['serve']), { cookie: admin });
    expect(off.status).toBe(303);

    // Person 3 (Sarah) is an active English-preferring member.
    const offToken = rawOf(await createLoginToken(env.DB, 3));
    const offRes = await post(`/auth/${offToken}`, '');
    expect(offRes.status).toBe(303);
    expect(offRes.headers.get('location')).toBe('/en/profile');

    // Serve back ON → the landing returns to /my.
    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    const onToken = rawOf(await createLoginToken(env.DB, 3));
    const onRes = await post(`/auth/${onToken}`, '');
    expect(onRes.status).toBe(303);
    expect(onRes.headers.get('location')).toBe('/en/my');
  });

  it('disabling people hides the profile household card while the auth basics still render', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const member = await sessionCookie(5, 'mark.liu@example.com');

    // Baseline: people on → the profile carries the household card (person 5 has
    // no household, so the create-household form renders) and the birthday input.
    const on = await (await get('/en/profile', { cookie: member })).text();
    expect(on).toContain('value="createHousehold"');
    expect(on).toContain('name="birthday"');

    const off = await post('/admin/settings', modulesBody(['people']), { cookie: admin });
    expect(off.status).toBe(303);

    // People off → /profile still serves (it is a core auth route, not people-owned)
    // and the basics render, but the household card + membership fields are gone.
    const page = await get('/en/profile', { cookie: member });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('name="display_name"'); // identity form basics
    expect(body).toContain('My teams'); // pre-existing section
    expect(body).not.toContain('value="createHousehold"'); // household card absent
    expect(body).not.toContain('name="birthday"'); // membership fields absent

    // Restore → card returns.
    const restore = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(restore.status).toBe(303);
    expect(await (await get('/en/profile', { cookie: member })).text()).toContain('value="createHousehold"');
  });

  it('a general settings POST cannot smuggle module.* writes (stripped server-side)', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const readRow = () =>
      env.DB.prepare(`SELECT value FROM settings WHERE key = 'module.sermons'`).first<{ value: string }>();

    // A NON-modules save (no action=modules) carrying module.sermons=0 passes the
    // parser allowlist but the general branch strips module.* keys before writing.
    // Compare the row before/after (order-independent: an earlier test's restore
    // may have left a persisted '1' row) — the smuggled '0' must never land.
    const before = await readRow();
    const body = new URLSearchParams({ 'site.phone': '(555) 010-9999', 'module.sermons': '0' });
    const res = await post('/admin/settings', body.toString(), { cookie: admin });
    expect(res.status).toBe(303);

    const after = await readRow();
    expect(after).toEqual(before); // unchanged
    expect(after?.value ?? '1').not.toBe('0');
    // …while the legitimate general key in the same POST did land.
    const phone = await env.DB
      .prepare(`SELECT value FROM settings WHERE key = 'site.phone'`)
      .first<{ value: string }>();
    expect(phone?.value).toBe('(555) 010-9999');

    // And sermons stays fully on.
    expect((await get('/en/sermons')).status).toBe(200);
  });

  it('the Modules panel lists every module, including People', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const panel = await (await get('/admin/settings', { cookie: admin })).text();
    // People has no routes yet (slice 9) but is still a togglable module here.
    expect(panel).toContain('name="module.people"');
    // All 15 keys render a checkbox (giving + registration are the backend-gated pair).
    for (const key of MODULE_KEYS) expect(panel).toContain(`name="module.${key}"`);
  });

  it('backend-gated modules (giving, registration) render disabled with a note on D1', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const panel = await (await get('/admin/settings', { cookie: admin })).text();

    // e2e runs on the D1 backend, so both supabase-only modules are force-disabled:
    // their checkbox carries the `disabled` attribute and the row shows the note.
    const inputFor = (key: string) =>
      panel.match(new RegExp(`<input[^>]*name="module\\.${key}"[^>]*>`))?.[0] ?? '';
    expect(inputFor('giving')).toContain('disabled');
    expect(inputFor('registration')).toContain('disabled');
    // A non-gated module's checkbox stays enabled — the note is specific to the pair.
    expect(inputFor('sermons')).not.toContain('disabled');
    expect(panel).toContain('Requires the Supabase database');
  });
});
