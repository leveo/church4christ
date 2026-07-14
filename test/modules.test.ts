// Registry purity (runs in the workers project by default — this file is pure and
// imports only modules.ts, so it needs no D1). Table-drives moduleForPath over
// every module's own public + admin prefix, the /serve overlap (gifts/testimonies
// win over serve by longest prefix), the serve-family aliases (/my, /cal,
// /ministries), and the always-on CORE paths that must resolve to null (/,
// /profile, /admin/people, unknown, and segment-aware lookalikes).
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
} from '../src/lib/capabilityCatalog';
import {
  MODULE_GROUPS,
  MODULE_KEYS,
  MODULES,
  moduleBackendRequirementKey,
  buildModuleGroups,
  filterByBackend,
  moduleForPath,
} from '../src/lib/modules';

describe('MODULES registry', () => {
  it('maps each supported backend to its requirement label key', () => {
    expect(moduleBackendRequirementKey('supabase')).toBe('admin.modules.requiresSupabase');
    expect(moduleBackendRequirementKey('d1')).toBe('admin.modules.requiresD1');
  });

  it('has all 17 module keys in display order', () => {
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
      'groups',
      'people',
      'children',
      'page-builder',
      'portal',
      'giving',
      'registration',
    ]);
  });

  it('matches the canonical catalog metadata while exposing independent arrays', () => {
    expect(MODULE_KEYS).toEqual(CAPABILITY_KEYS);
    for (const key of MODULE_KEYS) {
      expect(MODULES[key]).toEqual({
        publicPrefixes: CAPABILITIES[key].publicPrefixes,
        adminPrefixes: CAPABILITIES[key].adminPrefixes,
        navKeys: CAPABILITIES[key].navKeys,
        uses: CAPABILITIES[key].uses,
        ...(CAPABILITIES[key].requiresBackend
          ? { requiresBackend: CAPABILITIES[key].requiresBackend }
          : {}),
      });
      expect(MODULES[key].publicPrefixes).not.toBe(CAPABILITIES[key].publicPrefixes);
      expect(MODULES[key].adminPrefixes).not.toBe(CAPABILITIES[key].adminPrefixes);
      expect(MODULES[key].navKeys).not.toBe(CAPABILITIES[key].navKeys);
      expect(MODULES[key].uses).not.toBe(CAPABILITIES[key].uses);
    }
  });

  it('gifts/people softly use serve, giving softly uses people, groups softly uses people+registration, portal softly uses serve+groups; every other module has no deps', () => {
    expect(MODULES.gifts.uses).toEqual(['serve']);
    expect(MODULES.people.uses).toEqual(['serve']);
    expect(MODULES.giving.uses).toEqual(['people']);
    expect(MODULES.groups.uses).toEqual(['people', 'registration']);
    expect(MODULES.portal.uses).toEqual(['serve', 'groups']);
    for (const key of MODULE_KEYS) {
      if (key !== 'gifts' && key !== 'people' && key !== 'giving' && key !== 'groups' && key !== 'portal') {
        expect(MODULES[key].uses).toEqual([]);
      }
    }
  });

  it('giving, registration, and portal require the supabase backend; no other module does', () => {
    expect(MODULES.giving.requiresBackend).toBe('supabase');
    expect(MODULES.registration.requiresBackend).toBe('supabase');
    expect(MODULES.portal.requiresBackend).toBe('supabase');
    for (const key of MODULE_KEYS) {
      if (key !== 'giving' && key !== 'registration' && key !== 'portal') expect(MODULES[key].requiresBackend).toBeUndefined();
    }
  });

  it('groups every module exactly once and preserves catalog order within each group', () => {
    const flattened = MODULE_GROUPS.flatMap((group) => group.keys);
    expect([...flattened].sort()).toEqual([...MODULE_KEYS].sort());
    expect(new Set(flattened).size).toBe(MODULE_KEYS.length);
    for (const group of MODULE_GROUPS) {
      expect(group.keys).toEqual(
        MODULE_KEYS.filter((key) => CAPABILITIES[key].group === group.group),
      );
    }
  });

  it('rejects unsupported declared catalog groups instead of omitting them', () => {
    expect(() =>
      buildModuleGroups(MODULE_KEYS, CAPABILITIES, [
        ...CAPABILITY_CATALOG.groups,
        'missions',
      ]),
    ).toThrow(/unsupported capability group.*missions/i);
  });

  it('rejects duplicate module keys instead of grouping them more than once', () => {
    expect(() =>
      buildModuleGroups([...MODULE_KEYS, MODULE_KEYS[0]], CAPABILITIES, CAPABILITY_CATALOG.groups),
    ).toThrow(/duplicate module key.*bulletins/i);
  });
});

describe('filterByBackend (middleware fail-safe + getEnabledModules share it)', () => {
  it("on 'd1', drops the supabase-only modules (giving/registration/portal)", () => {
    const enabled = filterByBackend(MODULE_KEYS, 'd1');
    expect(enabled.has('giving')).toBe(false);
    expect(enabled.has('registration')).toBe(false);
    expect(enabled.has('portal')).toBe(false);
    // Every non-backend-gated module survives.
    expect(enabled.size).toBe(MODULE_KEYS.length - 3);
    for (const key of MODULE_KEYS) {
      if (key !== 'giving' && key !== 'registration' && key !== 'portal') expect(enabled.has(key)).toBe(true);
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
    ['/groups', 'groups'],
    ['/groups/7', 'groups'],
    ['/signup', 'groups'],
    ['/attendance', 'groups'],
    ['/attendance/abc123', 'groups'],
    // ── portal (backend-gated) prefixes; each beats serve's /my ──
    ['/my/household', 'portal'],
    ['/my/household/7', 'portal'],
    ['/my/groups', 'portal'],
    ['/my/events', 'portal'],
    ['/my/serving', 'portal'],
    ['/my/prayer', 'portal'],
    ['/email-change', 'portal'],
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
    ['/admin/groups', 'groups'],
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
    ['/admin/fellowships', null],
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

  it('portal owns its /my sub-prefixes but not /my itself', () => {
    expect(moduleForPath('/my')).toBe('serve');
    expect(moduleForPath('/my/household')).toBe('portal');
    expect(moduleForPath('/my/groups')).toBe('portal');
    expect(moduleForPath('/my/events')).toBe('portal');
    expect(moduleForPath('/my/serving')).toBe('portal');
    expect(moduleForPath('/my/prayer')).toBe('portal');
    expect(moduleForPath('/my/giving')).toBe('giving');
    expect(moduleForPath('/my/calendar')).toBe('serve');
    expect(moduleForPath('/email-change')).toBe('portal');
  });

  it('portal is supabase-only', () => {
    expect(filterByBackend(['portal'], 'd1').has('portal')).toBe(false);
    expect(filterByBackend(['portal'], 'supabase').has('portal')).toBe(true);
  });
});

describe('page-builder module', () => {
  it('owns the builder admin prefix; the classic pages admin stays core', () => {
    expect(moduleForPath('/admin/pages/builder')).toBe('page-builder');
    expect(moduleForPath('/admin/pages/builder/new')).toBe('page-builder');
    expect(moduleForPath('/admin/pages/builder/123-abc')).toBe('page-builder');
    expect(moduleForPath('/admin/pages')).toBeNull();
    expect(moduleForPath('/p/about')).toBeNull(); // public rendering never gated
  });
});
