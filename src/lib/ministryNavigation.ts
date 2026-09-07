import { hasAreaAccess } from './adminAreas';
import { ministryCopy } from '../i18n/designMinistry';
import { localePath, type Locale } from './locales';
import { moduleForPath } from './modules';
import { canAccess, classifyRoute } from './routePolicy';
import type { SessionUser } from './types';

export type MinistryAudience = 'public' | 'serving' | 'leader';
export interface MinistryLink { key: string; href: string; label: string; icon: string }

/** Contextual shortcuts only. Resource authorization remains in each route. */
export function ministryNavigation(modules: ReadonlySet<string>, locale: Locale, user: SessionUser | null, audience: MinistryAudience): MinistryLink[] {
  const copy = ministryCopy(locale);
  const links = audience === 'public'
    ? [
      { key: 'overview', path: '/serve', label: copy.overview, icon: 'serve' },
      { key: 'opportunities', path: '/serve/opportunities', label: copy.opportunities, icon: 'leaf' },
      { key: 'gifts', path: '/serve/gifts', label: copy.gifts, icon: 'leaf' },
      { key: 'stories', path: '/serve/testimonies', label: copy.stories, icon: 'book' },
    ]
    : [
      { key: 'plans', path: '/serve/plans', label: copy.plans, icon: 'calendar' },
      { key: 'matrix', path: '/serve/matrix', label: copy.matrix, icon: 'calendar' },
      { key: 'teams', path: '/serve/teams', label: copy.teams, icon: 'people' },
      ...(audience === 'leader' || (user && (user.leaderTeamIds.length > 0 || hasAreaAccess(user, 'serve')))
        ? [{ key: 'manage', path: '/manage', label: copy.manage, icon: 'leaf' }] : []),
    ];
  return links.filter(({ path }) => {
    const owner = moduleForPath(path);
    return (owner === null || modules.has(owner)) && canAccess(classifyRoute(path), user);
  }).map(({ path, ...link }) => ({ ...link, href: localePath(locale, path) }));
}

export function ministryLinkActive(href: string, pathname: string): boolean {
  const path = pathname.replace(/\/$/, '');
  return path === href || (!/^\/(en|zh)\/serve$/.test(href) && path.startsWith(`${href}/`));
}
