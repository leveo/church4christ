import { describe, expect, it } from 'vitest';
import {
  adminAreaForPath,
  grantableAreasForRole,
  hasAreaAccess,
  parseAdminAreas,
  parseAdminAreasForRole,
  ALWAYS_AREAS,
  GRANTABLE_AREAS,
  SCOPED_STAFF_AREAS,
} from '../src/lib/adminAreas';
import type { SessionUser } from '../src/lib/types';

const makeUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1, email: 'x@example.com', displayName: 'X', role: 'member',
  isAdmin: false, isEditor: false, isSuperAdmin: false, adminAreas: [],
  finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: 'en', ...over,
});

describe('adminAreaForPath', () => {
  const cases: Array<[string, string | null]> = [
    ['/admin', null],
    ['/admin/bulletins', 'bulletins'],
    ['/admin/bulletins/new', 'bulletins'],
    ['/admin/revisions/bulletin/1', 'bulletins'],
    ['/admin/sermons', 'sermons'],
    ['/admin/revisions/sermon/2', 'sermons'],
    ['/admin/prayer-sheets', 'prayer-sheets'],
    ['/admin/revisions/prayer_sheet/3', 'prayer-sheets'],
    ['/admin/testimonies', 'testimonies'],
    ['/admin/pages', 'pages'],
    ['/admin/revisions/custom_page/4', 'pages'],
    ['/admin/announcements', 'events'],
    ['/admin/events', 'events'],
    ['/admin/revisions/announcement/5', 'events'],
    ['/admin/revisions/event/6', 'events'],
    ['/admin/prayer-wall', 'prayer-wall'],
    ['/admin/newcomers', 'newcomers'],
    ['/admin/newcomers/', 'newcomers'],
    ['/admin/newcomers/42', 'newcomers'],
    ['/admin/newcomers/settings/unknown', 'newcomers'],
    ['/admin/people', 'people-basic'],
    ['/admin/people/3', 'people-basic'],
    ['/admin/people/import', 'people'],
    ['/admin/people/import/template.csv', 'people'],
    ['/admin/people/import/preview', 'people'],
    ['/admin/people/import/commit', 'people'],
    ['/admin/people/import/map/inspect', 'people'],
    ['/admin/people/import/map/profiles', 'people'],
    ['/admin/people/import/map/preview', 'people'],
    ['/admin/people/import/map/commit', 'people'],
    ['/admin/people/export', 'people'],
    ['/admin/people/export.csv', 'people'],
    ['/admin/people/export-notes', 'people'],
    ['/admin/groups', 'groups'],
    ['/admin/groups/2', 'groups'],
    ['/admin/attendance', 'attendance'],
    ['/admin/attendance/report.csv', 'attendance'],
    ['/admin/giving', 'giving'],
    ['/admin/giving/reconcile', 'giving'],
    ['/admin/stripe-events', 'payment-operations'],
    ['/admin/registration', 'registration'],
    ['/admin/ministries', 'serve'],
    ['/admin/service-types', 'serve'],
    ['/admin/teams', 'serve'],
    ['/admin/reports', 'serve'],
    ['/admin/reports.csv', 'serve'],
    ['/admin/availability', 'serve'],
    ['/admin/applications', 'serve'],
    ['/admin/settings', 'settings'],
    ['/admin/navigation', 'settings'],
    ['/admin/revisions', null],          // bare revisions: fail closed via null
    ['/admin/nonexistent', null],        // unknown: fail closed via null
    ['/adminx', null],                   // segment-aware: not under /admin
    ['/bulletin', null],                 // public path, no area
  ];
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected}`, () => expect(adminAreaForPath(path)).toBe(expected));
  }
});

describe('hasAreaAccess', () => {
  const limited = makeUser({ role: 'admin', isAdmin: true, adminAreas: ['groups'] });
  const superA = makeUser({ role: 'admin', isAdmin: true, isSuperAdmin: true });
  it('anon / member / editor / leader never pass (callers keep their own role logic)', () => {
    expect(hasAreaAccess(null, 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser(), 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser({ role: 'editor', isEditor: true }), 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser({ leaderTeamIds: [1] }), 'serve')).toBe(false);
  });
  it('super admin passes every area including settings', () => {
    expect(hasAreaAccess(superA, 'settings')).toBe(true);
    expect(hasAreaAccess(superA, 'giving')).toBe(true);
    expect(hasAreaAccess(superA, 'newcomers')).toBe(true);
  });
  it('limited admin: granted + always-on areas only; settings never grantable', () => {
    expect(hasAreaAccess(limited, 'groups')).toBe(true);
    expect(hasAreaAccess(limited, 'bulletins')).toBe(false);
    expect(hasAreaAccess(limited, 'prayer-wall')).toBe(true);
    expect(hasAreaAccess(limited, 'people-basic')).toBe(true);
    expect(hasAreaAccess(limited, 'settings')).toBe(false);
  });
  it('payment operations requires its dedicated grant', () => {
    expect(hasAreaAccess(makeUser({ role: 'admin', isAdmin: true, adminAreas: ['giving'] }), 'payment-operations')).toBe(false);
    expect(hasAreaAccess(makeUser({ role: 'admin', isAdmin: true, adminAreas: ['registration'] }), 'payment-operations')).toBe(false);
    expect(hasAreaAccess(makeUser({ role: 'admin', isAdmin: true, adminAreas: ['payment-operations'] }), 'payment-operations')).toBe(true);
    expect(hasAreaAccess(limited, 'payment-operations')).toBe(false);
  });
  it('aggregate attendance requires its own grant and does not grant Groups', () => {
    const attendanceOnly = makeUser({ role: 'admin', isAdmin: true, adminAreas: ['attendance'] });
    expect(hasAreaAccess(attendanceOnly, 'attendance')).toBe(true);
    expect(hasAreaAccess(attendanceOnly, 'groups')).toBe(false);
  });
  it('newcomers is the only area whose explicit grant works for scoped non-admin staff', () => {
    const scopedMember = makeUser({ adminAreas: ['newcomers', 'groups', 'people'] });
    const scopedEditor = makeUser({ role: 'editor', isEditor: true, adminAreas: ['newcomers', 'events'] });
    expect(hasAreaAccess(scopedMember, 'newcomers')).toBe(true);
    expect(hasAreaAccess(scopedEditor, 'newcomers')).toBe(true);
    const everyNonScopedArea = [
      ...GRANTABLE_AREAS.filter((area) => area !== 'newcomers'),
      ...ALWAYS_AREAS,
      'settings' as const,
    ];
    for (const legacy of everyNonScopedArea) {
      expect(hasAreaAccess(scopedMember, legacy), legacy).toBe(false);
      expect(hasAreaAccess(scopedEditor, legacy), legacy).toBe(false);
    }
  });
  it('an ordinary admin needs an explicit newcomers grant', () => {
    expect(hasAreaAccess(makeUser({ role: 'admin', isAdmin: true }), 'newcomers')).toBe(false);
    expect(hasAreaAccess(
      makeUser({ role: 'admin', isAdmin: true, adminAreas: ['newcomers'] }),
      'newcomers',
    )).toBe(true);
  });
});

describe('parseAdminAreas', () => {
  it('filters junk, reserved keys, and dupes; handles empty/null', () => {
    expect(parseAdminAreas('groups, events ,junk,settings,prayer-wall,groups')).toEqual(['groups', 'events']);
    expect(parseAdminAreas('')).toEqual([]);
    expect(parseAdminAreas(null)).toEqual([]);
    expect(parseAdminAreas(undefined)).toEqual([]);
  });
  it('accepts every grantable key', () => {
    expect(parseAdminAreas(GRANTABLE_AREAS.join(','))).toEqual([...GRANTABLE_AREAS]);
  });
  it('parses hostile CSV while retaining one valid scoped grant', () => {
    expect(parseAdminAreas(' groups, newcomers,newcomers,settings,people-basic,unknown, newcomers '))
      .toEqual(['groups', 'newcomers']);
  });
});

describe('role-aware grants', () => {
  it('exposes only the narrow scoped area for member and editor targets', () => {
    expect(SCOPED_STAFF_AREAS).toEqual(['newcomers']);
    expect(grantableAreasForRole('member')).toEqual(['newcomers']);
    expect(grantableAreasForRole('editor')).toEqual(['newcomers']);
    expect(grantableAreasForRole('admin')).toEqual(GRANTABLE_AREAS);
  });

  it('keeps all legal grants for admins but only newcomers for non-admins', () => {
    const hostile = 'groups,newcomers,events,newcomers,settings,junk';
    expect(parseAdminAreasForRole(GRANTABLE_AREAS.join(','), 'admin')).toEqual(GRANTABLE_AREAS);
    expect(parseAdminAreasForRole(hostile, 'member')).toEqual(['newcomers']);
    expect(parseAdminAreasForRole(hostile, 'editor')).toEqual(['newcomers']);
  });
});
