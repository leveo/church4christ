import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { mintSession, verifySession, verifySessionWithScreenshotFallback } from '../../src/lib/session';
import { mintScreenshotSession } from '../../scripts/lib/screenshot-session.mjs';

const SECRET = 'screenshot-only-secret-at-least-32-characters';

describe('screenshot-only session minting', () => {
  it('fails closed unless a strong secret is supplied only through the environment', async () => {
    const identity = { personId: 3, email: 'sarah.johnson@example.com', sessionEpoch: 0 };
    await expect(mintScreenshotSession({}, identity)).rejects.toThrow(/screenshot session unavailable/i);
    await expect(mintScreenshotSession({ SCREENSHOT_SESSION_SECRET: 'short' }, identity))
      .rejects.toThrow(/screenshot session unavailable/i);
  });

  it('mints a short-lived production-compatible session for the exact selected identity', async () => {
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const token = await mintScreenshotSession(
      { SCREENSHOT_SESSION_SECRET: SECRET },
      { personId: 4, email: 'grace.lin@example.com', sessionEpoch: 0 },
      nowEpochSeconds,
    );
    await expect(verifySession(SECRET, token)).resolves.toEqual({
      personId: 4,
      email: 'grace.lin@example.com',
      epoch: 0,
    });
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims.exp - claims.iat).toBe(5 * 60);
  });

  it('rejects ambiguous identities and never logs or persists the secret or token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const invalid = [
      { personId: 0, email: 'sarah.johnson@example.com', sessionEpoch: 0 },
      { personId: 3, email: 'Sarah.Johnson@example.com', sessionEpoch: 0 },
      { personId: 3, email: 'sarah.johnson@example.com', sessionEpoch: -1 },
    ];
    for (const identity of invalid) {
      await expect(mintScreenshotSession({ SCREENSHOT_SESSION_SECRET: SECRET }, identity))
        .rejects.toThrow(/screenshot identity unavailable/i);
    }
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();

    const source = readFileSync('scripts/lib/screenshot-session.mjs', 'utf8');
    expect(source).not.toMatch(/console\.|writeFile|appendFile|localStorage|sessionStorage/);
    expect(source).not.toContain(SECRET);
  });

  it('accepts the screenshot signing secret only in development and reports its origin', async () => {
    const regularSecret = 'regular-session-secret-at-least-32-characters';
    const identity = { id: 3, email: 'sarah.johnson@example.com', sessionEpoch: 0 };
    const regular = await mintSession(regularSecret, identity);
    const screenshot = await mintScreenshotSession(
      { SCREENSHOT_SESSION_SECRET: SECRET },
      { personId: identity.id, email: identity.email, sessionEpoch: identity.sessionEpoch },
    );

    await expect(verifySessionWithScreenshotFallback({
      jwt: regular,
      runtimeSecret: regularSecret,
      devMode: false,
      screenshotSecret: SECRET,
    })).resolves.toMatchObject({ origin: 'runtime', claims: { personId: 3 } });
    await expect(verifySessionWithScreenshotFallback({
      jwt: screenshot,
      runtimeSecret: regularSecret,
      devMode: false,
      screenshotSecret: SECRET,
    })).resolves.toBeNull();
    await expect(verifySessionWithScreenshotFallback({
      jwt: screenshot,
      runtimeSecret: undefined,
      devMode: true,
      screenshotSecret: SECRET,
    })).resolves.toEqual({
      origin: 'screenshot',
      claims: { personId: 3, email: 'sarah.johnson@example.com', epoch: 0 },
    });
  });

  it('requires middleware to bind screenshot claims to the loaded Person email', () => {
    const middleware = readFileSync('src/middleware.ts', 'utf8');
    expect(middleware).toContain('import.meta.env.DEV');
    expect(middleware).toContain('import.meta.env.SCREENSHOT_SESSION_SECRET');
    expect(middleware).toMatch(/origin === 'runtime'[^\n]*user\.email === verified\.claims\.email/);
  });
});
