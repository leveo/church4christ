// Member-groups (fellowships + Sunday School classes) data layer: public/portal
// group listings, admin CRUD, membership, and applications. Group definitions
// (member_groups/member_group_i18n) live in both backends; membership and
// applications (group_members/group_applications) are Supabase-only — reachable
// only when the portal module is on (migrations-supabase/0006_member_portal.sql).
// Patterns mirror teamDb.ts (saveServiceType's i18n-pair upsert;
// createApplication/decideApplication's P/A/R flow), adapted to
// group_applications' shape (no position_id, field is `note`, and — unlike
// team_applications — no partial unique index, so the pending dedupe uses a
// WHERE-NOT-EXISTS guarded INSERT instead of ON CONFLICT).
import type { AppDb } from './appDb';
import { isUniqueViolation } from './adminDb';
import { i18nJoin, type Locale } from './db';

export type GroupKind = 'fellowship' | 'sunday_school';

export interface MemberGroup {
  id: number;
  slug: string;
  kind: GroupKind;
  term_label: string | null;
  term_start: string | null;
  term_end: string | null;
  meeting_weekday: number | null;
  meeting_time: string | null;
  meeting_frequency: 'weekly' | 'biweekly' | 'monthly' | null;
  meeting_location: string | null;
  open_signup: number;
  active: number;
  sort: number;
  name: string; // i18nJoin-coalesced
  description: string | null; // i18nJoin-coalesced
}

const GROUP_COLS = `g.id AS id, g.slug AS slug, g.kind AS kind, g.term_label AS term_label,
              g.term_start AS term_start, g.term_end AS term_end, g.meeting_weekday AS meeting_weekday,
              g.meeting_time AS meeting_time, g.meeting_frequency AS meeting_frequency,
              g.meeting_location AS meeting_location, g.open_signup AS open_signup, g.active AS active,
              g.sort AS sort`;

/** Public/portal list: active, non-deleted, localized. kind filter optional. Portable SQL (runs on D1). */
export async function listGroups(db: AppDb, locale: Locale, opts?: { kind?: GroupKind }): Promise<MemberGroup[]> {
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name', 'description'], locale);
  const kindFilter = opts?.kind ? ' AND g.kind = ?1' : '';
  const { results } = await db
    .prepare(
      `SELECT ${GROUP_COLS}, ${gJ.select}
       FROM member_groups g
       ${gJ.joins}
       WHERE g.active = 1 AND g.deleted_at IS NULL${kindFilter}
       ORDER BY g.sort, g.id`,
    )
    .bind(...(opts?.kind ? [opts.kind] : []))
    .all<MemberGroup>();
  return results;
}

/** Single group by slug (public detail): active, non-deleted, localized. Portable. */
export async function getGroupBySlug(db: AppDb, slug: string, locale: Locale): Promise<MemberGroup | null> {
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name', 'description'], locale);
  return db
    .prepare(
      `SELECT ${GROUP_COLS}, ${gJ.select}
       FROM member_groups g
       ${gJ.joins}
       WHERE g.slug = ? AND g.active = 1 AND g.deleted_at IS NULL`,
    )
    .bind(slug)
    .first<MemberGroup>();
}

/** Single group by id (portal/admin): non-deleted (inactive groups still resolve, for editing). Portable. */
export async function getGroup(db: AppDb, id: number, locale: Locale): Promise<MemberGroup | null> {
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name', 'description'], locale);
  return db
    .prepare(
      `SELECT ${GROUP_COLS}, ${gJ.select}
       FROM member_groups g
       ${gJ.joins}
       WHERE g.id = ? AND g.deleted_at IS NULL`,
    )
    .bind(id)
    .first<MemberGroup>();
}

export interface MemberGroupEditRow {
  id: number;
  slug: string;
  kind: GroupKind;
  term_label: string | null;
  term_start: string | null;
  term_end: string | null;
  meeting_weekday: number | null;
  meeting_time: string | null;
  meeting_frequency: 'weekly' | 'biweekly' | 'monthly' | null;
  meeting_location: string | null;
  open_signup: number;
  active: number;
  sort: number;
  name_en: string;
  name_zh: string | null;
  desc_en: string | null;
  desc_zh: string | null;
}

/** Single non-deleted group (active or inactive, like getGroup) with both locale
 *  names/descriptions, for the admin edit form's en/zh field pairs. */
export async function getGroupAdmin(db: AppDb, id: number): Promise<MemberGroupEditRow | null> {
  return db
    .prepare(
      `SELECT g.id AS id, g.slug AS slug, g.kind AS kind, g.term_label AS term_label,
              g.term_start AS term_start, g.term_end AS term_end, g.meeting_weekday AS meeting_weekday,
              g.meeting_time AS meeting_time, g.meeting_frequency AS meeting_frequency,
              g.meeting_location AS meeting_location, g.open_signup AS open_signup, g.active AS active,
              g.sort AS sort, en.name AS name_en, en.description AS desc_en,
              zh.name AS name_zh, zh.description AS desc_zh
       FROM member_groups g
       LEFT JOIN member_group_i18n en ON en.group_id = g.id AND en.locale = 'en'
       LEFT JOIN member_group_i18n zh ON zh.group_id = g.id AND zh.locale = 'zh'
       WHERE g.id = ? AND g.deleted_at IS NULL`,
    )
    .bind(id)
    .first<MemberGroupEditRow>();
}

export interface MemberGroupAdminRow {
  id: number;
  slug: string;
  kind: GroupKind;
  term_label: string | null;
  meeting_weekday: number | null;
  meeting_time: string | null;
  meeting_frequency: 'weekly' | 'biweekly' | 'monthly' | null;
  meeting_location: string | null;
  open_signup: number;
  active: number;
  sort: number;
  name_en: string;
  name_zh: string | null;
}

/** Non-deleted groups (active + inactive), both locale names, for the admin table.
 *  Mirrors teamDb.ts's listServiceTypesAdmin (hand-rolled en/zh joins so both
 *  names are available separately, unlike the coalesced i18nJoin used by the
 *  public listGroups). */
export async function listGroupsAdmin(db: AppDb): Promise<MemberGroupAdminRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id AS id, g.slug AS slug, g.kind AS kind, g.term_label AS term_label,
              g.meeting_weekday AS meeting_weekday, g.meeting_time AS meeting_time,
              g.meeting_frequency AS meeting_frequency, g.meeting_location AS meeting_location,
              g.open_signup AS open_signup, g.active AS active, g.sort AS sort,
              en.name AS name_en, zh.name AS name_zh
       FROM member_groups g
       LEFT JOIN member_group_i18n en ON en.group_id = g.id AND en.locale = 'en'
       LEFT JOIN member_group_i18n zh ON zh.group_id = g.id AND zh.locale = 'zh'
       WHERE g.deleted_at IS NULL
       ORDER BY g.sort, g.id`,
    )
    .all<MemberGroupAdminRow>();
  return results;
}

export interface GroupInput {
  slug: string;
  kind: GroupKind;
  termLabel: string | null;
  termStart: string | null;
  termEnd: string | null;
  meetingWeekday: number | null;
  meetingTime: string | null;
  meetingFrequency: string | null;
  meetingLocation: string | null;
  openSignup: boolean;
  active: boolean;
  sort: number;
  nameEn: string;
  nameZh: string | null;
  descEn: string | null;
  descZh: string | null;
}

async function upsertGroupI18n(
  db: AppDb,
  id: number,
  locale: Locale,
  name: string,
  description: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO member_group_i18n (group_id, locale, name, description) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(group_id, locale) DO UPDATE SET name = excluded.name, description = excluded.description`,
    )
    .bind(id, locale, name, description)
    .run();
}

/** Admin CRUD (both backends). Create (id null) or update a group + its i18n
 *  names/descriptions (en required; zh only when provided). Returns the id.
 *  Throws 'slug_taken' on unique violation (isUniqueViolation). */
export async function saveGroup(db: AppDb, id: number | null, input: GroupInput): Promise<number> {
  let groupId = id;
  const args = [
    input.slug,
    input.kind,
    input.termLabel,
    input.termStart,
    input.termEnd,
    input.meetingWeekday,
    input.meetingTime,
    input.meetingFrequency,
    input.meetingLocation,
    input.openSignup ? 1 : 0,
    input.active ? 1 : 0,
    input.sort,
  ];
  try {
    if (groupId) {
      await db
        .prepare(
          `UPDATE member_groups SET slug = ?1, kind = ?2, term_label = ?3, term_start = ?4, term_end = ?5,
                  meeting_weekday = ?6, meeting_time = ?7, meeting_frequency = ?8, meeting_location = ?9,
                  open_signup = ?10, active = ?11, sort = ?12, updated_at = datetime('now')
           WHERE id = ?13`,
        )
        .bind(...args, groupId)
        .run();
    } else {
      const row = await db
        .prepare(
          `INSERT INTO member_groups
             (slug, kind, term_label, term_start, term_end, meeting_weekday, meeting_time,
              meeting_frequency, meeting_location, open_signup, active, sort)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id`,
        )
        .bind(...args)
        .first<{ id: number }>();
      groupId = row!.id;
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error('slug_taken');
    throw e;
  }
  await upsertGroupI18n(db, groupId, 'en', input.nameEn, input.descEn);
  if (input.nameZh) await upsertGroupI18n(db, groupId, 'zh', input.nameZh, input.descZh);
  return groupId;
}

export async function softDeleteGroup(db: AppDb, id: number): Promise<void> {
  await db.prepare(`UPDATE member_groups SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
}

// ---- membership (Supabase-only tables; only reachable when portal module on) ----

export interface GroupMemberRow {
  id: number;
  person_id: number;
  is_leader: number;
  joined_at: string;
  display_name: string;
}

/** A group's roster (leaders first), excluding inactive/soft-deleted people. */
export async function listGroupMembers(db: AppDb, groupId: number): Promise<GroupMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT gm.id AS id, gm.person_id AS person_id, gm.is_leader AS is_leader, gm.joined_at AS joined_at,
              COALESCE(people.display_name, people.first_name || ' ' || people.last_name) AS display_name
       FROM group_members gm
       JOIN people ON people.id = gm.person_id AND people.active = 1 AND people.deleted_at IS NULL
       WHERE gm.group_id = ?
       ORDER BY gm.is_leader DESC, display_name`,
    )
    .bind(groupId)
    .all<GroupMemberRow>();
  return results;
}

/** Groups a person belongs to (any group status except deleted), localized, with their leader flag. */
export async function listMyGroups(
  db: AppDb,
  personId: number,
  locale: Locale,
): Promise<(MemberGroup & { is_leader: number })[]> {
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name', 'description'], locale);
  const { results } = await db
    .prepare(
      `SELECT ${GROUP_COLS}, ${gJ.select}, gm.is_leader AS is_leader
       FROM group_members gm
       JOIN member_groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
       ${gJ.joins}
       WHERE gm.person_id = ?
       ORDER BY g.sort, g.id`,
    )
    .bind(personId)
    .all<MemberGroup & { is_leader: number }>();
  return results;
}

export async function isGroupMember(db: AppDb, groupId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM group_members WHERE group_id = ? AND person_id = ?`)
    .bind(groupId, personId)
    .first<{ x: number }>();
  return row !== null;
}

export async function isGroupLeader(db: AppDb, groupId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM group_members WHERE group_id = ? AND person_id = ? AND is_leader = 1`)
    .bind(groupId, personId)
    .first<{ x: number }>();
  return row !== null;
}

/** Admin member management. Idempotent add (UNIQUE(group_id, person_id); an existing row is left as-is). */
export async function addGroupMember(
  db: AppDb,
  groupId: number,
  personId: number,
  isLeader = false,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO group_members (group_id, person_id, is_leader) VALUES (?, ?, ?)
       ON CONFLICT(group_id, person_id) DO NOTHING`,
    )
    .bind(groupId, personId, isLeader ? 1 : 0)
    .run();
}

/** Flip a member's leader flag. */
export async function setGroupLeader(db: AppDb, groupId: number, personId: number, isLeader: boolean): Promise<void> {
  await db
    .prepare(`UPDATE group_members SET is_leader = ? WHERE group_id = ? AND person_id = ?`)
    .bind(isLeader ? 1 : 0, groupId, personId)
    .run();
}

/** Hard-delete a membership row (group_members has no soft-delete column). */
export async function removeGroupMember(db: AppDb, groupId: number, personId: number): Promise<void> {
  await db.prepare(`DELETE FROM group_members WHERE group_id = ? AND person_id = ?`).bind(groupId, personId).run();
}

// ---- applications (pattern: teamDb.ts createApplication/decideApplication, but no position_id, field is `note`) ----

/** True when the person already has a PENDING application for this group. */
export async function hasPendingGroupApplication(db: AppDb, personId: number, groupId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM group_applications WHERE person_id = ? AND group_id = ? AND status = 'P'`)
    .bind(personId, groupId)
    .first<{ x: number }>();
  return row !== null;
}

/**
 * Apply to join a group. Rejects with 'closed' when the group is missing,
 * soft-deleted, inactive, or not open for signup; 'already_member' when the
 * person is already a member. group_applications carries no partial unique
 * index (unlike team_applications), so the pending dedupe is a WHERE-NOT-EXISTS
 * guarded INSERT ... SELECT: a concurrent duplicate pending application is a
 * silent no-op (returns null) instead of a 500/unique-violation. A re-apply
 * after a prior application was decided (status != 'P') is allowed and creates
 * a new pending row.
 */
export async function applyToGroup(
  db: AppDb,
  personId: number,
  groupId: number,
  note: string | null,
): Promise<number | null> {
  const group = await db
    .prepare(`SELECT active, open_signup, deleted_at FROM member_groups WHERE id = ?`)
    .bind(groupId)
    .first<{ active: number; open_signup: number; deleted_at: string | null }>();
  if (!group || group.deleted_at !== null || group.active !== 1 || group.open_signup !== 1) {
    throw new Error('closed');
  }
  if (await isGroupMember(db, groupId, personId)) throw new Error('already_member');

  const row = await db
    .prepare(
      `INSERT INTO group_applications (group_id, person_id, note)
       SELECT ?1, ?2, ?3
       WHERE NOT EXISTS (
         SELECT 1 FROM group_applications WHERE group_id = ?1 AND person_id = ?2 AND status = 'P'
       )
       RETURNING id`,
    )
    .bind(groupId, personId, note)
    .first<{ id: number }>();
  return row ? row.id : null;
}

export interface GroupApplicationRow {
  id: number;
  group_id: number;
  person_id: number;
  status: string;
  note: string | null;
  created_at: string;
  applicant_name: string;
  applicant_email: string;
  group_name: string;
}

/** Pending applications for the given groups (localized group names), oldest first. */
export async function listPendingApplicationsForGroups(
  db: AppDb,
  groupIds: number[],
  locale: Locale,
): Promise<GroupApplicationRow[]> {
  if (groupIds.length === 0) return [];
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name'], locale);
  const placeholders = groupIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT ga.id AS id, ga.group_id AS group_id, ga.person_id AS person_id, ga.status AS status,
              ga.note AS note, ga.created_at AS created_at,
              people.display_name AS applicant_name, people.email AS applicant_email,
              COALESCE(g_l.name, g_d.name) AS group_name
       FROM group_applications ga
       JOIN people ON people.id = ga.person_id AND people.deleted_at IS NULL
       JOIN member_groups g ON g.id = ga.group_id
       ${gJ.joins}
       WHERE ga.status = 'P' AND ga.group_id IN (${placeholders})
       ORDER BY ga.created_at, ga.id`,
    )
    .bind(...groupIds)
    .all<GroupApplicationRow>();
  return results;
}

/**
 * Approve/reject a pending application. Guard: status='P' AND (expectedGroupId
 * absent or matches) — a leader can't decide another group's application by
 * posting its id, and a double-submit can't double-process. Approve batches
 * the status flip with an INSERT ... ON CONFLICT DO NOTHING into group_members
 * (group_members carries a real UNIQUE(group_id, person_id) constraint, so this
 * uses ON CONFLICT — unlike applyToGroup's WHERE-NOT-EXISTS insert, which
 * guards a status-scoped uniqueness the schema can't express as a constraint).
 * Returns the application's person/group, or null when it was not pending /
 * not on the expected group. deciderPersonId is recorded in decided_by.
 */
export async function decideGroupApplication(
  db: AppDb,
  applicationId: number,
  approve: boolean,
  deciderPersonId: number,
  expectedGroupId?: number,
): Promise<{ person_id: number; group_id: number } | null> {
  const row = await db
    .prepare(
      `SELECT person_id, group_id FROM group_applications
       WHERE id = ?1 AND status = 'P'${expectedGroupId != null ? ' AND group_id = ?2' : ''}`,
    )
    .bind(...(expectedGroupId != null ? [applicationId, expectedGroupId] : [applicationId]))
    .first<{ person_id: number; group_id: number }>();
  if (!row) return null;

  const statements = [
    db
      .prepare(
        `UPDATE group_applications SET status = ?1, decided_by = ?2, decided_at = datetime('now')
         WHERE id = ?3 AND status = 'P'`,
      )
      .bind(approve ? 'A' : 'R', deciderPersonId, applicationId),
  ];
  if (approve) {
    statements.push(
      db
        .prepare(
          `INSERT INTO group_members (group_id, person_id) VALUES (?, ?)
           ON CONFLICT(group_id, person_id) DO NOTHING`,
        )
        .bind(row.group_id, row.person_id),
    );
  }
  await db.batch(statements);
  return row;
}
