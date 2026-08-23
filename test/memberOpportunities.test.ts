import { describe, expect, it } from 'vitest';
import { buildMemberOpportunityCatalog } from '../src/lib/memberOpportunities';

const input = () => ({
  modules: new Set(['portal', 'groups', 'serve', 'learning']),
  publicGroups: [
    { id: 1, name: 'Genesis', description: '', kind: 'sunday_school' as const },
    { id: 2, name: 'Young Adults', description: '', kind: 'fellowship' as const },
    { id: 3, name: 'Families', description: '', kind: 'fellowship' as const },
  ],
  groupMemberships: [
    { id: 1, name: 'Genesis', description: '', kind: 'sunday_school' as const, is_admin: 0 },
  ],
  pendingGroupIds: [2],
  courses: [
    { courseId: 7, displayName: 'Bible Foundations', programName: 'Discipleship' },
  ],
  applicationTeams: [
    { team_id: 10, team_name: 'Worship', ministry_name: 'Sunday Service', positions: ['Vocalist'] },
    { team_id: 11, team_name: 'Welcome', ministry_name: 'Hospitality', positions: ['Greeter'] },
    { team_id: 12, team_name: 'Media', ministry_name: 'Sunday Service', positions: ['Slides'] },
  ],
  teamMemberships: [{ team_id: 10, name: 'Worship', is_leader: 1 }],
  applications: [
    { team_id: 11, team_name: 'Welcome', position_name: 'Greeter', status: 'P' as const },
    { team_id: 12, team_name: 'Media', position_name: null, status: 'R' as const },
    // Rows arrive newest first. The latest rejection means the person may
    // re-apply; an older approval must not hide that open team.
    { team_id: 12, team_name: 'Media', position_name: 'Slides', status: 'A' as const },
  ],
});

describe('buildMemberOpportunityCatalog', () => {
  it('puts joined, enrolled, led, and pending opportunities in the current list', () => {
    const catalog = buildMemberOpportunityCatalog(input());

    expect(catalog.current.map((item) => [item.kind, item.id, item.state])).toEqual([
      ['sunday_school', 1, 'joined'],
      ['group', 2, 'pending'],
      ['course', 7, 'enrolled'],
      ['team', 10, 'leader'],
      ['team', 11, 'pending'],
    ]);
  });

  it('keeps only joinable or re-applicable items in the open list', () => {
    const catalog = buildMemberOpportunityCatalog(input());

    expect(catalog.open.map((item) => [item.kind, item.id, item.state])).toEqual([
      ['group', 3, 'open'],
      ['team', 12, 'open'],
    ]);
  });

  it('omits data from disabled modules and returns nothing without the portal', () => {
    const groupsOnly = input();
    groupsOnly.modules = new Set(['portal', 'groups']);
    expect(buildMemberOpportunityCatalog(groupsOnly).current.map((item) => item.kind)).toEqual([
      'sunday_school',
      'group',
    ]);
    expect(buildMemberOpportunityCatalog(groupsOnly).open.map((item) => item.kind)).toEqual(['group']);

    const noPortal = input();
    noPortal.modules.delete('portal');
    expect(buildMemberOpportunityCatalog(noPortal)).toEqual({ current: [], open: [] });
  });
});
