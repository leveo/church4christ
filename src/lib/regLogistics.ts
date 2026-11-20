// Event logistics (the optional `event-logistics` module), shared core: the per-event switches, who may be housed,
// seated or grouped, the guarded write every logistics change runs through, tags, the cancel cascade, the
// board's people list, the overview numbers and what registrants and the check-in desk see. Housing, seating,
// groups and the seating planner live in regHousing.ts, regSeating.ts, regGroups.ts and regSeatPlanner.ts.
// Runs on D1 and Postgres through the AppDb seam; every shared statement is dialect-neutral SQL.
//
// Access: the caller has already run requireRegRole(..., 'manage') for writes or 'view' for reads on `eventId`,
// and checked logisticsModuleEnabled(). Every operation takes that event id and refuses ('not_found') any room,
// table, group, tag or person that belongs to another event: the guard SQL itself compares the target's event
// with the locked event, so a stale or forged id can never write across events.
//
// The guarded write (logisticsWrite) mirrors regAdminCore.guardedWrite on the EVENT row: [lock the event] ->
// [claim: logistics_version = -(v + 1) WHERE <every rule>] -> [work, each statement ANDed with `held`] ->
// [release: logistics_version = v + 1]. The lock serializes every logistics and seat-changing batch on the event,
// so the rules in the claim see every committed change; a rule that fails makes the claim, and so the whole
// batch, a no-op, and the writer re-reads to say exactly why. registrations.version is never touched here.
//
// Who may be placed ("eligible"): an active person on a registration in review or confirmed, or on a waitlisted
// registration once they are checked in. Pending (awaiting payment, may still expire) is not eligible.
// Cancelled people and cancelled or declined registrations are never eligible (`not_active`).
import type { AppDb, AppDbResult, AppStatement } from './appDb';
import { intLit, type NeedsConfirm } from './regAdminCore';
import { decodeChoices, isUniqueViolation, type RegStatus } from './regDb';

export type LogisticsArea = 'housing' | 'seating' | 'groups';
const FLAG: Record<LogisticsArea, string> = { housing: 'housing_enabled', seating: 'seating_enabled', groups: 'groups_enabled' };

/** A soft rule: show `reason` (every applying reason is in `reasons`) and resend with confirm: true. */
export type LogisticsConfirm = NeedsConfirm & { reasons: string[] };

export type LogisticsCode =
  | 'not_found' | 'invalid' | 'disabled' | 'duplicate' | 'conflict' | 'stale'
  | 'not_active' | 'not_eligible' | 'reason_required'
  | 'ROOM_FULL' | 'room_unconfirmed' | 'room_occupied' | 'venue_occupied' | 'in_use' | 'not_occupant'
  | 'table_occupied' | 'not_seated' | 'group_not_empty' | 'not_member' | 'too_many';

export type LogisticsFailure =
  | { ok: false; code: LogisticsCode; errors?: Array<{ path: string; code: string }> }
  | LogisticsConfirm;

export const fail = (code: LogisticsCode, errors?: Array<{ path: string; code: string }>): LogisticsFailure =>
  errors ? { ok: false, code, errors } : { ok: false, code };
export const needsConfirm = (reasons: string[]): LogisticsConfirm => ({ ok: false, code: 'NEEDS_CONFIRM', reason: reasons[0], reasons });

// ── SQL helpers ──────────────────────────────────────────────────────────────

/** `column IN (ids)`; an empty list matches nothing. Every id is a validated integer. */
export const inList = (column: string, ids: readonly number[]): string => (ids.length ? `${column} IN (${ids.map(intLit).join(',')})` : '1 = 0');
/** `column NOT IN (ids)`; an empty list excludes nothing (never `NOT IN ()`/`NOT IN (NULL)`). */
export const notInList = (column: string, ids: readonly number[]): string => (ids.length ? `${column} NOT IN (${ids.map(intLit).join(',')})` : '1 = 1');
/** A text literal for SQL (standard quoting, both backends). Only for short validated labels. */
export const textLit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Person alias `a`, registration alias `r`: may be housed, seated or grouped now. */
export const eligibleSql = (a = 'a', r = 'r'): string =>
  `(${a}.status = 'active' AND (${r}.status IN ('review','confirmed') OR (${r}.status = 'waitlist' AND EXISTS (SELECT 1 FROM reg_checkins ec WHERE ec.attendee_id = ${a}.id))))`;
/** Person alias `a`, registration alias `r`: still on the event (counts toward a room, table or group). */
export const liveSql = (a = 'a', r = 'r'): string => `(${a}.status = 'active' AND ${r}.status NOT IN ('cancelled','declined'))`;

/** How many live people are in `table` (assignment table aliased x) where `where` holds. */
export const liveCountSql = (table: 'reg_room_assignments' | 'reg_table_seats' | 'reg_group_members', where: string): string =>
  `(SELECT COUNT(*) FROM ${table} x JOIN reg_attendees xa ON xa.id = x.attendee_id JOIN registrations xr ON xr.id = xa.registration_id
    WHERE ${where} AND ${liveSql('xa', 'xr')})`;

/** Every listed person is eligible and on event `eventId`. */
export function allEligibleSql(eventId: number, attendeeIds: readonly number[]): string {
  return `(SELECT COUNT(*) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
           WHERE ${inList('a.id', attendeeIds)} AND r.event_id = ${intLit(eventId)} AND ${eligibleSql()}) = ${attendeeIds.length}`;
}

// ── The guarded write ────────────────────────────────────────────────────────

export interface LogisticsWrite {
  /** False when the claim matched nothing: the event is gone, the area is switched off, or a rule failed. */
  claimed: boolean;
  /** The results of `build`'s statements. */
  work: AppDbResult[];
}

/** The predicate that is true only inside a logistics batch after its claim. */
export const heldSql = (eventId: number): string => `EXISTS (SELECT 1 FROM reg_events lh WHERE lh.id = ${intLit(eventId)} AND lh.logistics_version < 0)`;

/**
 * Run `build(held)` under the event's logistics claim. `claimSql` holds every rule (ANDed into the claim, so a
 * failing rule commits nothing); `area` (when given) must be switched on for the event. AND `held` into the
 * WHERE of every statement `build` returns. On success logistics_version moves by one.
 */
export async function logisticsWrite(
  db: AppDb,
  eventId: number,
  area: LogisticsArea | null,
  claimSql: string,
  build: (held: string) => AppStatement[],
): Promise<LogisticsWrite> {
  const id = intLit(eventId);
  const work = build(heldSql(id));
  const results = await db.batch([
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ${id}`),
    db.prepare(
      `UPDATE reg_events SET logistics_version = -logistics_version - 1
       WHERE id = ${id} AND is_template = 0 AND logistics_version >= 0${area ? ` AND ${FLAG[area]} = 1` : ''} AND (${claimSql})`,
    ),
    ...work,
    db.prepare(`UPDATE reg_events SET logistics_version = -logistics_version WHERE id = ${id} AND logistics_version < 0`),
  ]);
  return { claimed: results[1].meta.changes === 1, work: results.slice(2, 2 + work.length) };
}

/** One activity row per listed registration of the event (the history of a logistics change). `detail` is small
 *  JSON: ids, labels staff typed for rooms, tables or groups, and a staff reason; never a token or a link. */
export function activityFor(
  db: AppDb,
  eventId: number,
  registrationIds: readonly number[],
  actor: number | null,
  action: string,
  detail: Record<string, unknown> | null,
  held: string,
): AppStatement {
  return db
    .prepare(
      `INSERT INTO reg_activity (campus_id, event_id, registration_id, actor_person_id, action, detail_json)
       SELECT r.campus_id, r.event_id, r.id, CAST(?1 AS INTEGER), CAST(?2 AS TEXT), CAST(?3 AS TEXT)
       FROM registrations r WHERE ${inList('r.id', [...new Set(registrationIds)])} AND r.event_id = ${intLit(eventId)} AND ${held}`,
    )
    .bind(actor, action, detail === null ? null : JSON.stringify(detail));
}

// ── Event settings ───────────────────────────────────────────────────────────

export interface LogisticsSettings {
  housing: boolean;
  seating: boolean;
  groups: boolean;
  /** Registrants see their room, table and group on the manage page, My events and the reminder email. */
  showAssignments: boolean;
  /** The per-person choice question whose options are the groups of a single-gender room. */
  genderQuestionId: number | null;
  version: number;
}

interface SettingsRow { housing_enabled: number; seating_enabled: number; groups_enabled: number; show_assignments: number; gender_question_id: number | null; logistics_version: number }

const toSettings = (row: SettingsRow): LogisticsSettings => ({
  housing: row.housing_enabled === 1,
  seating: row.seating_enabled === 1,
  groups: row.groups_enabled === 1,
  showAssignments: row.show_assignments === 1,
  genderQuestionId: row.gender_question_id ?? null,
  version: Number(row.logistics_version),
});

/** The event's logistics switches, or null for an unknown event or a template. */
export async function getLogisticsSettings(db: AppDb, eventId: number): Promise<LogisticsSettings | null> {
  if (!Number.isSafeInteger(eventId)) return null;
  const row = await db
    .prepare(
      `SELECT housing_enabled, seating_enabled, groups_enabled, show_assignments, gender_question_id, logistics_version
       FROM reg_events WHERE id = ?1 AND is_template = 0`,
    )
    .bind(eventId)
    .first<SettingsRow>();
  return row ? toSettings(row) : null;
}

export interface LogisticsSettingsInput {
  housing?: boolean;
  seating?: boolean;
  groups?: boolean;
  showAssignments?: boolean;
  /** null clears it. Must be a per-person single-choice (select) question of this event. */
  genderQuestionId?: number | null;
}

/** Change the event's logistics switches (registration admins: the caller checks canEditEvent). Turning an area
 *  off keeps its data; it is only hidden and read-only until it is turned back on. */
export async function saveLogisticsSettings(db: AppDb, eventId: number, input: LogisticsSettingsInput): Promise<{ ok: true; settings: LogisticsSettings } | LogisticsFailure> {
  const current = await getLogisticsSettings(db, eventId);
  if (!current) return fail('not_found');
  let gender = current.genderQuestionId;
  if (input.genderQuestionId !== undefined) {
    gender = input.genderQuestionId;
    if (gender !== null) {
      if (!Number.isSafeInteger(gender)) return fail('invalid', [{ path: 'genderQuestionId', code: 'invalid' }]);
      const question = await db
        .prepare(`SELECT 1 AS present FROM reg_questions WHERE id = ?1 AND event_id = ?2 AND scope = 'attendee' AND type = 'select'`)
        .bind(gender, eventId)
        .first();
      if (!question) return fail('invalid', [{ path: 'genderQuestionId', code: 'not_person_choice' }]);
    }
  }
  const bit = (value: boolean | undefined, now: boolean) => ((value ?? now) ? 1 : 0);
  await db
    .prepare(
      `UPDATE reg_events SET housing_enabled = ?2, seating_enabled = ?3, groups_enabled = ?4, show_assignments = ?5,
              gender_question_id = CAST(?6 AS INTEGER), updated_at = datetime('now')
       WHERE id = ?1 AND is_template = 0`,
    )
    .bind(eventId, bit(input.housing, current.housing), bit(input.seating, current.seating), bit(input.groups, current.groups),
      bit(input.showAssignments, current.showAssignments), gender)
    .run();
  return { ok: true, settings: (await getLogisticsSettings(db, eventId))! };
}

// ── People ───────────────────────────────────────────────────────────────────

export interface LogisticsPerson {
  attendeeId: number;
  registrationId: number;
  eventId: number;
  name: string;
  sort: number;
  status: 'active' | 'cancelled';
  registrationStatus: RegStatus;
  ticketTypeId: number | null;
  /** At the door now (checked in and not checked out). */
  checkedIn: boolean;
  /** Was checked in at some point (a waitlisted person who arrived may be placed). */
  arrived: boolean;
  /** The answer to the event's gender question (an option key), or null. */
  gender: string | null;
  roomId: number | null;
  tableId: number | null;
  groupId: number | null;
}

interface PersonRow {
  attendee_id: number; registration_id: number; event_id: number; name: string; sort: number; status: 'active' | 'cancelled';
  registration_status: RegStatus; ticket_type_id: number | null; checked_in_at: string | null; checked_out_at: string | null;
  gender: string | null; room_id: number | null; table_id: number | null; group_id: number | null;
}

const PERSON_SELECT = `
  SELECT a.id AS attendee_id, a.registration_id AS registration_id, r.event_id AS event_id, a.name AS name, a.sort AS sort,
         a.status AS status, r.status AS registration_status, a.ticket_type_id AS ticket_type_id,
         c.checked_in_at AS checked_in_at, c.checked_out_at AS checked_out_at,
         (SELECT ga.value FROM reg_attendee_answers ga WHERE ga.attendee_id = a.id AND ga.question_id = e.gender_question_id) AS gender,
         ra.room_id AS room_id, ts.table_id AS table_id, gm.group_id AS group_id
  FROM reg_attendees a
  JOIN registrations r ON r.id = a.registration_id
  JOIN reg_events e ON e.id = r.event_id
  LEFT JOIN reg_checkins c ON c.attendee_id = a.id
  LEFT JOIN reg_room_assignments ra ON ra.attendee_id = a.id
  LEFT JOIN reg_table_seats ts ON ts.attendee_id = a.id
  LEFT JOIN reg_group_members gm ON gm.attendee_id = a.id`;

const toPerson = (row: PersonRow): LogisticsPerson => ({
  attendeeId: row.attendee_id,
  registrationId: row.registration_id,
  eventId: row.event_id,
  name: row.name,
  sort: Number(row.sort),
  status: row.status,
  registrationStatus: row.registration_status,
  ticketTypeId: row.ticket_type_id ?? null,
  checkedIn: row.checked_in_at !== null && row.checked_out_at === null,
  arrived: row.checked_in_at !== null,
  gender: row.gender ?? null,
  roomId: row.room_id ?? null,
  tableId: row.table_id ?? null,
  groupId: row.group_id ?? null,
});

/** The listed people on event `eventId` (people of other events are left out, so callers compare sizes). */
export async function loadPeople(db: AppDb, eventId: number, attendeeIds: readonly number[]): Promise<LogisticsPerson[]> {
  const ids = [...new Set(attendeeIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`${PERSON_SELECT} WHERE ${inList('a.id', ids)} AND r.event_id = ?1 ORDER BY a.registration_id, a.sort, a.id`)
    .bind(eventId)
    .all<PersonRow>();
  return results.map(toPerson);
}

/** Every person on one registration of event `eventId`, in party order. */
export async function loadParty(db: AppDb, eventId: number, registrationId: number): Promise<LogisticsPerson[]> {
  const { results } = await db
    .prepare(`${PERSON_SELECT} WHERE a.registration_id = ?1 AND r.event_id = ?2 ORDER BY a.sort, a.id`)
    .bind(registrationId, eventId)
    .all<PersonRow>();
  return results.map(toPerson);
}

/** Why a person may not be placed now, or null when they may. */
export function eligibility(p: Pick<LogisticsPerson, 'status' | 'registrationStatus' | 'arrived'>): null | 'not_active' | 'not_eligible' {
  if (p.status !== 'active' || p.registrationStatus === 'cancelled' || p.registrationStatus === 'declined') return 'not_active';
  if (p.registrationStatus === 'review' || p.registrationStatus === 'confirmed') return null;
  if (p.registrationStatus === 'waitlist' && p.arrived) return null;
  return 'not_eligible';
}

/** The first eligibility failure among `people` ('not_active' wins), or null. */
export function firstIneligible(people: readonly LogisticsPerson[]): null | 'not_active' | 'not_eligible' {
  const codes = people.map(eligibility);
  return codes.includes('not_active') ? 'not_active' : codes.includes('not_eligible') ? 'not_eligible' : null;
}

/** The rest of a person's party that "keep party together" brings along: eligible people on the same registration
 *  who have no room / seat / group yet (the person themself excluded). */
export async function partyToBring(db: AppDb, eventId: number, attendeeId: number, kind: 'room' | 'table' | 'group'): Promise<LogisticsPerson[]> {
  const [person] = await loadPeople(db, eventId, [attendeeId]);
  if (!person) return [];
  const key = kind === 'room' ? 'roomId' : kind === 'table' ? 'tableId' : 'groupId';
  return (await loadParty(db, eventId, person.registrationId)).filter((p) => p.attendeeId !== attendeeId && eligibility(p) === null && p[key] === null);
}

export const MAX_REASON_LENGTH = 200;
const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;

/** A staff reason for the history (trimmed, control characters removed), or null when blank. */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').replace(CONTROL, '').trim();
  return text === '' ? null : text.slice(0, MAX_REASON_LENGTH);
}

export const MAX_LABEL_LENGTH = 80;

/** A staff-typed name or label: trimmed, 1..max characters, no control characters; null when invalid. */
export function cleanLabel(value: unknown, max = MAX_LABEL_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').trim();
  if (text === '' || [...text].length > max || /[\0-\x1f\x7f]/u.test(text)) return null;
  return text;
}

// ── Board data ───────────────────────────────────────────────────────────────

export interface BoardPerson extends LogisticsPerson {
  registrationName: string;
  confirmationNo: string | null;
  eligible: boolean;
  tags: number[];
}

/** Everyone still on the event (active people on live registrations), for the housing, tables and groups boards:
 *  their room, seat, group, tags, ticket type and gender answer; `eligible` says whether they may be placed. */
export async function listLogisticsPeople(db: AppDb, eventId: number): Promise<BoardPerson[]> {
  const { results } = await db
    .prepare(
      `${PERSON_SELECT.replace('a.ticket_type_id AS ticket_type_id,', 'a.ticket_type_id AS ticket_type_id, r.name AS registration_name, r.confirmation_no AS confirmation_no,')}
       WHERE r.event_id = ?1 AND ${liveSql()}
       ORDER BY LOWER(r.name), r.id, a.sort, a.id`,
    )
    .bind(eventId)
    .all<PersonRow & { registration_name: string; confirmation_no: string | null }>();
  const { results: tagRows } = await db
    .prepare(
      `SELECT at.attendee_id AS attendee_id, at.tag_id AS tag_id FROM reg_attendee_tags at JOIN reg_tags t ON t.id = at.tag_id
       WHERE t.event_id = ?1 ORDER BY at.tag_id`,
    )
    .bind(eventId)
    .all<{ attendee_id: number; tag_id: number }>();
  const tags = new Map<number, number[]>();
  for (const row of tagRows) (tags.get(row.attendee_id) ?? tags.set(row.attendee_id, []).get(row.attendee_id)!).push(row.tag_id);
  return results.map((row) => {
    const person = toPerson(row);
    return { ...person, registrationName: row.registration_name, confirmationNo: row.confirmation_no, eligible: eligibility(person) === null, tags: tags.get(person.attendeeId) ?? [] };
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export const TAG_COLORS = ['neutral', 'primary', 'accent', 'info', 'success', 'warn', 'danger'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const MAX_TAGS_PER_EVENT = 100;

export interface RegTag { id: number; label: string; color: TagColor; people: number }

export async function listTags(db: AppDb, eventId: number): Promise<RegTag[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS id, t.label AS label, t.color_token AS color,
              (SELECT COUNT(*) FROM reg_attendee_tags at JOIN reg_attendees a ON a.id = at.attendee_id JOIN registrations r ON r.id = a.registration_id
               WHERE at.tag_id = t.id AND ${liveSql()}) AS people
       FROM reg_tags t WHERE t.event_id = ?1 ORDER BY LOWER(t.label), t.id`,
    )
    .bind(eventId)
    .all<{ id: number; label: string; color: string; people: number }>();
  return results.map((r) => ({ id: r.id, label: r.label, color: (TAG_COLORS as readonly string[]).includes(r.color) ? (r.color as TagColor) : 'neutral', people: Number(r.people) }));
}

const isColor = (value: unknown): value is TagColor => typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);

/** Create a tag on the event. */
export async function createTag(db: AppDb, eventId: number, input: { label: unknown; color?: unknown }): Promise<{ ok: true; id: number } | LogisticsFailure> {
  const label = cleanLabel(input.label, 40);
  if (!label) return fail('invalid', [{ path: 'label', code: 'invalid' }]);
  if (input.color !== undefined && !isColor(input.color)) return fail('invalid', [{ path: 'color', code: 'invalid' }]);
  const tagCount = `(SELECT COUNT(*) FROM reg_tags ct WHERE ct.event_id = ${intLit(eventId)}) < ${MAX_TAGS_PER_EVENT}`;
  try {
    const write = await logisticsWrite(db, eventId, null, tagCount, (held) => [
      db
        .prepare(
          `INSERT INTO reg_tags (campus_id, event_id, label, color_token)
           SELECT e.campus_id, e.id, CAST(?2 AS TEXT), CAST(?3 AS TEXT) FROM reg_events e WHERE e.id = ?1 AND ${held}
           RETURNING id`,
        )
        .bind(eventId, label, input.color ?? 'neutral'),
    ]);
    if (!write.claimed) return (await getLogisticsSettings(db, eventId)) ? fail('too_many') : fail('not_found');
    return { ok: true, id: (write.work[0].results[0] as { id: number }).id };
  } catch (error) {
    if (isUniqueViolation(error)) return fail('duplicate', [{ path: 'label', code: 'duplicate' }]);
    throw error;
  }
}

/** Rename or recolor a tag of the event. */
export async function updateTag(db: AppDb, eventId: number, tagId: number, input: { label?: unknown; color?: unknown }): Promise<{ ok: true } | LogisticsFailure> {
  const label = input.label === undefined ? undefined : cleanLabel(input.label, 40);
  if (label === null) return fail('invalid', [{ path: 'label', code: 'invalid' }]);
  if (input.color !== undefined && !isColor(input.color)) return fail('invalid', [{ path: 'color', code: 'invalid' }]);
  const tag = await db.prepare(`SELECT label, color_token FROM reg_tags WHERE id = ?1 AND event_id = ?2`).bind(tagId, eventId).first<{ label: string; color_token: string }>();
  if (!tag) return fail('not_found');
  try {
    const write = await logisticsWrite(db, eventId, null, `EXISTS (SELECT 1 FROM reg_tags t WHERE t.id = ${intLit(tagId)} AND t.event_id = ${intLit(eventId)})`, (held) => [
      db.prepare(`UPDATE reg_tags SET label = ?2, color_token = ?3 WHERE id = ?1 AND ${held}`).bind(tagId, label ?? tag.label, input.color ?? tag.color_token),
    ]);
    return write.claimed ? { ok: true } : fail('not_found');
  } catch (error) {
    if (isUniqueViolation(error)) return fail('duplicate', [{ path: 'label', code: 'duplicate' }]);
    throw error;
  }
}

/** Delete a tag (and take it off everyone). Seating rules that named it simply stop applying. */
export async function deleteTag(db: AppDb, eventId: number, tagId: number): Promise<{ ok: true } | LogisticsFailure> {
  const write = await logisticsWrite(db, eventId, null, `EXISTS (SELECT 1 FROM reg_tags t WHERE t.id = ${intLit(tagId)} AND t.event_id = ${intLit(eventId)})`, (held) => [
    db.prepare(`DELETE FROM reg_tags WHERE id = ?1 AND ${held}`).bind(tagId),
  ]);
  return write.claimed ? { ok: true } : fail('not_found');
}

export const MAX_BULK_PEOPLE = 500;

/** Put a tag on (on: true) or take it off (on: false) the listed people. Cancelled people may be untagged but not
 *  tagged. Answers how many people changed. */
export async function setTag(
  db: AppDb,
  eventId: number,
  input: { tagId: number; attendeeIds: number[]; on: boolean },
  opts: { actor: number | null },
): Promise<{ ok: true; changed: number } | LogisticsFailure> {
  if (!Array.isArray(input.attendeeIds) || input.attendeeIds.length === 0) return fail('invalid', [{ path: 'attendeeIds', code: 'invalid' }]);
  if (input.attendeeIds.length > MAX_BULK_PEOPLE) return fail('too_many');
  const people = await loadPeople(db, eventId, input.attendeeIds);
  if (people.length !== new Set(input.attendeeIds).size) return fail('not_found');
  const tag = await db.prepare(`SELECT label FROM reg_tags WHERE id = ?1 AND event_id = ?2`).bind(input.tagId, eventId).first<{ label: string }>();
  if (!tag) return fail('not_found');
  const ids = people.filter((p) => !input.on || eligibility(p) !== 'not_active').map((p) => p.attendeeId);
  if (ids.length === 0) return fail('not_active');
  const registrations = [...new Set(people.filter((p) => ids.includes(p.attendeeId)).map((p) => p.registrationId))];
  const tagOk = `EXISTS (SELECT 1 FROM reg_tags t WHERE t.id = ${intLit(input.tagId)} AND t.event_id = ${intLit(eventId)})`;
  const write = await logisticsWrite(db, eventId, null, tagOk, (held) => [
    input.on
      ? db
          .prepare(
            `INSERT INTO reg_attendee_tags (campus_id, attendee_id, tag_id)
             SELECT a.campus_id, a.id, CAST(?1 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
             WHERE ${inList('a.id', ids)} AND r.event_id = ${intLit(eventId)} AND ${liveSql()} AND ${held}
             ON CONFLICT (attendee_id, tag_id) DO NOTHING`,
          )
          .bind(input.tagId)
      : db.prepare(`DELETE FROM reg_attendee_tags WHERE tag_id = ?1 AND ${inList('attendee_id', ids)} AND ${held}`).bind(input.tagId),
    activityFor(db, eventId, registrations, opts.actor, input.on ? 'tagged' : 'untagged', { tagId: input.tagId, tag: tag.label, attendeeIds: ids }, held),
  ]);
  if (!write.claimed) return fail('not_found');
  return { ok: true, changed: write.work[0].meta.changes };
}

/** "Tag everyone who answered `option` to `questionId`": a one-off apply (later answers are not followed). A
 *  per-person question tags the person; a once-per-registration question tags everyone on the registration.
 *  Only people still on the event are tagged. */
export async function applyTagByAnswer(
  db: AppDb,
  eventId: number,
  input: { tagId: number; questionId: number; option: string },
  opts: { actor: number | null },
): Promise<{ ok: true; tagged: number; matched: number } | LogisticsFailure> {
  const question = await db
    .prepare(`SELECT scope, type, options FROM reg_questions WHERE id = ?1 AND event_id = ?2`)
    .bind(input.questionId, eventId)
    .first<{ scope: 'registration' | 'attendee'; type: string; options: string | null }>();
  if (!question || !['select', 'checkbox', 'yesno'].includes(question.type)) return fail('invalid', [{ path: 'questionId', code: 'not_choice' }]);
  const options = question.type === 'yesno' ? ['yes', 'no'] : (() => { try { return JSON.parse(question.options ?? '[]') as string[]; } catch { return []; } })();
  if (typeof input.option !== 'string' || !options.includes(input.option)) return fail('invalid', [{ path: 'option', code: 'invalid' }]);
  const tag = await db.prepare(`SELECT label FROM reg_tags WHERE id = ?1 AND event_id = ?2`).bind(input.tagId, eventId).first<{ label: string }>();
  if (!tag) return fail('not_found');
  const matches = (raw: string) => (question.type === 'checkbox' ? decodeChoices(raw).includes(input.option) : raw === input.option);
  const rows = question.scope === 'attendee'
    ? (await db
        .prepare(
          `SELECT a.id AS attendee_id, a.registration_id AS registration_id, aa.value AS value
           FROM reg_attendee_answers aa JOIN reg_attendees a ON a.id = aa.attendee_id JOIN registrations r ON r.id = a.registration_id
           WHERE aa.question_id = ?1 AND r.event_id = ?2 AND ${liveSql()}`,
        )
        .bind(input.questionId, eventId)
        .all<{ attendee_id: number; registration_id: number; value: string }>()).results
    : (await db
        .prepare(
          `SELECT a.id AS attendee_id, a.registration_id AS registration_id, ans.value AS value
           FROM reg_answers ans JOIN registrations r ON r.id = ans.registration_id JOIN reg_attendees a ON a.registration_id = r.id
           WHERE ans.question_id = ?1 AND r.event_id = ?2 AND ${liveSql()}`,
        )
        .bind(input.questionId, eventId)
        .all<{ attendee_id: number; registration_id: number; value: string }>()).results;
  const hit = rows.filter((r) => matches(r.value));
  if (hit.length === 0) return { ok: true, tagged: 0, matched: 0 };
  if (hit.length > MAX_BULK_PEOPLE * 4) return fail('too_many');
  const ids = hit.map((r) => r.attendee_id);
  const tagOk = `EXISTS (SELECT 1 FROM reg_tags t WHERE t.id = ${intLit(input.tagId)} AND t.event_id = ${intLit(eventId)})`;
  const write = await logisticsWrite(db, eventId, null, tagOk, (held) => [
    db
      .prepare(
        `INSERT INTO reg_attendee_tags (campus_id, attendee_id, tag_id)
         SELECT a.campus_id, a.id, CAST(?1 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         WHERE ${inList('a.id', ids)} AND r.event_id = ${intLit(eventId)} AND ${liveSql()} AND ${held}
         ON CONFLICT (attendee_id, tag_id) DO NOTHING`,
      )
      .bind(input.tagId),
    activityFor(db, eventId, hit.map((r) => r.registration_id), opts.actor, 'tagged', { tagId: input.tagId, tag: tag.label, questionId: input.questionId, option: input.option }, held),
  ]);
  if (!write.claimed) return fail('not_found');
  return { ok: true, tagged: write.work[0].meta.changes, matched: ids.length };
}

// ── Cancel cascade ───────────────────────────────────────────────────────────

// The statements live in a leaf module (regDb's cancel path imports them, and regDb must not import this file).
export { releaseLogisticsStatements } from './regLogisticsRelease';

// ── What registrants and the desk see ────────────────────────────────────────

export interface AttendeeAssignments {
  /** Present when housing is on for the event: the room, or null = not assigned yet. */
  room?: { label: string; venue: string } | null;
  /** Present when seating is on: the table, or null = not seated yet. */
  table?: { label: string } | null;
  /** Present when small groups are on: the group, or null = not in a group yet. */
  group?: { name: string } | null;
}

/**
 * Room, table and group per person for the listed people of event `eventId`, for the areas switched on for the
 * event. `forRegistrant` also requires the event's show_assignments switch. Null when nothing is to be shown.
 * The caller decides whether the module is on (logisticsModuleEnabled) and only calls this when it is.
 */
export async function assignmentsForAttendees(
  db: AppDb,
  eventId: number,
  attendeeIds: readonly number[],
  opts: { forRegistrant?: boolean } = {},
): Promise<Map<number, AttendeeAssignments> | null> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings || (!settings.housing && !settings.seating && !settings.groups)) return null;
  if (opts.forRegistrant && !settings.showAssignments) return null;
  const ids = [...new Set(attendeeIds)];
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT a.id AS attendee_id, rm.label AS room_label, v.name AS venue_name, tb.label AS table_label, g.name AS group_name
       FROM reg_attendees a
       JOIN registrations r ON r.id = a.registration_id
       LEFT JOIN reg_room_assignments ra ON ra.attendee_id = a.id
       LEFT JOIN reg_rooms rm ON rm.id = ra.room_id
       LEFT JOIN reg_venues v ON v.id = rm.venue_id
       LEFT JOIN reg_table_seats ts ON ts.attendee_id = a.id
       LEFT JOIN reg_tables tb ON tb.id = ts.table_id
       LEFT JOIN reg_group_members gm ON gm.attendee_id = a.id
       LEFT JOIN reg_groups g ON g.id = gm.group_id
       WHERE ${inList('a.id', ids)} AND r.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ attendee_id: number; room_label: string | null; venue_name: string | null; table_label: string | null; group_name: string | null }>();
  const out = new Map<number, AttendeeAssignments>();
  for (const row of results) {
    const entry: AttendeeAssignments = {};
    if (settings.housing) entry.room = row.room_label !== null ? { label: row.room_label, venue: row.venue_name ?? '' } : null;
    if (settings.seating) entry.table = row.table_label !== null ? { label: row.table_label } : null;
    if (settings.groups) entry.group = row.group_name !== null ? { name: row.group_name } : null;
    out.set(row.attendee_id, entry);
  }
  return out;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface LogisticsOverview {
  /** People who may be placed now (see eligibility). */
  people: number;
  housing: { enabled: boolean; assigned: number; rooms: number; confirmedRooms: number; beds: number };
  seating: { enabled: boolean; seated: number; tables: number; seats: number };
  groups: { enabled: boolean; placed: number; groups: number };
}

/** Housing, seating and group progress for the event page's overview; null for an unknown event. */
export async function logisticsOverview(db: AppDb, eventId: number): Promise<LogisticsOverview | null> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return null;
  const eligible = `FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = ?1 AND ${eligibleSql()}`;
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) ${eligible}) AS people,
              (SELECT COUNT(*) ${eligible} AND EXISTS (SELECT 1 FROM reg_room_assignments x WHERE x.attendee_id = a.id)) AS assigned,
              (SELECT COUNT(*) ${eligible} AND EXISTS (SELECT 1 FROM reg_table_seats x WHERE x.attendee_id = a.id)) AS seated,
              (SELECT COUNT(*) ${eligible} AND EXISTS (SELECT 1 FROM reg_group_members x WHERE x.attendee_id = a.id)) AS placed,
              (SELECT COUNT(*) FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE v.event_id = ?1) AS rooms,
              (SELECT COUNT(*) FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE v.event_id = ?1 AND rm.confirmed = 1) AS confirmed_rooms,
              (SELECT COALESCE(SUM(COALESCE(rm.beds_override, rt.beds)), 0) FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id
               LEFT JOIN reg_room_types rt ON rt.id = rm.room_type_id WHERE v.event_id = ?1 AND rm.confirmed = 1) AS beds,
              (SELECT COUNT(*) FROM reg_tables t WHERE t.event_id = ?1) AS tables,
              (SELECT COALESCE(SUM(t.seats), 0) FROM reg_tables t WHERE t.event_id = ?1) AS seats,
              (SELECT COUNT(*) FROM reg_groups g WHERE g.event_id = ?1) AS groups_count`,
    )
    .bind(eventId)
    .first<Record<string, number>>();
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    people: n('people'),
    housing: { enabled: settings.housing, assigned: n('assigned'), rooms: n('rooms'), confirmedRooms: n('confirmed_rooms'), beds: n('beds') },
    seating: { enabled: settings.seating, seated: n('seated'), tables: n('tables'), seats: n('seats') },
    groups: { enabled: settings.groups, placed: n('placed'), groups: n('groups_count') },
  };
}
