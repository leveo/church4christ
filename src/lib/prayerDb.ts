// Prayer-wall data layer (member portal fusion): posting, scoped tab reads, the
// approver's moderation queue, decide/delete, and the event_admins helpers that
// serve event-scoped moderation. Supabase-only module (schema in
// migrations-supabase/0009_member_portal.sql) — reachable only when the portal
// is on; the pg e2e suite covers the real Postgres DDL, while this module's
// dialect-neutral SQL is unit-tested against the D1 harness like groupFiles.
//
// Fusion note: this adapts onto the public repo's existing groups module —
// `prayer_items.group_id` references `groups(id)` (single-name, no i18n join),
// group membership is an active `group_members` row (removed_at IS NULL), and a
// group's moderator is a member with `is_admin = 1` (the public groups module's
// admin flag; the reference implementation called it is_leader). Event-title
// joins still use reg_event_i18n (this repo has it), so the locale parameter is
// retained for those.
//
// Authority model — four scopes, four actor tiers:
//   church   post: any signed-in member (→ pending). moderate: church admin only.
//            read: everyone, once approved.
//   group    post: a member of the group (→ pending). moderate: that group's
//            admins, or a church admin. read: the group's members, once approved.
//   event    post: someone registered for the event (person_id OR email match,
//            non-cancelled) or one of its event_admins (→ pending). moderate: the
//            event's admins, or a church admin. read: registrants + event admins,
//            once approved.
//   private  post: anyone; AUTO-APPROVED (no moderation). read: the author only.
//
// isAdmin (church-wide moderator) short-circuits every scope check on the
// queue/decide/delete paths; posting and tab reads never take isAdmin (a member's
// own posting eligibility and what they may READ are membership-driven, not
// admin-driven). event_admins helpers live here (not regDb) because they exist to
// serve prayer approval; the event admin console imports them from this module.
import type { AppDb } from './appDb';
import type { Locale } from './db';
import type { SessionUser } from './types';
import { isGroupAdmin, isGroupMember } from './groupDb';

export type PrayerScope = 'church' | 'group' | 'event' | 'private';

export interface PrayerItem {
  id: number;
  author_person_id: number;
  author_name: string;
  scope: PrayerScope;
  group_id: number | null;
  group_name: string | null;
  reg_event_id: number | null;
  event_title: string | null;
  body: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

// Shared localized projection. Locale binds as ?1 (event title only); callers
// append their own WHERE / ORDER BY numbered from ?2. author_name coalesces
// display_name over the name pair (people-roster convention); group_name reads
// the single-column `groups.name` (no i18n), event_title uses the same
// localized-with-en-fallback join as regDb's EVENT_SELECT, and both read null
// when the row has no group_id / reg_event_id.
const PRAYER_SELECT = `
  SELECT p.id AS id, p.author_person_id AS author_person_id,
         COALESCE(ppl.display_name, ppl.first_name || ' ' || ppl.last_name) AS author_name,
         p.scope AS scope, p.group_id AS group_id,
         g.name AS group_name,
         p.reg_event_id AS reg_event_id,
         COALESCE(el.title, ed.title) AS event_title,
         p.body AS body, p.status AS status, p.created_at AS created_at
  FROM prayer_items p
  JOIN people ppl ON ppl.id = p.author_person_id
  LEFT JOIN groups g ON g.id = p.group_id
  LEFT JOIN reg_event_i18n el ON el.event_id = p.reg_event_id AND el.locale = ?1
  LEFT JOIN reg_event_i18n ed ON ed.event_id = p.reg_event_id AND ed.locale = 'en'`;

const MAX_BODY = 2000;

// Portal surfaces pass the session context so only a super admin receives the
// church-wide moderation override. Group and event moderation remain
// membership-based for every other signed-in person.
type PrayerModerator = Pick<SessionUser, 'isSuperAdmin'>;

function hasChurchWideModeration(moderator: PrayerModerator): boolean {
  return moderator.isSuperAdmin;
}

/** True when the person holds a non-cancelled registration for the event, matched
 *  by person_id OR a case-insensitive email match — the same rule as
 *  regDb.listRegistrationsForPerson (covers a registration made anonymously with
 *  the same email before signup). */
async function isRegisteredForEvent(
  db: AppDb,
  eventId: number,
  personId: number,
  email: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM registrations
       WHERE event_id = ?1 AND (person_id = ?2 OR LOWER(email) = LOWER(?3)) AND status != 'cancelled'`,
    )
    .bind(eventId, personId, email)
    .first<{ x: number }>();
  return row !== null;
}

/**
 * Post a prayer item. Validates the scope/id shape (a scope must carry exactly
 * its own foreign key and no other — else 'invalid'), the body ('invalid' when
 * blank, 'too_long' past 2000 chars), then the author's eligibility for the scope
 * ('not_eligible'): group → a member of the group; event → registered or an event
 * admin; church/private → open to any signed-in member. private is AUTO-APPROVED
 * (status 'approved'); every other scope enters moderation as 'pending'. Returns
 * the new id.
 */
export async function postPrayerItem(
  db: AppDb,
  args: {
    authorPersonId: number;
    authorEmail: string;
    scope: PrayerScope;
    groupId?: number | null;
    regEventId?: number | null;
    body: string;
  },
): Promise<number> {
  const { authorPersonId, authorEmail, scope } = args;
  const groupId = args.groupId ?? null;
  const regEventId = args.regEventId ?? null;

  // Scope/id shape: exactly the matching FK, nothing else.
  if (scope === 'group') {
    if (groupId === null || regEventId !== null) throw new Error('invalid');
  } else if (scope === 'event') {
    if (regEventId === null || groupId !== null) throw new Error('invalid');
  } else if (scope === 'church' || scope === 'private') {
    if (groupId !== null || regEventId !== null) throw new Error('invalid');
  } else {
    throw new Error('invalid');
  }

  const body = args.body.trim();
  if (body === '') throw new Error('invalid');
  if (body.length > MAX_BODY) throw new Error('too_long');

  // Eligibility for the scope.
  if (scope === 'group') {
    if (!(await isGroupMember(db, groupId!, authorPersonId))) throw new Error('not_eligible');
  } else if (scope === 'event') {
    const ok =
      (await isRegisteredForEvent(db, regEventId!, authorPersonId, authorEmail)) ||
      (await isEventAdmin(db, regEventId!, authorPersonId));
    if (!ok) throw new Error('not_eligible');
  }

  const status = scope === 'private' ? 'approved' : 'pending';
  const row = await db
    .prepare(
      `INSERT INTO prayer_items (author_person_id, scope, group_id, reg_event_id, body, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
    )
    .bind(authorPersonId, scope, groupId, regEventId, body, status)
    .first<{ id: number }>();
  return row!.id;
}

/** The church tab: approved church items, newest first. */
export async function listChurchPrayers(db: AppDb, locale: Locale): Promise<PrayerItem[]> {
  const { results } = await db
    .prepare(
      `${PRAYER_SELECT}
       WHERE p.scope = 'church' AND p.status = 'approved' AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .bind(locale)
    .all<PrayerItem>();
  return results;
}

/** The group tab: approved group items in any group the person actively belongs
 *  to, newest first. A non-member (or removed member) sees none of a group's
 *  items. */
export async function listGroupPrayersForPerson(
  db: AppDb,
  personId: number,
  locale: Locale,
): Promise<PrayerItem[]> {
  const { results } = await db
    .prepare(
      `${PRAYER_SELECT}
       WHERE p.scope = 'group' AND p.status = 'approved' AND p.deleted_at IS NULL
         AND p.group_id IN (SELECT group_id FROM group_members WHERE person_id = ?2 AND removed_at IS NULL)
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .bind(locale, personId)
    .all<PrayerItem>();
  return results;
}

/** The event tab: approved event items for events the person is registered for
 *  (person_id OR email match, non-cancelled) OR is an event admin of, newest
 *  first. Someone with neither tie sees none of the event's items. */
export async function listEventPrayersForPerson(
  db: AppDb,
  personId: number,
  email: string,
  locale: Locale,
): Promise<PrayerItem[]> {
  const { results } = await db
    .prepare(
      `${PRAYER_SELECT}
       WHERE p.scope = 'event' AND p.status = 'approved' AND p.deleted_at IS NULL
         AND (
           p.reg_event_id IN (
             SELECT event_id FROM registrations
             WHERE (person_id = ?2 OR LOWER(email) = LOWER(?3)) AND status != 'cancelled'
           )
           OR p.reg_event_id IN (SELECT reg_event_id FROM event_admins WHERE person_id = ?2)
         )
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .bind(locale, personId, email)
    .all<PrayerItem>();
  return results;
}

/** The "my requests" view: all of the author's own items regardless of scope or
 *  status (private, pending, rejected included), newest first. Soft-deleted rows
 *  are excluded. */
export async function listMyPrayerItems(db: AppDb, personId: number, locale: Locale): Promise<PrayerItem[]> {
  const { results } = await db
    .prepare(
      `${PRAYER_SELECT}
       WHERE p.author_person_id = ?2 AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC`,
    )
    .bind(locale, personId)
    .all<PrayerItem>();
  return results;
}

/**
 * The moderation queue: pending items within the approver's authority, oldest
 * first (FIFO). A church-wide moderator → every pending item (including church
 * scope included). Otherwise only the pending group items of groups the person
 * ADMINS and the pending event items of events they ADMIN — church-scope pending
 * is admin-only, and private items are never pending.
 */
export async function listPendingForApprover(
  db: AppDb,
  approverId: number,
  moderator: PrayerModerator,
  locale: Locale,
): Promise<PrayerItem[]> {
  if (hasChurchWideModeration(moderator)) {
    const { results } = await db
      .prepare(
        `${PRAYER_SELECT}
         WHERE p.status = 'pending' AND p.deleted_at IS NULL
         ORDER BY p.created_at ASC, p.id ASC`,
      )
      .bind(locale)
      .all<PrayerItem>();
    return results;
  }
  const { results } = await db
    .prepare(
      `${PRAYER_SELECT}
       WHERE p.status = 'pending' AND p.deleted_at IS NULL
         AND (
           (p.scope = 'group' AND p.group_id IN (
             SELECT group_id FROM group_members WHERE person_id = ?2 AND is_admin = 1 AND removed_at IS NULL))
           OR (p.scope = 'event' AND p.reg_event_id IN (
             SELECT reg_event_id FROM event_admins WHERE person_id = ?2))
         )
       ORDER BY p.created_at ASC, p.id ASC`,
    )
    .bind(locale, approverId)
    .all<PrayerItem>();
  return results;
}

/** True when the approver may moderate this item's scope: a church admin always;
 *  otherwise the admin of a 'group' item's group or an admin of an 'event' item's
 *  event. church/private are admin-only here (private never reaches moderation). */
async function canModerate(
  db: AppDb,
  item: { scope: PrayerScope; group_id: number | null; reg_event_id: number | null },
  approverId: number,
  moderator: PrayerModerator,
): Promise<boolean> {
  if (hasChurchWideModeration(moderator)) return true;
  if (item.scope === 'group' && item.group_id !== null) return isGroupAdmin(db, item.group_id, approverId);
  if (item.scope === 'event' && item.reg_event_id !== null) return isEventAdmin(db, item.reg_event_id, approverId);
  return false;
}

/**
 * Approve or reject a pending item. Throws 'not_authorized' when the item exists
 * but sits outside the approver's authority (an admin of one group can't decide
 * another group's item). Returns false when the item is missing, soft-deleted, or
 * already decided (status != 'pending') — an idempotent double-decide is a no-op,
 * not an error. Records approved_by/approved_at on the decision.
 */
export async function decidePrayerItem(
  db: AppDb,
  args: { itemId: number; approve: boolean; approverId: number; moderator: PrayerModerator },
): Promise<boolean> {
  const { itemId, approve, approverId, moderator } = args;
  const item = await db
    .prepare(
      `SELECT scope, group_id, reg_event_id, status, deleted_at FROM prayer_items WHERE id = ?`,
    )
    .bind(itemId)
    .first<{
      scope: PrayerScope;
      group_id: number | null;
      reg_event_id: number | null;
      status: string;
      deleted_at: string | null;
    }>();
  if (!item || item.deleted_at !== null) return false;
  if (!(await canModerate(db, item, approverId, moderator))) throw new Error('not_authorized');
  if (item.status !== 'pending') return false;

  const r = await db
    .prepare(
      `UPDATE prayer_items
       SET status = ?1, approved_by = ?2, approved_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?3 AND status = 'pending'`,
    )
    .bind(approve ? 'approved' : 'rejected', approverId, itemId)
    .run();
  return r.meta.changes > 0;
}

/**
 * Soft-delete an item. Allowed for the author (own item), a moderator of the
 * item's scope (group admin / event admin), or a church admin. Throws
 * 'not_authorized' when the actor is none of those. Returns false when the item
 * is missing or already deleted (idempotent).
 */
export async function deletePrayerItem(
  db: AppDb,
  args: { itemId: number; actorId: number; moderator: PrayerModerator },
): Promise<boolean> {
  const { itemId, actorId, moderator } = args;
  const item = await db
    .prepare(
      `SELECT author_person_id, scope, group_id, reg_event_id, deleted_at FROM prayer_items WHERE id = ?`,
    )
    .bind(itemId)
    .first<{
      author_person_id: number;
      scope: PrayerScope;
      group_id: number | null;
      reg_event_id: number | null;
      deleted_at: string | null;
    }>();
  if (!item || item.deleted_at !== null) return false;

  const authorized = item.author_person_id === actorId || (await canModerate(db, item, actorId, moderator));
  if (!authorized) throw new Error('not_authorized');

  await db
    .prepare(`UPDATE prayer_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .bind(itemId)
    .run();
  return true;
}

// ---- event admins (moderators of an event's prayer items + roster) ----

/** An event's admins with display names (people-roster COALESCE), name-sorted;
 *  soft-deleted people excluded. */
export async function listEventAdmins(
  db: AppDb,
  regEventId: number,
): Promise<{ person_id: number; display_name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT ea.person_id AS person_id,
              COALESCE(p.display_name, p.first_name || ' ' || p.last_name) AS display_name
       FROM event_admins ea
       JOIN people p ON p.id = ea.person_id AND p.deleted_at IS NULL
       WHERE ea.reg_event_id = ?
       ORDER BY display_name`,
    )
    .bind(regEventId)
    .all<{ person_id: number; display_name: string }>();
  return results;
}

/** Active people who can sign in to the portal (email set) — the pool eligible
 *  for the event-admin picker, since an admin must be able to log in to
 *  moderate the event's prayer requests. */
export async function listPeopleWithAccount(db: AppDb): Promise<{ id: number; display_name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, display_name FROM people
       WHERE active = 1 AND deleted_at IS NULL AND email IS NOT NULL AND email <> ''
       ORDER BY display_name`,
    )
    .all<{ id: number; display_name: string }>();
  return results;
}

/** Grant event-admin. Idempotent via UNIQUE(reg_event_id, person_id). */
export async function addEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_admins (reg_event_id, person_id) VALUES (?, ?)
       ON CONFLICT(reg_event_id, person_id) DO NOTHING`,
    )
    .bind(regEventId, personId)
    .run();
}

/** Revoke event-admin (hard delete; event_admins has no soft-delete column). */
export async function removeEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<void> {
  await db.prepare(`DELETE FROM event_admins WHERE reg_event_id = ? AND person_id = ?`).bind(regEventId, personId).run();
}

export async function isEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM event_admins WHERE reg_event_id = ? AND person_id = ?`)
    .bind(regEventId, personId)
    .first<{ x: number }>();
  return row !== null;
}
