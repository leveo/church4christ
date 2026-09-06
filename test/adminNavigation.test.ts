import { describe, expect, it } from 'vitest';
import { groupAdminLinks, isNavigationActive } from '../src/lib/adminNavigation';

describe('contextual admin navigation', () => {
  it('groups all authorized destinations once in stable task order', () => {
    const links = [
      { href: '/admin/settings', label: 'Settings' },
      { href: '/admin/people', label: 'People' },
      { href: '/admin/bulletins', label: 'Bulletins' },
      { href: '/admin/prayer-wall', label: 'Prayer Wall' },
      { href: '/admin/teams', label: 'Teams' },
      { href: '/admin/giving', label: 'Giving' },
    ];
    const groups = groupAdminLinks(links, 'en');
    expect(groups.map(g => g.key)).toEqual(['content', 'care', 'ministry', 'operations', 'system']);
    expect(groups.find(g => g.key === 'care')?.links).toEqual([links[1], links[3]]);
    expect(groups.flatMap(g => g.links)).toHaveLength(links.length);
  });
  it('never invents destinations beyond the authorized input and removes empty groups', () => {
    expect(groupAdminLinks([], 'en')).toEqual([]);
    expect(groupAdminLinks([{ href: '/admin/newcomers', label: 'Newcomers' }], 'en'))
      .toEqual([{ key: 'care', label: 'People & Care', icon: 'people', links: [{ href: '/admin/newcomers', label: 'Newcomers' }] }]);
  });
  it('localizes categories and keeps the English shell entirely English', () => {
    const links = [{ href: '/admin', label: 'Dashboard' }, { href: '/admin/groups', label: 'Groups' }];
    expect(groupAdminLinks(links, 'zh').map(g => g.label)).toEqual(['工作台', '事工协作']);
    expect(JSON.stringify(groupAdminLinks(links, 'en'))).not.toMatch(/\p{Script=Han}/u);
  });
  it('activates descendants on path boundaries without prefix collisions', () => {
    expect(isNavigationActive('/admin/people/42', '/admin/people')).toBe(true);
    expect(isNavigationActive('/admin/people/', '/admin/people')).toBe(true);
    expect(isNavigationActive('/admin/people-extra', '/admin/people')).toBe(false);
    expect(isNavigationActive('/admin/people', '/admin')).toBe(false);
    expect(isNavigationActive('/admin', '/admin')).toBe(true);
  });
});
