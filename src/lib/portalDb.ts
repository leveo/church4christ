// Household ownership (member portal). An "owner" is a household's adult,
// linked (person_id set) member with a real account (people.email set) who
// may add/edit/remove other members through the self-service surface — a
// looser-permissioned peer of the admin console. Ownership is capped at 2 per
// household (app-layer enforced, not a DB constraint) and is orthogonal to
// `is_primary` (the church's single point-of-contact marker).
import type { AppDb } from './appDb';
import { getLiveHouseholdForPerson, type HouseholdWithMembers } from './householdDb';

export interface PortalHousehold extends HouseholdWithMembers {
  viewerIsOwner: boolean;
}

/** Household for the signed-in viewer with ownership flag; null when none. */
export async function getPortalHousehold(db: AppDb, viewerPersonId: number): Promise<PortalHousehold | null> {
  const household = await getLiveHouseholdForPerson(db, viewerPersonId);
  if (!household) return null;
  const viewer = household.members.find((m) => m.person_id === viewerPersonId);
  return { ...household, viewerIsOwner: viewer?.is_owner === 1 };
}

/** True when the person holds an is_owner=1 row in their LIVE household (a
 *  soft-deleted household's former owner reads back false). */
export async function isHouseholdOwner(db: AppDb, personId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS one
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id AND h.deleted_at IS NULL
       WHERE hm.person_id = ? AND hm.is_owner = 1`,
    )
    .bind(personId)
    .first<{ one: number }>();
  return row !== null;
}

/**
 * Promote/demote a co-owner. The actor must already be an owner of the same
 * household, or an admin (isAdmin bypasses every other actor check, including
 * self-demotion). The target must be a live household_members row in that
 * household with role='adult', a linked person_id, and a people row with a
 * non-null email — otherwise `not_eligible`. Promoting past 2 existing owners
 * throws `owner_limit`; promoting an already-owner is a no-op. Demoting is
 * always allowed once authorized, except a non-admin owner may not demote
 * themselves (`cannot_demote_self`). Throws `not_found` when memberId isn't a
 * member of householdId.
 */
export async function setOwner(
  db: AppDb,
  args: { householdId: number; memberId: number; isOwner: boolean; actorPersonId: number; isAdmin: boolean },
): Promise<void> {
  const { householdId, memberId, isOwner, actorPersonId, isAdmin } = args;

  if (!isAdmin) {
    const actor = await db
      .prepare(
        `SELECT hm.is_owner AS is_owner
         FROM household_members hm
         JOIN households h ON h.id = hm.household_id
         WHERE hm.household_id = ? AND hm.person_id = ? AND h.deleted_at IS NULL`,
      )
      .bind(householdId, actorPersonId)
      .first<{ is_owner: number }>();
    if (!actor || actor.is_owner !== 1) throw new Error('not_authorized');
  }

  const target = await db
    .prepare(
      `SELECT hm.id, hm.person_id, hm.role, hm.is_owner, p.email
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       LEFT JOIN people p ON p.id = hm.person_id AND p.deleted_at IS NULL
       WHERE hm.id = ? AND hm.household_id = ? AND h.deleted_at IS NULL`,
    )
    .bind(memberId, householdId)
    .first<{ id: number; person_id: number | null; role: string; is_owner: number; email: string | null }>();
  if (target === null) throw new Error('not_found');

  if (isOwner) {
    if (target.role !== 'adult' || target.person_id === null || !target.email) throw new Error('not_eligible');
    if (target.is_owner === 1) return; // already an owner
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM household_members WHERE household_id = ? AND is_owner = 1`)
      .bind(householdId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 2) throw new Error('owner_limit');
    await db.prepare(`UPDATE household_members SET is_owner = 1 WHERE id = ?`).bind(memberId).run();
    return;
  }

  if (!isAdmin && target.person_id === actorPersonId) throw new Error('cannot_demote_self');
  await db.prepare(`UPDATE household_members SET is_owner = 0 WHERE id = ?`).bind(memberId).run();
}

/** Fields an owner may edit on a linked member's people row (never email). */
export interface MemberProfilePatch {
  first_name?: string;
  last_name?: string;
  display_name?: string;
  phone?: string | null;
  birthday?: string | null;
  address?: string | null;
}

/**
 * Owner (or self, or admin) edits a household member's profile. A linked
 * member (person_id set) writes through to their `people` row (never email —
 * that field doesn't exist on {@link MemberProfilePatch}, so there is nothing
 * to strip). A dependent row (person_id NULL) has no people row, so only its
 * own `display_name` and, when passed, `dependentRole` apply. Throws
 * `not_found` when memberId doesn't exist, `not_authorized` when the actor is
 * neither the member themselves, an owner of the household, nor an admin.
 */
export async function updateMemberProfile(
  db: AppDb,
  args: {
    actorPersonId: number;
    isAdmin: boolean;
    memberId: number;
    patch: MemberProfilePatch;
    dependentRole?: 'adult' | 'child';
  },
): Promise<void> {
  const { actorPersonId, isAdmin, memberId, patch, dependentRole } = args;
  const member = await db
    .prepare(
      `SELECT hm.id, hm.household_id, hm.person_id
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       WHERE hm.id = ? AND h.deleted_at IS NULL`,
    )
    .bind(memberId)
    .first<{ id: number; household_id: number; person_id: number | null }>();
  if (!member) throw new Error('not_found');

  if (!isAdmin && member.person_id !== actorPersonId) {
    const actor = await db
      .prepare(
        `SELECT hm.is_owner AS is_owner
         FROM household_members hm
         JOIN households h ON h.id = hm.household_id
         WHERE hm.household_id = ? AND hm.person_id = ? AND h.deleted_at IS NULL`,
      )
      .bind(member.household_id, actorPersonId)
      .first<{ is_owner: number }>();
    if (!actor || actor.is_owner !== 1) throw new Error('not_authorized');
  }

  if (member.person_id === null) {
    const sets: string[] = [];
    const binds: (string | number)[] = [];
    if (patch.display_name !== undefined) {
      sets.push('display_name = ?');
      binds.push(patch.display_name);
    }
    if (dependentRole !== undefined) {
      sets.push('role = ?');
      binds.push(dependentRole);
    }
    if (sets.length === 0) return;
    binds.push(memberId);
    await db.prepare(`UPDATE household_members SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    return;
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (patch.first_name !== undefined) {
    sets.push('first_name = ?');
    binds.push(patch.first_name);
  }
  if (patch.last_name !== undefined) {
    sets.push('last_name = ?');
    binds.push(patch.last_name);
  }
  if (patch.display_name !== undefined) {
    sets.push('display_name = ?');
    binds.push(patch.display_name);
  }
  if (patch.phone !== undefined) {
    sets.push('phone = ?');
    binds.push(patch.phone);
  }
  if (patch.birthday !== undefined) {
    sets.push('birthday = ?');
    binds.push(patch.birthday);
  }
  if (patch.address !== undefined) {
    sets.push('address = ?');
    binds.push(patch.address);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  binds.push(member.person_id);
  await db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}
