// Carry-forward admin role matrix against the BUILT worker (SELF.fetch): the
// /admin/people console is adminOnly, so anonymous → 303 to signin, a member
// session → 403, and an admin session → 200. Session cookies are minted with the
// pure session lib (mintSession) using the e2e SESSION_SECRET, for seeded people
// whose session_epoch is the default 0 — no mail round-trip needed.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN, sunday } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { uploadKey } from '../../src/lib/upload';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
// Minimal 1x1 PNG (67 bytes). A fresh Uint8Array so its .buffer is exactly the
// image bytes - uploadKey hashes it to derive the content-addressed R2 key.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

/** A `cookie:` header carrying a freshly minted session JWT for a seeded person. */
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

// Full admin role matrix (table-driven), the authoritative access sweep that
// supersedes the earlier scattered per-page status cells: for every admin
// section index page, anonymous → 303 signin, a member → 403, an editor → 200 on
// content consoles but 403 on the admin-only areas (people, settings), and an
// admin → 200 everywhere. Seed people: 1 admin, 2 editor (pastor.david), 3 member.
describe('admin role matrix (anon 303 / member 403 / editor content-only / admin all)', () => {
  type Section = { path: string; kind: 'content' | 'adminOnly' };
  const SECTIONS: Section[] = [
    { path: '/admin/bulletins', kind: 'content' },
    { path: '/admin/sermons', kind: 'content' },
    { path: '/admin/prayer-sheets', kind: 'content' },
    { path: '/admin/announcements', kind: 'content' },
    { path: '/admin/events', kind: 'content' },
    { path: '/admin/pages', kind: 'content' },
    { path: '/admin/prayer-wall', kind: 'content' },
    { path: '/admin/revisions/bulletin/1', kind: 'content' }, // seeded bulletin id 1
    { path: '/admin/people', kind: 'adminOnly' },
    { path: '/admin/settings', kind: 'adminOnly' },
  ];

  for (const { path, kind } of SECTIONS) {
    const editorExpect = kind === 'content' ? 200 : 403;
    it(`${path}: anon→303, member→403, editor→${editorExpect}, admin→200`, async () => {
      const anon = await get(path);
      expect(anon.status).toBe(303);
      expect(anon.headers.get('location')).toContain('/signin');

      const member = await sessionCookie(3, 'sarah.johnson@example.com');
      expect((await get(path, { cookie: member })).status).toBe(403);

      const editor = await sessionCookie(2, 'pastor.david@example.com');
      expect((await get(path, { cookie: editor })).status).toBe(editorExpect);

      const admin = await sessionCookie(1, 'admin@example.com');
      expect((await get(path, { cookie: admin })).status).toBe(200);
    });
  }
});

describe('/admin/bulletins (console class)', () => {
  it('editor session GET → 200', async () => {
    // Seed person 2 (pastor.david) is the editor pastor.
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const res = await get('/admin/bulletins', { cookie });
    expect(res.status).toBe(200);
  });

  it('member session GET → 403 (console gate re-checked on the page)', async () => {
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const res = await get('/admin/bulletins', { cookie });
    expect(res.status).toBe(403);
  });

  it('editor creates a draft bulletin via parallel repeat-row arrays → 303 → row listed, absent from public', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    // A Sunday guaranteed outside the seed's occupied range (the relative seed
    // occupies sunday(-10)..sunday(+7)), so UNIQUE(service_type_id, bulletin_date)
    // can never collide with a seeded row on any wall-clock date.
    const date = sunday(9);

    const body = new URLSearchParams();
    body.append('action', 'save');
    body.append('service_type_id', '1');
    body.append('bulletin_date', date);
    body.append('service_time_label', '9:30 AM');
    // Two program rows as parallel arrays.
    body.append('program_item', 'Prelude');
    body.append('program_content', '');
    body.append('program_person', 'Pianist');
    body.append('program_item', 'Message');
    body.append('program_content', 'A New Thing');
    body.append('program_person', 'Pastor David');
    body.append('offering_label', 'General Fund');
    body.append('offering_amount', '1,234');
    body.append('attendance_label', 'Adults');
    body.append('attendance_count', '120');
    body.append('ann_title', 'Welcome');
    body.append('ann_body', 'Glad you are here.');
    body.append('ann_url', '');
    body.append('ann_label', '');
    body.append('memory_verse', 'Matthew 5:16');
    body.append('flowers', '');
    body.append('status', 'draft');
    body.append('publish_at', '');

    const created = await post('/admin/bulletins/new', body.toString(), { cookie });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toContain('/admin/bulletins');

    // The draft is listed in the admin bulletins table…
    const list = await get('/admin/bulletins', { cookie });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(date);

    // …but never surfaces on the public bulletin page (drafts are unpublished).
    const publicPage = await get('/en/bulletin');
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).not.toContain(date);
  });
});

describe('content console pages render for editors and 403 for members', () => {
  const editorPages = ['/admin', '/admin/sermons', '/admin/sermons/new', '/admin/prayer-sheets', '/admin/prayer-sheets/new', '/admin/bulletins/new'];

  for (const path of editorPages) {
    it(`editor GET ${path} → 200`, async () => {
      const cookie = await sessionCookie(2, 'pastor.david@example.com');
      const res = await get(path, { cookie });
      expect(res.status).toBe(200);
    });
  }

  for (const path of ['/admin/sermons', '/admin/prayer-sheets']) {
    it(`member GET ${path} → 403`, async () => {
      const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
      const res = await get(path, { cookie });
      expect(res.status).toBe(403);
    });
  }
});

describe('announcements + events console + media upload loop', () => {
  it('announcements + events consoles render for an editor and 403 for a member', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    for (const path of ['/admin/announcements', '/admin/events']) {
      expect((await get(path, { cookie: editor })).status).toBe(200);
      expect((await get(path, { cookie: member })).status).toBe(403);
    }
  });

  it('editor uploads a tiny PNG on a new event → 303, /media serves it, and it shows on /en/events', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');

    const form = new FormData();
    form.set('action', 'save');
    form.set('title_en', 'E2E Upload Event');
    form.set('title_zh', '上传测试活动');
    form.set('blurb_en', 'Uploaded from the e2e test.');
    form.set('sort', '0');
    form.set('active', 'on');
    form.set('image_key', '');
    form.set('image', new File([pngBytes], 'tiny.png', { type: 'image/png' }));

    const created = await SELF.fetch(`${ORIGIN}/admin/events`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toContain('/admin/events');

    // The content-addressed key is deterministic from the bytes + filename.
    const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'tiny.png');
    expect(key).toMatch(/^uploads\/[a-f0-9]{16}-tiny\.png$/);

    // /media serves the object inline with the stored type + immutable cache.
    const served = await get(`/media/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // The new event (active, no window bounds) renders on the public events page
    // with the /media image URL — the full upload→display loop.
    const events = await get('/en/events');
    expect(events.status).toBe(200);
    const html = await events.text();
    expect(html).toContain('E2E Upload Event');
    expect(html).toContain(`/media/${key}`);
  });

  it('the media route refuses non-uploads keys and path traversal (404)', async () => {
    expect((await get('/media/backups/2026-01-01.sql')).status).toBe(404);
    expect((await get('/media/uploads/%2e%2e/backups/leak.sql')).status).toBe(404);
    expect((await get('/media/uploads/UPPER.png')).status).toBe(404);
  });

  it('a garbage multipart body on /admin/events re-renders with the bad-request banner, not a 5xx', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const res = await SELF.fetch(`${ORIGIN}/admin/events`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie,
        'content-type': 'multipart/form-data; boundary=----broken',
      },
      body: 'this is not a valid multipart payload',
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    // The editor's lang is zh (seed person 2), so the zh banner text renders.
    expect(await res.text()).toContain('提交的表单无法读取，请重试。');
  });
});

describe('prayer wall — no-JS move + revisions + settings theme', () => {
  it('editor moves a seeded request via the no-JS form POST → 303 → status changed + moved activity logged', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    // Seed prayer request 1 starts in the 'new' column.
    const body = new URLSearchParams({ _action: 'move', id: '1', status: 'praying' });
    const res = await post('/admin/prayer-wall', body.toString(), { cookie });
    expect(res.status).toBe(303);

    const row = await env.DB.prepare(`SELECT status FROM prayer_requests WHERE id = 1`).first<{ status: string }>();
    expect(row!.status).toBe('praying');
    const act = await env.DB
      .prepare(`SELECT author, kind, body FROM prayer_activity WHERE request_id = 1 AND kind = 'moved' ORDER BY id DESC`)
      .first<{ author: string; kind: string; body: string }>();
    expect(act).toMatchObject({ kind: 'moved', body: 'praying', author: 'pastor.david@example.com' });

    // A member cannot reach the wall (console gate re-checked on the page).
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    expect((await get('/admin/prayer-wall', { cookie: member })).status).toBe(403);
  });

  it('the revisions page renders the history of a bulletin the editor just saved', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const date = sunday(13); // outside the seed's sunday(-10)..sunday(+7) range
    const body = new URLSearchParams({ action: 'save', service_type_id: '1', bulletin_date: date, status: 'draft', publish_at: '' });
    const created = await post('/admin/bulletins/new', body.toString(), { cookie });
    expect(created.status).toBe(303);

    const row = await env.DB.prepare(`SELECT id FROM bulletins WHERE bulletin_date = ? AND service_type_id = 1`).bind(date).first<{ id: number }>();
    const id = row!.id;

    const hist = await get(`/admin/revisions/bulletin/${id}`, { cookie });
    expect(hist.status).toBe(200);
    const html = await hist.text();
    expect(html).toContain('pastor.david@example.com'); // the revision's edited_by
    expect(html).toContain(`/admin/bulletins/${id}`); // back-to-editor link
  });

  it('admin saves a theme change → clearThemeCache path flips the public home data-theme, then restores', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');

    const toHarvest = await post('/admin/settings', new URLSearchParams({ 'theme.name': 'harvest' }).toString(), { cookie });
    expect(toHarvest.status).toBe(303);
    const home = await get('/en/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('data-theme="harvest"');

    // Restore the seeded theme + bust the cache again so later files see sanctuary.
    const back = await post('/admin/settings', new URLSearchParams({ 'theme.name': 'sanctuary' }).toString(), { cookie });
    expect(back.status).toBe(303);
    expect(await (await get('/en/')).text()).toContain('data-theme="sanctuary"');
  });

  it('a member cannot save settings (adminOnly re-checked on the page → 403)', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    expect((await get('/admin/settings', { cookie: member })).status).toBe(403);
  });
});

describe('editor-created content reaches the public site (publish lifecycles)', () => {
  it('a PUBLISHED bulletin appears on its public dated page (draft-not-public is proven elsewhere)', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const date = sunday(17); // outside the seed's sunday(-10)..sunday(+7) range
    const marker = 'Living Water Message E2E';

    const body = new URLSearchParams();
    body.append('action', 'save');
    body.append('service_type_id', '1'); // English service → shows under /en
    body.append('bulletin_date', date);
    body.append('service_time_label', '9:30 AM');
    body.append('program_item', 'Message');
    body.append('program_content', marker);
    body.append('program_person', 'Pastor David');
    body.append('status', 'published');
    body.append('publish_at', ''); // empty → published now (publish_at NULL)

    const created = await post('/admin/bulletins/new', body.toString(), { cookie });
    expect(created.status).toBe(303);

    const publicPage = await get(`/en/bulletin/${date}?service=1`);
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).toContain(marker);
  });

  it('a PUBLISHED sermon (pasted full YouTube URL) appears on /en/sermons/<year> with the extracted id in the embed facade', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const date = sunday(25); // outside the seed's sunday(-10)..sunday(+7) range
    const year = date.slice(0, 4); // the archive year is computed from the same date

    const body = new URLSearchParams();
    body.append('action', 'save');
    body.append('service_type_id', '1');
    body.append('sermon_date', date);
    body.append('title', 'The Living Water E2E');
    body.append('speaker', 'Pastor David');
    body.append('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'); // full URL
    body.append('status', 'published');

    const created = await post('/admin/sermons/new', body.toString(), { cookie });
    expect(created.status).toBe(303);

    const page = await get(`/en/sermons/${year}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('The Living Water E2E');
    // youtube_id was extracted from the URL and drives the click-to-load facade.
    expect(html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('an ACTIVE announcement (both locale titles) shows in the home ticker in BOTH locales', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const enTitle = 'Bell Choir Signup E2E';
    const zhTitle = '钟乐团报名 E2E';

    const body = new URLSearchParams();
    body.append('action', 'save');
    body.append('title_en', enTitle);
    body.append('title_zh', zhTitle);
    body.append('url', '');
    body.append('sort', '0');
    body.append('starts_at', ''); // no window → always on
    body.append('ends_at', '');
    body.append('active', 'on');

    const created = await post('/admin/announcements', body.toString(), { cookie });
    expect(created.status).toBe(303);

    expect(await (await get('/en/')).text()).toContain(enTitle);
    expect(await (await get('/zh/')).text()).toContain(zhTitle);
  });

  it('a PUBLISHED zh prayer sheet on a new date renders on /zh/prayer/<date>', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const date = sunday(21); // outside the seed's sunday(-10)..sunday(+7) range
    const heading = '感恩 E2E';

    const body = new URLSearchParams();
    body.append('action', 'save');
    body.append('sheet_date', date);
    body.append('locale', 'zh');
    body.append('section_heading', heading);
    body.append('section_items', '为测试的顺利感恩');
    body.append('status', 'published');
    body.append('publish_at', '');

    const created = await post('/admin/prayer-sheets/new', body.toString(), { cookie });
    expect(created.status).toBe(303);

    const page = await get(`/zh/prayer/${date}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(heading);
  });
});

describe('revision restore round-trips public content', () => {
  it('restoring an earlier bulletin revision brings its public content back', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    const id = 1; // seeded published English bulletin (its own -3-week Sunday)
    const date = sunday(-3); // re-save on bulletin 1's own seeded date — never collides with siblings

    // A full, valid bulletin save carrying one distinctive program line. saveBulletin
    // snapshots the NEW state on every save (snapshot-after), so we first save a
    // baseline (→ revision R1), then change it, then restore R1.
    const saveBody = (content: string) => {
      const b = new URLSearchParams();
      b.append('action', 'save');
      b.append('service_type_id', '1');
      b.append('bulletin_date', date);
      b.append('service_time_label', '9:30 AM');
      b.append('program_item', 'Message');
      b.append('program_content', content);
      b.append('program_person', 'Sarah Johnson');
      b.append('status', 'published');
      b.append('publish_at', '');
      return b.toString();
    };

    const baseline = 'Baseline Headline E2E';
    expect((await post(`/admin/bulletins/${id}`, saveBody(baseline), { cookie })).status).toBe(303);
    const r1 = await env.DB
      .prepare(`SELECT id FROM revisions WHERE entity = 'bulletin' AND entity_id = ? ORDER BY id DESC LIMIT 1`)
      .bind(id)
      .first<{ id: number }>();
    expect(r1).not.toBeNull();

    // Change the headline → the public page now shows the new content, not the baseline.
    const changed = 'Changed Headline E2E';
    expect((await post(`/admin/bulletins/${id}`, saveBody(changed), { cookie })).status).toBe(303);
    let pub = await (await get(`/en/bulletin/${date}?service=1`)).text();
    expect(pub).toContain(changed);
    expect(pub).not.toContain(baseline);

    // Restore R1 → the public page shows the baseline content again.
    const restore = new URLSearchParams({ _action: 'restore', revision_id: String(r1!.id) });
    const restored = await post(`/admin/revisions/bulletin/${id}`, restore.toString(), { cookie });
    expect(restored.status).toBe(303);
    expect(restored.headers.get('location')).toContain('restored=1');
    pub = await (await get(`/en/bulletin/${date}?service=1`)).text();
    expect(pub).toContain(baseline);
    expect(pub).not.toContain(changed);
  });
});

describe('settings identity flows to the public site', () => {
  const setHeroKey = (value: string) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('site.hero_image_key', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(value)
      .run();
  const getHeroKey = async () =>
    (await env.DB.prepare(`SELECT value FROM settings WHERE key = 'site.hero_image_key'`).first<{ value: string }>())?.value ?? '';

  it('admin uploads a homepage hero image from settings and the public home page renders it', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const form = new FormData();
    form.set('site.name.en', 'Church4Christ');
    form.set('site.name.zh', '四方基督教会');
    form.set('site.tagline.en', 'A church for the city');
    form.set('site.tagline.zh', '城市中的教会');
    form.set('site.service_times.en', 'Sundays');
    form.set('site.service_times.zh', '主日');
    form.set('site.address', '123 Grace Avenue');
    form.set('site.email', 'hello@example.com');
    form.set('site.phone', '(555) 010-4444');
    form.set('site.map_url', 'https://maps.example.com');
    form.set('site.giving_url', 'https://give.example.com');
    form.set('site.youtube_url', 'https://youtube.example.com');
    form.set('theme.name', 'sanctuary');
    form.set('theme.default_mode', 'light');
    form.set('locale.default', 'en');
    form.set('site.hero_image_key', '');
    form.set('hero_image', new File([pngBytes], 'hero.png', { type: 'image/png' }));

    const res = await SELF.fetch(`${ORIGIN}/admin/settings`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'hero.png');
    expect(await getHeroKey()).toBe(key);
    const html = await (await get('/en')).text();
    expect(html).toContain(`/media/${key}`);
  });

  it('normal settings save does not persist a posted homepage hero key', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const existingKey = 'uploads/current-hero.webp';
    await setHeroKey(existingKey);

    const res = await post(
      '/admin/settings',
      new URLSearchParams({
        'site.name.en': 'Church4Christ',
        'site.hero_image_key': 'https://example.com/x.png',
      }).toString(),
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(await getHeroKey()).toBe(existingKey);
  });

  it('admin removes an existing homepage hero image from settings', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    await setHeroKey('uploads/current-hero.webp');

    const form = new FormData();
    form.set('site.name.en', 'Church4Christ');
    form.set('site.hero_image_key', 'uploads/current-hero.webp');
    form.set('remove_hero_image', 'on');

    const res = await SELF.fetch(`${ORIGIN}/admin/settings`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(await getHeroKey()).toBe('');
  });

  it('invalid homepage hero image upload re-renders and leaves the existing hero key unchanged', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const existingKey = 'uploads/current-hero.webp';
    await setHeroKey(existingKey);

    const form = new FormData();
    form.set('site.name.en', 'Church4Christ');
    form.set('site.hero_image_key', 'https://example.com/x.png');
    form.set('hero_image', new File(['not an image'], 'hero.txt', { type: 'text/plain' }));

    const res = await SELF.fetch(`${ORIGIN}/admin/settings`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unsupported image format. Use JPG, PNG, WebP, or GIF.');
    expect(html).toContain(`/media/${existingKey}`);
    expect(html).not.toContain('https://example.com/x.png');
    expect(await getHeroKey()).toBe(existingKey);
  });

  it('admin updates site.name.en → the public home <title> reflects it, then restores', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const newName = 'Living Water Community E2E';

    const upd = await post('/admin/settings', new URLSearchParams({ 'site.name.en': newName }).toString(), { cookie });
    expect(upd.status).toBe(303);

    const home = await get('/en/');
    expect(home.status).toBe(200);
    // fullTitle is `${pageTitle} · ${siteName}`, so the site name is the tail of <title>.
    expect(await home.text()).toContain(`${newName}</title>`);

    // Restore the seeded identity so later tests/files see the original name.
    const back = await post('/admin/settings', new URLSearchParams({ 'site.name.en': 'Church4Christ' }).toString(), { cookie });
    expect(back.status).toBe(303);
    expect(await (await get('/en/')).text()).toContain('Church4Christ</title>');
  });

  it('a zh site.name set via SQL surfaces in the /zh/ <title>, then restores', async () => {
    const zhName = '活水社区教会 E2E';
    const setName = (value: string) =>
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('site.name.zh', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
        .bind(value)
        .run();

    await setName(zhName);
    try {
      const home = await get('/zh/');
      expect(home.status).toBe(200);
      // getSiteIdentity resolves site.name.zh for the zh locale, so the localized
      // name is the tail of <title> on the Chinese home page.
      expect(await home.text()).toContain(`${zhName}</title>`);
    } finally {
      // Restore the seeded zh identity for later files sharing this baseline.
      await setName('四方基督教会');
    }
  });
});

describe('profile avatar uploads', () => {
  it('invalid avatar on new admin person re-renders without creating a duplicate-email trap', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const email = 'avatar.new.e2e@example.com';
    await env.DB.prepare('DELETE FROM people WHERE email = ?').bind(email).run();

    const invalid = new FormData();
    invalid.set('action', 'save');
    invalid.set('display_name', 'Avatar New');
    invalid.set('first_name', 'Avatar');
    invalid.set('last_name', 'New');
    invalid.set('email', email);
    invalid.set('phone', '');
    invalid.set('role', 'member');
    invalid.set('active', '1');
    invalid.set('lang', 'en');
    invalid.set('birthday', '');
    invalid.set('address', '');
    invalid.set('membership_status', 'member');
    invalid.set('joined_on', '');
    invalid.set('avatar', new File(['not an image'], 'avatar.txt', { type: 'text/plain' }));

    const res = await SELF.fetch(`${ORIGIN}/admin/people/new`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: invalid,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsupported image format. Use JPG, PNG, WebP, or GIF.');
    const missing = await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE email = ?').bind(email).first<{ n: number }>();
    expect(missing?.n).toBe(0);

    const retry = new FormData();
    retry.set('action', 'save');
    retry.set('display_name', 'Avatar New');
    retry.set('first_name', 'Avatar');
    retry.set('last_name', 'New');
    retry.set('email', email);
    retry.set('phone', '');
    retry.set('role', 'member');
    retry.set('active', '1');
    retry.set('lang', 'en');
    retry.set('birthday', '');
    retry.set('address', '');
    retry.set('membership_status', 'member');
    retry.set('joined_on', '');
    const created = await SELF.fetch(`${ORIGIN}/admin/people/new`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: retry,
      redirect: 'manual',
    });
    expect(created.status).toBe(303);
    const row = await env.DB.prepare('SELECT id, avatar_url FROM people WHERE email = ?').bind(email).first<{ id: number; avatar_url: string | null }>();
    expect(row).toMatchObject({ avatar_url: null });
  });

  it('invalid avatar on profile preserves existing identity and avatar', async () => {
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const existingAvatar = '/media/uploads/existing-profile.png';
    await env.DB
      .prepare(
        `UPDATE people
         SET display_name = 'Sarah Original', first_name = 'Sarah', last_name = 'Johnson', phone = '555-0103', lang = 'en', avatar_url = ?
         WHERE id = 3`,
      )
      .bind(existingAvatar)
      .run();

    const form = new FormData();
    form.set('display_name', 'Sarah Changed');
    form.set('first_name', 'Changed');
    form.set('last_name', 'Person');
    form.set('phone', '555-9999');
    form.set('lang', 'zh');
    form.set('avatar', new File(['not an image'], 'avatar.txt', { type: 'text/plain' }));

    const res = await SELF.fetch(`${ORIGIN}/en/profile`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsupported image format. Use JPG, PNG, WebP, or GIF.');
    const row = await env.DB
      .prepare('SELECT display_name, first_name, last_name, phone, lang, avatar_url FROM people WHERE id = 3')
      .first<{ display_name: string; first_name: string; last_name: string; phone: string | null; lang: string | null; avatar_url: string | null }>();
    expect(row).toMatchObject({
      display_name: 'Sarah Original',
      first_name: 'Sarah',
      last_name: 'Johnson',
      phone: '555-0103',
      lang: 'en',
      avatar_url: existingAvatar,
    });
  });

  it('member removes their profile avatar', async () => {
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    await env.DB
      .prepare(
        `UPDATE people
         SET display_name = 'Sarah Johnson 莎拉', first_name = 'Sarah', last_name = 'Johnson', phone = NULL, lang = 'en', avatar_url = '/media/uploads/remove-me.png'
         WHERE id = 3`,
      )
      .run();

    const form = new FormData();
    form.set('display_name', 'Sarah Johnson 莎拉');
    form.set('first_name', 'Sarah');
    form.set('last_name', 'Johnson');
    form.set('phone', '');
    form.set('lang', 'en');
    form.set('remove_avatar', 'on');

    const res = await SELF.fetch(`${ORIGIN}/en/profile`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string | null }>();
    expect(row?.avatar_url).toBeNull();
  });

  it('crafted posted avatar URL fields without a file are ignored', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const existingAvatar = '/media/uploads/current-safe.png';
    await env.DB.prepare('UPDATE people SET avatar_url = ? WHERE id = 3').bind(existingAvatar).run();

    const form = new FormData();
    form.set('action', 'save');
    form.set('display_name', 'Sarah Johnson 莎拉');
    form.set('first_name', 'Sarah');
    form.set('last_name', 'Johnson');
    form.set('email', 'sarah.johnson@example.com');
    form.set('phone', '');
    form.set('role', 'member');
    form.set('active', '1');
    form.set('lang', 'en');
    form.set('birthday', '');
    form.set('address', '');
    form.set('membership_status', 'member');
    form.set('joined_on', '2020-01-01');
    form.set('avatar_url', 'https://example.com/evil.png');
    form.set('avatar_key', 'uploads/evil.png');

    const res = await SELF.fetch(`${ORIGIN}/admin/people/3`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string | null }>();
    expect(row?.avatar_url).toBe(existingAvatar);
  });

  it('member uploads their own profile avatar', async () => {
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const form = new FormData();
    form.set('display_name', 'Sarah Johnson 莎拉');
    form.set('first_name', 'Sarah');
    form.set('last_name', 'Johnson');
    form.set('phone', '');
    form.set('lang', 'en');
    form.set('avatar', new File([pngBytes], 'sarah.png', { type: 'image/png' }));

    const res = await SELF.fetch(`${ORIGIN}/en/profile`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'sarah.png');
    const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string }>();
    expect(row?.avatar_url).toBe(`/media/${key}`);
  });

  it('admin uploads a profile avatar for another person', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const form = new FormData();
    form.set('action', 'save');
    form.set('display_name', 'Sarah Johnson 莎拉');
    form.set('first_name', 'Sarah');
    form.set('last_name', 'Johnson');
    form.set('email', 'sarah.johnson@example.com');
    form.set('phone', '');
    form.set('role', 'member');
    form.set('active', '1');
    form.set('lang', 'en');
    form.set('birthday', '');
    form.set('address', '');
    form.set('membership_status', 'member');
    form.set('joined_on', '2020-01-01');
    form.set('avatar', new File([pngBytes], 'sarah-admin.png', { type: 'image/png' }));

    const res = await SELF.fetch(`${ORIGIN}/admin/people/3`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const key = await uploadKey(pngBytes.buffer as ArrayBuffer, 'sarah-admin.png');
    const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = 3').first<{ avatar_url: string }>();
    expect(row?.avatar_url).toBe(`/media/${key}`);
  });
});

describe('deactivation locks a session out immediately', () => {
  it('setting the editor active=0 makes their still-valid cookie 303 to signin on the next request', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    // The cookie works while the person is active.
    expect((await get('/admin/bulletins', { cookie })).status).toBe(200);

    await env.DB.prepare(`UPDATE people SET active = 0 WHERE id = 2`).run();
    try {
      // loadSessionUser filters active = 1, so the user is now null → anonymous GET
      // to a protected page redirects to signin (immediate lockout, no cache).
      const res = await get('/admin/bulletins', { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('/signin');
    } finally {
      await env.DB.prepare(`UPDATE people SET active = 1 WHERE id = 2`).run();
    }
  });
});
