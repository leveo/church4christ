// Registry purity (runs in the workers project by default — this file is pure and
// imports only modules.ts, so it needs no D1). Table-drives moduleForPath over
// every module's own public + admin prefix, the /serve overlap (gifts/testimonies
// win over serve by longest prefix), the serve-family aliases (/my, /cal,
// /ministries), and the always-on CORE paths that must resolve to null (/,
// /profile, /admin/people, unknown, and segment-aware lookalikes).
import { describe, expect, it } from 'vitest';
import { MODULE_KEYS, MODULES, filterByBackend, moduleForPath } from '../src/lib/modules';

describe('MODULES registry', () => {
  it('has all 14 module keys in display order', () => {
    expect([...MODULE_KEYS]).toEqual([
      'bulletins',
      'sermons',
      'prayer-sheets',
      'prayer-wall',
      'events',
      'serve',
      'gifts',
      'testimonies',
      'articles',
      'fellowships',
      'people',
      'children',
      'giving',
      'registration',
    ]);
  });

  it('gifts/people softly use serve, giving softly uses people; every other module has no deps', () => {
    expect(MODULES.gifts.uses).toEqual(['serve']);
    expect(MODULES.people.uses).toEqual(['serve']);
    expect(MODULES.giving.uses).toEqual(['people']);
    for (const key of MODULE_KEYS) {
      if (key !== 'gifts' && key !== 'people' && key !== 'giving') expect(MODULES[key].uses).toEqual([]);
    }
  });

  it('giving and registration require the supabase backend; no other module does', () => {
    expect(MODULES.giving.requiresBackend).toBe('supabase');
    expect(MODULES.registration.requiresBackend).toBe('supabase');
    for (const key of MODULE_KEYS) {
      if (key !== 'giving' && key !== 'registration') expect(MODULES[key].requiresBackend).toBeUndefined();
    }
  });
});

describe('filterByBackend (middleware fail-safe + getEnabledModules share it)', () => {
  it("on 'd1', drops the supabase-only modules (giving/registration)", () => {
    const enabled = filterByBackend(MODULE_KEYS, 'd1');
    expect(enabled.has('giving')).toBe(false);
    expect(enabled.has('registration')).toBe(false);
    // Every non-backend-gated module survives.
    expect(enabled.size).toBe(MODULE_KEYS.length - 2);
    for (const key of MODULE_KEYS) {
      if (key !== 'giving' && key !== 'registration') expect(enabled.has(key)).toBe(true);
    }
  });

  it("on 'supabase', keeps every module", () => {
    const enabled = filterByBackend(MODULE_KEYS, 'supabase');
    expect(enabled.size).toBe(MODULE_KEYS.length);
    expect(enabled.has('giving')).toBe(true);
    expect(enabled.has('registration')).toBe(true);
  });
});

describe('moduleForPath (longest-prefix wins)', () => {
  const cases: [string, string | null][] = [
    // ── own public prefixes (+ sub-paths) ──
    ['/bulletin', 'bulletins'],
    ['/bulletin/2026-06-28', 'bulletins'],
    ['/sermons', 'sermons'],
    ['/sermons/2026', 'sermons'],
    ['/prayer', 'prayer-sheets'],
    ['/prayer/2026-06-28', 'prayer-sheets'],
    ['/api/prayer-request', 'prayer-wall'],
    ['/events', 'events'],
    ['/serve', 'serve'],
    ['/serve/plans', 'serve'],
    ['/serve/plans/7', 'serve'],
    ['/serve/apply', 'serve'],
    ['/my', 'serve'],
    ['/my/blockouts', 'serve'],
    ['/cal', 'serve'],
    ['/cal/feed.ics', 'serve'],
    ['/ministries', 'serve'], // spec §A: the ministries directory belongs to serve
    ['/ministries/worship', 'serve'],
    ['/serve/gifts', 'gifts'], // longest prefix wins over serve
    ['/serve/testimonies', 'testimonies'], // longest prefix wins over serve
    ['/articles', 'articles'],
    ['/articles/2026/grace', 'articles'],
    ['/fellowships', 'fellowships'],
    // ── giving (backend-gated) prefixes; /my/giving beats serve's /my ──
    ['/give/checkout', 'giving'],
    ['/give/checkout/thanks', 'giving'],
    ['/my/giving', 'giving'],
    ['/my/giving/2026', 'giving'],
    ['/api/giving', 'giving'],
    // ── registration (backend-gated) prefixes ──
    ['/register', 'registration'],
    ['/register/summer-camp', 'registration'],
    ['/api/register', 'registration'],
    // ── admin prefixes ──
    ['/admin/bulletins', 'bulletins'],
    ['/admin/sermons', 'sermons'],
    ['/admin/prayer-sheets', 'prayer-sheets'],
    ['/admin/prayer-wall', 'prayer-wall'],
    ['/admin/events', 'events'],
    ['/admin/announcements', 'events'], // events owns the homepage ticker admin
    ['/admin/ministries', 'serve'],
    ['/admin/service-types', 'serve'],
    ['/admin/teams', 'serve'],
    ['/admin/reports', 'serve'],
    ['/admin/testimonies', 'testimonies'],
    ['/admin/giving', 'giving'],
    ['/admin/registration', 'registration'],
    ['/admin/children', 'children'],
    // ── children's check-in kiosk ──
    ['/kiosk', 'children'],
    ['/kiosk/abc123', 'children'],
    // ── always-on core → null ──
    ['/', null],
    ['/profile', null], // auth surface stays core
    ['/profile/7', null],
    ['/visit', null],
    ['/about', null],
    ['/about/staff', null],
    ['/give', null],
    ['/privacy', null],
    ['/signin', null],
    ['/admin', null],
    ['/admin/settings', null],
    ['/admin/people', null], // predates the module — core
    ['/admin/revisions', null],
    ['/admin/availability', null],
    ['/admin/applications', null],
    ['/healthz', null],
    ['/xyz', null],
    ['/serveware', null], // segment-aware: NOT /serve
    ['/mystery', null], // segment-aware: NOT /my
  ];

  for (const [path, expected] of cases) {
    it(`${path} → ${expected}`, () => {
      expect(moduleForPath(path)).toBe(expected);
    });
  }

  it('a trailing slash resolves like the bare path', () => {
    expect(moduleForPath('/serve/')).toBe('serve');
    expect(moduleForPath('/serve/gifts/')).toBe('gifts');
    expect(moduleForPath('/bulletin/')).toBe('bulletins');
    expect(moduleForPath('/kiosk/')).toBe('children');
  });
});
