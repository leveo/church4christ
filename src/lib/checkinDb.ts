// Children's check-in: kiosk events admin (list/save/toggle), the kiosk
// household search that drives the "find your family" step, check-in/checkout,
// the kiosk household status view, the staff roster, and weekly stats.
// Children are household_members rows with role='child' and person_id NULL
// (see migrations/0003_people.sql).
import type { AppDb } from './appDb';
import { isUniqueViolation } from './adminDb';
import { addDays } from './dates';

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
             (h.phone IS NOT NULL AND ${digitStripExpr('h.phone')} LIKE '%' || ? || '%' ESCAPE '\\')
             OR (p.phone IS NOT NULL AND ${digitStripExpr('p.phone')} LIKE '%' || ? || '%' ESCAPE '\\')
           )
         ORDER BY h.name
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
         ORDER BY h.name
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

export interface KioskChildStatus {
  memberId: number;
  name: string;
  checkins: { checkinId: number; eventId: number; eventName: string; securityCode: string; checkedOutAt: string | null }[];
}

export interface RosterRow {
  checkinId: number;
  childName: string;
  householdName: string;
  eventName: string;
  securityCode: string;
  checkedInAt: string;
  checkedOutAt: string | null;
}

export interface WeeklyStats {
  weeks: { weekStart: string; total: number }[];
  byEvent: { eventId: number; name: string; counts: number[] }[];
  thisWeek: number;
  fourWeekAvg: number;
  distinctChildrenThisMonth: number;
  activeEvents: number;
}

// Unambiguous alphabet for kiosk security codes — no 0/O/1/I/L, which are easy
// to confuse when a parent reads a printed code aloud at pickup.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Random 4-char security code, e.g. `4X7Q`. The code guards child pickup, so
 * the default path uses the CSPRNG (crypto.getRandomValues); the injectable
 * `rand` exists for deterministic tests only. The tiny modulo bias over a
 * 31-char alphabet is acceptable for a staff-supervised 4-char code.
 */
export function generateSecurityCode(rand?: () => number): string {
  let code = '';
  if (rand) {
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    return code;
  }
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return code;
}

/** Sunday that starts the week containing `dateStr` (0=Sunday, per JS getUTCDay). */
function weekStartOf(dateStr: string): string {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return addDays(dateStr, -dow);
}

/**
 * Check in one or more children of a household to an event on `date`. Member
 * ids are validated against `household_id` + `role = 'child'` — ids from
 * another household or belonging to an adult are silently dropped, and if
 * NONE validate the whole call throws `Error('no_children')`. Siblings
 * checking in together share one security code (reused if the household
 * already has a code for this event+date, otherwise freshly generated).
 * Re-checking in an already-checked-in child is idempotent: the duplicate
 * insert is swallowed via `isUniqueViolation` and treated as success. A child
 * who was already checked OUT today (the kiosk makes them pickable again)
 * hits the same unique violation on `(event_id, household_member_id,
 * checkin_date)` — in that case this is a genuine re-admission, so the
 * existing row is re-opened (`checked_out_at` cleared) rather than left
 * checked out under a confirmation that did nothing.
 */
export async function checkInChildren(
  db: AppDb,
  input: { eventId: number; householdId: number; memberIds: number[]; date: string },
): Promise<{ code: string; checkedIn: string[] }> {
  const { eventId, householdId, memberIds, date } = input;
  if (memberIds.length === 0) throw new Error('no_children');

  const placeholders = memberIds.map(() => '?').join(', ');
  const { results: validated } = await db
    .prepare(`SELECT id, display_name FROM household_members WHERE household_id = ? AND role = 'child' AND id IN (${placeholders})`)
    .bind(householdId, ...memberIds)
    .all<{ id: number; display_name: string }>();
  if (validated.length === 0) throw new Error('no_children');

  const existing = await db
    .prepare(`SELECT security_code FROM checkins WHERE event_id = ? AND household_id = ? AND checkin_date = ? LIMIT 1`)
    .bind(eventId, householdId, date)
    .first<{ security_code: string }>();
  const code = existing?.security_code ?? generateSecurityCode();

  // Sequential (not batched): each insert independently swallows a duplicate
  // (already checked in today) without aborting the siblings around it.
  for (const child of validated) {
    try {
      await db
        .prepare(
          `INSERT INTO checkins (event_id, household_id, household_member_id, child_name, security_code, checkin_date)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(eventId, householdId, child.id, child.display_name, code, date)
        .run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Row already exists for this event/child/day — either a duplicate
      // submit (already checked in, no-op) or a re-admission (was checked
      // out, so re-open it).
      await db
        .prepare(`UPDATE checkins SET checked_out_at = NULL WHERE event_id = ? AND household_member_id = ? AND checkin_date = ?`)
        .bind(eventId, child.id, date)
        .run();
    }
  }

  return { code, checkedIn: validated.map((c) => c.display_name) };
}

/**
 * The kiosk's household view for pickup/status: the household plus each
 * child and their check-ins for `date` (possibly across multiple events).
 * Returns null if the household doesn't exist or is soft-deleted.
 */
export async function getHouseholdForKiosk(
  db: AppDb,
  householdId: number,
  date: string,
): Promise<{ id: number; name: string; children: KioskChildStatus[] } | null> {
  const household = await db
    .prepare(`SELECT id, name FROM households WHERE id = ? AND deleted_at IS NULL`)
    .bind(householdId)
    .first<{ id: number; name: string }>();
  if (!household) return null;

  const { results: children } = await db
    .prepare(`SELECT id, display_name FROM household_members WHERE household_id = ? AND role = 'child' ORDER BY id`)
    .bind(householdId)
    .all<{ id: number; display_name: string }>();

  const { results: checkins } = await db
    .prepare(
      `SELECT c.id AS checkinId, c.household_member_id AS memberId, c.event_id AS eventId, e.name AS eventName,
              c.security_code AS securityCode, c.checked_out_at AS checkedOutAt
       FROM checkins c JOIN checkin_events e ON e.id = c.event_id
       WHERE c.household_id = ? AND c.checkin_date = ?`,
    )
    .bind(householdId, date)
    .all<{ checkinId: number; memberId: number; eventId: number; eventName: string; securityCode: string; checkedOutAt: string | null }>();

  return {
    id: household.id,
    name: household.name,
    children: children.map((c) => ({
      memberId: c.id,
      name: c.display_name,
      checkins: checkins
        .filter((ci) => ci.memberId === c.id)
        .map((ci) => ({ checkinId: ci.checkinId, eventId: ci.eventId, eventName: ci.eventName, securityCode: ci.securityCode, checkedOutAt: ci.checkedOutAt })),
    })),
  };
}

/**
 * Parent-facing checkout: requires the security code (case-insensitive) and
 * only closes an open row. Returns false for a wrong code, an already
 * checked-out row, or an unknown checkinId — never throws.
 */
export async function checkOutChild(db: AppDb, input: { checkinId: number; code: string }): Promise<boolean> {
  const { meta } = await db
    .prepare(`UPDATE checkins SET checked_out_at = datetime('now') WHERE id = ? AND checked_out_at IS NULL AND UPPER(security_code) = UPPER(?)`)
    .bind(input.checkinId, input.code)
    .run();
  return meta.changes > 0;
}

/** Staff-facing checkout override: no security code required. */
export async function staffCheckOut(db: AppDb, checkinId: number): Promise<void> {
  await db
    .prepare(`UPDATE checkins SET checked_out_at = datetime('now') WHERE id = ? AND checked_out_at IS NULL`)
    .bind(checkinId)
    .run();
}

/** All check-ins for `date`, joined with child/household/event names, oldest first — the staff roster screen. */
export async function todayRoster(db: AppDb, date: string): Promise<RosterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS checkinId, c.child_name AS childName, h.name AS householdName, e.name AS eventName,
              c.security_code AS securityCode, c.checked_in_at AS checkedInAt, c.checked_out_at AS checkedOutAt
       FROM checkins c
       JOIN households h ON h.id = c.household_id
       JOIN checkin_events e ON e.id = c.event_id
       WHERE c.checkin_date = ?
       ORDER BY c.checked_in_at, c.id`,
    )
    .bind(date)
    .all<RosterRow>();
  return results;
}

/**
 * Admin dashboard stats: a zero-filled `weeksBack`-week (default 12) series
 * of Sunday-starting weeks ending with the week containing `today`, per-event
 * breakdown for the last 4 of those weeks, and a few at-a-glance totals.
 */
export async function weeklyStats(db: AppDb, opts: { today: string; weeksBack?: number }): Promise<WeeklyStats> {
  const weeksBack = opts.weeksBack ?? 12;
  const oldestWeekStart = addDays(weekStartOf(opts.today), -7 * (weeksBack - 1));

  const { results: rows } = await db
    .prepare(
      `SELECT c.checkin_date AS checkinDate, c.event_id AS eventId, e.name AS eventName, COUNT(*) AS n
       FROM checkins c JOIN checkin_events e ON e.id = c.event_id
       WHERE c.checkin_date >= ?
       GROUP BY c.checkin_date, c.event_id, e.name`,
    )
    .bind(oldestWeekStart)
    .all<{ checkinDate: string; eventId: number; eventName: string; n: number }>();

  const weeks = Array.from({ length: weeksBack }, (_, i) => ({ weekStart: addDays(oldestWeekStart, i * 7), total: 0 }));
  const weekIndex = new Map(weeks.map((w, i) => [w.weekStart, i]));

  const byEventMap = new Map<number, { name: string; perWeek: Map<string, number> }>();
  for (const row of rows) {
    const ws = weekStartOf(row.checkinDate);
    const idx = weekIndex.get(ws);
    if (idx === undefined) continue; // outside the window (defensive; shouldn't happen)
    weeks[idx].total += row.n;

    const entry = byEventMap.get(row.eventId) ?? { name: row.eventName, perWeek: new Map<string, number>() };
    entry.perWeek.set(ws, (entry.perWeek.get(ws) ?? 0) + row.n);
    byEventMap.set(row.eventId, entry);
  }

  const last4Weeks = weeks.slice(-4);
  const byEvent = [...byEventMap.entries()].map(([eventId, { name, perWeek }]) => ({
    eventId,
    name,
    counts: last4Weeks.map((w) => perWeek.get(w.weekStart) ?? 0),
  }));

  const thisWeek = weeks[weeks.length - 1].total;
  const fourWeekAvg = Math.round(last4Weeks.reduce((sum, w) => sum + w.total, 0) / last4Weeks.length);

  const monthPrefix = opts.today.slice(0, 7);
  const monthRow = await db
    .prepare(`SELECT COUNT(DISTINCT household_member_id) AS n FROM checkins WHERE checkin_date LIKE ?`)
    .bind(`${monthPrefix}-%`)
    .first<{ n: number }>();
  const distinctChildrenThisMonth = monthRow?.n ?? 0;

  const activeRow = await db.prepare(`SELECT COUNT(*) AS n FROM checkin_events WHERE active = 1`).first<{ n: number }>();
  const activeEvents = activeRow?.n ?? 0;

  return { weeks, byEvent, thisWeek, fourWeekAvg, distinctChildrenThisMonth, activeEvents };
}
