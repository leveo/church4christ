// Runs in the workers project against a live, migrated D1 binding. Covers
// getActiveTheme: it reads the theme + default mode from settings, validates the
// stored theme name against THEMES (unknown → THEME_DEFAULT), and caches the
// result per-isolate so a mid-TTL DB change is served stale until clearThemeCache.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSetting } from '../src/lib/settings';
import { clearThemeCache, getActiveTheme, THEME_DEFAULT } from '../src/lib/theme';

// The cache is module-level and survives across tests in this file; wipe both the
// settings table and the cache before each test so reads see only that test's writes.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings').run();
  clearThemeCache();
});

describe('getActiveTheme', () => {
  it('reads the theme name + default mode from settings', async () => {
    await setSetting(env.DB, 'theme.name', 'midnight');
    await setSetting(env.DB, 'theme.default_mode', 'dark');
    expect(await getActiveTheme(env.DB)).toEqual({ theme: 'midnight', defaultMode: 'dark' });
  });

  it('defaults to sanctuary/light when settings are empty', async () => {
    expect(await getActiveTheme(env.DB)).toEqual({ theme: 'sanctuary', defaultMode: 'light' });
  });

  it('falls back to THEME_DEFAULT for an unknown stored theme name', async () => {
    await setSetting(env.DB, 'theme.name', 'not-a-real-theme');
    expect((await getActiveTheme(env.DB)).theme).toBe(THEME_DEFAULT);
  });

  it("falls back to the theme's intrinsic default mode for an invalid default_mode", async () => {
    await setSetting(env.DB, 'theme.name', 'midnight');
    await setSetting(env.DB, 'theme.default_mode', 'sideways');
    expect(await getActiveTheme(env.DB)).toEqual({ theme: 'midnight', defaultMode: 'dark' });
  });

  it('serves a cached value within the TTL even after the DB changes, until cleared', async () => {
    await setSetting(env.DB, 'theme.name', 'sanctuary');
    expect((await getActiveTheme(env.DB)).theme).toBe('sanctuary'); // caches

    // Change the stored theme directly — without clearing the cache the reader
    // must keep serving the cached value (per-isolate 60s TTL).
    await setSetting(env.DB, 'theme.name', 'midnight');
    expect((await getActiveTheme(env.DB)).theme).toBe('sanctuary'); // stale, still cached

    clearThemeCache();
    expect((await getActiveTheme(env.DB)).theme).toBe('midnight'); // fresh after bust
  });
});
