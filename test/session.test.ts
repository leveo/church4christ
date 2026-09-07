// Pure-logic session tests (node project): jose HS256 mint/verify round-trip,
// tamper/wrong-secret/expired/garbage rejection, and the Set-Cookie builders.
// Ported + adapted from the reference stack's test/session.test.ts (cookie name c4c_session,
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
import { hasRecentStepUp } from '../src/lib/sessionAssurance';

const SECRET = 'test-secret-at-least-32-characters-long';

describe('session JWT', () => {
  it('mints an opaque v2 token with assurance but no contact or profile data', async () => {
    const authTime = 1_800_000_000;
    const jwt = await mintSession(
      SECRET,
      { id: 42, email: 'leo@example.com', sessionEpoch: 3 },
      { authMethod: 'email_otp', authTime },
    );
    expect(await verifySession(SECRET, jwt)).toEqual({
      personId: 42,
      epoch: 3,
      assurance: {
        schemaVersion: 2,
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        authMethod: 'email_otp',
        authTime,
        stepUpTime: null,
      },
    });
    const [, encoded] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ sub: '42', ep: 3, v: 2, am: 'email_otp', at: authTime });
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('contact');
  });

  it.each(['email_otp', 'magic_link'] as const)(
    'round-trips a new %s authentication timestamp',
    async (authMethod) => {
      const jwt = await mintSession(
        SECRET,
        { id: 42, email: 'ignored@example.com', sessionEpoch: 3 },
        { authMethod, authTime: 1_800_000_000, stepUpTime: 1_800_000_100 },
      );
      expect((await verifySession(SECRET, jwt))?.assurance).toMatchObject({
        authMethod,
        authTime: 1_800_000_000,
        stepUpTime: 1_800_000_100,
      });
    },
  );

  it('rejects an invalid subject or epoch before minting', async () => {
    await expect(mintSession(SECRET, { id: 0, sessionEpoch: 0 })).rejects.toThrow(/person/i);
    await expect(mintSession(SECRET, { id: 1, sessionEpoch: -1 })).rejects.toThrow(/epoch/i);
  });

  it('restores a legacy email-bearing token without trusting or returning its email', async () => {
    const legacy = await new SignJWT({ email: 'stale-or-forged@example.com', ep: 7 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('42')
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifySession(SECRET, legacy)).toEqual({
      personId: 42,
      epoch: 7,
      assurance: {
        schemaVersion: 1,
        sessionId: null,
        authMethod: 'legacy',
        authTime: null,
        stepUpTime: null,
      },
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

describe('recent session assurance', () => {
  const assured = {
    schemaVersion: 2 as const,
    sessionId: '00000000-0000-4000-8000-000000000001',
    authMethod: 'email_otp' as const,
    authTime: 1_000,
    stepUpTime: null,
  };

  it('accepts the exact ten-minute boundary and rejects one second beyond it', () => {
    expect(hasRecentStepUp(assured, 1_600)).toBe(true);
    expect(hasRecentStepUp(assured, 1_601)).toBe(false);
  });

  it('uses an explicit later step-up timestamp', () => {
    expect(hasRecentStepUp({ ...assured, stepUpTime: 2_000 }, 2_600)).toBe(true);
  });

  it('fails closed for legacy, screenshot, future, invalid, and inconsistent timestamps', () => {
    expect(hasRecentStepUp({ ...assured, schemaVersion: 1, authMethod: 'legacy', authTime: null }, 1_000)).toBe(false);
    expect(hasRecentStepUp({ ...assured, authMethod: 'screenshot' }, 1_000)).toBe(false);
    expect(hasRecentStepUp({ ...assured, authTime: 1_001 }, 1_000)).toBe(false);
    expect(hasRecentStepUp({ ...assured, authTime: Number.NaN }, 1_000)).toBe(false);
    expect(hasRecentStepUp({ ...assured, stepUpTime: 999 }, 1_000)).toBe(false);
    expect(hasRecentStepUp({ ...assured, sessionId: 'malformed-session-id' }, 1_000)).toBe(false);
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
