// Public-site sweep against the BUILT worker (SELF.fetch). setup.ts has migrated
// + seeded env.DB, which SELF reads. Covers spec §6 route map in both locales,
// the bare-root content-negotiated redirect, unknown/invalid-param 404s, the
// draft + future-publish visibility rules, the announcement ticker, per-locale
// <html> attributes + hreflang, the baseline security headers (on a page AND on
// the redirect), the health probe, and the public prayer-request API + CSRF.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { LOCALES } from '../../src/lib/locales';

// Seeded slugs (content collections + DB) referenced by the §6 route map.
const STAFF_SLUG = 'david-chen';
const ARTICLE_SLUG = 'psalms-of-ascent';
const FELLOWSHIP_SLUG = 'campus';
const MINISTRY_SLUG = 'worship';

// Locale-relative paths that must all 200. '' is the localized home ('/en/').
const PUBLIC_PATHS = [
  '',
  '/visit',
  '/about',
  '/about/beliefs',
  '/about/staff',
  `/about/staff/${STAFF_SLUG}`,
  '/articles',
  `/articles/${ARTICLE_SLUG}`,
  '/fellowships',
  `/fellowships/${FELLOWSHIP_SLUG}`,
  '/ministries',
  `/ministries/${MINISTRY_SLUG}`,
  '/events',
  '/sermons',
  '/bulletin',
  '/prayer',
  '/give',
  '/privacy',
  '/serve',
];

describe('public routes render 200 in both locales', () => {
  for (const locale of LOCALES) {
    for (const path of PUBLIC_PATHS) {
      const url = `/${locale}${path}/`.replace(/\/+$/, '/'); // '' → '/en/'
      it(`GET ${url} → 200`, async () => {
        const res = await get(url);
        expect(res.status).toBe(200);
        expect((await res.text()).length).toBeGreaterThan(500);
      });
    }
  }
});

describe('bare root content-negotiates a locale (302)', () => {
  it('Accept-Language zh → 302 /zh/', async () => {
    const res = await get('/', { 'accept-language': 'zh' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/zh/');
  });

  it('Accept-Language en → 302 /en/', async () => {
    const res = await get('/', { 'accept-language': 'en-US,en;q=0.9' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/en/');
  });

  it('carries the baseline security headers on the redirect itself', async () => {
    const res = await get('/', { 'accept-language': 'en' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('not-found handling', () => {
  it('unknown leading segment /xx/ → 404', async () => {
    expect((await get('/xx/')).status).toBe(404);
  });

  it('/en/sermons/1999 (year out of range) → 404', async () => {
    expect((await get('/en/sermons/1999')).status).toBe(404);
  });

  it('/en/bulletin/9999-99-99 (impossible date) → 404', async () => {
    expect((await get('/en/bulletin/9999-99-99')).status).toBe(404);
  });
});

describe('draft + publish-window visibility', () => {
  it('the draft sermon title is absent from /en/sermons, published ones show', async () => {
    const body = await (await get('/en/sermons')).text();
    expect(body).toContain('The Beatitudes'); // published sermon renders
    expect(body).not.toContain('上行之诗预告'); // seeded draft sermon (id 10)
  });

  it('a future-publish bulletin never appears on /en/bulletin', async () => {
    // Insert a published bulletin whose publish_at is in the future AND whose
    // date is later than every seeded one: if the publish_at filter were broken
    // it would become the "latest" bulletin and surface in the archive. The
    // write rolls back after this test (isolated storage).
    await env.DB.prepare(
      `INSERT INTO bulletins (id, service_type_id, bulletin_date, service_time_label, program_json, status, publish_at, updated_by)
       VALUES (9001, 1, '2099-12-25', '9:30 AM', '[]', 'published', '2099-01-01 00:00:00', 'admin@example.com')`,
    ).run();
    const body = await (await get('/en/bulletin')).text();
    expect(body).not.toContain('2099');
  });
});

describe('announcement ticker shows the active announcement per locale', () => {
  it('/en/ shows the always-on announcement title (English)', async () => {
    const body = await (await get('/en/')).text();
    expect(body).toContain('New members class every first Sunday');
  });

  it('/zh/ shows the always-on announcement title (Chinese)', async () => {
    const body = await (await get('/zh/')).text();
    expect(body).toContain('新朋友课程每月首个主日');
  });
});

describe('homepage hero image', () => {
  it('renders a configured homepage hero image through /media', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('site.hero_image_key', 'uploads/hero-test.webp')",
    ).run();
    const res = await get('/en');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/media/uploads/hero-test.webp');
  });
});

describe('per-locale document attributes + hreflang', () => {
  it('/en/ reflects the seeded theme setting (data-theme) and both hreflang alternates', async () => {
    // data-theme is now settings-driven: middleware reads theme.name via the
    // cached getActiveTheme, and the seed sets it to sanctuary. (The cache-bust
    // path after a live theme switch is covered by the unit test, since the
    // per-isolate 60s cache makes it flaky to exercise over SELF.fetch here.)
    const body = await (await get('/en/')).text();
    expect(body).toContain('data-theme="sanctuary"');
    expect(body).toContain('hreflang="en"');
    expect(body).toContain('hreflang="zh-Hans"');
  });

  it('/zh/ declares lang="zh-Hans"', async () => {
    const body = await (await get('/zh/')).text();
    expect(body).toContain('lang="zh-Hans"');
  });
});

describe('baseline security headers on a rendered page', () => {
  it('/en/ sets all three baseline headers', async () => {
    const res = await get('/en/');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('health probe', () => {
  it('/healthz → 200 {"ok":true}', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---- Carry-forward: prayer-request API + CSRF (controller-mandated) ----

async function prayerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM prayer_requests').first<{ n: number }>();
  return row?.n ?? 0;
}

describe('prayer-request API (same-origin)', () => {
  it('a valid consented submission 303s to ?prayer=sent and stores one row', async () => {
    const before = await prayerCount();
    const res = await post('/api/prayer-request', 'consent=on&message=Please+pray+for+my+family', {
      referer: `${ORIGIN}/en/`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('?prayer=sent');
    expect(await prayerCount()).toBe(before + 1);
  });

  it('a filled honeypot 303s to ?prayer=sent but stores NO row', async () => {
    const before = await prayerCount();
    const res = await post('/api/prayer-request', 'website=http://spam&message=spam&consent=on', {
      referer: `${ORIGIN}/en/`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('?prayer=sent');
    expect(await prayerCount()).toBe(before);
  });
});

describe('CSRF', () => {
  it('rejects a cross-origin POST to /api/prayer-request with 403', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/prayer-request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: 'consent=on&message=hi',
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });
});
