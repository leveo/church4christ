// Module gating against the BUILT worker (SELF.fetch): an admin toggles modules
// through the Settings → Modules panel (a real POST, which busts the per-isolate
// enabled-set cache IN-PROCESS — the only way to flip state on a long-lived e2e
// isolate; a raw SQL write + 60s TTL would not take effect). Each `it` restores
// the all-on baseline before it returns so the cache and storage stay in sync
// for the next test.
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
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

describe('Modules panel gates routes, nav, and home sections', () => {
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

  it('disabling serve 404s /serve and /my; re-enabling restores /serve', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const member = await sessionCookie(3, 'sarah.johnson@example.com');

    // Baseline: serve on.
    expect((await get('/en/serve')).status).toBe(200);

    const off = await post('/admin/settings', modulesBody(['serve']), { cookie: admin });
    expect(off.status).toBe(303);

    // /serve (public) and /my (serve-owned, normally authed) both 404 — the module
    // gate short-circuits before the route policy would redirect the member.
    expect((await get('/en/serve')).status).toBe(404);
    expect((await get('/en/my', { cookie: member })).status).toBe(404);

    // Restore serve on.
    const on = await post('/admin/settings', modulesBody([]), { cookie: admin });
    expect(on.status).toBe(303);
    expect((await get('/en/serve')).status).toBe(200);
  });

  it('the Modules panel lists every module, including People', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const panel = await (await get('/admin/settings', { cookie: admin })).text();
    // People has no routes yet (slice 9) but is still a togglable module here.
    expect(panel).toContain('name="module.people"');
    for (const key of MODULE_KEYS) expect(panel).toContain(`name="module.${key}"`);
  });
});
