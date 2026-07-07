// Households (spec addendum §B). A household is a shared family card: real
// members carry a person_id (unique across all households — one household per
// real person), and dependents (children, or account-less adults) are name-only
// rows with person_id NULL. `is_primary` marks the household's primary contact;
// setPrimary keeps it exclusive.
//
// Authorization: mutating a household requires the actor to be an ADULT member
// of it, OR an admin. The self-service surfaces pass the signed-in person's id
// plus isAdmin=false; admin surfaces pass isAdmin=true (actorPersonId is then
// ignored for the check). The lib enforces this and throws 'not_authorized'
// when it fails; it throws 'already_in_household' when a real person would join
// a second household. All other reads/writes assume the caller already gated the
// route (route policy / adminOnly).
//
// Deletion model: leaveHousehold removes the caller's own row; when the last
// REAL member leaves, the household is soft-deleted (deleted_at) and its
// remaining name-only dependent rows are hard-deleted (they cannot outlive it).
import { isUniqueViolation } from './adminDb';

export const HOUSEHOLD_ROLES = ['adult', 'child'] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

export interface HouseholdInput {
  name: string;
  address: string | null;
  phone: string | null;
}

export interface HouseholdMember {
  id: number;
  household_id: number;
  person_id: number | null;
  display_name: string;
  role: HouseholdRole;
  is_primary: number; // 0 | 1
  created_at: string;
}

export interface HouseholdWithMembers {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
  members: HouseholdMember[];
}

export interface HouseholdSummary {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

const MEMBER_COL_NAMES = ['id', 'household_id', 'person_id', 'display_name', 'role', 'is_primary', 'created_at'];
const MEMBER_COLS = MEMBER_COL_NAMES.join(', ');
const MEMBER_COLS_HM = MEMBER_COL_NAMES.map((c) => `hm.${c}`).join(', ');

/** The active (non-deleted) household_members row for a real person, or null. */
async function memberRowForPerson(db: D1Database, personId: number): Promise<HouseholdMember | null> {
  return db
    .prepare(
      `SELECT ${MEMBER_COLS_HM} FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       WHERE hm.person_id = ? AND h.deleted_at IS NULL`,
    )
    .bind(personId)
    .first<HouseholdMember>();
}

/**
 * Throw 'not_authorized' unless the actor may mutate this household. Admins may
 * always; otherwise the actor must be an ADULT member of the household. Children
 * and account-less adults (name-only rows) can never be actors — they have no
 * person_id — so an adult account is required.
 */
async function assertCanEdit(
  db: D1Database,
  householdId: number,
  actorPersonId: number,
  isAdmin: boolean,
): Promise<void> {
  if (isAdmin) return;
  const row = await db
    .prepare(
      `SELECT 1 FROM household_members
       WHERE household_id = ? AND person_id = ? AND role = 'adult'`,
    )
    .bind(householdId, actorPersonId)
    .first();
  if (!row) throw new Error('not_authorized');
}

/**
 * Create a household and add the creator as its adult + primary member (their
 * display_name is copied from the people row). Throws 'already_in_household' if
 * the creator already belongs to one. Returns the new household id.
 */
export async function createHousehold(
  db: D1Database,
  input: HouseholdInput,
  creatorPersonId: number,
): Promise<number> {
  if (await memberRowForPerson(db, creatorPersonId)) throw new Error('already_in_household');
  const person = await db
    .prepare(`SELECT display_name FROM people WHERE id = ?`)
    .bind(creatorPersonId)
    .first<{ display_name: string }>();
  if (!person) throw new Error('person_not_found');

  const created = await db
    .prepare(`INSERT INTO households (name, address, phone) VALUES (?, ?, ?) RETURNING id`)
    .bind(input.name, input.address, input.phone)
    .first<{ id: number }>();
  const householdId = created!.id;

  try {
    await db
      .prepare(
        `INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
         VALUES (?, ?, ?, 'adult', 1)`,
      )
      .bind(householdId, creatorPersonId, person.display_name)
      .run();
  } catch (e) {
    // Pre-check ↔ INSERT race: the creator joined another household between the
    // SELECT and this INSERT, so the partial UNIQUE(person_id) index fired.
    // Remove the just-created (member-less) household and surface the same
    // clean error the pre-check would have.
    if (isUniqueViolation(e)) {
      await db.prepare(`DELETE FROM households WHERE id = ?`).bind(householdId).run();
      throw new Error('already_in_household');
    }
    throw e;
  }
  return householdId;
}

/**
 * The household a person belongs to, with all members ordered primary → other
 * adults → children (then oldest first), including name-only dependents. Returns
 * null when the person is not in any (live) household.
 */
export async function getHouseholdForPerson(
  db: D1Database,
  personId: number,
): Promise<HouseholdWithMembers | null> {
  const membership = await memberRowForPerson(db, personId);
  if (!membership) return null;
  return getHousehold(db, membership.household_id);
}

/**
 * Like {@link getHouseholdForPerson} but each member's `display_name` is the
 * LIVE `people.display_name` for real members (person_id set) and the stored
 * name for dependents. This is the self-service surface's read — a real member
 * who later renames their account shows the current name, and no member's email
 * is ever selected (privacy rule: never render another member's email).
 */
export async function getLiveHouseholdForPerson(
  db: D1Database,
  personId: number,
): Promise<HouseholdWithMembers | null> {
  const membership = await memberRowForPerson(db, personId);
  if (!membership) return null;
  const h = await db
    .prepare(
      `SELECT id, name, address, phone, created_at, updated_at
       FROM households WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(membership.household_id)
    .first<Omit<HouseholdWithMembers, 'members'>>();
  if (!h) return null;
  const { results } = await db
    .prepare(
      `SELECT hm.id AS id, hm.household_id AS household_id, hm.person_id AS person_id,
              COALESCE(p.display_name, hm.display_name) AS display_name,
              hm.role AS role, hm.is_primary AS is_primary, hm.created_at AS created_at
       FROM household_members hm
       LEFT JOIN people p ON p.id = hm.person_id AND p.deleted_at IS NULL
       WHERE hm.household_id = ?
       ORDER BY hm.is_primary DESC, hm.role ASC, hm.created_at, hm.id`,
    )
    .bind(membership.household_id)
    .all<HouseholdMember>();
  return { ...h, members: results };
}

/** A household by id with its ordered members, or null if missing/soft-deleted. */
export async function getHousehold(db: D1Database, householdId: number): Promise<HouseholdWithMembers | null> {
  const h = await db
    .prepare(
      `SELECT id, name, address, phone, created_at, updated_at
       FROM households WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(householdId)
    .first<Omit<HouseholdWithMembers, 'members'>>();
  if (!h) return null;
  // is_primary DESC → primary first; role ASC → 'adult' before 'child'.
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLS} FROM household_members
       WHERE household_id = ?
       ORDER BY is_primary DESC, role ASC, created_at, id`,
    )
    .bind(householdId)
    .all<HouseholdMember>();
  return { ...h, members: results };
}

/**
 * Update a household's name/address/phone. Actor must be an adult member or an
 * admin (throws 'not_authorized' otherwise). Returns true when a live row was
 * updated.
 */
export async function updateHousehold(
  db: D1Database,
  householdId: number,
  input: HouseholdInput,
  actorPersonId: number,
  isAdmin: boolean,
): Promise<boolean> {
  await assertCanEdit(db, householdId, actorPersonId, isAdmin);
  const r = await db
    .prepare(
      `UPDATE households SET name = ?, address = ?, phone = ?, updated_at = datetime('now')
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(input.name, input.address, input.phone, householdId)
    .run();
  return r.meta.changes > 0;
}

/**
 * Add a name-only dependent (person_id NULL) to a household. Actor must be an
 * adult member or an admin. Returns the new member id.
 */
export async function addDependent(
  db: D1Database,
  householdId: number,
  displayName: string,
  role: HouseholdRole,
  actorPersonId: number,
  isAdmin: boolean,
): Promise<number> {
  await assertCanEdit(db, householdId, actorPersonId, isAdmin);
  const created = await db
    .prepare(
      `INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
       VALUES (?, NULL, ?, ?, 0) RETURNING id`,
    )
    .bind(householdId, displayName, role)
    .first<{ id: number }>();
  return created!.id;
}

/**
 * Remove a dependent (name-only, person_id NULL) member. Actor must be an adult
 * member of that household or an admin. Throws 'not_a_dependent' if the target
 * carries a person_id (real members leave via leaveHousehold / unlinkPerson).
 * Returns true when a row was deleted.
 */
export async function removeDependent(
  db: D1Database,
  memberId: number,
  actorPersonId: number,
  isAdmin: boolean,
): Promise<boolean> {
  const member = await db
    .prepare(`SELECT household_id, person_id FROM household_members WHERE id = ?`)
    .bind(memberId)
    .first<{ household_id: number; person_id: number | null }>();
  if (!member) return false;
  if (member.person_id !== null) throw new Error('not_a_dependent');
  await assertCanEdit(db, member.household_id, actorPersonId, isAdmin);
  const r = await db.prepare(`DELETE FROM household_members WHERE id = ?`).bind(memberId).run();
  return r.meta.changes > 0;
}

/**
 * A person leaves their household: their own membership row is removed. When no
 * REAL member remains, the household is soft-deleted and its leftover name-only
 * dependents are hard-deleted (a dependent cannot outlive its household). When
 * real members DO remain and the departing member was the primary contact, the
 * oldest remaining adult REAL member is promoted to primary — a household with
 * adults always keeps a primary (no-op when only child-role real members
 * remain). Returns true when the person had a membership to remove.
 */
export async function leaveHousehold(db: D1Database, personId: number): Promise<boolean> {
  const membership = await memberRowForPerson(db, personId);
  if (!membership) return false;
  const householdId = membership.household_id;

  await db.prepare(`DELETE FROM household_members WHERE id = ?`).bind(membership.id).run();

  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM household_members
       WHERE household_id = ? AND person_id IS NOT NULL`,
    )
    .bind(householdId)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await db.batch([
      db
        .prepare(`UPDATE households SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .bind(householdId),
      db.prepare(`DELETE FROM household_members WHERE household_id = ? AND person_id IS NULL`).bind(householdId),
    ]);
  } else if (membership.is_primary === 1) {
    // The departing member was primary: hand it to the oldest remaining adult
    // real member so the household keeps a primary contact.
    const next = await db
      .prepare(
        `SELECT id FROM household_members
         WHERE household_id = ? AND person_id IS NOT NULL AND role = 'adult'
         ORDER BY created_at, id LIMIT 1`,
      )
      .bind(householdId)
      .first<{ id: number }>();
    if (next) {
      await db.prepare(`UPDATE household_members SET is_primary = 1 WHERE id = ?`).bind(next.id).run();
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Admin-only operations (callers gate on adminOnly).
// ---------------------------------------------------------------------------

/**
 * Link an existing real person into a household as a member (default role
 * 'adult', non-primary; display_name copied from the people row). Throws
 * 'household_not_found' when the household is missing or soft-deleted, and
 * 'already_in_household' if the person already belongs to one (including the
 * pre-check ↔ INSERT race, mapped from the partial UNIQUE(person_id) index).
 * Returns the new member id.
 */
export async function linkPersonToHousehold(
  db: D1Database,
  householdId: number,
  personId: number,
  role: HouseholdRole = 'adult',
): Promise<number> {
  const household = await db
    .prepare(`SELECT 1 FROM households WHERE id = ? AND deleted_at IS NULL`)
    .bind(householdId)
    .first();
  if (!household) throw new Error('household_not_found');
  if (await memberRowForPerson(db, personId)) throw new Error('already_in_household');
  const person = await db
    .prepare(`SELECT display_name FROM people WHERE id = ?`)
    .bind(personId)
    .first<{ display_name: string }>();
  if (!person) throw new Error('person_not_found');
  try {
    const created = await db
      .prepare(
        `INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
         VALUES (?, ?, ?, ?, 0) RETURNING id`,
      )
      .bind(householdId, personId, person.display_name, role)
      .first<{ id: number }>();
    return created!.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error('already_in_household'); // pre-check ↔ INSERT race
    throw e;
  }
}

/** Remove a real person's membership row (admin surgical unlink). Returns true when removed. */
export async function unlinkPerson(db: D1Database, personId: number): Promise<boolean> {
  const r = await db
    .prepare(`DELETE FROM household_members WHERE person_id = ?`)
    .bind(personId)
    .run();
  return r.meta.changes > 0;
}

/** Set a member's role (adult/child). Returns true when a row changed. */
export async function setMemberRole(db: D1Database, memberId: number, role: HouseholdRole): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE household_members SET role = ? WHERE id = ?`)
    .bind(role, memberId)
    .run();
  return r.meta.changes > 0;
}

/**
 * Make one member the household's primary contact, clearing any other primary in
 * the same household (primary is exclusive). Returns true when the target member
 * exists in the household.
 */
export async function setPrimary(db: D1Database, householdId: number, memberId: number): Promise<boolean> {
  const target = await db
    .prepare(`SELECT 1 FROM household_members WHERE id = ? AND household_id = ?`)
    .bind(memberId, householdId)
    .first();
  if (!target) return false;
  await db.batch([
    db.prepare(`UPDATE household_members SET is_primary = 0 WHERE household_id = ?`).bind(householdId),
    db.prepare(`UPDATE household_members SET is_primary = 1 WHERE id = ?`).bind(memberId),
  ]);
  return true;
}

/**
 * List live households with member counts (dependents included) for the admin
 * directory, name-ordered. An optional case-insensitive name substring filters.
 */
export async function listHouseholds(db: D1Database, opts: { q?: string } = {}): Promise<HouseholdSummary[]> {
  const q = (opts.q ?? '').trim();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT h.id, h.name, h.address, h.phone, h.created_at, h.updated_at,
              COUNT(hm.id) AS member_count
       FROM households h
       LEFT JOIN household_members hm ON hm.household_id = h.id
       WHERE h.deleted_at IS NULL
         AND (?1 = '' OR LOWER(h.name) LIKE LOWER(?2) ESCAPE '\\')
       GROUP BY h.id
       ORDER BY h.name, h.id`,
    )
    .bind(q, like)
    .all<HouseholdSummary>();
  return results;
}
