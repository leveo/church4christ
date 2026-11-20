// Event logistics, housing: venues, room types and rooms (with range entry), confirming rooms, and putting people
// in rooms (assign with "keep party together", move, swap, clear, room leader). Every rule is enforced in the
// claim of one guarded batch (regLogistics.logisticsWrite) and pre-checked to answer precisely:
//   hard (refused):   room_unconfirmed, ROOM_FULL (venue capacity rule 'hard'), not_active (cancelled person or
//                     registration), not_eligible (see regLogistics.eligibility), reason_required (moving or
//                     removing someone who is checked in needs a reason, kept in the history), not_found (any id
//                     of another event)
//   soft (confirm):   room_over_capacity ('soft' rule), room_other_party (policy one_party), room_mixed_gender /
//                     gender_unknown / gender_question_missing (policy single_gender)
// The caller has checked requireRegRole(..., 'manage') (writes) or 'view' (listHousing) on `eventId` and that the
// module is on. Writes also need the event's housing switch (else 'disabled').
import type { AppDb } from './appDb';
import { intLit } from './regAdminCore';
import { isUniqueViolation } from './regDb';
import {
  activityFor, allEligibleSql, cleanLabel, cleanReason, eligibility, fail, firstIneligible, getLogisticsSettings, inList, liveCountSql,
  liveSql, loadParty, loadPeople, logisticsWrite, needsConfirm, notInList, textLit,
  type LogisticsFailure, type LogisticsPerson, type LogisticsSettings,
} from './regLogistics';

export const VENUE_KINDS = ['hotel', 'dorm', 'campsite', 'other'] as const;
export type VenueKind = (typeof VENUE_KINDS)[number];
export type CapacityRule = 'hard' | 'soft';
export const ROOM_POLICIES = ['any', 'single_gender', 'one_party'] as const;
export type RoomPolicy = (typeof ROOM_POLICIES)[number];

/** Dorms and campsites have a fixed number of beds; hotels and other venues can usually take a cot. */
export const defaultCapacityRule = (kind: VenueKind): CapacityRule => (kind === 'dorm' || kind === 'campsite' ? 'hard' : 'soft');

export const MAX_ROOMS_PER_CALL = 500;
export const MAX_ROOM_LABEL_LENGTH = 40;
export const MAX_BEDS = 100;

// ── Range entry ──────────────────────────────────────────────────────────────

export type RoomLabelsResult =
  | { ok: true; labels: string[] }
  | { ok: false; code: 'empty' | 'too_many' | 'reversed' | 'bad_range' | 'too_long'; segment?: string };

const RANGE = /^(.*?)(\d+)\s*[-–—~]\s*(\D*?)(\d+)$/u;

/**
 * "101-120, A1-A6, Loft" -> ["101", ..., "120", "A1", ..., "A6", "Loft"]. Segments are separated by commas,
 * semicolons or new lines (also the full-width comma and the ideographic comma). A range keeps a shared letter
 * prefix ("A1-A6", "B01-B12": the second prefix may be left out, "B01-12") and the zero-padding of its start
 * ("001-010"). Anything else is one label as typed. Duplicates are dropped, first one kept. Refused: a reversed
 * range, mismatched prefixes, more than MAX_ROOMS_PER_CALL labels in all, a label longer than 40 characters.
 */
export function parseRoomLabels(text: string): RoomLabelsResult {
  const segments = String(text ?? '').normalize('NFC').split(/[,;\n\r，、；]+/u).map((s) => s.trim()).filter((s) => s !== '');
  if (segments.length === 0) return { ok: false, code: 'empty' };
  const seen = new Set<string>();
  const labels: string[] = [];
  const add = (label: string): boolean => {
    if (seen.has(label)) return true;
    seen.add(label);
    labels.push(label);
    return labels.length <= MAX_ROOMS_PER_CALL;
  };
  for (const segment of segments) {
    const m = RANGE.exec(segment);
    if (!m) {
      if ([...segment].length > MAX_ROOM_LABEL_LENGTH || /[\0-\x1f\x7f]/u.test(segment)) return { ok: false, code: 'too_long', segment };
      if (!add(segment)) return { ok: false, code: 'too_many' };
      continue;
    }
    const [, prefix, startText, secondPrefix, endText] = m;
    if (secondPrefix !== '' && secondPrefix !== prefix) return { ok: false, code: 'bad_range', segment };
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false, code: 'bad_range', segment };
    if (end < start) return { ok: false, code: 'reversed', segment };
    if (end - start + 1 > MAX_ROOMS_PER_CALL) return { ok: false, code: 'too_many', segment };
    const width = startText.length > 1 && startText.startsWith('0') ? startText.length : 0;
    for (let n = start; n <= end; n++) {
      const label = `${prefix}${String(n).padStart(width, '0')}`;
      if ([...label].length > MAX_ROOM_LABEL_LENGTH) return { ok: false, code: 'too_long', segment };
      if (!add(label)) return { ok: false, code: 'too_many' };
    }
  }
  return { ok: true, labels };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface HousingRoom {
  id: number;
  venueId: number;
  label: string;
  floor: string | null;
  notes: string | null;
  roomTypeId: number | null;
  bedsOverride: number | null;
  beds: number;
  policy: RoomPolicy;
  confirmed: boolean;
  leaderAttendeeId: number | null;
  /** Live occupants (attendee ids), in assignment order. */
  occupants: number[];
}

export interface HousingVenue {
  id: number;
  name: string;
  kind: VenueKind;
  capacityRule: CapacityRule;
  roomTypes: Array<{ id: number; name: string; beds: number; rooms: number }>;
  rooms: HousingRoom[];
}

/** Every venue of the event with its room types and rooms (label order as entered) and who is in each room. */
export async function listHousing(db: AppDb, eventId: number): Promise<HousingVenue[]> {
  const [venues, types, rooms, occupants] = await db.batch([
    db.prepare(`SELECT id, name, kind, capacity_rule FROM reg_venues WHERE event_id = ?1 ORDER BY sort, id`).bind(eventId),
    db
      .prepare(
        `SELECT t.id AS id, t.venue_id AS venue_id, t.name AS name, t.beds AS beds,
                (SELECT COUNT(*) FROM reg_rooms c WHERE c.room_type_id = t.id) AS rooms
         FROM reg_room_types t JOIN reg_venues v ON v.id = t.venue_id WHERE v.event_id = ?1 ORDER BY t.id`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT rm.id AS id, rm.venue_id AS venue_id, rm.label AS label, rm.floor AS floor, rm.notes AS notes, rm.room_type_id AS room_type_id,
                rm.beds_override AS beds_override, COALESCE(rm.beds_override, rt.beds) AS beds, rm.policy AS policy, rm.confirmed AS confirmed,
                rm.leader_attendee_id AS leader_attendee_id
         FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id LEFT JOIN reg_room_types rt ON rt.id = rm.room_type_id
         WHERE v.event_id = ?1 ORDER BY rm.venue_id, rm.sort, rm.id`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT x.room_id AS room_id, x.attendee_id AS attendee_id
         FROM reg_room_assignments x JOIN reg_attendees a ON a.id = x.attendee_id JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND ${liveSql()} ORDER BY x.assigned_at, x.attendee_id`,
      )
      .bind(eventId),
  ]);
  const byRoom = new Map<number, number[]>();
  for (const o of occupants.results as Array<{ room_id: number; attendee_id: number }>) (byRoom.get(o.room_id) ?? byRoom.set(o.room_id, []).get(o.room_id)!).push(o.attendee_id);
  type RoomRow = { id: number; venue_id: number; label: string; floor: string | null; notes: string | null; room_type_id: number | null; beds_override: number | null; beds: number; policy: RoomPolicy; confirmed: number; leader_attendee_id: number | null };
  return (venues.results as Array<{ id: number; name: string; kind: VenueKind; capacity_rule: CapacityRule }>).map((v) => ({
    id: v.id,
    name: v.name,
    kind: v.kind,
    capacityRule: v.capacity_rule,
    roomTypes: (types.results as Array<{ id: number; venue_id: number; name: string; beds: number; rooms: number }>)
      .filter((t) => t.venue_id === v.id)
      .map((t) => ({ id: t.id, name: t.name, beds: Number(t.beds), rooms: Number(t.rooms) })),
    rooms: (rooms.results as RoomRow[])
      .filter((r) => r.venue_id === v.id)
      .map((r) => ({
        id: r.id, venueId: r.venue_id, label: r.label, floor: r.floor, notes: r.notes, roomTypeId: r.room_type_id, bedsOverride: r.beds_override,
        beds: Number(r.beds), policy: r.policy, confirmed: r.confirmed === 1, leaderAttendeeId: r.leader_attendee_id, occupants: byRoom.get(r.id) ?? [],
      })),
  }));
}

interface RoomCtx {
  id: number;
  label: string;
  venueId: number;
  venueName: string;
  capacityRule: CapacityRule;
  beds: number;
  policy: RoomPolicy;
  confirmed: boolean;
  leaderAttendeeId: number | null;
}

async function loadRoom(db: AppDb, eventId: number, roomId: number): Promise<RoomCtx | null> {
  if (!Number.isSafeInteger(roomId) || roomId < 1) return null;
  const row = await db
    .prepare(
      `SELECT rm.id AS id, rm.label AS label, v.id AS venue_id, v.name AS venue_name, v.capacity_rule AS capacity_rule,
              COALESCE(rm.beds_override, rt.beds) AS beds, rm.policy AS policy, rm.confirmed AS confirmed, rm.leader_attendee_id AS leader_attendee_id
       FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id LEFT JOIN reg_room_types rt ON rt.id = rm.room_type_id
       WHERE rm.id = ?1 AND v.event_id = ?2`,
    )
    .bind(roomId, eventId)
    .first<{ id: number; label: string; venue_id: number; venue_name: string; capacity_rule: CapacityRule; beds: number; policy: RoomPolicy; confirmed: number; leader_attendee_id: number | null }>();
  return row
    ? { id: row.id, label: row.label, venueId: row.venue_id, venueName: row.venue_name, capacityRule: row.capacity_rule, beds: Number(row.beds), policy: row.policy, confirmed: row.confirmed === 1, leaderAttendeeId: row.leader_attendee_id }
    : null;
}

async function roomOccupants(db: AppDb, eventId: number, roomId: number): Promise<LogisticsPerson[]> {
  const { results } = await db
    .prepare(
      `SELECT x.attendee_id AS id FROM reg_room_assignments x JOIN reg_attendees a ON a.id = x.attendee_id JOIN registrations r ON r.id = a.registration_id
       WHERE x.room_id = ?1 AND ${liveSql()}`,
    )
    .bind(roomId)
    .all<{ id: number }>();
  return loadPeople(db, eventId, results.map((r) => r.id));
}

// ── Rules ────────────────────────────────────────────────────────────────────

type Verdict = { hard: LogisticsFailure | null; soft: string[] };

/** The rules for `incoming` people entering `room` while `leaving` (attendee ids) leave or are already counted. */
function roomVerdict(
  room: RoomCtx,
  occupants: readonly LogisticsPerson[],
  incoming: readonly LogisticsPerson[],
  leaving: readonly number[],
  settings: LogisticsSettings,
  checkCapacity: boolean,
): Verdict {
  if (!room.confirmed) return { hard: fail('room_unconfirmed'), soft: [] };
  const ineligible = firstIneligible(incoming);
  if (ineligible) return { hard: fail(ineligible), soft: [] };
  const away = new Set([...leaving, ...incoming.map((p) => p.attendeeId)]);
  const stay = occupants.filter((p) => !away.has(p.attendeeId));
  const soft: string[] = [];
  if (checkCapacity && stay.length + incoming.length > room.beds) {
    if (room.capacityRule === 'hard') return { hard: fail('ROOM_FULL'), soft: [] };
    soft.push('room_over_capacity');
  }
  const everyone = [...stay, ...incoming];
  if (room.policy === 'one_party' && new Set(everyone.map((p) => p.registrationId)).size > 1) soft.push('room_other_party');
  if (room.policy === 'single_gender') {
    if (settings.genderQuestionId === null) soft.push('gender_question_missing');
    else if (everyone.some((p) => p.gender === null)) soft.push('gender_unknown');
    else if (new Set(everyone.map((p) => p.gender)).size > 1) soft.push('room_mixed_gender');
  }
  return { hard: null, soft };
}

/** The claim predicate twin of roomVerdict (soft rules only without confirm). */
function roomRulesSql(
  eventId: number,
  room: RoomCtx,
  incoming: readonly LogisticsPerson[],
  leaving: readonly number[],
  settings: LogisticsSettings,
  opts: { confirm: boolean; capacity: boolean },
): string {
  const R = intLit(room.id);
  const E = intLit(eventId);
  const ids = incoming.map((p) => p.attendeeId);
  const away = [...new Set([...leaving, ...ids])];
  const stayWhere = `x.room_id = ${R} AND ${notInList('x.attendee_id', away)}`;
  const parts = [
    `EXISTS (SELECT 1 FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ${R} AND v.event_id = ${E} AND rm.confirmed = 1)`,
    allEligibleSql(eventId, ids),
  ];
  if (opts.capacity) {
    const fits = `${liveCountSql('reg_room_assignments', stayWhere)} + ${ids.length}
      <= (SELECT COALESCE(rm.beds_override, rt.beds) FROM reg_rooms rm LEFT JOIN reg_room_types rt ON rt.id = rm.room_type_id WHERE rm.id = ${R})`;
    const soft = `(SELECT v.capacity_rule FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ${R}) = 'soft'`;
    parts.push(opts.confirm ? `(${fits} OR ${soft})` : fits);
  }
  if (!opts.confirm) {
    const policy = `(SELECT pr.policy FROM reg_rooms pr WHERE pr.id = ${R})`;
    const regs = [...new Set(incoming.map((p) => p.registrationId))];
    const oneParty = regs.length > 1
      ? '1 = 0'
      : `NOT EXISTS (SELECT 1 FROM reg_room_assignments x JOIN reg_attendees xa ON xa.id = x.attendee_id JOIN registrations xr ON xr.id = xa.registration_id
                     WHERE ${stayWhere} AND ${liveSql('xa', 'xr')} AND ${notInList('xa.registration_id', regs)})`;
    const genders = [...new Set(incoming.map((p) => p.gender))];
    const singleGender = settings.genderQuestionId === null || genders.length !== 1 || genders[0] === null
      ? '1 = 0'
      : `NOT EXISTS (SELECT 1 FROM reg_room_assignments x JOIN reg_attendees xa ON xa.id = x.attendee_id JOIN registrations xr ON xr.id = xa.registration_id
                     WHERE ${stayWhere} AND ${liveSql('xa', 'xr')}
                       AND COALESCE((SELECT ga.value FROM reg_attendee_answers ga WHERE ga.attendee_id = x.attendee_id AND ga.question_id = ${intLit(settings.genderQuestionId)}), '') <> ${textLit(genders[0])})`;
    parts.push(`(${policy} = 'any' OR (${policy} = 'one_party' AND ${oneParty}) OR (${policy} = 'single_gender' AND ${singleGender}))`);
  }
  return parts.join(' AND ');
}

/** Whether moving or removing these people needs a reason (someone checked in is changing rooms). */
const needsReason = (people: readonly LogisticsPerson[]): boolean => people.some((p) => p.checkedIn && p.roomId !== null);

async function housingContext(db: AppDb, eventId: number): Promise<{ settings: LogisticsSettings } | LogisticsFailure> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return fail('not_found');
  if (!settings.housing) return fail('disabled');
  return { settings };
}

// ── Assign / move ────────────────────────────────────────────────────────────

export interface AssignRoomInput {
  attendeeId: number;
  roomId: number;
  /** Keep party together (default true): also bring the rest of the registration's eligible people who have no room. */
  party?: boolean;
  confirm?: boolean;
  /** Required when someone checked in moves rooms. */
  reason?: string;
}

export type AssignRoomResult = { ok: true; moved: number[] } | LogisticsFailure;

interface AssignPlan { settings: LogisticsSettings; room: RoomCtx; movers: LogisticsPerson[]; soft: string[]; reason: string | null; registrationId: number }

async function planAssign(db: AppDb, eventId: number, input: AssignRoomInput): Promise<AssignPlan | LogisticsFailure | { ok: true; moved: number[] }> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const room = await loadRoom(db, eventId, input.roomId);
  if (!room) return fail('not_found');
  const [person] = await loadPeople(db, eventId, [input.attendeeId]);
  if (!person) return fail('not_found');
  let movers = [person];
  if (input.party !== false) {
    const rest = (await loadParty(db, eventId, person.registrationId)).filter((p) => p.attendeeId !== person.attendeeId && p.roomId === null && eligibility(p) === null);
    movers = [person, ...rest];
  }
  movers = movers.filter((p) => p.roomId !== room.id);
  if (movers.length === 0) return { ok: true, moved: [] };
  const occupants = await roomOccupants(db, eventId, room.id);
  const verdict = roomVerdict(room, occupants, movers, [], ctx.settings, true);
  if (verdict.hard) return verdict.hard;
  const reason = cleanReason(input.reason);
  if (needsReason(movers) && !reason) return fail('reason_required');
  if (verdict.soft.length > 0 && !input.confirm) return needsConfirm(verdict.soft);
  return { settings: ctx.settings, room, movers, soft: verdict.soft, reason, registrationId: person.registrationId };
}

/** Put a person (and, by default, the rest of their party who have no room yet) in a room, or move them there. */
export async function assignRoom(db: AppDb, eventId: number, input: AssignRoomInput, opts: { actor: number | null }): Promise<AssignRoomResult> {
  const plan = await planAssign(db, eventId, input);
  if (!('movers' in plan)) return plan;
  const ids = plan.movers.map((p) => p.attendeeId);
  const from = plan.movers.filter((p) => p.roomId !== null).map((p) => ({ attendeeId: p.attendeeId, roomId: p.roomId }));
  const write = await logisticsWrite(db, eventId, 'housing', roomRulesSql(eventId, plan.room, plan.movers, [], plan.settings, { confirm: input.confirm === true, capacity: true }), (held) => [
    db
      .prepare(
        `INSERT INTO reg_room_assignments (campus_id, attendee_id, room_id, assigned_by)
         SELECT a.campus_id, a.id, CAST(?1 AS INTEGER), CAST(?2 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         WHERE ${inList('a.id', ids)} AND r.event_id = ${intLit(eventId)} AND ${held}
         ON CONFLICT (attendee_id) DO UPDATE SET room_id = excluded.room_id, assigned_by = excluded.assigned_by, assigned_at = datetime('now')`,
      )
      .bind(plan.room.id, opts.actor),
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = NULL WHERE ${inList('leader_attendee_id', ids)} AND id <> ?1 AND ${held}`).bind(plan.room.id),
    activityFor(db, eventId, [plan.registrationId], opts.actor, from.length > 0 ? 'room_moved' : 'room_assigned', {
      roomId: plan.room.id, room: plan.room.label, venue: plan.room.venueName, attendeeIds: ids,
      ...(from.length > 0 ? { from } : {}), ...(plan.reason ? { reason: plan.reason } : {}), ...(plan.soft.length > 0 ? { override: plan.soft } : {}),
    }, held),
  ]);
  if (write.claimed) return { ok: true, moved: ids };
  const again = await planAssign(db, eventId, input);
  return 'movers' in again || ('ok' in again && again.ok) ? fail('conflict') : again;
}

/** Take a person out of their room. Someone checked in needs a reason. */
export async function unassignRoom(
  db: AppDb,
  eventId: number,
  input: { attendeeId: number; reason?: string },
  opts: { actor: number | null },
): Promise<{ ok: true; changed: boolean } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const [person] = await loadPeople(db, eventId, [input.attendeeId]);
  if (!person) return fail('not_found');
  if (person.roomId === null) return { ok: true, changed: false };
  const room = await loadRoom(db, eventId, person.roomId);
  if (!room) return fail('not_found');
  const reason = cleanReason(input.reason);
  if (needsReason([person]) && !reason) return fail('reason_required');
  const A = intLit(person.attendeeId);
  const write = await logisticsWrite(db, eventId, 'housing', `EXISTS (SELECT 1 FROM reg_room_assignments x JOIN reg_rooms rm ON rm.id = x.room_id JOIN reg_venues v ON v.id = rm.venue_id WHERE x.attendee_id = ${A} AND v.event_id = ${intLit(eventId)})`, (held) => [
    db.prepare(`DELETE FROM reg_room_assignments WHERE attendee_id = ${A} AND ${held}`),
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = NULL WHERE leader_attendee_id = ${A} AND ${held}`),
    activityFor(db, eventId, [person.registrationId], opts.actor, 'room_unassigned', { roomId: room.id, room: room.label, attendeeIds: [A], ...(reason ? { reason } : {}) }, held),
  ]);
  return write.claimed ? { ok: true, changed: true } : { ok: true, changed: false };
}

/** Everyone out of one room (e.g. the room became unusable). Someone checked in needs a reason. */
export async function clearRoom(
  db: AppDb,
  eventId: number,
  input: { roomId: number; reason?: string },
  opts: { actor: number | null },
): Promise<{ ok: true; removed: number } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const room = await loadRoom(db, eventId, input.roomId);
  if (!room) return fail('not_found');
  const occupants = await roomOccupants(db, eventId, room.id);
  if (occupants.length === 0) return { ok: true, removed: 0 };
  const reason = cleanReason(input.reason);
  if (needsReason(occupants) && !reason) return fail('reason_required');
  const R = intLit(room.id);
  const ids = occupants.map((p) => p.attendeeId);
  const write = await logisticsWrite(db, eventId, 'housing', `EXISTS (SELECT 1 FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ${R} AND v.event_id = ${intLit(eventId)})`, (held) => [
    activityFor(db, eventId, occupants.map((p) => p.registrationId), opts.actor, 'room_unassigned', { roomId: R, room: room.label, attendeeIds: ids, ...(reason ? { reason } : {}) }, held),
    db.prepare(`DELETE FROM reg_room_assignments WHERE room_id = ${R} AND ${held}`),
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = NULL WHERE id = ${R} AND ${held}`),
  ]);
  return write.claimed ? { ok: true, removed: write.work[1].meta.changes } : fail('conflict');
}

/** Swap the rooms of two people in different rooms. Policies are re-checked (soft); beds do not change. */
export async function swapRooms(
  db: AppDb,
  eventId: number,
  input: { attendeeA: number; attendeeB: number; confirm?: boolean; reason?: string },
  opts: { actor: number | null },
): Promise<{ ok: true } | LogisticsFailure> {
  const plan = async (confirm: boolean) => {
    const ctx = await housingContext(db, eventId);
    if ('ok' in ctx) return ctx;
    if (input.attendeeA === input.attendeeB) return fail('invalid');
    const people = await loadPeople(db, eventId, [input.attendeeA, input.attendeeB]);
    const a = people.find((p) => p.attendeeId === input.attendeeA);
    const b = people.find((p) => p.attendeeId === input.attendeeB);
    if (!a || !b || a.roomId === null || b.roomId === null) return fail('not_found');
    if (a.roomId === b.roomId) return fail('invalid');
    const roomA = await loadRoom(db, eventId, a.roomId);
    const roomB = await loadRoom(db, eventId, b.roomId);
    if (!roomA || !roomB) return fail('not_found');
    const both = [a.attendeeId, b.attendeeId];
    const va = roomVerdict(roomA, await roomOccupants(db, eventId, roomA.id), [b], both, ctx.settings, false);
    const vb = roomVerdict(roomB, await roomOccupants(db, eventId, roomB.id), [a], both, ctx.settings, false);
    if (va.hard) return va.hard;
    if (vb.hard) return vb.hard;
    const reason = cleanReason(input.reason);
    if (needsReason([a, b]) && !reason) return fail('reason_required');
    const soft = [...new Set([...va.soft, ...vb.soft])];
    if (soft.length > 0 && !confirm) return needsConfirm(soft);
    return { settings: ctx.settings, a, b, roomA, roomB, soft, reason };
  };
  const p = await plan(input.confirm === true);
  if (!('a' in p)) return p;
  const A = intLit(p.a.attendeeId);
  const B = intLit(p.b.attendeeId);
  const claim = [
    `EXISTS (SELECT 1 FROM reg_room_assignments x WHERE x.attendee_id = ${A} AND x.room_id = ${intLit(p.roomA.id)})`,
    `EXISTS (SELECT 1 FROM reg_room_assignments x WHERE x.attendee_id = ${B} AND x.room_id = ${intLit(p.roomB.id)})`,
    roomRulesSql(eventId, p.roomA, [p.b], [A, B], p.settings, { confirm: input.confirm === true, capacity: false }),
    roomRulesSql(eventId, p.roomB, [p.a], [A, B], p.settings, { confirm: input.confirm === true, capacity: false }),
  ].join(' AND ');
  const write = await logisticsWrite(db, eventId, 'housing', claim, (held) => [
    db.prepare(
      `UPDATE reg_room_assignments SET room_id = CASE attendee_id WHEN ${A} THEN ${intLit(p.roomB.id)} ELSE ${intLit(p.roomA.id)} END,
              assigned_by = CAST(?1 AS INTEGER), assigned_at = datetime('now')
       WHERE attendee_id IN (${A}, ${B}) AND ${held}`,
    ).bind(opts.actor),
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = NULL WHERE leader_attendee_id IN (${A}, ${B}) AND ${held}`),
    activityFor(db, eventId, [p.a.registrationId, p.b.registrationId], opts.actor, 'room_swapped', {
      attendeeIds: [A, B], rooms: [p.roomA.label, p.roomB.label], ...(p.reason ? { reason: p.reason } : {}), ...(p.soft.length > 0 ? { override: p.soft } : {}),
    }, held),
  ]);
  if (write.claimed) return { ok: true };
  const again = await plan(input.confirm === true);
  return 'a' in again ? fail('conflict') : again;
}

/** Make an occupant the room leader (null clears it). */
export async function setRoomLeader(
  db: AppDb,
  eventId: number,
  input: { roomId: number; attendeeId: number | null },
  opts: { actor: number | null },
): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const room = await loadRoom(db, eventId, input.roomId);
  if (!room) return fail('not_found');
  const R = intLit(room.id);
  const target = input.attendeeId;
  let registrationId: number | null = null;
  if (target !== null) {
    const occupants = await roomOccupants(db, eventId, room.id);
    const leader = occupants.find((p) => p.attendeeId === target);
    if (!leader) return fail('not_occupant');
    registrationId = leader.registrationId;
  } else if (room.leaderAttendeeId !== null) {
    registrationId = (await loadPeople(db, eventId, [room.leaderAttendeeId]))[0]?.registrationId ?? null;
  }
  const occupantOk = target === null ? '1 = 1' : `${liveCountSql('reg_room_assignments', `x.room_id = ${R} AND x.attendee_id = ${intLit(target)}`)} = 1`;
  const write = await logisticsWrite(db, eventId, 'housing', `EXISTS (SELECT 1 FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ${R} AND v.event_id = ${intLit(eventId)}) AND ${occupantOk}`, (held) => [
    db.prepare(`UPDATE reg_rooms SET leader_attendee_id = CAST(?1 AS INTEGER) WHERE id = ${R} AND ${held}`).bind(target),
    ...(registrationId !== null
      ? [activityFor(db, eventId, [registrationId], opts.actor, target === null ? 'room_leader_cleared' : 'room_leader', { roomId: R, room: room.label, attendeeId: target ?? room.leaderAttendeeId }, held)]
      : []),
  ]);
  return write.claimed ? { ok: true } : fail(target === null ? 'conflict' : 'not_occupant');
}

// ── Venues, room types, rooms ────────────────────────────────────────────────

const venueOfEvent = (eventId: number, venueId: number) => `EXISTS (SELECT 1 FROM reg_venues v WHERE v.id = ${intLit(venueId)} AND v.event_id = ${intLit(eventId)})`;
const isKind = (v: unknown): v is VenueKind => typeof v === 'string' && (VENUE_KINDS as readonly string[]).includes(v);
const isRule = (v: unknown): v is CapacityRule => v === 'hard' || v === 'soft';
const isPolicy = (v: unknown): v is RoomPolicy => typeof v === 'string' && (ROOM_POLICIES as readonly string[]).includes(v);
const validBeds = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_BEDS;

async function guardedDuplicate<T>(run: () => Promise<T>, path: string): Promise<T | LogisticsFailure> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) return fail('duplicate', [{ path, code: 'duplicate' }]);
    throw error;
  }
}

/** Add a venue. The capacity rule defaults from the kind (hard for dorm / campsite, soft otherwise). */
export async function createVenue(
  db: AppDb,
  eventId: number,
  input: { name: unknown; kind?: unknown; capacityRule?: unknown },
): Promise<{ ok: true; id: number } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const name = cleanLabel(input.name, 120);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  const kind = input.kind === undefined ? 'other' : input.kind;
  if (!isKind(kind)) return fail('invalid', [{ path: 'kind', code: 'invalid' }]);
  const rule = input.capacityRule === undefined ? defaultCapacityRule(kind) : input.capacityRule;
  if (!isRule(rule)) return fail('invalid', [{ path: 'capacityRule', code: 'invalid' }]);
  return guardedDuplicate(async () => {
    const write = await logisticsWrite(db, eventId, 'housing', '1 = 1', (held) => [
      db
        .prepare(
          `INSERT INTO reg_venues (campus_id, event_id, name, kind, capacity_rule, sort)
           SELECT e.campus_id, e.id, CAST(?2 AS TEXT), CAST(?3 AS TEXT), CAST(?4 AS TEXT), (SELECT COALESCE(MAX(s.sort), 0) + 1 FROM reg_venues s WHERE s.event_id = e.id)
           FROM reg_events e WHERE e.id = ?1 AND ${held} RETURNING id`,
        )
        .bind(eventId, name, kind, rule),
    ]);
    return write.claimed ? { ok: true as const, id: (write.work[0].results[0] as { id: number }).id } : fail('not_found');
  }, 'name');
}

export async function updateVenue(
  db: AppDb,
  eventId: number,
  venueId: number,
  input: { name?: unknown; kind?: unknown; capacityRule?: unknown },
): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const venue = await db.prepare(`SELECT name, kind, capacity_rule FROM reg_venues WHERE id = ?1 AND event_id = ?2`).bind(venueId, eventId).first<{ name: string; kind: VenueKind; capacity_rule: CapacityRule }>();
  if (!venue) return fail('not_found');
  const name = input.name === undefined ? venue.name : cleanLabel(input.name, 120);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  const kind = input.kind === undefined ? venue.kind : input.kind;
  if (!isKind(kind)) return fail('invalid', [{ path: 'kind', code: 'invalid' }]);
  const rule = input.capacityRule === undefined ? venue.capacity_rule : input.capacityRule;
  if (!isRule(rule)) return fail('invalid', [{ path: 'capacityRule', code: 'invalid' }]);
  return guardedDuplicate(async () => {
    const write = await logisticsWrite(db, eventId, 'housing', venueOfEvent(eventId, venueId), (held) => [
      db.prepare(`UPDATE reg_venues SET name = ?2, kind = ?3, capacity_rule = ?4 WHERE id = ?1 AND ${held}`).bind(venueId, name, kind, rule),
    ]);
    return write.claimed ? { ok: true as const } : fail('not_found');
  }, 'name');
}

/** Delete a venue with its room types and rooms. Refused while anyone is in one of its rooms. */
export async function deleteVenue(db: AppDb, eventId: number, venueId: number): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const venue = await db.prepare(`SELECT id FROM reg_venues WHERE id = ?1 AND event_id = ?2`).bind(venueId, eventId).first();
  if (!venue) return fail('not_found');
  const empty = `${liveCountSql('reg_room_assignments', `x.room_id IN (SELECT rm.id FROM reg_rooms rm WHERE rm.venue_id = ${intLit(venueId)})`)} = 0`;
  const write = await logisticsWrite(db, eventId, 'housing', `${venueOfEvent(eventId, venueId)} AND ${empty}`, (held) => [
    db.prepare(`DELETE FROM reg_venues WHERE id = ?1 AND ${held}`).bind(venueId),
  ]);
  return write.claimed ? { ok: true } : fail('venue_occupied');
}

export async function createRoomType(
  db: AppDb,
  eventId: number,
  input: { venueId: number; name: unknown; beds: unknown },
): Promise<{ ok: true; id: number } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const name = cleanLabel(input.name, 80);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  if (!validBeds(input.beds)) return fail('invalid', [{ path: 'beds', code: 'invalid' }]);
  return guardedDuplicate(async () => {
    const write = await logisticsWrite(db, eventId, 'housing', venueOfEvent(eventId, input.venueId), (held) => [
      db
        .prepare(
          `INSERT INTO reg_room_types (campus_id, venue_id, name, beds)
           SELECT v.campus_id, v.id, CAST(?2 AS TEXT), CAST(?3 AS INTEGER) FROM reg_venues v WHERE v.id = ?1 AND ${held} RETURNING id`,
        )
        .bind(input.venueId, name, input.beds),
    ]);
    return write.claimed ? { ok: true as const, id: (write.work[0].results[0] as { id: number }).id } : fail('not_found');
  }, 'name');
}

export async function updateRoomType(
  db: AppDb,
  eventId: number,
  roomTypeId: number,
  input: { name?: unknown; beds?: unknown },
): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const type = await db
    .prepare(`SELECT t.name AS name, t.beds AS beds FROM reg_room_types t JOIN reg_venues v ON v.id = t.venue_id WHERE t.id = ?1 AND v.event_id = ?2`)
    .bind(roomTypeId, eventId)
    .first<{ name: string; beds: number }>();
  if (!type) return fail('not_found');
  const name = input.name === undefined ? type.name : cleanLabel(input.name, 80);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  const beds = input.beds === undefined ? Number(type.beds) : input.beds;
  if (!validBeds(beds)) return fail('invalid', [{ path: 'beds', code: 'invalid' }]);
  const ofEvent = `EXISTS (SELECT 1 FROM reg_room_types t JOIN reg_venues v ON v.id = t.venue_id WHERE t.id = ${intLit(roomTypeId)} AND v.event_id = ${intLit(eventId)})`;
  return guardedDuplicate(async () => {
    const write = await logisticsWrite(db, eventId, 'housing', ofEvent, (held) => [
      db.prepare(`UPDATE reg_room_types SET name = ?2, beds = ?3 WHERE id = ?1 AND ${held}`).bind(roomTypeId, name, beds),
    ]);
    return write.claimed ? { ok: true as const } : fail('not_found');
  }, 'name');
}

/** Delete a room type no room uses ('in_use' otherwise). */
export async function deleteRoomType(db: AppDb, eventId: number, roomTypeId: number): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const T = intLit(roomTypeId);
  const type = await db.prepare(`SELECT 1 AS present FROM reg_room_types t JOIN reg_venues v ON v.id = t.venue_id WHERE t.id = ?1 AND v.event_id = ?2`).bind(T, eventId).first();
  if (!type) return fail('not_found');
  const claim = `EXISTS (SELECT 1 FROM reg_room_types t JOIN reg_venues v ON v.id = t.venue_id WHERE t.id = ${T} AND v.event_id = ${intLit(eventId)})
    AND NOT EXISTS (SELECT 1 FROM reg_rooms rm WHERE rm.room_type_id = ${T})`;
  const write = await logisticsWrite(db, eventId, 'housing', claim, (held) => [db.prepare(`DELETE FROM reg_room_types WHERE id = ${T} AND ${held}`)]);
  return write.claimed ? { ok: true } : fail('in_use');
}

export interface AddRoomsInput {
  venueId: number;
  /** Range text ("101-120, A1-A6, Loft"; see parseRoomLabels). */
  labels: string;
  roomTypeId?: number | null;
  bedsOverride?: number | null;
  policy?: RoomPolicy;
  floor?: string | null;
}

/** Add rooms to a venue from range text. New rooms are unconfirmed. A label the venue already has is skipped. */
export async function addRooms(db: AppDb, eventId: number, input: AddRoomsInput): Promise<{ ok: true; created: Array<{ id: number; label: string }>; skipped: string[] } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const parsed = parseRoomLabels(input.labels);
  if (!parsed.ok) return fail(parsed.code === 'too_many' ? 'too_many' : 'invalid', [{ path: 'labels', code: parsed.code }]);
  const roomTypeId = input.roomTypeId ?? null;
  const beds = input.bedsOverride ?? null;
  if (beds !== null && !validBeds(beds)) return fail('invalid', [{ path: 'bedsOverride', code: 'invalid' }]);
  if (roomTypeId === null && beds === null) return fail('invalid', [{ path: 'roomTypeId', code: 'beds_required' }]);
  const policy = input.policy ?? 'any';
  if (!isPolicy(policy)) return fail('invalid', [{ path: 'policy', code: 'invalid' }]);
  const floor = input.floor === undefined || input.floor === null || input.floor === '' ? null : cleanLabel(input.floor, 40);
  if (input.floor && !floor) return fail('invalid', [{ path: 'floor', code: 'invalid' }]);
  const venue = await db.prepare(`SELECT id FROM reg_venues WHERE id = ?1 AND event_id = ?2`).bind(input.venueId, eventId).first();
  if (!venue) return fail('not_found');
  if (roomTypeId !== null) {
    const type = await db.prepare(`SELECT 1 AS present FROM reg_room_types WHERE id = ?1 AND venue_id = ?2`).bind(roomTypeId, input.venueId).first();
    if (!type) return fail('invalid', [{ path: 'roomTypeId', code: 'invalid' }]);
  }
  const values = parsed.labels.map((label, i) => `(${textLit(label)}, ${i + 1})`).join(', ');
  const typeOk = roomTypeId === null ? '1 = 1' : `EXISTS (SELECT 1 FROM reg_room_types t WHERE t.id = ${intLit(roomTypeId)} AND t.venue_id = ${intLit(input.venueId)})`;
  const write = await logisticsWrite(db, eventId, 'housing', `${venueOfEvent(eventId, input.venueId)} AND ${typeOk}`, (held) => [
    db
      .prepare(
        `INSERT INTO reg_rooms (campus_id, venue_id, room_type_id, beds_override, policy, floor, label, sort)
         SELECT v.campus_id, v.id, CAST(?2 AS INTEGER), CAST(?3 AS INTEGER), CAST(?4 AS TEXT), CAST(?5 AS TEXT), l.column1,
                l.column2 + (SELECT COALESCE(MAX(s.sort), 0) FROM reg_rooms s WHERE s.venue_id = v.id)
         FROM reg_venues v CROSS JOIN (VALUES ${values}) AS l
         WHERE v.id = ?1 AND ${held}
         ON CONFLICT (venue_id, label) DO NOTHING
         RETURNING id, label`,
      )
      .bind(input.venueId, roomTypeId, beds, policy, floor),
  ]);
  if (!write.claimed) return fail('not_found');
  const created = (write.work[0].results as Array<{ id: number; label: string }>).map((r) => ({ id: r.id, label: r.label }));
  const made = new Set(created.map((r) => r.label));
  created.sort((a, b) => parsed.labels.indexOf(a.label) - parsed.labels.indexOf(b.label));
  return { ok: true, created, skipped: parsed.labels.filter((l) => !made.has(l)) };
}

export interface RoomUpdateInput {
  label?: unknown;
  floor?: unknown;
  notes?: unknown;
  roomTypeId?: number | null;
  bedsOverride?: number | null;
  policy?: unknown;
}

/** Edit one room. Fewer beds than people already in it is allowed (the board shows the room as over capacity). */
export async function updateRoom(db: AppDb, eventId: number, roomId: number, input: RoomUpdateInput): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const room = await db
    .prepare(
      `SELECT rm.venue_id AS venue_id, rm.label AS label, rm.floor AS floor, rm.notes AS notes, rm.room_type_id AS room_type_id, rm.beds_override AS beds_override, rm.policy AS policy
       FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ?1 AND v.event_id = ?2`,
    )
    .bind(roomId, eventId)
    .first<{ venue_id: number; label: string; floor: string | null; notes: string | null; room_type_id: number | null; beds_override: number | null; policy: RoomPolicy }>();
  if (!room) return fail('not_found');
  const label = input.label === undefined ? room.label : cleanLabel(input.label, MAX_ROOM_LABEL_LENGTH);
  if (!label) return fail('invalid', [{ path: 'label', code: 'invalid' }]);
  const optional = (value: unknown, now: string | null, max: number): string | null | false => {
    if (value === undefined) return now;
    if (value === null || value === '') return null;
    return cleanLabel(value, max) ?? false;
  };
  const floor = optional(input.floor, room.floor, 40);
  if (floor === false) return fail('invalid', [{ path: 'floor', code: 'invalid' }]);
  const notes = input.notes === undefined ? room.notes : typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) || null : null;
  const roomTypeId = input.roomTypeId === undefined ? room.room_type_id : input.roomTypeId;
  const beds = input.bedsOverride === undefined ? room.beds_override : input.bedsOverride;
  if (beds !== null && !validBeds(beds)) return fail('invalid', [{ path: 'bedsOverride', code: 'invalid' }]);
  if (roomTypeId === null && beds === null) return fail('invalid', [{ path: 'roomTypeId', code: 'beds_required' }]);
  if (roomTypeId !== null && roomTypeId !== room.room_type_id) {
    const type = await db.prepare(`SELECT 1 AS present FROM reg_room_types WHERE id = ?1 AND venue_id = ?2`).bind(roomTypeId, room.venue_id).first();
    if (!type) return fail('invalid', [{ path: 'roomTypeId', code: 'invalid' }]);
  }
  const policy = input.policy === undefined ? room.policy : input.policy;
  if (!isPolicy(policy)) return fail('invalid', [{ path: 'policy', code: 'invalid' }]);
  const typeOk = roomTypeId === null ? '1 = 1' : `EXISTS (SELECT 1 FROM reg_room_types t WHERE t.id = ${intLit(roomTypeId)} AND t.venue_id = ${intLit(room.venue_id)})`;
  return guardedDuplicate(async () => {
    const write = await logisticsWrite(db, eventId, 'housing', `EXISTS (SELECT 1 FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE rm.id = ${intLit(roomId)} AND v.event_id = ${intLit(eventId)}) AND ${typeOk}`, (held) => [
      db
        .prepare(
          `UPDATE reg_rooms SET label = ?2, floor = CAST(?3 AS TEXT), notes = CAST(?4 AS TEXT), room_type_id = CAST(?5 AS INTEGER),
                  beds_override = CAST(?6 AS INTEGER), policy = ?7
           WHERE id = ?1 AND ${held}`,
        )
        .bind(roomId, label, floor, notes, roomTypeId, beds, policy),
    ]);
    return write.claimed ? { ok: true as const } : fail('not_found');
  }, 'label');
}

async function roomsOfEvent(db: AppDb, eventId: number, roomIds: readonly number[]): Promise<Array<{ id: number; occupied: boolean }> | null> {
  const ids = [...new Set(roomIds)];
  if (ids.length === 0 || ids.length > MAX_ROOMS_PER_CALL || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return null;
  const { results } = await db
    .prepare(
      `SELECT rm.id AS id, ${liveCountSql('reg_room_assignments', 'x.room_id = rm.id')} AS occupants
       FROM reg_rooms rm JOIN reg_venues v ON v.id = rm.venue_id WHERE ${inList('rm.id', ids)} AND v.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ id: number; occupants: number }>();
  if (results.length !== ids.length) return null;
  return results.map((r) => ({ id: r.id, occupied: Number(r.occupants) > 0 }));
}

const eventRoomsSql = (eventId: number) => `venue_id IN (SELECT ev.id FROM reg_venues ev WHERE ev.event_id = ${intLit(eventId)})`;
const emptyRoomSql = (alias: string) => `${liveCountSql('reg_room_assignments', `x.room_id = ${alias}.id`)} = 0`;

/** Confirm (rooms can take people) or unconfirm rooms in bulk. An occupied room is never unconfirmed: it is
 *  reported in `occupied` and left as it is. Any room of another event refuses the whole call. */
export async function setRoomsConfirmed(
  db: AppDb,
  eventId: number,
  input: { roomIds: number[]; confirmed: boolean },
): Promise<{ ok: true; changed: number; occupied: number[] } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const rooms = await roomsOfEvent(db, eventId, input.roomIds);
  if (!rooms) return fail('not_found');
  const ids = rooms.map((r) => r.id);
  const write = await logisticsWrite(db, eventId, 'housing', '1 = 1', (held) => [
    db.prepare(
      `UPDATE reg_rooms SET confirmed = ${input.confirmed ? 1 : 0}
       WHERE ${inList('id', ids)} AND ${eventRoomsSql(eventId)} AND confirmed = ${input.confirmed ? 0 : 1}
         ${input.confirmed ? '' : `AND ${emptyRoomSql('reg_rooms')}`} AND ${held}`,
    ),
  ]);
  if (!write.claimed) return fail('disabled');
  return { ok: true, changed: write.work[0].meta.changes, occupied: input.confirmed ? [] : rooms.filter((r) => r.occupied).map((r) => r.id) };
}

/** Delete rooms in bulk. Occupied rooms are kept and reported in `occupied`. */
export async function deleteRooms(db: AppDb, eventId: number, input: { roomIds: number[] }): Promise<{ ok: true; deleted: number; occupied: number[] } | LogisticsFailure> {
  const ctx = await housingContext(db, eventId);
  if ('ok' in ctx) return ctx;
  const rooms = await roomsOfEvent(db, eventId, input.roomIds);
  if (!rooms) return fail('not_found');
  const write = await logisticsWrite(db, eventId, 'housing', '1 = 1', (held) => [
    db.prepare(`DELETE FROM reg_rooms WHERE ${inList('id', rooms.map((r) => r.id))} AND ${eventRoomsSql(eventId)} AND ${emptyRoomSql('reg_rooms')} AND ${held}`),
  ]);
  if (!write.claimed) return fail('disabled');
  return { ok: true, deleted: write.work[0].meta.changes, occupied: rooms.filter((r) => r.occupied).map((r) => r.id) };
}
