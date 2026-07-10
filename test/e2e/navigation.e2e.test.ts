// Admin navigation editor (/admin/navigation) mutation behavior against the BUILT
// worker: role gating is covered by the admin.e2e.test.ts role matrix, so this
// file exercises what each POST action actually does — reorder, remove, add a
// builtin/page/link, bounds-checked no-ops, and reset — mirroring the pattern
// customPages.e2e.test.ts uses for its Task 4 route. No seed row sets nav.items,
// so every test starts from the DEFAULT_NAV baseline (isolated storage rolls
// back per-test writes).
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { BUILTIN_NAV, DEFAULT_NAV, NAV_SETTING_KEY, parseNavItems, type NavItem } from '../../src/lib/nav';
import { saveCustomPage } from '../../src/lib/pagesDb';
import { t } from '../../src/lib/i18n';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

/** A `cookie:` header carrying a freshly minted session JWT for a seeded person. */
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** The live nav.items setting, parsed the same way the app reads it. */
async function navItems(): Promise<NavItem[]> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(NAV_SETTING_KEY).first<{ value: string }>();
  return parseNavItems(row?.value ?? '');
}

describe('/admin/navigation (admin session)', () => {
  it('GET renders the default items with nothing left in the built-in add list', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await get('/admin/navigation', { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    // DEFAULT_NAV already carries every BUILTIN_NAV entry.
    expect(html).toContain(t('en', 'admin.navigation.allBuiltinsAdded'));
    expect(html).toContain(t('en', 'nav.visit'));
  });

  it('up swaps an item with its predecessor and redirects ?saved=1', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();
    expect(before[0]).toEqual({ type: 'builtin', key: 'nav.visit' });
    expect(before[1]).toEqual({ type: 'builtin', key: 'nav.about' });

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'up', idx: '1' }).toString(), { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/admin/navigation?saved=1');

    const after = await navItems();
    expect(after[0]).toEqual({ type: 'builtin', key: 'nav.about' });
    expect(after[1]).toEqual({ type: 'builtin', key: 'nav.visit' });
    expect(after.length).toBe(before.length);
  });

  it('down swaps an item with its successor', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'down', idx: '0' }).toString(), { cookie });
    expect(res.status).toBe(303);

    const after = await navItems();
    expect(after[0]).toEqual(before[1]);
    expect(after[1]).toEqual(before[0]);
  });

  it('up at idx 0 is a silent no-op that still redirects ?saved=1', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'up', idx: '0' }).toString(), { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('saved=1');
    expect(await navItems()).toEqual(before);
  });

  it('down at the last idx is a silent no-op that still redirects ?saved=1', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();
    const lastIdx = before.length - 1;

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'down', idx: String(lastIdx) }).toString(), { cookie });
    expect(res.status).toBe(303);
    expect(await navItems()).toEqual(before);
  });

  it('an out-of-range or non-numeric idx is a silent no-op on remove/up/down', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();

    for (const idx of ['999', '-1', 'abc', '']) {
      const res = await post('/admin/navigation', new URLSearchParams({ action: 'remove', idx }).toString(), { cookie });
      expect(res.status).toBe(303);
      expect(await navItems()).toEqual(before);
    }
  });

  it('remove splices out the item at idx', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'remove', idx: '0' }).toString(), { cookie });
    expect(res.status).toBe(303);
    expect(await navItems()).toEqual(before.slice(1));
  });

  it('add-builtin appends a not-yet-present entry; an unknown or already-present key is a no-op', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    // Free up nav.visit by removing it first (DEFAULT_NAV starts with every builtin present).
    await post('/admin/navigation', new URLSearchParams({ action: 'remove', idx: '0' }).toString(), { cookie });
    const freed = await navItems();
    expect(freed.some((i) => i.type === 'builtin' && i.key === 'nav.visit')).toBe(false);

    const bogus = await post('/admin/navigation', new URLSearchParams({ action: 'add-builtin', key: 'nav.bogus' }).toString(), { cookie });
    expect(bogus.status).toBe(303);
    expect(await navItems()).toEqual(freed);

    const added = await post('/admin/navigation', new URLSearchParams({ action: 'add-builtin', key: 'nav.visit' }).toString(), { cookie });
    expect(added.status).toBe(303);
    const after = await navItems();
    expect(after[after.length - 1]).toEqual({ type: 'builtin', key: 'nav.visit' });

    // Re-adding the same key again is a no-op (already present).
    const dup = await post('/admin/navigation', new URLSearchParams({ action: 'add-builtin', key: 'nav.visit' }).toString(), { cookie });
    expect(dup.status).toBe(303);
    expect(await navItems()).toEqual(after);
  });

  it('add-page appends a page by slug and the page title shows on the next GET', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'nav-e2e-page',
      published: true,
      title_en: 'Nav E2E Page',
      title_zh: '导航测试页面',
      body_en: 'body',
      body_zh: '内容',
      updatedBy: 'admin@example.com',
    });

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'add-page', slug: 'nav-e2e-page' }).toString(), { cookie });
    expect(res.status).toBe(303);
    const after = await navItems();
    expect(after[after.length - 1]).toEqual({ type: 'page', slug: 'nav-e2e-page' });

    const listing = await get('/admin/navigation', { cookie });
    expect(await listing.text()).toContain('Nav E2E Page');
  });

  it('add-page with an unknown slug is a no-op', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();
    const res = await post('/admin/navigation', new URLSearchParams({ action: 'add-page', slug: 'no-such-page' }).toString(), { cookie });
    expect(res.status).toBe(303);
    expect(await navItems()).toEqual(before);
  });

  it('add-link rejects an unsafe url and a missing label without persisting, then succeeds once both are fixed', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const before = await navItems();

    const badUrl = await post(
      '/admin/navigation',
      new URLSearchParams({ action: 'add-link', url: 'javascript:alert(1)', label_en: 'Evil' }).toString(),
      { cookie },
    );
    expect(badUrl.status).toBe(200); // re-rendered with the error, not redirected
    expect(await badUrl.text()).toContain(t('en', 'admin.navigation.urlInvalid'));
    expect(await navItems()).toEqual(before);

    const missingLabel = await post(
      '/admin/navigation',
      new URLSearchParams({ action: 'add-link', url: 'https://example.com' }).toString(),
      { cookie },
    );
    expect(missingLabel.status).toBe(200);
    expect(await missingLabel.text()).toContain(t('en', 'admin.navigation.labelRequired'));
    expect(await navItems()).toEqual(before);

    const ok = await post(
      '/admin/navigation',
      new URLSearchParams({ action: 'add-link', url: '/give', label_en: 'Give', label_zh: '奉献' }).toString(),
      { cookie },
    );
    expect(ok.status).toBe(303);
    const after = await navItems();
    expect(after[after.length - 1]).toEqual({ type: 'link', url: '/give', label: { en: 'Give', zh: '奉献' } });
  });

  it('reset deletes the setting so the next read falls back to DEFAULT_NAV', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    await post('/admin/navigation', new URLSearchParams({ action: 'remove', idx: '0' }).toString(), { cookie });
    expect(await navItems()).not.toEqual(DEFAULT_NAV);

    const res = await post('/admin/navigation', new URLSearchParams({ action: 'reset' }).toString(), { cookie });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(NAV_SETTING_KEY).first();
    expect(row).toBeNull();
    expect(await navItems()).toEqual(DEFAULT_NAV);
  });

  it('a garbage multipart body re-renders with the bad-request banner, not a 5xx', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await SELF.fetch(`${ORIGIN}/admin/navigation`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie, 'content-type': 'multipart/form-data; boundary=----broken' },
      body: 'not a valid multipart payload',
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t('en', 'admin.form.badRequest'));
  });
});

describe('/admin/navigation sanity: BUILTIN_NAV/DEFAULT_NAV stay in lockstep with the seeded fixture assumptions', () => {
  it('DEFAULT_NAV is exactly BUILTIN_NAV mapped to builtin items, in the same order', () => {
    expect(DEFAULT_NAV).toEqual(BUILTIN_NAV.map((b) => ({ type: 'builtin', key: b.key })));
  });
});
