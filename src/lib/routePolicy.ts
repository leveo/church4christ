// Route authorization policy, isolated from the Astro/CF middleware so it stays
// pure and unit-testable. `classifyRoute` takes a pathname with the locale prefix
// ALREADY stripped (the middleware does that via pathWithoutLocale) and buckets
// it into the minimum access class; `canAccess` decides whether a given user
// clears that class. The only dependency is the SessionUser type.
//
// Fallback model (namespace-scoped fail-closed hybrid): explicit classifications
// come first; a path matching nothing explicit is then judged by its namespace.
// Protected namespaces fail CLOSED — an unknown /admin path is adminOnly (the
// strictest tier), unknown /my|/profile|/settings paths are authed, unknown
// /serve paths are team — so a typo or not-yet-built page in a private area
// never leaks below its tier. Every OTHER unknown path is public: this is a
// public church website, and a mistyped URL (/sermon, /abut) must fall through
// to Astro's natural 404 for anonymous visitors, not bounce them to signin.
import type { SessionUser } from './types';

export type RouteClass = 'public' | 'authed' | 'team' | 'finance' | 'console' | 'adminOnly';

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
  '/serve/opportunities',
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
  // The email-change confirm page is gated by the token in the URL, not a
  // session — the epoch bump on confirm has already revoked the member's
  // session, so they land here signed out. Mirrors /auth and /respond.
  '/email-change/',
  '/cal/',
  '/media/',
  // Giving: the public give sub-pages (`/give/thanks`, `/give/checkout`) and the
  // giving API (checkout/portal). Anonymous donors may give, so these need no
  // session; the giving admin lives under /admin/giving (the `finance` class).
  '/give/',
  '/api/giving',
  // The shared Stripe webhook — verified by signature, not by session; it is
  // owned by no module, so the middleware never module-gates it (the endpoint
  // does its own giving||registration check).
  '/api/stripe/webhook',
  // Registration lands its public prefixes now (Phase 3 builds the pages) so the
  // policy is not re-touched later; harmless while the module is disabled.
  '/register',
  '/api/register',
  // Groups: the public directory/detail pages, self-service signup, and the
  // token-authed attendance page all do their own in-page auth (private group
  // detail/manage 404s non-members itself), so none of these need a session.
  '/groups',
  '/signup',
  '/attendance',
  // The children's check-in kiosk: no session, gated by the token in the URL
  // itself (/kiosk/<token>), not by the route policy.
  '/kiosk',
];

// Site-admin-only areas under /admin. Checked BEFORE the console list.
const ADMIN_ONLY = [
  '/admin/people',
  '/admin/service-types',
  '/admin/settings',
  '/admin/reports',
  '/admin/teams',
  '/admin/navigation',
  // Group admins manage their own group at /groups/<id>/manage (in-page auth);
  // /admin/groups is the site-admin CRUD console, so it stays adminOnly.
  '/admin/groups',
  '/admin/children',
];

// Console areas under /admin (editor ∪ admin ∪ leader; pages enforce finer).
// Any /admin path in NEITHER list fails closed to adminOnly.
const ADMIN_CONSOLE = [
  '/admin/bulletins',
  '/admin/sermons',
  '/admin/prayer-sheets',
  '/admin/announcements',
  '/admin/events',
  '/admin/pages',
  '/admin/prayer-wall',
  '/admin/revisions',
  '/admin/ministries',
  '/admin/availability',
  '/admin/applications',
  '/admin/testimonies',
  // Registration admin: editors run events, so the whole /admin/registration tree
  // is console (editor ∪ admin ∪ leader), not adminOnly. The module gate (off by
  // default) still 404s it when registration is disabled.
  '/admin/registration',
];

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
 * Classify a locale-stripped pathname into the access it requires. Explicit
 * rules first (admin-only areas before the console list; the team scheduling
 * consoles and `/profile/<id>` before the public `/serve` and authed `/profile`
 * exact matches), then the namespace fallbacks: unknown /admin → adminOnly,
 * unknown /my|/profile|/settings → authed, unknown /serve → team, and anything
 * else → public so it reaches the natural 404. See the module comment.
 */
export function classifyRoute(pathname: string): RouteClass {
  const p = norm(pathname);

  // /admin namespace: the finance area (giving admin) first — a finance-flagged
  // user reaches it without full site-admin — then admin-only areas, then the
  // console root + explicit console list, then fail closed (an unlisted /admin
  // path is adminOnly, never weaker).
  if (under(p, '/admin/giving') || under(p, '/admin/stripe-events')) return 'finance';
  if (ADMIN_ONLY.some((base) => under(p, base))) return 'adminOnly';
  if (p === '/admin' || ADMIN_CONSOLE.some((base) => under(p, base))) return 'console';
  if (under(p, '/admin')) return 'adminOnly';

  // Team: serving consoles and a specific person's profile (`/profile/<id>`).
  if (p.startsWith('/serve/plans') || p.startsWith('/serve/matrix') || p.startsWith('/serve/teams')) return 'team';
  if (p.startsWith('/profile/')) return 'team';

  if (isPublic(p)) return 'public';

  // Protected namespaces fail closed on unknown sub-paths. `under` is
  // segment-aware, so /mystery or /serveware do NOT match /my or /serve.
  if (under(p, '/my')) return 'authed';
  if (p === '/profile') return 'authed';
  if (under(p, '/settings')) return 'authed';
  if (under(p, '/serve')) return 'team';

  // Everything else fails open: anonymous typo URLs get the real 404 page.
  return 'public';
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
    case 'finance':
      return user !== null && (user.isAdmin || user.finance === 1);
    case 'console':
      return user !== null && (user.isAdmin || user.isEditor || user.leaderTeamIds.length > 0);
    case 'adminOnly':
      return user?.isAdmin ?? false;
  }
}
