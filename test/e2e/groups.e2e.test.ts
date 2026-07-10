// Groups module public surface against the BUILT worker (SELF.fetch). setup.ts
// has migrated + seeded env.DB: group 1 "Young Adults 青年团契" is PUBLIC (Ben,
// person 8, is its group admin; Mark 5 and Joshua 10 are plain members; one
// name-only member; a pending join request from Grace, person 4); group 2
// "Prayer Partners 祷告伙伴" is PRIVATE (Faithful, person 6, is its admin).
// Anti-enumeration is the headline behavior under test: a private group and a
// nonexistent id must be indistinguishable to an anonymous (or non-member)
// visitor — same 404, same rewrite.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('GET /en/groups — public directory', () => {
  it('200s and lists the seeded public group but not the private one', async () => {
    const res = await get('/en/groups');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Young Adults');
    expect(body).not.toContain('Prayer Partners');
  });

  it('signed-in shows a "my groups" section that includes a PRIVATE membership', async () => {
    // Faithful (person 6) is the admin of the private "Prayer Partners" group,
    // which never appears in the anonymous directory above — but it must show
    // up in her own "my groups" section (listGroupsForPerson ignores visibility).
    const faithful = await sessionCookie(6, 'faithful.wang@example.com');
    const body = await (await get('/en/groups', { cookie: faithful })).text();
    expect(body).toContain('Prayer Partners');
  });
});

describe('GET /en/groups/[id] — visibility', () => {
  it('the seeded PUBLIC group 200s for an anonymous visitor', async () => {
    const res = await get('/en/groups/1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Young Adults');
  });

  it('the seeded PRIVATE group 404s for an anonymous visitor', async () => {
    expect((await get('/en/groups/2')).status).toBe(404);
  });

  it('a nonexistent group id 404s identically (anti-enumeration)', async () => {
    const missing = await get('/en/groups/999999');
    const priv = await get('/en/groups/2');
    expect(missing.status).toBe(404);
    expect(priv.status).toBe(404);
  });

  it('the private group 200s for its active member and shows the roster', async () => {
    const faithful = await sessionCookie(6, 'faithful.wang@example.com');
    const res = await get('/en/groups/2', { cookie: faithful });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Esther Lin');
  });

  it('the private group 200s for a site admin who is not a member', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await get('/en/groups/2', { cookie: admin });
    expect(res.status).toBe(200);
  });

  it('a non-member (site admin or otherwise) never sees the full roster of a group they are not in, publicly visible or not', async () => {
    // Amy (person 7) belongs to neither seeded group.
    const amy = await sessionCookie(7, 'amy.chen@example.com');
    const body = await (await get('/en/groups/1', { cookie: amy })).text();
    expect(body).not.toContain('Joshua Zhao'); // roster name absent
  });
});

describe('GET /en/groups/1 — signed-out join prompt', () => {
  it('shows a sign-in-to-join prompt linking to signin and signup', async () => {
    const body = await (await get('/en/groups/1')).text();
    expect(body).toContain('Sign in to request to join this group.');
    expect(body).toContain('/en/signin');
    expect(body).toContain('/en/signup');
  });
});

describe('GET /en/groups/1 — signed-in member state', () => {
  it("Ben (group admin) sees the member state and a manage link", async () => {
    const ben = await sessionCookie(8, 'ben.wu@example.com');
    const body = await (await get('/en/groups/1', { cookie: ben })).text();
    expect(body).toContain('a member of this group.');
    expect(body).toContain('/en/groups/1/manage');
  });

  it('Mark (plain member) sees the member state but no manage link', async () => {
    const mark = await sessionCookie(5, 'mark.liu@example.com');
    const body = await (await get('/en/groups/1', { cookie: mark })).text();
    expect(body).toContain('a member of this group.');
    expect(body).not.toContain('/en/groups/1/manage');
  });
});

describe('POST /en/groups/1 — request to join', () => {
  it('a signed-in non-member can request to join; the pending state then shows on GET', async () => {
    // Amy (person 7) is in neither seeded group.
    const amy = await sessionCookie(7, 'amy.chen@example.com');
    const before = await env.DB
      .prepare(`SELECT status FROM group_join_requests WHERE group_id = 1 AND person_id = 7`)
      .first<{ status: string }>();
    expect(before).toBeNull();

    const res = await post('/en/groups/1', 'action=join', { cookie: amy });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/groups/1');

    const row = await env.DB
      .prepare(`SELECT status FROM group_join_requests WHERE group_id = 1 AND person_id = 7`)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending');

    const body = await (await get('/en/groups/1', { cookie: amy })).text();
    expect(body).toContain('Your request to join is pending approval.');
  });
});

describe('/attendance/[token] — tracker page', () => {
  async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('an unknown token renders the friendly invalid page with a 404 status (no detail leak)', async () => {
    const res = await get('/attendance/not-a-real-token');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Link expired or invalid');
    expect(body).not.toContain('Young Adults'); // occurrence detail must not leak
  });

  it('a valid token renders the sheet, and POST records attendance', async () => {
    // Bind a known raw token to seeded occurrence 1 (group 1 "Young Adults"),
    // owned by its group admin Ben (person 8). Seed attendance for occurrence 1:
    // member 1 present, member 2 present, member 3 absent.
    const raw = 'e2e-attendance-token-occ1';
    await env.DB
      .prepare(
        `INSERT INTO group_attendance_tokens (occurrence_id, person_id, token_hash, expires_at)
         VALUES (1, 8, ?1, datetime('now','+72 hours'))`,
      )
      .bind(await sha256Hex(raw))
      .run();

    const getRes = await get(`/attendance/${raw}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toContain('Mark Liu'); // a roster member renders
    expect(body).toContain('Save attendance');

    // Mark only member 1 present; everyone else (incl. the name-only member) → absent.
    const postRes = await post(`/attendance/${raw}`, `token=${raw}&member=1`);
    expect(postRes.status).toBe(303);
    expect(postRes.headers.get('location')).toBe(`/attendance/${raw}?saved=1`);

    const { results } = await env.DB
      .prepare('SELECT member_id, present FROM group_attendance WHERE occurrence_id = 1 ORDER BY member_id')
      .all<{ member_id: number; present: number }>();
    const map = Object.fromEntries(results.map((r) => [r.member_id, r.present]));
    expect(map[1]).toBe(1); // checked
    expect(map[2]).toBe(0); // unchecked → recorded absent
    expect(map[3]).toBe(0);
    expect(map[4]).toBe(0); // name-only member also gets a row
  });

  it('POST with a tampered hidden token records nothing', async () => {
    const before = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM group_attendance WHERE occurrence_id = 2')
      .first<{ n: number }>();
    const res = await post('/attendance/whatever', 'token=forged-token&member=1');
    // Invalid token → the page falls through to the 404 invalid state, no write.
    expect(res.status).toBe(404);
    const after = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM group_attendance WHERE occurrence_id = 2')
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe('GET /en/signup', () => {
  it('200s and renders the sign-up form', async () => {
    const res = await get('/en/signup');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="first_name"');
    expect(body).toContain('name="email"');
  });
});

describe('POST /en/signup — anti-enumeration', () => {
  async function personCount(email: string): Promise<number> {
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM people WHERE email = ?`)
      .bind(email)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('a brand-new email creates a person row and shows the neutral confirmation', async () => {
    const email = 'new.visitor@example.com';
    expect(await personCount(email)).toBe(0);

    const res = await post('/en/signup', `first_name=New&last_name=Visitor&email=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Check your email');

    expect(await personCount(email)).toBe(1);
    const row = await env.DB
      .prepare(`SELECT display_name, role, active, membership_status, lang FROM people WHERE email = ?`)
      .bind(email)
      .first<{ display_name: string; role: string; active: number; membership_status: string; lang: string }>();
    expect(row).toEqual({
      display_name: 'New Visitor',
      role: 'member',
      active: 1,
      membership_status: 'visitor',
      lang: 'en',
    });
  });

  it('an existing email shows the identical neutral confirmation and creates no duplicate row', async () => {
    const email = 'ben.wu@example.com';
    expect(await personCount(email)).toBe(1);

    const res = await post('/en/signup', `first_name=Ben&last_name=Wu&email=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Check your email');

    expect(await personCount(email)).toBe(1); // no duplicate
  });

  it('a filled honeypot shows the same neutral confirmation and creates no row', async () => {
    const email = 'bot.trap@example.com';
    const res = await post(
      '/en/signup',
      `first_name=Bot&last_name=Trap&email=${encodeURIComponent(email)}&website=http://spam.example`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Check your email');
    expect(await personCount(email)).toBe(0);
  });
});
