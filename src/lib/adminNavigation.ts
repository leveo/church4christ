import type { Locale } from './locales';
import { t } from './i18n';

export interface AdminLink { href: string; label: string }
export type AdminGroupKey = 'workspace' | 'content' | 'care' | 'ministry' | 'operations' | 'system';
export interface AdminNavGroup {
  key: AdminGroupKey;
  label: string;
  icon: string;
  links: AdminLink[];
}
const GROUPS: readonly { key: AdminGroupKey; icon: string; routes: readonly string[] }[] = [
  { key: 'workspace', icon: 'home', routes: ['/admin'] },
  { key: 'content', icon: 'book', routes: ['/admin/bulletins', '/admin/sermons', '/admin/prayer-sheets', '/admin/testimonies', '/admin/pages', '/admin/announcements', '/admin/events'] },
  { key: 'care', icon: 'people', routes: ['/admin/people', '/admin/newcomers', '/admin/prayer-wall'] },
  { key: 'ministry', icon: 'serve', routes: ['/admin/community', '/admin/workflows', '/admin/groups', '/admin/ministries', '/admin/teams', '/admin/service-types', '/admin/learning', '/admin/reports'] },
  { key: 'operations', icon: 'chart', routes: ['/admin/children', '/admin/attendance', '/admin/activity-score', '/admin/giving', '/admin/registration', '/admin/stripe-events'] },
  { key: 'system', icon: 'settings', routes: ['/admin/settings', '/admin/navigation', '/admin/campuses', '/admin/onboarding'] },
];

export function isNavigationActive(current: string, href: string): boolean {
  const path = current.replace(/\/+$/, '') || '/';
  return path === href || (href !== '/admin' && path.startsWith(`${href}/`));
}

/** Presentation only: callers pass already authorized, module-filtered links.
 * Never add links here, so a new grouping cannot widen anyone's permissions. */
export function groupAdminLinks(links: readonly AdminLink[], locale: Locale): AdminNavGroup[] {
  return GROUPS.flatMap(group => {
    const grouped = links.filter(link => {
      const owner = GROUPS.find(candidate => candidate.routes.some(route => isNavigationActive(link.href, route)));
      return (owner?.key ?? 'system') === group.key;
    });
    return grouped.length ? [{ key: group.key, icon: group.icon, label: t(locale, `design.nav.${group.key}`), links: grouped }] : [];
  });
}
