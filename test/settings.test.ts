// Runs in the workers project against a live, migrated D1 binding. Covers
// settings.ts: the key/value getters + upsert, the localized site-identity
// reader (locale key with .en fallback + locale-free keys), and the theme
// reader's defaults.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteSetting, getHeroImageKey, getSetting, getSettings, getSiteIdentity, getTheme, setSetting } from '../src/lib/settings';

// Storage is isolated per test file but not per test in this pool config; wipe
// the flat settings table before each test so reads see only that test's writes.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings').run();
});

describe('getSettings / getSetting / setSetting', () => {
  it('getSettings returns only present keys, omitting missing ones', async () => {
    const db = env.DB;
    await setSetting(db, 'site.email', 'hi@church.org');
    expect(await getSettings(db, ['site.email', 'site.phone'])).toEqual({ 'site.email': 'hi@church.org' });
  });

  it('getSettings tolerates an empty key list', async () => {
    expect(await getSettings(env.DB, [])).toEqual({});
  });

  it('getSetting returns the value or the fallback', async () => {
    const db = env.DB;
    await setSetting(db, 'site.phone', '555-1234');
    expect(await getSetting(db, 'site.phone')).toBe('555-1234');
    expect(await getSetting(db, 'missing.key')).toBe('');
    expect(await getSetting(db, 'missing.key', 'default')).toBe('default');
  });

  it('setSetting upserts — second write updates in place, one row', async () => {
    const db = env.DB;
    await setSetting(db, 'theme.name', 'sanctuary');
    await setSetting(db, 'theme.name', 'harvest');
    expect(await getSetting(db, 'theme.name')).toBe('harvest');
    const count = await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'theme.name'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('deleteSetting removes a key so the next read falls back to the default; a missing key is a harmless no-op', async () => {
    const db = env.DB;
    await setSetting(db, 'nav.items', '[]');
    await deleteSetting(db, 'nav.items');
    expect(await getSetting(db, 'nav.items', 'fallback')).toBe('fallback');
    await deleteSetting(db, 'nav.items'); // already gone — no-op, does not throw
  });
});

describe('getSiteIdentity', () => {
  it('reads localized keys with .en fallback plus the locale-free keys', async () => {
    const db = env.DB;
    await setSetting(db, 'site.name.en', 'Church4Christ');
    await setSetting(db, 'site.name.zh', '四方基督教会');
    await setSetting(db, 'site.tagline.en', 'A church for the city'); // no zh → falls back
    await setSetting(db, 'site.service_times.en', 'Sun 10am');
    await setSetting(db, 'site.address', '123 Main St');
    await setSetting(db, 'site.email', 'hi@church.org');
    await setSetting(db, 'site.phone', '555-1234');
    await setSetting(db, 'site.giving_url', 'https://give.example');
    await setSetting(db, 'site.youtube_url', 'https://youtube.example');
    await setSetting(db, 'site.map_url', 'https://maps.example');

    const zh = await getSiteIdentity(db, 'zh');
    expect(zh.name).toBe('四方基督教会'); // zh present
    expect(zh.tagline).toBe('A church for the city'); // zh absent → en fallback
    expect(zh.serviceTimes).toBe('Sun 10am'); // zh absent → en fallback
    expect(zh.address).toBe('123 Main St');
    expect(zh.email).toBe('hi@church.org');
    expect(zh.phone).toBe('555-1234');
    expect(zh.givingUrl).toBe('https://give.example');
    expect(zh.youtubeUrl).toBe('https://youtube.example');
    expect(zh.mapUrl).toBe('https://maps.example');

    expect((await getSiteIdentity(db, 'en')).name).toBe('Church4Christ');
  });

  it('returns empty strings when nothing is set', async () => {
    expect(await getSiteIdentity(env.DB, 'en')).toEqual({
      name: '',
      tagline: '',
      address: '',
      email: '',
      phone: '',
      serviceTimes: '',
      givingUrl: '',
      youtubeUrl: '',
      mapUrl: '',
    });
  });
});

describe('getTheme', () => {
  it('defaults to sanctuary/light when unset', async () => {
    expect(await getTheme(env.DB)).toEqual({ theme: 'sanctuary', defaultMode: 'light' });
  });

  it('reads theme.name / theme.default_mode when set', async () => {
    const db = env.DB;
    await setSetting(db, 'theme.name', 'midnight');
    await setSetting(db, 'theme.default_mode', 'dark');
    expect(await getTheme(db)).toEqual({ theme: 'midnight', defaultMode: 'dark' });
  });
});

describe('getHeroImageKey', () => {
  it('returns an empty string when the homepage hero media key is unset', async () => {
    expect(await getHeroImageKey(env.DB)).toBe('');
  });

  it('getHeroImageKey returns the configured homepage hero media key', async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('site.hero_image_key', 'uploads/hero.webp')",
    ).run();
    expect(await getHeroImageKey(env.DB)).toBe('uploads/hero.webp');
  });
});
