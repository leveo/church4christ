// Settings save → theme cache bust (workers project, live D1). Mirrors the
// /admin/settings save handler's lib calls: setSettings writes the allowlisted
// keys in one batch, and getActiveTheme reflects a new theme.name only AFTER
// clearThemeCache() — exactly the sequence the page runs before its 303, so a
// theme switch takes effect on the very next render.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getLogoImageKey, getSettings, setSetting, setSettings } from '../src/lib/settings';
import { clearThemeCache, getActiveTheme } from '../src/lib/theme';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings').run();
  clearThemeCache();
});

describe('setSettings', () => {
  it('upserts every key in one batch and overwrites existing values', async () => {
    await setSettings(env.DB, { 'site.name.en': 'First', 'theme.name': 'sanctuary' });
    await setSettings(env.DB, { 'site.name.en': 'Renamed', 'site.email': 'hi@example.com' });
    const s = await getSettings(env.DB, ['site.name.en', 'site.email', 'theme.name']);
    expect(s).toEqual({ 'site.name.en': 'Renamed', 'site.email': 'hi@example.com', 'theme.name': 'sanctuary' });
  });

  it('a no-op empty update touches nothing', async () => {
    await setSettings(env.DB, {});
    expect(await getSettings(env.DB, ['site.name.en'])).toEqual({});
  });
});

describe('getLogoImageKey', () => {
  it('logo image key round-trips and defaults empty', async () => {
    expect(await getLogoImageKey(env.DB)).toBe('');
    await setSetting(env.DB, 'site.logo_image_key', 'uploads/abc-logo.png');
    expect(await getLogoImageKey(env.DB)).toBe('uploads/abc-logo.png');
  });
});

describe('settings save → theme cache busted', () => {
  it('getActiveTheme reflects a saved theme.name immediately after clearThemeCache', async () => {
    await setSettings(env.DB, { 'theme.name': 'sanctuary', 'theme.default_mode': 'light' });
    expect((await getActiveTheme(env.DB)).theme).toBe('sanctuary'); // warms the cache

    // The save handler writes the new theme, then clears the cache.
    await setSettings(env.DB, { 'theme.name': 'harvest' });
    expect((await getActiveTheme(env.DB)).theme).toBe('sanctuary'); // still stale until cleared
    clearThemeCache();
    expect((await getActiveTheme(env.DB)).theme).toBe('harvest'); // fresh on the next render
  });
});
