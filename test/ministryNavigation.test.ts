import { describe, expect, it } from 'vitest';
import { ministryNavigation, ministryLinkActive } from '../src/lib/ministryNavigation';
import { ministryCopy } from '../src/i18n/designMinistry';
import type { SessionUser } from '../src/lib/types';

const member: SessionUser = {
  id: 1, email: 'member@example.test', displayName: '王明', role: 'member',
  isAdmin: false, isEditor: false, isSuperAdmin: false, adminAreas: [], finance: 0,
  memberTeamIds: [3], leaderTeamIds: [], lang: null,
};

describe('ministry workspace navigation', () => {
  it('keeps independent gifts and testimony modules reachable when serving is off', () => {
    expect(ministryNavigation(new Set(['gifts', 'testimonies']), 'en', null, 'public').map((l) => l.href))
      .toEqual(['/en/serve/gifts', '/en/serve/testimonies']);
  });

  it('does not advertise private scheduling to anonymous or non-team viewers', () => {
    const modules = new Set(['serve']);
    expect(ministryNavigation(modules, 'en', null, 'serving')).toEqual([]);
    expect(ministryNavigation(modules, 'en', { ...member, memberTeamIds: [] }, 'serving')).toEqual([]);
    expect(ministryNavigation(modules, 'en', member, 'serving').map((l) => l.key))
      .toEqual(['plans', 'matrix', 'teams']);
  });

  it('limits manager shortcuts to leaders and respects module ownership', () => {
    const leader = { ...member, leaderTeamIds: [3] };
    expect(ministryNavigation(new Set(['serve']), 'zh', leader, 'serving').map((l) => l.href))
      .toEqual(['/zh/serve/plans', '/zh/serve/matrix', '/zh/serve/teams', '/zh/manage']);
    expect(ministryNavigation(new Set(['groups']), 'en', member, 'leader').map((l) => l.href))
      .toEqual(['/en/manage']);
  });

  it('marks only the current section active, including detail pages', () => {
    expect(ministryLinkActive('/en/serve', '/en/serve/gifts')).toBe(false);
    expect(ministryLinkActive('/en/serve/plans', '/en/serve/plans/9')).toBe(true);
    expect(ministryLinkActive('/en/serve/plans', '/en/serve/plans-extra')).toBe(false);
    expect(ministryLinkActive('/en/manage', '/en/manage/ministries/1')).toBe(true);
  });

  it('supplies English presentation copy without changing user identities', () => {
    expect(JSON.stringify(ministryCopy('en'))).not.toMatch(/\p{Script=Han}/u);
    expect(Object.keys(ministryCopy('zh'))).toEqual(Object.keys(ministryCopy('en')));
    expect(member.displayName).toBe('王明');
  });
});
