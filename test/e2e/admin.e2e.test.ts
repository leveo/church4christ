// Carry-forward admin role matrix against the BUILT worker (SELF.fetch): the
// /admin/people console is adminOnly, so anonymous → 303 to signin, a member
// session → 403, and an admin session → 200. Session cookies are minted with the
// pure session lib (mintSession) using the e2e SESSION_SECRET, for seeded people
// whose session_epoch is the default 0 — no mail round-trip needed.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from './helpers';
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
