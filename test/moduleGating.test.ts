// getEnabledModules against a live, migrated D1 (workers project). Covers the
// enablement rules (empty DB = all on; module.<key>='0' disables only that one; a
// junk value still counts as enabled — '0' is the sole disable) and the 60s
// per-isolate cache serving stale within the TTL until clearModuleCache busts it,
// matching the theme-cache semantics.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSetting } from '../src/lib/settings';
import { MODULE_KEYS, clearModuleCache, getEnabledModules, moduleForPath } from '../src/lib/modules';

// The cache is module-level and survives across tests in this file; wipe both the
// settings table and the cache before each test so reads see only that test's writes.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings').run();
  clearModuleCache();
});

describe('getEnabledModules', () => {
  // These suites exercise the settings-read + cache logic, independent of backend
  // gating, so they pass the 'supabase' backend (every module is available there —
  // the physical DB is still the test D1; `backend` only selects the gating filter).
  it('an empty settings table enables every module (default on)', async () => {
    const enabled = await getEnabledModules(env.DB, 'supabase');
    expect(enabled.size).toBe(MODULE_KEYS.length);
    for (const key of MODULE_KEYS) expect(enabled.has(key)).toBe(true);
  });

  it("module.<key>='0' disables only that module", async () => {
    await setSetting(env.DB, 'module.sermons', '0');
    const enabled = await getEnabledModules(env.DB, 'supabase');
    expect(enabled.has('sermons')).toBe(false);
    expect(enabled.has('serve')).toBe(true);
    expect(enabled.size).toBe(MODULE_KEYS.length - 1);
  });

  it("a junk value counts as enabled — '0' is the only disable", async () => {
    await setSetting(env.DB, 'module.events', 'yes');
    await setSetting(env.DB, 'module.serve', '');
    await setSetting(env.DB, 'module.gifts', '1');
    const enabled = await getEnabledModules(env.DB, 'supabase');
    expect(enabled.has('events')).toBe(true);
    expect(enabled.has('serve')).toBe(true);
    expect(enabled.has('gifts')).toBe(true);
  });

  it('serves a cached value within the TTL even after the DB changes, until cleared', async () => {
    expect((await getEnabledModules(env.DB, 'supabase')).has('sermons')).toBe(true); // warms the cache

    // Disable sermons directly — without clearing, the reader must keep serving the
    // cached (all-on) value (per-isolate 60s TTL).
    await setSetting(env.DB, 'module.sermons', '0');
    expect((await getEnabledModules(env.DB, 'supabase')).has('sermons')).toBe(true); // stale, still cached

    clearModuleCache();
    expect((await getEnabledModules(env.DB, 'supabase')).has('sermons')).toBe(false); // fresh after bust
  });
});

describe('getEnabledModules — backend gating', () => {
  it("never contains giving/registration on 'd1', even when their settings rows are '1'", async () => {
    await setSetting(env.DB, 'module.giving', '1');
    await setSetting(env.DB, 'module.registration', '1');
    const enabled = await getEnabledModules(env.DB, 'd1');
    expect(enabled.has('giving')).toBe(false);
    expect(enabled.has('registration')).toBe(false);
  });

  it("contains giving/registration by default on 'supabase'", async () => {
    const enabled = await getEnabledModules(env.DB, 'supabase');
    expect(enabled.has('giving')).toBe(true);
    expect(enabled.has('registration')).toBe(true);
  });

  it('caches per backend — a d1 read then a supabase read return different sets with no TTL wait', async () => {
    const d1 = await getEnabledModules(env.DB, 'd1'); // warms the cache keyed to d1
    expect(d1.has('giving')).toBe(false);

    // No clearModuleCache() + no TTL wait: the backend in the cache key must force a
    // miss so the supabase read recomputes rather than serving the cached d1 set.
    const supa = await getEnabledModules(env.DB, 'supabase');
    expect(supa.has('giving')).toBe(true);
    expect(supa.has('registration')).toBe(true);
  });
});

describe('moduleForPath — backend-gated module prefixes', () => {
  it("resolves /my/giving to 'giving' (longest prefix beats serve's /my)", () => {
    expect(moduleForPath('/my/giving')).toBe('giving');
    expect(moduleForPath('/my/giving/2026-06')).toBe('giving');
  });

  it('resolves the registration prefixes', () => {
    expect(moduleForPath('/register')).toBe('registration');
    expect(moduleForPath('/api/register')).toBe('registration');
  });
});
