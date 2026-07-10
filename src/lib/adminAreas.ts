// Per-ADMIN area grants (design spec 2026-07-10) — the third authorization axis,
// distinct from the church-wide module toggles (src/lib/modules.ts) and the role
// classes (src/lib/routePolicy.ts). An "area" is the unit a super admin grants to
// an individual admin. Where an area matches a ModuleKey it reuses the same string
// so the church-wide toggle (404, pre-session) and the per-admin grant (403,
// post-session) compose without translation. Pure and unit-tested; the middleware
// is the enforcement choke point, pages re-check inline per house convention.
import type { SessionUser } from './types';

// Areas a super admin can grant. prayer-wall and people-basic are NOT here: they
// are always-on for every admin (Leo's default: prayer wall + member basics).
// settings (which also covers /admin/navigation) is never grantable — super only.
export const GRANTABLE_AREAS = [
  'bulletins',
  'sermons',
  'prayer-sheets',
  'testimonies',
  'pages',
  'events',
  'people',
  'groups',
  'children',
  'giving',
  'registration',
  'serve',
] as const;
export type GrantableArea = (typeof GRANTABLE_AREAS)[number];
export type AdminAreaKey = GrantableArea | 'prayer-wall' | 'people-basic' | 'settings';

export const ALWAYS_AREAS: readonly AdminAreaKey[] = ['prayer-wall', 'people-basic'];

// Admin route prefix -> owning area. Longest prefix wins (so the per-entity
// revision editors map to their content area, not a generic revisions bucket).
// A bare/unknown /admin path maps to NO area — the middleware fails closed and
// only super admins pass, mirroring routePolicy's unknown-/admin -> adminOnly.
const AREA_PREFIXES: Array<[string, AdminAreaKey]> = [
  ['/admin/bulletins', 'bulletins'],
  ['/admin/revisions/bulletin', 'bulletins'],
  ['/admin/sermons', 'sermons'],
  ['/admin/revisions/sermon', 'sermons'],
  ['/admin/prayer-sheets', 'prayer-sheets'],
  ['/admin/revisions/prayer_sheet', 'prayer-sheets'],
  ['/admin/testimonies', 'testimonies'],
  ['/admin/pages', 'pages'],
  ['/admin/revisions/custom_page', 'pages'],
  ['/admin/announcements', 'events'],
  ['/admin/events', 'events'],
  ['/admin/revisions/announcement', 'events'],
  ['/admin/revisions/event', 'events'],
  ['/admin/prayer-wall', 'prayer-wall'],
  ['/admin/people', 'people-basic'],
  ['/admin/groups', 'groups'],
  ['/admin/children', 'children'],
  ['/admin/giving', 'giving'],
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
];

/** Segment-aware prefix match (same shape as modules.ts): exact or `prefix/…`. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** The area owning a locale-stripped admin path, or null (dashboard / unknown). */
export function adminAreaForPath(path: string): AdminAreaKey | null {
  let best: [string, AdminAreaKey] | null = null;
  for (const entry of AREA_PREFIXES) {
    if (under(path, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** Comma-separated grant list -> validated, deduped GrantableArea[]. */
export function parseAdminAreas(csv: string | null | undefined): GrantableArea[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: GrantableArea[] = [];
  for (const raw of csv.split(',')) {
    const key = raw.trim();
    if ((GRANTABLE_AREAS as readonly string[]).includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key as GrantableArea);
    }
  }
  return out;
}

/**
 * Whether this user's ADMIN grant covers `area`. Only ever true for admins:
 * editors / leaders / finance-flagged members return false and their callers
 * keep their existing role logic (this layer only narrows admins). Super admins
 * pass everything; limited admins pass the always-on defaults plus their grants;
 * `settings` is reserved for super admins.
 */
export function hasAreaAccess(user: SessionUser | null, area: AdminAreaKey): boolean {
  if (!user || !user.isAdmin) return false;
  if (user.isSuperAdmin) return true;
  if (area === 'settings') return false;
  if (ALWAYS_AREAS.includes(area)) return true;
  return (user.adminAreas as readonly string[]).includes(area);
}
