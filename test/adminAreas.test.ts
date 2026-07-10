import { describe, expect, it } from 'vitest';
import { adminAreaForPath, hasAreaAccess, parseAdminAreas, GRANTABLE_AREAS } from '../src/lib/adminAreas';
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
    ['/admin/people', 'people-basic'],
    ['/admin/people/3', 'people-basic'],
    ['/admin/groups', 'groups'],
    ['/admin/groups/2', 'groups'],
    ['/admin/giving', 'giving'],
    ['/admin/giving/reconcile', 'giving'],
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
  });
  it('limited admin: granted + always-on areas only; settings never grantable', () => {
    expect(hasAreaAccess(limited, 'groups')).toBe(true);
    expect(hasAreaAccess(limited, 'bulletins')).toBe(false);
    expect(hasAreaAccess(limited, 'prayer-wall')).toBe(true);
    expect(hasAreaAccess(limited, 'people-basic')).toBe(true);
    expect(hasAreaAccess(limited, 'settings')).toBe(false);
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
});
