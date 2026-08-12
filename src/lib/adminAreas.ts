// Per-person area grants (design specs 2026-07-10 and 2026-08-11) — the third authorization axis,
// distinct from the church-wide module toggles (src/lib/modules.ts) and the role
// classes (src/lib/routePolicy.ts). An "area" is the unit a super admin grants to
// an admin or narrowly scoped staff member. Where an area matches a ModuleKey it
// reuses the same string so the church-wide toggle (404, pre-session) and the grant (403,
// post-session) compose without translation. Pure and unit-tested; the middleware
// is the enforcement choke point, pages re-check inline per house convention.
import type { SessionUser } from './types';

// Legacy admin-only grants. A non-admin may carry hostile/stale copies in the
// database, but they remain inert and are filtered out of their SessionUser.
export const ADMIN_GRANTABLE_AREAS = [
  'bulletins',
  'sermons',
  'prayer-sheets',
  'testimonies',
  'pages',
  'events',
  'people',
  'groups',
  'children',
  'attendance',
  'giving',
  'registration',
  'payment-operations',
  'serve',
] as const;
export type AdminGrantableArea = (typeof ADMIN_GRANTABLE_AREAS)[number];

// Narrow scoped-staff grants may be assigned without changing a person's role.
// Keep this list deliberately separate so adding an ordinary admin area cannot
// accidentally expand member/editor authority.
export const SCOPED_STAFF_AREAS = ['newcomers'] as const;
export type ScopedStaffArea = (typeof SCOPED_STAFF_AREAS)[number];

// Areas a super admin can persist through the People flags form. prayer-wall
// and people-basic are NOT here: they are always-on for every admin. settings
// (which also covers /admin/navigation) is never grantable — super only.
export const GRANTABLE_AREAS = [...ADMIN_GRANTABLE_AREAS, ...SCOPED_STAFF_AREAS] as const;
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
  ['/admin/newcomers', 'newcomers'],
  // The directory remains a people-basic default, but bulk import is a full
  // people-management capability. Longest-prefix matching keeps the split.
  ['/admin/people/import', 'people'],
  ['/admin/people/export', 'people'],
  ['/admin/people/export.csv', 'people'],
  ['/admin/people/export-notes', 'people'],
  ['/admin/people', 'people-basic'],
  ['/admin/groups', 'groups'],
  ['/admin/children', 'children'],
  ['/admin/attendance', 'attendance'],
  ['/admin/stripe-events', 'payment-operations'],
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

/** Grants a super admin may assign to a target with this application role. */
export function grantableAreasForRole(role: SessionUser['role']): readonly GrantableArea[] {
  return role === 'admin' ? GRANTABLE_AREAS : SCOPED_STAFF_AREAS;
}

/** Parse stored/submitted grants and discard everything illegal for the target role. */
export function parseAdminAreasForRole(
  csv: string | null | undefined,
  role: SessionUser['role'],
): GrantableArea[] {
  const allowed = grantableAreasForRole(role) as readonly string[];
  return parseAdminAreas(csv).filter((area) => allowed.includes(area));
}

/**
 * Whether this user's stored grant covers `area`. Super admins pass everything;
 * `newcomers` is the sole explicit grant honored for a non-admin scoped worker.
 * Every legacy area still requires isAdmin; limited admins retain their two
 * always-on defaults; `settings` remains reserved for super admins.
 */
export function hasAreaAccess(user: SessionUser | null, area: AdminAreaKey): boolean {
  if (!user) return false;
  if (user.isAdmin && user.isSuperAdmin) return true;
  if (area === 'newcomers') return (user.adminAreas as readonly string[]).includes(area);
  if (!user.isAdmin) return false;
  if (area === 'settings') return false;
  if (ALWAYS_AREAS.includes(area)) return true;
  return (user.adminAreas as readonly string[]).includes(area);
}
