import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifySession } from '../../src/lib/session';
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
    const nowEpochSeconds = 1_787_030_400;
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
});
