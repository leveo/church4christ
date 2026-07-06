// Gifts quiz + testimonies e2e against the BUILT worker (SELF.fetch): the public
// quiz POST renders result cards; a signed-in submission persists a gift_results
// row; a testimony submission files a pending row that stays off the public page
// until an editor/admin approves it, after which it appears. Sessions are minted
// with the pure session lib for seeded people (session_epoch 0).
//
// Seed anchors (seed/dev-seed.sql): person 1 (admin), person 5 (mark.liu, member,
// no gift_results). Three approved + one pending testimony exist at baseline.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

// Answer all 40 statements with the same value (2 = "Often").
const fullAnswers = (v = 2): string => Array.from({ length: 40 }, (_, i) => `q${i + 1}=${v}`).join('&');

describe('/en/serve/gifts (public quiz)', () => {
  it('a POST scores the answers and renders the top-3 gift cards', async () => {
    const res = await post('/en/serve/gifts', fullAnswers());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Your top gifts'); // result title
    expect(html).toContain('Teaching'); // a top gift label (equal answers → canonical order)
  });

  it('a signed-in submission saves a gift_results history row', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    const res = await post('/en/serve/gifts', fullAnswers(), { cookie });
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(`SELECT top_gifts_json FROM gift_results WHERE person_id = 5 ORDER BY id DESC LIMIT 1`)
      .first<{ top_gifts_json: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.top_gifts_json)).toHaveLength(3);
  });
});

describe('/en/serve/testimonies (submit + review lifecycle)', () => {
  it('a submission files a PENDING row that is not public until approved', async () => {
    const title = 'E2E Testimony Marker QX';
    const res = await post(
      '/en/serve/testimonies',
      `title=${encodeURIComponent(title)}&body=${encodeURIComponent('A fresh e2e story of grace.')}&name=E2E+Author`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/serve/testimonies?sent=1');

    const row = await env.DB
      .prepare(`SELECT status, person_id FROM testimonies WHERE title = ?`)
      .bind(title)
      .first<{ status: string; person_id: number | null }>();
    expect(row).toMatchObject({ status: 'P', person_id: null });

    // Pending → absent from the public page.
    const page = await (await get('/en/serve/testimonies')).text();
    expect(page).not.toContain(title);
  });

  it('an admin approval publishes it and it then appears on the public page', async () => {
    const title = 'E2E Approve Marker QY';
    await post('/en/serve/testimonies', `title=${encodeURIComponent(title)}&body=${encodeURIComponent('Story pending approval.')}`);
    const submitted = await env.DB
      .prepare(`SELECT id FROM testimonies WHERE title = ?`)
      .bind(title)
      .first<{ id: number }>();
    expect(submitted).not.toBeNull();

    const adminCookie = await sessionCookie(1, 'admin@example.com');
    const approve = await post('/admin/testimonies', `_action=approve&id=${submitted!.id}`, { cookie: adminCookie });
    expect(approve.status).toBe(303);
    expect(approve.headers.get('location')).toBe('/admin/testimonies?approved=1');

    const after = await env.DB
      .prepare(`SELECT status, published_at FROM testimonies WHERE id = ?`)
      .bind(submitted!.id)
      .first<{ status: string; published_at: string | null }>();
    expect(after?.status).toBe('A');
    expect(after?.published_at).not.toBeNull();

    const page = await (await get('/en/serve/testimonies')).text();
    expect(page).toContain(title);
  });

  it('the review queue is gated to editors/admins (a member is 403)', async () => {
    const memberCookie = await sessionCookie(5, 'mark.liu@example.com');
    const res = await get('/admin/testimonies', { cookie: memberCookie });
    expect(res.status).toBe(403);
  });
});
