// Children's check-in: kiosk events admin (list/save/toggle) and the kiosk
// household search that drives the "find your family" step. Children are
// household_members rows with role='child' and person_id NULL (see
// migrations/0003_people.sql); check-in/checkout/stats are a later task.
import type { AppDb } from './appDb';

export interface CheckinEvent {
  id: number;
  name: string;
  weekday: number | null;
  active: number;
}

export interface KioskHouseholdHit {
  id: number;
  name: string;
  phone: string | null;
  adults: string[];
  children: string[];
}

/** All check-in events (active and inactive), newest first, for the admin console. */
export async function listEventsAdmin(db: AppDb): Promise<CheckinEvent[]> {
  const { results } = await db
    .prepare(`SELECT id, name, weekday, active FROM checkin_events ORDER BY id DESC`)
    .all<CheckinEvent>();
  return results;
}

/** Active events offered on `weekday` (0=Sunday) or every day (weekday IS NULL) — the kiosk's event picker. */
export async function listActiveEvents(db: AppDb, weekday: number): Promise<CheckinEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, weekday, active FROM checkin_events
       WHERE active = 1 AND (weekday IS NULL OR weekday = ?) ORDER BY id DESC`,
    )
    .bind(weekday)
    .all<CheckinEvent>();
  return results;
}

/** Create or update a check-in event. Returns the row's id. */
export async function saveEvent(db: AppDb, input: { id?: number; name: string; weekday: number | null }): Promise<number> {
  if (input.id === undefined) {
    const created = await db
      .prepare(`INSERT INTO checkin_events (name, weekday) VALUES (?, ?) RETURNING id`)
      .bind(input.name, input.weekday)
      .first<{ id: number }>();
    return created!.id;
  }
  await db
    .prepare(`UPDATE checkin_events SET name = ?, weekday = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(input.name, input.weekday, input.id)
    .run();
  return input.id;
}

/** Flip an event's active flag (quick list action). */
export async function toggleEventActive(db: AppDb, id: number, active: boolean): Promise<void> {
  await db
    .prepare(`UPDATE checkin_events SET active = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(active ? 1 : 0, id)
    .run();
}

/** Strip everything but digits, for phone-mode matching against user input. */
function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** Escape LIKE wildcards (%, _, \) so a literal query searches for itself — see adminDb.ts:88-93. */
function likeEscape(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

// Nested REPLACE chain that strips the formatting characters this app's phone
// inputs may contain, so a digits-only query can match regardless of how the
// stored phone is punctuated.
function digitStripExpr(col: string): string {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, '-', ''), ' ', ''), '(', ''), ')', ''), '+', ''), '.', '')`;
}

/**
 * Kiosk household search: `digits.length >= 4` switches to phone mode (matching
 * household phone or an adult member's people.phone, digit-stripped), otherwise
 * name mode (case-insensitive substring match on a child's display_name). Only
 * households with at least one child ever appear, LIMIT 10. Runs two queries —
 * matched household ids, then their members grouped in JS — never N+1.
 */
export async function searchHouseholds(db: AppDb, q: string): Promise<KioskHouseholdHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const digits = digitsOf(trimmed);

  let matched: { id: number; name: string; phone: string | null }[];
  if (digits.length >= 4) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT h.id AS id, h.name AS name, h.phone AS phone
         FROM households h
         LEFT JOIN household_members hm ON hm.household_id = h.id AND hm.role = 'adult'
         LEFT JOIN people p ON p.id = hm.person_id
         WHERE h.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM household_members c WHERE c.household_id = h.id AND c.role = 'child')
           AND (
             (h.phone IS NOT NULL AND ${digitStripExpr('h.phone')} LIKE '%' || ? ESCAPE '\\')
             OR (p.phone IS NOT NULL AND ${digitStripExpr('p.phone')} LIKE '%' || ? ESCAPE '\\')
           )
         LIMIT 10`,
      )
      .bind(likeEscape(digits), likeEscape(digits))
      .all<{ id: number; name: string; phone: string | null }>();
    matched = results;
  } else {
    const like = `%${likeEscape(trimmed)}%`;
    const { results } = await db
      .prepare(
        `SELECT DISTINCT h.id AS id, h.name AS name, h.phone AS phone
         FROM households h
         JOIN household_members c ON c.household_id = h.id AND c.role = 'child'
         WHERE h.deleted_at IS NULL AND LOWER(c.display_name) LIKE LOWER(?) ESCAPE '\\'
         LIMIT 10`,
      )
      .bind(like)
      .all<{ id: number; name: string; phone: string | null }>();
    matched = results;
  }
  if (matched.length === 0) return [];

  const ids = matched.map((h) => h.id);
  const { results: members } = await db
    .prepare(
      `SELECT household_id, display_name, role FROM household_members
       WHERE household_id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(...ids)
    .all<{ household_id: number; display_name: string; role: 'adult' | 'child' }>();

  return matched.map((h) => ({
    id: h.id,
    name: h.name,
    phone: h.phone,
    adults: members.filter((m) => m.household_id === h.id && m.role === 'adult').map((m) => m.display_name),
    children: members.filter((m) => m.household_id === h.id && m.role === 'child').map((m) => m.display_name),
  }));
}
