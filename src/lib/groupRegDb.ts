// Group ↔ Registration bridge (Supabase-ONLY, like regDb.ts). The registration
// module is Supabase-backed, so its tables (reg_events / reg_event_i18n /
// registrations) and the link table group_reg_events (migrations-supabase/
// 0004_groups.sql) exist ONLY on Postgres. Every caller gates on
// `Astro.locals.modules.has('registration')`, so none of these functions is ever
// reached on a D1 request — but the file must still typecheck against the AppDb
// seam, so it is written the same portable way as regDb.ts. Tests run against real
// Postgres in test/pg/groupRegDb.test.ts.
//
// Localized reads COALESCE the requested-locale reg_event_i18n row over the 'en'
// row (the exact fallback regDb uses). Confirmed count is the settled subset of a
// linked event's registrations (status = 'confirmed'). "Open" mirrors regDb's
// OPEN_WHERE: active, its sign-up window opened (opens_at NULL = immediately) and
// not yet closed (closes_at NULL = open until the event starts).
import type { AppDb } from './appDb';
import type { Locale } from './db';
import { saveEvent } from './regDb';

/** A linked special event as the manage console lists it: localized title, start,
 *  active flag, whether it is currently open for sign-ups, and its confirmed
 *  registration count. */
export interface GroupSpecialEvent {
  id: number;
  title: string;
  starts_at: string;
  active: number;
  is_open: number;
  confirmed_count: number;
}

/** A reg event the group could still link (active, not already linked). Both
 *  locale titles raw (en fallback rendered by the caller). */
export interface LinkableEvent {
  id: number;
  title_en: string;
  title_zh: string | null;
  starts_at: string;
}

/** One of a person's registrations for the profile history reader (Slice H):
 *  localized event title, event start, registration status, newest first. */
export interface PersonRegistration {
  id: number;
  event_id: number;
  title: string;
  starts_at: string;
  status: string;
  created_at: string;
}

// The open-window predicate, identical to regDb's OPEN_WHERE (active + opened +
// not closed), expressed as a 1/0 flag so the list can badge each event.
const IS_OPEN = `CASE WHEN e.active = 1
    AND (e.opens_at IS NULL OR e.opens_at <= datetime('now'))
    AND (COALESCE(e.closes_at, e.starts_at) > datetime('now'))
  THEN 1 ELSE 0 END`;

/**
 * Link a reg event to a group. Idempotent: the (group_id, reg_event_id) UNIQUE
 * index makes a repeat link a no-op via ON CONFLICT DO NOTHING (never an error).
 */
export async function linkSpecialEvent(db: AppDb, groupId: number, regEventId: number): Promise<void> {
  await db
    .prepare(`INSERT INTO group_reg_events (group_id, reg_event_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING`)
    .bind(groupId, regEventId)
    .run();
}

/** Remove a group ↔ reg event link (leaves the reg event itself untouched). */
export async function unlinkSpecialEvent(db: AppDb, groupId: number, regEventId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM group_reg_events WHERE group_id = ?1 AND reg_event_id = ?2`)
    .bind(groupId, regEventId)
    .run();
}

/**
 * Create a new reg event for a group and link it in one logical step. The event
 * is created through regDb.saveEvent (so it shares the registration module's
 * writer + i18n handling) then linked. Group special events default active + FREE
 * (price_cents left NULL when the caller passes none) — staff can later set a
 * price from the registration admin. A blank zh title reuses the en title (so the
 * group-facing form only needs one language), mirroring the members-entered
 * proper-noun convention.
 *
 * Compensation: regDb offers no hard event delete (deactivation is its "remove"),
 * so if the link INSERT fails after the event was created we deactivate the just-
 * created event (active = 0) — it then never shows in the public open list or the
 * registration-admin active view, leaving no reachable orphan.
 */
export async function createSpecialEvent(
  db: AppDb,
  groupId: number,
  input: {
    title_en: string;
    title_zh?: string;
    description_en?: string;
    description_zh?: string;
    starts_at: string;
    ends_at?: string | null;
    location?: string | null;
    capacity?: number | null;
    price_cents?: number | null;
  },
): Promise<number> {
  const titleZh = input.title_zh && input.title_zh.trim() ? input.title_zh.trim() : input.title_en;
  const eventId = await saveEvent(db, {
    title_en: input.title_en,
    title_zh: titleZh,
    description_en: input.description_en,
    description_zh: input.description_zh,
    starts_at: input.starts_at,
    ends_at: input.ends_at ?? null,
    location: input.location ?? null,
    capacity: input.capacity ?? null,
    price_cents: input.price_cents ?? null,
    active: 1,
  });
  try {
    await linkSpecialEvent(db, groupId, eventId);
  } catch (e) {
    // Best-effort compensate: deactivate the event we just created so a failed
    // link never leaves a live, unreachable special event behind.
    await saveEvent(db, { id: eventId, title_en: input.title_en, title_zh: titleZh, starts_at: input.starts_at, active: 0 }).catch(() => {});
    throw e;
  }
  return eventId;
}

/** Every reg event linked to a group (active + inactive), localized title, open
 *  flag, and confirmed count — the manage console's special-events list. Soonest
 *  first. */
export async function listSpecialEventsForGroup(db: AppDb, groupId: number, locale: Locale): Promise<GroupSpecialEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS id,
              COALESCE(el.title, ed.title, '') AS title,
              e.starts_at AS starts_at,
              e.active AS active,
              ${IS_OPEN} AS is_open,
              (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_count
       FROM group_reg_events g
       JOIN reg_events e ON e.id = g.reg_event_id
       LEFT JOIN reg_event_i18n el ON el.event_id = e.id AND el.locale = ?2
       LEFT JOIN reg_event_i18n ed ON ed.event_id = e.id AND ed.locale = 'en'
       WHERE g.group_id = ?1
       ORDER BY e.starts_at, e.id`,
    )
    .bind(groupId, locale)
    .all<GroupSpecialEvent>();
  return results;
}

/** The linked reg events that are currently OPEN for sign-ups (public detail
 *  page), localized title, soonest first. */
export async function listOpenSpecialEventsForGroup(
  db: AppDb,
  groupId: number,
  locale: Locale,
): Promise<Array<{ id: number; title: string; starts_at: string }>> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS id, COALESCE(el.title, ed.title, '') AS title, e.starts_at AS starts_at
       FROM group_reg_events g
       JOIN reg_events e ON e.id = g.reg_event_id
       LEFT JOIN reg_event_i18n el ON el.event_id = e.id AND el.locale = ?2
       LEFT JOIN reg_event_i18n ed ON ed.event_id = e.id AND ed.locale = 'en'
       WHERE g.group_id = ?1
         AND e.active = 1
         AND (e.opens_at IS NULL OR e.opens_at <= datetime('now'))
         AND (COALESCE(e.closes_at, e.starts_at) > datetime('now'))
       ORDER BY e.starts_at, e.id`,
    )
    .bind(groupId, locale)
    .all<{ id: number; title: string; starts_at: string }>();
  return results;
}

/** Active reg events NOT yet linked to this group — the link-existing picker.
 *  Both locale titles raw, newest first. */
export async function listLinkableEvents(db: AppDb, groupId: number): Promise<LinkableEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS id, COALESCE(een.title, '') AS title_en, ezh.title AS title_zh, e.starts_at AS starts_at
       FROM reg_events e
       LEFT JOIN reg_event_i18n een ON een.event_id = e.id AND een.locale = 'en'
       LEFT JOIN reg_event_i18n ezh ON ezh.event_id = e.id AND ezh.locale = 'zh'
       WHERE e.active = 1
         AND NOT EXISTS (SELECT 1 FROM group_reg_events g WHERE g.reg_event_id = e.id AND g.group_id = ?1)
       ORDER BY e.starts_at DESC, e.id DESC`,
    )
    .bind(groupId)
    .all<LinkableEvent>();
  return results;
}

/** A person's registrations (localized event title, event start, status), newest
 *  first — the profile-history reader consumed by Slice H. */
export async function listRegistrationsForPerson(db: AppDb, personId: number, locale: Locale): Promise<PersonRegistration[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, r.event_id AS event_id,
              COALESCE(el.title, ed.title, '') AS title,
              e.starts_at AS starts_at, r.status AS status, r.created_at AS created_at
       FROM registrations r
       JOIN reg_events e ON e.id = r.event_id
       LEFT JOIN reg_event_i18n el ON el.event_id = e.id AND el.locale = ?2
       LEFT JOIN reg_event_i18n ed ON ed.event_id = e.id AND ed.locale = 'en'
       WHERE r.person_id = ?1
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .bind(personId, locale)
    .all<PersonRegistration>();
  return results;
}
