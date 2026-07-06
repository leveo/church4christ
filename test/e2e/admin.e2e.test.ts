// Carry-forward admin role matrix against the BUILT worker (SELF.fetch): the
// /admin/people console is adminOnly, so anonymous → 303 to signin, a member
// session → 403, and an admin session → 200. Session cookies are minted with the
// pure session lib (mintSession) using the e2e SESSION_SECRET, for seeded people
// whose session_epoch is the default 0 — no mail round-trip needed.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { uploadKey } from '../../src/lib/upload';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

/** A `cookie:` header carrying a freshly minted session JWT for a seeded person. */
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('/admin/people role matrix', () => {
  it('anonymous GET → 303 to signin', async () => {
    const res = await get('/admin/people');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('member session GET → 403', async () => {
    // Seed person 3 (sarah.johnson) is a member, not an admin.
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const res = await get('/admin/people', { cookie });
    expect(res.status).toBe(403);
  });

  it('admin session GET → 200', async () => {
    // Seed person 1 (admin@example.com) is the site admin.
    const cookie = await sessionCookie(1, 'admin@example.com');
    const res = await get('/admin/people', { cookie });
    expect(res.status).toBe(200);
  });
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
    const date = '2026-09-06'; // a Sunday not present in the seed

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
  // Minimal 1×1 PNG (67 bytes). A fresh Uint8Array so its .buffer is exactly the
  // image bytes — uploadKey hashes it to derive the content-addressed R2 key.
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

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
    const date = '2026-10-04';
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
