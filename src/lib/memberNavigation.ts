import { localePath, type Locale } from './locales';
import { t } from './i18n';
import { moduleForPath } from './modules';

export type MemberNavKey = 'workflows' | 'dashboard' | 'opportunities' | 'household' | 'giving' | 'groups' | 'events' | 'serving' | 'calendar' | 'prayer' | 'learning' | 'blockouts' | 'profile' | 'security';
export interface MemberNavLink { key: MemberNavKey; href: string; label: string; icon: string }
export function memberNavigation(modules: ReadonlySet<string>, locale: Locale): MemberNavLink[] {
  const candidates: { key: MemberNavKey; path: string; label: string; icon: string; requires?: string[] }[] = [
    { key: 'dashboard', path: '/my', label: 'portal.nav.dashboard', icon: 'home' },
    { key: 'opportunities', path: '/my/opportunities', label: 'portal.nav.opportunities', icon: 'leaf' },
    { key: 'household', path: '/my/household', label: 'portal.nav.household', icon: 'people' },
    { key: 'calendar', path: '/my/calendar', label: 'portal.nav.calendar', icon: 'calendar' },
    { key: 'serving', path: '/my/serving', label: 'portal.nav.serving', icon: 'serve', requires: ['serve'] },
    { key: 'workflows', path: '/my/workflows', label: 'My follow-up tasks', icon: 'calendar', requires: ['groups'] },
    { key: 'groups', path: '/groups', label: 'portal.nav.groups', icon: 'people' },
    { key: 'learning', path: '/learn', label: 'learning.title', icon: 'book' },
    { key: 'events', path: '/my/events', label: 'portal.nav.events', icon: 'calendar', requires: ['registration'] },
    { key: 'prayer', path: '/my/prayer', label: 'portal.nav.prayer', icon: 'leaf' },
    { key: 'giving', path: '/my/giving', label: 'portal.nav.giving', icon: 'serve' },
    { key: 'blockouts', path: '/my/blockouts', label: 'my.blockouts', icon: 'calendar' },
    { key: 'profile', path: '/profile', label: 'profile.title', icon: 'settings' },
    { key: 'security', path: '/settings/security', label: 'security.title', icon: 'lock' },
  ];
  return candidates.filter(({ path, requires = [] }) => {
    const owner = moduleForPath(path);
    return (owner === null || modules.has(owner)) && requires.every(key => modules.has(key));
  }).map(({ key, path, label, icon }) => ({ key, href: localePath(locale, path), label: key === 'workflows' ? label : t(locale, label), icon }));
}
