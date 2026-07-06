// Carry-forward admin role matrix against the BUILT worker (SELF.fetch): the
// /admin/people console is adminOnly, so anonymous → 303 to signin, a member
// session → 403, and an admin session → 200. Session cookies are minted with the
// pure session lib (mintSession) using the e2e SESSION_SECRET, for seeded people
// whose session_epoch is the default 0 — no mail round-trip needed.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

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
