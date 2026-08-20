import type { GrantableArea } from './adminAreas';
import { parseAdminAreasForRole } from './adminAreas';
import type { AppDb } from './appDb';
import { MODULE_KEYS } from './modules';

export type CampusRole = 'member' | 'editor' | 'admin';
export const CAMPUS_COOKIE = 'c4c_campus';

export interface CampusRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  isDefault: number;
}

export interface CampusMembership {
  campusId: number;
  personId: number;
  role: CampusRole;
  finance: number;
  adminAreas: GrantableArea[];
  active: number;
}

export interface CampusMembershipRow extends CampusMembership {
  displayName: string;
  email: string;
}

export interface CampusContext {
  mode: 'all' | 'campus';
  campus: CampusRow | null;
  membership: CampusMembership | null;
}

export async function listCampusesForUser(
  db: AppDb,
  personId: number,
  isMasterAdmin: boolean,
): Promise<CampusRow[]> {
  const sql = isMasterAdmin
    ? `SELECT id, slug, name, active, is_default FROM campuses ORDER BY id`
    : `SELECT c.id, c.slug, c.name, c.active, c.is_default
       FROM campuses c
       JOIN campus_memberships cm ON cm.campus_id = c.id
       WHERE cm.person_id = ?1 AND cm.active = 1 AND c.active = 1
       ORDER BY c.is_default DESC, c.id`;
  const { results } = await db
    .prepare(sql)
    .bind(...(isMasterAdmin ? [] : [personId]))
    .all<CampusDbRow>();
  return results.map(toCampusRow);
}

export async function resolveCampusContext(
  db: AppDb,
  requestedSlug: string | null,
  user: { personId: number; isMasterAdmin: boolean } | null,
): Promise<CampusContext | null> {
  const slug = requestedSlug?.trim().toLowerCase() || null;
  if (slug === 'all') {
    return user?.isMasterAdmin ? { mode: 'all', campus: null, membership: null } : null;
  }
  if (!slug && user?.isMasterAdmin) {
    return { mode: 'all', campus: null, membership: null };
  }

  const campus = slug
    ? await db.prepare(
        `SELECT id, slug, name, active, is_default FROM campuses
         WHERE slug = ?1 AND active = 1`,
      ).bind(slug).first<CampusDbRow>()
    : user
      ? await db.prepare(
          `SELECT c.id, c.slug, c.name, c.active, c.is_default
           FROM campuses c
           JOIN campus_memberships cm ON cm.campus_id = c.id
           WHERE cm.person_id = ?1 AND cm.active = 1 AND c.active = 1
           ORDER BY c.is_default DESC, c.id LIMIT 1`,
        ).bind(user.personId).first<CampusDbRow>()
      : await db.prepare(
          `SELECT id, slug, name, active, is_default FROM campuses
           WHERE active = 1 ORDER BY is_default DESC, id LIMIT 1`,
        ).first<CampusDbRow>();
  if (!campus) return null;

  if (!user || user.isMasterAdmin) {
    return { mode: 'campus', campus: toCampusRow(campus), membership: null };
  }
  const membership = await db.prepare(
    `SELECT campus_id, person_id, role, finance, admin_areas, active
     FROM campus_memberships
     WHERE campus_id = ?1 AND person_id = ?2 AND active = 1`,
  ).bind(campus.id, user.personId).first<MembershipDbRow>();
  if (!membership) return null;
  return {
    mode: 'campus',
    campus: toCampusRow(campus),
    membership: toMembership(membership),
  };
}

export async function createCampus(
  db: AppDb,
  input: { name: string; slug: string },
): Promise<CampusRow> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name || name.length > 120) throw new Error('invalid_campus_name');
  if (slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('invalid_campus_slug');
  }
  const row = await db.prepare(
    `INSERT INTO campuses (slug, name) VALUES (?1, ?2)
     RETURNING id, slug, name, active, is_default`,
  ).bind(slug, name).first<CampusDbRow>();
  if (!row) throw new Error('campus_create_failed');
  return toCampusRow(row);
}

export async function upsertCampusMembership(
  db: AppDb,
  input: {
    campusId: number;
    personId: number;
    role: CampusRole;
    finance: boolean;
    adminAreas: string[];
    active: boolean;
  },
): Promise<void> {
  const areas = parseAdminAreasForRole(input.adminAreas.join(','), input.role).join(',');
  await db.prepare(
    `INSERT INTO campus_memberships
       (campus_id, person_id, role, finance, admin_areas, active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(campus_id, person_id) DO UPDATE SET
       role = excluded.role,
       finance = excluded.finance,
       admin_areas = excluded.admin_areas,
       active = excluded.active,
       updated_at = datetime('now')`,
  ).bind(
    input.campusId,
    input.personId,
    input.role,
    input.finance ? 1 : 0,
    areas,
    input.active ? 1 : 0,
  ).run();
}

export async function listCampusMemberships(
  db: AppDb,
  campusId: number,
): Promise<CampusMembershipRow[]> {
  const { results } = await db.prepare(
    `SELECT cm.campus_id, cm.person_id, cm.role, cm.finance, cm.admin_areas, cm.active,
            p.display_name, p.email
     FROM campus_memberships cm
     JOIN people p ON p.id = cm.person_id AND p.deleted_at IS NULL
     WHERE cm.campus_id = ?1
     ORDER BY p.display_name, p.id`,
  ).bind(campusId).all<MembershipDbRow & { display_name: string; email: string }>();
  return results.map((row) => ({
    ...toMembership(row),
    displayName: row.display_name,
    email: row.email,
  }));
}

export async function setCampusModules(
  db: AppDb,
  campusId: number,
  enabled: ReadonlySet<string>,
): Promise<void> {
  for (const key of enabled) {
    if (!(MODULE_KEYS as readonly string[]).includes(key)) throw new Error('invalid_campus_module');
  }
  await db.batch(MODULE_KEYS.map((key) => db.prepare(
    `INSERT INTO campus_modules (campus_id, module_key, enabled)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(campus_id, module_key) DO UPDATE SET
       enabled = excluded.enabled, updated_at = datetime('now')`,
  ).bind(campusId, key, enabled.has(key) ? 1 : 0)));
}

export async function getCampusModules(db: AppDb, campusId: number): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT module_key FROM campus_modules WHERE campus_id = ?1 AND enabled = 1`,
  ).bind(campusId).all<{ module_key: string }>();
  return new Set(results
    .map(({ module_key }) => module_key)
    .filter((key) => (MODULE_KEYS as readonly string[]).includes(key)));
}

/** Campus overrides may only narrow the globally/backend-enabled module set. */
export async function getEffectiveCampusModules(
  db: AppDb,
  campusId: number,
  globallyEnabled: ReadonlySet<string>,
): Promise<Set<string>> {
  const { results } = await db.prepare(
    `SELECT module_key, enabled FROM campus_modules WHERE campus_id = ?1`,
  ).bind(campusId).all<{ module_key: string; enabled: number }>();
  if (results.length === 0) return new Set(globallyEnabled);
  return new Set(results
    .filter(({ module_key, enabled }) => (
      enabled === 1
      && globallyEnabled.has(module_key)
      && (MODULE_KEYS as readonly string[]).includes(module_key)
    ))
    .map(({ module_key }) => module_key));
}

interface CampusDbRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  is_default: number;
}

interface MembershipDbRow {
  campus_id: number;
  person_id: number;
  role: CampusRole;
  finance: number;
  admin_areas: string;
  active: number;
}

function toCampusRow(row: CampusDbRow): CampusRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    active: row.active,
    isDefault: row.is_default,
  };
}

function toMembership(row: MembershipDbRow): CampusMembership {
  return {
    campusId: row.campus_id,
    personId: row.person_id,
    role: row.role,
    finance: row.finance,
    adminAreas: parseAdminAreasForRole(row.admin_areas, row.role),
    active: row.active,
  };
}
