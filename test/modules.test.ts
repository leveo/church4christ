// Registry purity (runs in the workers project by default — this file is pure and
// imports only modules.ts, so it needs no D1). Table-drives moduleForPath over
// every module's own public + admin prefix, the /serve overlap (gifts/testimonies
// win over serve by longest prefix), the serve-family aliases (/my, /cal,
// /ministries), and the always-on CORE paths that must resolve to null (/,
// /profile, /admin/people, unknown, and segment-aware lookalikes).
import { describe, expect, it } from 'vitest';
import { MODULE_KEYS, MODULES, moduleForPath } from '../src/lib/modules';

describe('MODULES registry', () => {
  it('has all 11 module keys in display order', () => {
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
    ]);
  });

  it('gifts and people softly use serve; every other module has no deps', () => {
    expect(MODULES.gifts.uses).toEqual(['serve']);
    expect(MODULES.people.uses).toEqual(['serve']);
    for (const key of MODULE_KEYS) {
      if (key !== 'gifts' && key !== 'people') expect(MODULES[key].uses).toEqual([]);
    }
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
  });
});
