import { describe, expect, it } from 'vitest';
import { memberNavigation } from '../src/lib/memberNavigation';
import { moduleForPath } from '../src/lib/modules';

describe('member navigation', () => {
  it('has a profile destination even without optional modules', () => {
    expect(memberNavigation(new Set(), 'en').map(link => link.key)).toEqual(['profile']);
  });
  it('does not send portal-only members to serving routes', () => {
    const links = memberNavigation(new Set(['portal']), 'en');
    expect(links.map(link => link.key)).toContain('opportunities');
    expect(links.map(link => link.key)).not.toContain('dashboard');
    expect(links.map(link => link.key)).not.toContain('calendar');
    expect(links.map(link => link.key)).not.toContain('blockouts');
  });
  it('provides only destinations whose owning module is enabled', () => {
    for (const keys of [[], ['serve'], ['learning'], ['portal'], ['portal', 'registration', 'serve', 'groups', 'giving', 'learning']]) {
      const enabled = new Set(keys);
      for (const link of memberNavigation(enabled, 'en')) {
        const owner = moduleForPath(link.href.replace(/^\/en/, ''));
        expect(owner === null || enabled.has(owner), `${keys}: ${link.href}`).toBe(true);
      }
    }
  });
  it('localizes labels and links with no duplicate destinations', () => {
    const modules = new Set(['portal', 'registration', 'serve', 'groups', 'giving', 'learning']);
    const en = memberNavigation(modules, 'en');
    const zh = memberNavigation(modules, 'zh');
    expect(en.some(link => link.key === 'learning')).toBe(true);
    expect(new Set(en.map(link => link.href)).size).toBe(en.length);
    expect(en.every(link => link.href.startsWith('/en/') && !/\p{Script=Han}/u.test(link.label))).toBe(true);
    expect(zh.every(link => link.href.startsWith('/zh/'))).toBe(true);
    expect(zh.map(link => link.label)).not.toEqual(en.map(link => link.label));
  });
});
