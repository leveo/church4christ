// Route authorization policy, isolated from the Astro/CF middleware so it stays
// pure and unit-testable. `classifyRoute` takes a pathname with the locale prefix
// ALREADY stripped (the middleware does that via pathWithoutLocale) and buckets
// it into the minimum access class; `canAccess` decides whether a given user
// clears that class. The only dependency is the SessionUser type. Adapted from
// dcfc-serve/src/lib/routePolicy.ts to the plan's five-class model.
import type { SessionUser } from './types';

export type RouteClass = 'public' | 'authed' | 'team' | 'console' | 'adminOnly';

// Exact-match public paths (no session). Prefix families live in PUBLIC_PREFIXES.
const PUBLIC_EXACT = new Set([
  '/',
  '/visit',
  '/events',
  '/give',
  '/privacy',
  '/serve',
  '/serve/gifts',
  '/serve/apply',
  '/serve/testimonies',
  '/signin',
  '/api/prayer-request',
  '/healthz',
  '/404',
]);

// Public path families (the plan's `/about*`, `/sermons*`, …). Matched as raw
// string prefixes so `/bulletin*` covers both `/bulletin` and `/bulletins/<date>`.
// The token routes carry a trailing slash since they are always `/auth/<token>`.
const PUBLIC_PREFIXES = [
  '/about',
  '/articles',
  '/fellowships',
  '/ministries',
  '/sermons',
  '/bulletin',
  '/prayer',
  '/auth/',
  '/respond/',
  '/cal/',
  '/media/',
];

// Site-admin-only areas under /admin. Checked BEFORE the /admin console catch-all.
const ADMIN_ONLY = ['/admin/people', '/admin/service-types', '/admin/settings', '/admin/reports', '/admin/teams'];

/** Strip a single trailing slash (but keep the bare root `/`). */
function norm(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** True when `p` equals `base` or is a sub-path (`base/...`). */
function under(p: string, base: string): boolean {
  return p === base || p.startsWith(base + '/');
}

function isPublic(p: string): boolean {
  if (PUBLIC_EXACT.has(p)) return true;
  return PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Classify a locale-stripped pathname into the access it requires. Order matters:
 * the admin-only areas are tested before the /admin console catch-all, and the
 * team scheduling consoles before the public `/serve` exact match. Any /admin
 * path not explicitly admin-only falls to `console` (never below), and every
 * other unknown path defaults to `authed` — fail safe, never accidentally public.
 */
export function classifyRoute(pathname: string): RouteClass {
  const p = norm(pathname);

  // Admin: site-admin-only areas first, then the console catch-all.
  if (ADMIN_ONLY.some((base) => under(p, base))) return 'adminOnly';
  if (under(p, '/admin')) return 'console';

  // Team: serving consoles and a specific person's profile (`/profile/<id>`).
  if (p.startsWith('/serve/plans') || p.startsWith('/serve/matrix') || p.startsWith('/serve/teams')) return 'team';
  if (p.startsWith('/profile/')) return 'team';

  if (isPublic(p)) return 'public';

  // Authed: personal areas.
  if (p.startsWith('/my')) return 'authed';
  if (p === '/profile') return 'authed';
  if (p.startsWith('/settings/')) return 'authed';

  return 'authed';
}

/** Whether `user` (null = anonymous) may access a route of the given class. */
export function canAccess(cls: RouteClass, user: SessionUser | null): boolean {
  switch (cls) {
    case 'public':
      return true;
    case 'authed':
      return user !== null;
    case 'team':
      return user !== null && (user.isAdmin || user.memberTeamIds.length > 0 || user.leaderTeamIds.length > 0);
    case 'console':
      return user !== null && (user.isAdmin || user.isEditor || user.leaderTeamIds.length > 0);
    case 'adminOnly':
      return user?.isAdmin ?? false;
  }
}
