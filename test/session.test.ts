// Pure-logic session tests (node project): jose HS256 mint/verify round-trip,
// tamper/wrong-secret/expired/garbage rejection, and the Set-Cookie builders.
// Ported + adapted from dcfc-serve/test/session.test.ts (cookie name c4c_session,
// secret-first signatures, {id,email,sessionEpoch} person shape).
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  mintSession,
  SESSION_COOKIE,
  sessionCookie,
  verifySession,
} from '../src/lib/session';

const SECRET = 'test-secret-at-least-32-characters-long';

describe('session JWT', () => {
  it('round-trips personId, email, and epoch', async () => {
    const jwt = await mintSession(SECRET, { id: 42, email: 'leo@example.com', sessionEpoch: 3 });
    expect(await verifySession(SECRET, jwt)).toEqual({
      personId: 42,
      email: 'leo@example.com',
      epoch: 3,
    });
  });

  it('rejects a tampered token', async () => {
    const jwt = await mintSession(SECRET, { id: 42, email: 'leo@example.com', sessionEpoch: 0 });
    const [h, p, s] = jwt.split('.');
    // Flip a character in the payload; signature no longer matches.
    const tampered = `${h}.${p.slice(0, -1)}${p.endsWith('A') ? 'B' : 'A'}.${s}`;
    expect(await verifySession(SECRET, tampered)).toBeNull();
  });

  it('rejects the wrong secret', async () => {
    const jwt = await mintSession(SECRET, { id: 42, email: 'leo@example.com', sessionEpoch: 0 });
    expect(await verifySession('some-other-secret-32-characters!', jwt)).toBeNull();
  });

  it('rejects an expired token', async () => {
    // mintSession always stamps a 30d expiry, so forge an already-expired JWT
    // with jose directly to exercise the expiry branch.
    const expired = await new SignJWT({ email: 'leo@example.com', ep: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('42')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySession(SECRET, expired)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySession(SECRET, 'garbage')).toBeNull();
    expect(await verifySession(SECRET, '')).toBeNull();
  });
});

describe('session cookie', () => {
  it('carries HttpOnly, SameSite=Lax, Path, 30d Max-Age; Secure only in prod', async () => {
    const jwt = await mintSession(SECRET, { id: 1, email: 'a@b.com', sessionEpoch: 0 });
    const prod = sessionCookie(jwt, true);
    expect(prod).toContain(`${SESSION_COOKIE}=${jwt}`);
    expect(prod).toContain('HttpOnly');
    expect(prod).toContain('SameSite=Lax');
    expect(prod).toContain('Path=/');
    expect(prod).toContain('Max-Age=2592000'); // 30 days in seconds
    expect(prod).toContain('Secure');

    const dev = sessionCookie(jwt, false);
    expect(dev).toContain('HttpOnly');
    expect(dev).not.toContain('Secure');
  });

  it('clearSessionCookie expires the cookie (Max-Age=0)', () => {
    const cleared = clearSessionCookie(true);
    expect(cleared).toContain(`${SESSION_COOKIE}=`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('Secure');
    expect(clearSessionCookie(false)).not.toContain('Secure');
  });
});
