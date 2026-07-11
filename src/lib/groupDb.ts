// Groups data-access layer. Member-run small groups: a public directory plus
// private groups, membership (real people OR name-only rows, household_members
// precedent), self-service join requests, and the reads that feed the profile /
// person activity sections. Soft deletes throughout (groups.deleted_at,
// group_members.removed_at). No authorization lives here — pages gate the route
// (route policy / in-page checks); this module assumes the caller is allowed and
// only maps the pre-check ↔ INSERT race to a clean result via isUniqueViolation.
import type { AppDb, AppStatement } from './appDb';
import { isUniqueViolation } from './adminDb';

/** Fellowship (open small group) vs Sunday-school class (term-scoped). Mirrors
 *  the groups.kind CHECK from migrations/0010_member_portal.sql. */
export type GroupKind = 'fellowship' | 'sunday_school';

export interface GroupInput {
  name: string;
  description: string;
  isPublic: boolean;
  kind: GroupKind;
  termLabel: string | null;
  termStart: string | null; // 'YYYY-MM-DD' or null
  termEnd: string | null; // 'YYYY-MM-DD' or null
}

export interface GroupRow {
  id: number;
  name: string;
  description: string;
  is_public: number; // 0 | 1
  kind: GroupKind;
  term_label: string | null;
  term_start: string | null;
  term_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupSummary extends GroupRow {
  member_count: number;
}

/** A group the signed-in person belongs to (their own admin flag + roster size). */
export interface PersonGroupRow extends GroupRow {
  is_admin: number; // 0 | 1
  member_count: number;
}

export interface GroupMemberRow {
  id: number;
  group_id: number;
  person_id: number | null;
  display_name: string;
  phone: string | null;
  is_admin: number; // 0 | 1
  created_at: string;
}

// ── Groups CRUD (soft delete) ──────────────────────────────────────────────

/** Create a group; returns the new id. */
export async function createGroup(db: AppDb, input: GroupInput): Promise<number> {
  const created = await db
    .prepare(
      `INSERT INTO groups (name, description, is_public, kind, term_label, term_start, term_end)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    )
    .bind(input.name, input.description, input.isPublic ? 1 : 0, input.kind, input.termLabel, input.termStart, input.termEnd)
    .first<{ id: number }>();
  return created!.id;
}

/** Update a live group's name/description/visibility + kind/term. Returns true when a row changed. */
export async function updateGroup(db: AppDb, id: number, input: GroupInput): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE groups SET name = ?1, description = ?2, is_public = ?3, kind = ?5, term_label = ?6,
              term_start = ?7, term_end = ?8, updated_at = datetime('now')
       WHERE id = ?4 AND deleted_at IS NULL`,
    )
    .bind(input.name, input.description, input.isPublic ? 1 : 0, id, input.kind, input.termLabel, input.termStart, input.termEnd)
    .run();
  return r.meta.changes > 0;
}

/** Soft-delete a group (hides it from every listing; membership rows are kept). */
export async function softDeleteGroup(db: AppDb, id: number): Promise<void> {
  await db
    .prepare(`UPDATE groups SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`)
    .bind(id)
    .run();
}

/** A single live group, or null if missing/soft-deleted. */
export async function getGroup(db: AppDb, id: number): Promise<GroupRow | null> {
  return db
    .prepare(
      `SELECT id, name, description, is_public, kind, term_label, term_start, term_end, created_at, updated_at
       FROM groups WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<GroupRow>();
}

const MEMBER_COUNT_SUBQUERY = `(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id AND m.removed_at IS NULL)`;

/** All live groups with active-member counts (admin directory), name-ordered. */
export async function listGroups(db: AppDb): Promise<GroupSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.description, g.is_public, g.kind, g.term_label, g.term_start, g.term_end,
              g.created_at, g.updated_at, ${MEMBER_COUNT_SUBQUERY} AS member_count
       FROM groups g WHERE g.deleted_at IS NULL ORDER BY g.name, g.id`,
    )
    .all<GroupSummary>();
  return results;
}

/** Live PUBLIC groups with member counts (the public directory). */
export async function listPublicGroups(db: AppDb): Promise<GroupSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.description, g.is_public, g.kind, g.term_label, g.term_start, g.term_end,
              g.created_at, g.updated_at, ${MEMBER_COUNT_SUBQUERY} AS member_count
       FROM groups g WHERE g.deleted_at IS NULL AND g.is_public = 1 ORDER BY g.name, g.id`,
    )
    .all<GroupSummary>();
  return results;
}

/** Live groups the person is an active member of (incl. private), with their
 *  own admin flag — the "my groups" section, which shows private memberships. */
export async function listGroupsForPerson(db: AppDb, personId: number): Promise<PersonGroupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.description, g.is_public, g.kind, g.term_label, g.term_start, g.term_end,
              g.created_at, g.updated_at, gm.is_admin AS is_admin, ${MEMBER_COUNT_SUBQUERY} AS member_count
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
       WHERE gm.person_id = ?1 AND gm.removed_at IS NULL
       ORDER BY g.name, g.id`,
    )
    .bind(personId)
    .all<PersonGroupRow>();
  return results;
}

// ── Membership ─────────────────────────────────────────────────────────────

/** The group's active roster (removed rows excluded), admins first then by live
 *  name. `display_name` is the LIVE people name for real members, the stored name
 *  for name-only rows. No email is selected (privacy: rosters never render it). */
export async function listMembers(db: AppDb, groupId: number): Promise<GroupMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT gm.id AS id, gm.group_id AS group_id, gm.person_id AS person_id,
              COALESCE(p.display_name, gm.display_name) AS display_name,
              gm.phone AS phone, gm.is_admin AS is_admin, gm.created_at AS created_at
       FROM group_members gm
       LEFT JOIN people p ON p.id = gm.person_id AND p.deleted_at IS NULL
       WHERE gm.group_id = ?1 AND gm.removed_at IS NULL
       ORDER BY gm.is_admin DESC, display_name, gm.id`,
    )
    .bind(groupId)
    .all<GroupMemberRow>();
  return results;
}

/** True when the person has an active (removed_at IS NULL) membership in the
 *  group — the group-files download ACL and files-panel gate. */
export async function isGroupMember(db: AppDb, groupId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM group_members WHERE group_id = ?1 AND person_id = ?2 AND removed_at IS NULL`)
    .bind(groupId, personId)
    .first<{ x: number }>();
  return row !== null;
}

/** True when the person is an active admin of the group. */
export async function isGroupAdmin(db: AppDb, groupId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM group_members
       WHERE group_id = ?1 AND person_id = ?2 AND is_admin = 1 AND removed_at IS NULL`,
    )
    .bind(groupId, personId)
    .first<{ x: number }>();
  return row !== null;
}

/**
 * Add a real person to a group (display_name copied from the people row).
 * Idempotent: an already-active membership returns its existing id. Maps the
 * partial UNIQUE(group_id, person_id) race to the same idempotent result.
 * Returns the member id; throws 'person_not_found' for a missing/deleted person.
 */
export async function addMemberByPerson(
  db: AppDb,
  groupId: number,
  personId: number,
  isAdmin = false,
): Promise<number> {
  const active = await activeMemberId(db, groupId, personId);
  if (active !== null) return active;
  const person = await db
    .prepare(`SELECT display_name FROM people WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(personId)
    .first<{ display_name: string }>();
  if (!person) throw new Error('person_not_found');
  try {
    const created = await db
      .prepare(
        `INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, ?2, ?3, ?4) RETURNING id`,
      )
      .bind(groupId, personId, person.display_name, isAdmin ? 1 : 0)
      .first<{ id: number }>();
    return created!.id;
  } catch (e) {
    // Pre-check ↔ INSERT race on the partial UNIQUE index: someone added the same
    // person concurrently — return that active row instead of a raw 500.
    if (isUniqueViolation(e)) {
      const raced = await activeMemberId(db, groupId, personId);
      if (raced !== null) return raced;
    }
    throw e;
  }
}

async function activeMemberId(db: AppDb, groupId: number, personId: number): Promise<number | null> {
  const row = await db
    .prepare(`SELECT id FROM group_members WHERE group_id = ?1 AND person_id = ?2 AND removed_at IS NULL`)
    .bind(groupId, personId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export interface InlineMemberInput {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

/**
 * Add a member from the inline "add member" form. With an email, reuse the
 * existing (live) people row for that lowercased email, else create one
 * (role 'member', membership_status 'visitor') — savePerson-style, with the
 * pre-check ↔ INSERT race mapped via isUniqueViolation — then link it. Without an
 * email, insert a name-only member row (person_id NULL), the household-dependent
 * precedent. Returns the new/existing member id.
 */
export async function addMemberInline(db: AppDb, groupId: number, input: InlineMemberInput): Promise<number> {
  const displayName = [input.firstName, input.lastName].map((s) => s.trim()).filter(Boolean).join(' ');
  const email = input.email?.trim().toLowerCase() || null;
  if (!email) {
    const created = await db
      .prepare(`INSERT INTO group_members (group_id, person_id, display_name, phone) VALUES (?1, NULL, ?2, ?3) RETURNING id`)
      .bind(groupId, displayName, input.phone)
      .first<{ id: number }>();
    return created!.id;
  }
  const personId = await reuseOrCreatePerson(db, {
    email,
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: displayName || email,
    phone: input.phone,
  });
  return addMemberByPerson(db, groupId, personId);
}

async function reuseOrCreatePerson(
  db: AppDb,
  p: { email: string; firstName: string; lastName: string; displayName: string; phone: string | null },
): Promise<number> {
  const existing = await db
    .prepare(`SELECT id FROM people WHERE email = ?1 AND deleted_at IS NULL`)
    .bind(p.email)
    .first<{ id: number }>();
  if (existing) return existing.id;
  try {
    const created = await db
      .prepare(
        `INSERT INTO people (first_name, last_name, display_name, email, phone, role, active, membership_status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'member', 1, 'visitor') RETURNING id`,
      )
      .bind(p.firstName, p.lastName, p.displayName, p.email, p.phone)
      .first<{ id: number }>();
    return created!.id;
  } catch (e) {
    // A live person for this email was created concurrently — adopt it.
    if (isUniqueViolation(e)) {
      const raced = await db
        .prepare(`SELECT id FROM people WHERE email = ?1 AND deleted_at IS NULL`)
        .bind(p.email)
        .first<{ id: number }>();
      if (raced) return raced.id;
    }
    throw e;
  }
}

/** Remove a member (set removed_at). Returns true when an active row was removed. */
export async function removeMember(db: AppDb, memberId: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE group_members SET removed_at = datetime('now') WHERE id = ?1 AND removed_at IS NULL`)
    .bind(memberId)
    .run();
  return r.meta.changes > 0;
}

/** Promote/demote a member's group-admin flag. Returns true when a row changed. */
export async function setMemberAdmin(db: AppDb, memberId: number, isAdmin: boolean): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE group_members SET is_admin = ?2 WHERE id = ?1 AND removed_at IS NULL`)
    .bind(memberId, isAdmin ? 1 : 0)
    .run();
  return r.meta.changes > 0;
}

// ── Join requests ──────────────────────────────────────────────────────────

export type JoinRequestResult = 'created' | 'pending' | 'already_member';

/**
 * A person asks to join a group. Idempotent: 'already_member' when they are an
 * active member, 'pending' when a pending request already exists (the partial
 * UNIQUE(group_id, person_id) WHERE status='pending' index, incl. the race),
 * else 'created'.
 */
export async function createJoinRequest(db: AppDb, groupId: number, personId: number): Promise<JoinRequestResult> {
  if ((await activeMemberId(db, groupId, personId)) !== null) return 'already_member';
  try {
    await db
      .prepare(`INSERT INTO group_join_requests (group_id, person_id) VALUES (?1, ?2)`)
      .bind(groupId, personId)
      .run();
    return 'created';
  } catch (e) {
    if (isUniqueViolation(e)) return 'pending'; // pending request already exists (incl. race)
    throw e;
  }
}

export interface JoinRequestRow {
  id: number;
  person_id: number;
  display_name: string;
  email: string;
  created_at: string;
}

/** Pending join requests for a group (with the requester's name + email), oldest first. */
export async function listJoinRequests(db: AppDb, groupId: number): Promise<JoinRequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT gjr.id AS id, gjr.person_id AS person_id, p.display_name AS display_name,
              p.email AS email, gjr.created_at AS created_at
       FROM group_join_requests gjr
       JOIN people p ON p.id = gjr.person_id
       WHERE gjr.group_id = ?1 AND gjr.status = 'pending'
       ORDER BY gjr.created_at, gjr.id`,
    )
    .bind(groupId)
    .all<JoinRequestRow>();
  return results;
}

/**
 * Decide a pending join request. Approve → add the member and mark the request
 * approved in ONE db.batch (atomic); reject → mark it rejected. Returns false
 * when the request is missing or already decided. `decidedBy` is the deciding
 * person's id (audit).
 */
export async function decideJoinRequest(
  db: AppDb,
  requestId: number,
  approve: boolean,
  decidedBy: number,
): Promise<boolean> {
  const req = await db
    .prepare(`SELECT group_id, person_id, status FROM group_join_requests WHERE id = ?1`)
    .bind(requestId)
    .first<{ group_id: number; person_id: number; status: string }>();
  if (!req || req.status !== 'pending') return false;

  if (!approve) {
    await db
      .prepare(
        `UPDATE group_join_requests SET status = 'rejected', decided_at = datetime('now'), decided_by = ?2
         WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(requestId, decidedBy)
      .run();
    return true;
  }

  const already = (await activeMemberId(db, req.group_id, req.person_id)) !== null;
  const person = await db
    .prepare(`SELECT display_name FROM people WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(req.person_id)
    .first<{ display_name: string }>();
  const stmts: AppStatement[] = [];
  if (!already && person) {
    stmts.push(
      db
        .prepare(`INSERT INTO group_members (group_id, person_id, display_name) VALUES (?1, ?2, ?3)`)
        .bind(req.group_id, req.person_id, person.display_name),
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE group_join_requests SET status = 'approved', decided_at = datetime('now'), decided_by = ?2
         WHERE id = ?1 AND status = 'pending'`,
      )
      .bind(requestId, decidedBy),
  );
  await db.batch(stmts);
  return true;
}

// ── People search (scoped to the group add-member picker) ──────────────────

export interface GroupPersonHit {
  id: number;
  display_name: string;
  email: string;
}

/**
 * Search active (non-deleted) people for the group add-member picker — a scoped
 * projection (id, display_name, email only). Case-insensitive on display_name or
 * email, with LIKE wildcards in the query escaped (a literal % / _ / \ searches
 * for itself), same as adminDb.listPeople. Empty query → no rows. Capped at 20.
 */
export async function searchPeopleForGroup(db: AppDb, q: string): Promise<GroupPersonHit[]> {
  const query = q.trim();
  if (!query) return [];
  const like = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
  const { results } = await db
    .prepare(
      `SELECT id, display_name, email FROM people
       WHERE deleted_at IS NULL AND active = 1
         AND (LOWER(display_name) LIKE LOWER(?1) ESCAPE '\\' OR LOWER(email) LIKE LOWER(?1) ESCAPE '\\')
       ORDER BY display_name, id LIMIT 20`,
    )
    .bind(like)
    .all<GroupPersonHit>();
  return results;
}

// ── Profile / person activity ──────────────────────────────────────────────

export interface PersonMembership {
  group_id: number;
  group_name: string;
  is_admin: number; // 0 | 1
}

export interface PersonAttendance {
  group_name: string;
  event_title: string;
  occurs_on: string;
  present: number; // 0 | 1
}

export interface PersonGroupActivity {
  memberships: PersonMembership[];
  attendance: PersonAttendance[];
}

/** A person's group memberships plus their attendance history (event title,
 *  group name, occurrence date, present), for the profile / admin person page. */
export async function listPersonGroupActivity(db: AppDb, personId: number): Promise<PersonGroupActivity> {
  const { results: memberships } = await db
    .prepare(
      `SELECT g.id AS group_id, g.name AS group_name, gm.is_admin AS is_admin
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id AND g.deleted_at IS NULL
       WHERE gm.person_id = ?1 AND gm.removed_at IS NULL
       ORDER BY g.name, g.id`,
    )
    .bind(personId)
    .all<PersonMembership>();
  const { results: attendance } = await db
    .prepare(
      `SELECT g.name AS group_name, ge.title AS event_title, geo.occurs_on AS occurs_on, ga.present AS present
       FROM group_attendance ga
       JOIN group_members gm ON gm.id = ga.member_id AND gm.person_id = ?1
       JOIN group_event_occurrences geo ON geo.id = ga.occurrence_id
       JOIN group_events ge ON ge.id = geo.event_id
       JOIN groups g ON g.id = ge.group_id
       ORDER BY geo.occurs_on DESC, ge.title`,
    )
    .bind(personId)
    .all<PersonAttendance>();
  return { memberships, attendance };
}
