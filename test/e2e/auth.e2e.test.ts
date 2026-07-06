// Carry-forward auth flows against the BUILT worker (SELF.fetch): the magic-link
// consume (/auth/[token]), the email accept/decline consume (/respond/[token]),
// and the sign-in anti-enumeration guarantee. Tokens are created directly in the
// seeded env.DB via the pure auth libs (the same env.DB the worker reads) — the
// dcfc-serve/test/e2e/smoke.test.ts pattern. Isolated storage rolls back each
// test's writes, so every `it` starts from the clean seed.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { createLoginToken, createRespondToken, peekToken, sha256Hex } from '../../src/lib/auth';
import { SESSION_COOKIE } from '../../src/lib/session';

function rawOf(res: { raw: string } | { rateLimited: true }): string {
  if ('rateLimited' in res) throw new Error('expected a token, got rateLimited');
  return res.raw;
}

describe('/auth/[token] magic-link consume', () => {
  it('GET peeks (no consume), POST signs in with a c4c_session cookie + 303 /en/my', async () => {
    // Seed person 3 is an active English-preferring member.
    const raw = rawOf(await createLoginToken(env.DB, 3));

    // GET only peeks — the token must survive it (mail-scanner prefetch safety).
    const page = await get(`/auth/${raw}`);
    expect(page.status).toBe(200);
    expect(await peekToken(env.DB, raw, 'login')).not.toBeNull();

    // POST consumes and establishes the session.
    const consumed = await post(`/auth/${raw}`, '');
    expect(consumed.status).toBe(303);
    expect(consumed.headers.get('location')).toBe('/en/my');
    expect(consumed.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);

    // Replaying the now-consumed token must NOT re-establish a session.
    const replay = await post(`/auth/${raw}`, '');
    expect(replay.status).toBe(200); // renders the error page, not a redirect
    expect(replay.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });

  it('redirects a zh-preferring person to /zh/my', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 4)); // person 4: lang zh
    const res = await post(`/auth/${raw}`, '');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/zh/my');
  });

  it('an expired token sets no session cookie', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 3));
    await env.DB.prepare(`UPDATE tokens SET expires_at = datetime('now', '-1 minute') WHERE token_hash = ?`)
      .bind(await sha256Hex(raw))
      .run();
    const res = await post(`/auth/${raw}`, '');
    expect(res.headers.get('set-cookie') ?? '').not.toContain(`${SESSION_COOKIE}=`);
  });
});

// Writes made in one `it` persist into the next (the pool isolates storage per
// FILE, not per test), so clear the fixed-id respond chain before each test —
// tokens first for FK order (tokens.assignment_id → roster_assignments).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens WHERE assignment_id = 9001'),
    env.DB.prepare('DELETE FROM roster_assignments WHERE id = 9001'),
    env.DB.prepare('DELETE FROM positions WHERE id = 9001'),
    env.DB.prepare('DELETE FROM plans WHERE id = 9001'),
    env.DB.prepare('DELETE FROM teams WHERE id = 9001'),
  ]);
});

/** Seed a plan→team→position→assignment chain for `personId`, plus a respond
 *  token, all with high ids to stay clear of the seed. Returns the assignment id
 *  and the raw token. plan_date is future so respondToAssignment won't reject it. */
async function seedRespond(personId: number): Promise<{ assignmentId: number; raw: string }> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (9001, 1, '2999-01-01')`),
    env.DB.prepare(`INSERT INTO teams (id, ministry_id) VALUES (9001, NULL)`),
    env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (9001, 9001)`),
    env.DB
      .prepare(`INSERT INTO roster_assignments (id, plan_id, position_id, person_id, status) VALUES (9001, 9001, 9001, ?, 'U')`)
      .bind(personId),
  ]);
  const raw = (await createRespondToken(env.DB, personId, 9001)).raw;
  return { assignmentId: 9001, raw };
}

async function statusOf(assignmentId: number): Promise<{ status: string; decline_reason: string | null }> {
  return (await env.DB
    .prepare('SELECT status, decline_reason FROM roster_assignments WHERE id = ?')
    .bind(assignmentId)
    .first<{ status: string; decline_reason: string | null }>())!;
}

describe('/respond/[token] accept/decline consume', () => {
  it('GET shows the assignment summary without consuming the token', async () => {
    const { raw } = await seedRespond(3);
    const page = await get(`/respond/${raw}`);
    expect(page.status).toBe(200);
    // Summary of the seeded English service must be on the page.
    expect(await page.text()).toContain('Sunday Worship (English)');
    expect(await peekToken(env.DB, raw, 'respond')).not.toBeNull(); // not consumed
  });

  it('POST action=accept marks the assignment confirmed (C)', async () => {
    const { assignmentId, raw } = await seedRespond(3);
    const res = await post(`/respond/${raw}`, 'action=accept');
    expect(res.status).toBe(200);
    expect((await statusOf(assignmentId)).status).toBe('C');
  });

  it('POST with an INVALID action leaves the token unconsumed and the status unchanged', async () => {
    const { assignmentId, raw } = await seedRespond(3);
    await post(`/respond/${raw}`, 'action=bogus');
    // The route validates the action BEFORE touching the token, so a single-use
    // token is not burned to no effect.
    expect(await peekToken(env.DB, raw, 'respond')).not.toBeNull();
    expect((await statusOf(assignmentId)).status).toBe('U');
  });

  it('POST action=decline stores status D and the reason', async () => {
    const { assignmentId, raw } = await seedRespond(3);
    await post(`/respond/${raw}`, 'action=decline&reason=Out+of+town');
    const row = await statusOf(assignmentId);
    expect(row.status).toBe('D');
    expect(row.decline_reason).toBe('Out of town');
  });
});

describe('sign-in anti-enumeration', () => {
  it('a seeded email and an unknown email produce byte-identical responses', async () => {
    const seeded = await post('/en/signin', 'email=admin@example.com');
    const unknown = await post('/en/signin', 'email=nobody-unknown@example.com');
    expect(seeded.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await seeded.text()).toBe(await unknown.text());
  });
});
