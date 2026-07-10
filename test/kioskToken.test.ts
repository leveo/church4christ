// kioskToken (workers project, live D1). Covers the children's check-in kiosk
// token helpers: read (empty when unset), create-if-missing (32 lowercase hex
// chars, persisted, idempotent on repeat calls), and regenerate (always a
// fresh, different token). Built on getSetting/setSetting over the flat
// settings table — see test/settings.test.ts for that layer's own coverage.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { KIOSK_TOKEN_KEY, ensureKioskToken, getKioskToken, regenerateKioskToken } from '../src/lib/kioskToken';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings').run();
});

const HEX32 = /^[0-9a-f]{32}$/;

describe('getKioskToken', () => {
  it('returns an empty string when no token has been generated yet', async () => {
    expect(await getKioskToken(env.DB)).toBe('');
  });

  it('returns the stored token once set', async () => {
    const token = await ensureKioskToken(env.DB);
    expect(await getKioskToken(env.DB)).toBe(token);
  });
});

describe('ensureKioskToken', () => {
  it('creates a 32-character lowercase hex token and persists it under children.kiosk_token', async () => {
    const token = await ensureKioskToken(env.DB);
    expect(token).toMatch(HEX32);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KIOSK_TOKEN_KEY).first<{ value: string }>();
    expect(row?.value).toBe(token);
  });

  it('is idempotent — a second call returns the same token, no new row', async () => {
    const first = await ensureKioskToken(env.DB);
    const second = await ensureKioskToken(env.DB);
    expect(second).toBe(first);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?').bind(KIOSK_TOKEN_KEY).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('regenerateKioskToken', () => {
  it('replaces an existing token with a different 32-hex value', async () => {
    const first = await ensureKioskToken(env.DB);
    const regenerated = await regenerateKioskToken(env.DB);
    expect(regenerated).toMatch(HEX32);
    expect(regenerated).not.toBe(first);
    expect(await getKioskToken(env.DB)).toBe(regenerated);
  });

  it('also works when no token existed yet', async () => {
    const token = await regenerateKioskToken(env.DB);
    expect(token).toMatch(HEX32);
    expect(await getKioskToken(env.DB)).toBe(token);
  });
});
