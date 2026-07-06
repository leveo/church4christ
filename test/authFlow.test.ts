// End-to-end magic-link flow at the library level (workers project, live D1).
// Page endpoints are thin wrappers over these libs, so exercising the libs in
// sequence covers the flow without the weight of importing Astro routes: request
// a link → token row stores only a hash → peek (no consume) → consume (single
// use) → mint + verify a session → load the user; plus replay + expiry rejection.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeToken, createLoginToken, peekToken, sha256Hex } from '../src/lib/auth';
import { mintSession, verifySession } from '../src/lib/session';
import { loadSessionUser } from '../src/lib/currentUser';
import { getPersonById } from '../src/lib/db';
import { sendMagicLink } from '../src/lib/notify';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens'),
    env.DB.prepare('DELETE FROM email_log'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare(
    `INSERT INTO people (id, display_name, email, role, active, session_epoch, lang)
     VALUES (1, 'Tester', 'tester@example.com', 'member', 1, 0, 'en')`,
  ).run();
});

function rawOf(res: { raw: string } | { rateLimited: true }): string {
  if ('rateLimited' in res) throw new Error('expected a token, got rateLimited');
  return res.raw;
}

describe('sendMagicLink', () => {
  it('issues a login token and dev-logs the email', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await sendMagicLink(
      env,
      env.DB,
      { id: 1, email: 'tester@example.com', display_name: 'Tester', lang: 'en' },
      'en',
    );
    spy.mockRestore();
    expect(ok).toBe(true);

    const tok = await env.DB.prepare(`SELECT token_hash, purpose FROM tokens ORDER BY id DESC LIMIT 1`).first<{
      token_hash: string;
      purpose: string;
    }>();
    expect(tok?.purpose).toBe('login');
    expect(tok?.token_hash).toHaveLength(64); // sha256 hex, not a raw token

    const log = await env.DB.prepare(`SELECT status, kind FROM email_log ORDER BY id DESC LIMIT 1`).first<{
      status: string;
      kind: string;
    }>();
    expect(log).toMatchObject({ status: 'devlog', kind: 'signin' });
  });
});

describe('full sign-in flow', () => {
  it('peek → consume → session, and the token is single-use', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));

    // Stored as a hash, never the raw token.
    const row = await env.DB.prepare(`SELECT token_hash FROM tokens ORDER BY id DESC LIMIT 1`).first<{
      token_hash: string;
    }>();
    expect(row!.token_hash).not.toBe(raw);
    expect(row!.token_hash).toBe(await sha256Hex(raw));

    // GET peeks without consuming; POST consumes once.
    expect(await peekToken(env.DB, raw, 'login')).toMatchObject({ person_id: 1 });
    expect(await consumeToken(env.DB, raw, 'login')).toMatchObject({ person_id: 1 });
    expect(await consumeToken(env.DB, raw, 'login')).toBeNull(); // replay rejected

    // Mint the session the confirm POST would set, then verify + load the user.
    const person = (await getPersonById(env.DB, 1))!;
    const jwt = await mintSession(SECRET, {
      id: person.id,
      email: person.email,
      sessionEpoch: person.session_epoch,
    });
    const claims = await verifySession(SECRET, jwt);
    expect(claims).toMatchObject({ personId: 1, email: 'tester@example.com', epoch: 0 });
    const user = await loadSessionUser(env.DB, claims!.personId, claims!.epoch);
    expect(user).toMatchObject({ id: 1, email: 'tester@example.com', role: 'member' });
  });

  it('rejects an expired token at both peek and consume', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));
    await env.DB.prepare(`UPDATE tokens SET expires_at = datetime('now', '-1 minute') WHERE token_hash = ?`)
      .bind(await sha256Hex(raw))
      .run();
    expect(await peekToken(env.DB, raw, 'login')).toBeNull();
    expect(await consumeToken(env.DB, raw, 'login')).toBeNull();
  });
});
