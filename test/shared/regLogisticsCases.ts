// Event logistics (Phase 5) behavior that must hold on BOTH backends: the schema's constraints, the per-event
// switches, housing (rooms, rules, keep-party-together, moves, swaps, leaders, confirm), seating (tables, party
// seating, auto-seat preview / apply / stale), small groups (capacity, leaders, auto-fill), tags, the cancel
// cascade, what registrants and the desk see, the overview, and cross-event refusal. Run against D1
// (test/regLogistics.d1.test.ts) and Postgres (test/pg/regLogistics.pg.test.ts), plain and through the campus
// SQL scoper. No cloudflare:test or node imports, and the name does not end in .test.ts.
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbBackend } from '../../src/lib/dbProvider';
import { createRegistration, listQuestions, saveEvent, saveEventForm, type EventFormPayload, type RegAttendeeInput, cancelRegistration } from '../../src/lib/regDb';
import { adminCancelRegistration, adminRemovePerson, decideRegistration, listActivity } from '../../src/lib/regAdmin';
import { checkIn, findForDesk } from '../../src/lib/regCheckin';
import { cancelAttendee, registrationSummary } from '../../src/lib/regManage';
import {
  applyTagByAnswer, assignmentsForAttendees, createTag, deleteTag, getLogisticsSettings, listLogisticsPeople, listTags, logisticsOverview,
  partyToBring, saveLogisticsSettings, setTag, updateTag, type LogisticsSettingsInput,
} from '../../src/lib/regLogistics';
import {
  addRooms, assignRoom, clearRoom, createRoomType, createVenue, deleteRoomType, deleteRooms, deleteVenue, listHousing, setRoomLeader,
  setRoomsConfirmed, swapRooms, unassignRoom, updateRoom, updateVenue,
} from '../../src/lib/regHousing';
import {
  addTables, applySeatingPlan, deleteTables, listSeating, previewSeating, seatAtTable, seatingStamp, setTableHost, unseat, updateTable,
} from '../../src/lib/regSeating';
import { autoFillGroups, createGroup, deleteGroup, joinGroup, leaveGroup, listGroups, setGroupLeader, updateGroup } from '../../src/lib/regGroups';

const DAY = 24 * 3600_000;
export const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let keySeq = 0;
const key = () => `logistics-${Date.now()}-${++keySeq}`;
const actor = { actor: null };

export function defineRegLogisticsCases(label: string, getDb: () => AppDb, backend: DbBackend): void {
  const db = () => getDb();
  const newEvent = async (flags: LogisticsSettingsInput = { housing: true, seating: true, groups: true }, over: Partial<Parameters<typeof saveEvent>[1]> = {}) => {
    const id = await saveEvent(db(), { title_en: 'Retreat', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 8, ...over });
    expect(await saveLogisticsSettings(db(), id, flags)).toMatchObject({ ok: true });
    return id;
  };
  const register = async (eventId: number, names: string[] | RegAttendeeInput[], over: Partial<Parameters<typeof createRegistration>[1]> = {}) => {
    const attendees = (names as Array<string | RegAttendeeInput>).map((n) => (typeof n === 'string' ? { name: n } : n));
    const reg = await createRegistration(db(), {
      eventId, personId: null, name: attendees[0].name, email: `${attendees[0].name.toLowerCase().replace(/\W+/g, '')}-${keySeq}@example.com`,
      status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], attendees, submissionKey: key(), allowWaitlist: false, ...over,
    });
    const { results } = await db().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`).bind(reg.id).all<{ id: number }>();
    return { id: reg.id, people: results.map((r) => r.id) };
  };
  const mustForm = async (eventId: number, payload: EventFormPayload) => expect(await saveEventForm(db(), eventId, payload, { backend })).toEqual({ ok: true });
  const one = async <T>(sql: string, ...binds: unknown[]) => (await db().prepare(sql).bind(...binds).first<T>())!;
  const count = async (sql: string, ...binds: unknown[]) => Number((await one<{ n: number }>(sql, ...binds)).n);
  const roomOf = async (attendeeId: number) => (await db().prepare(`SELECT room_id FROM reg_room_assignments WHERE attendee_id = ?1`).bind(attendeeId).first<{ room_id: number }>())?.room_id ?? null;
  const tableOf = async (attendeeId: number) => (await db().prepare(`SELECT table_id FROM reg_table_seats WHERE attendee_id = ?1`).bind(attendeeId).first<{ table_id: number }>())?.table_id ?? null;
  const groupOf = async (attendeeId: number) => (await db().prepare(`SELECT group_id FROM reg_group_members WHERE attendee_id = ?1`).bind(attendeeId).first<{ group_id: number }>())?.group_id ?? null;
  const actionsOf = async (registrationId: number) => (await listActivity(db(), registrationId)).map((a) => a.action).reverse();
  const ok = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => {
    expect(value).toMatchObject({ ok: true });
    return value as Extract<T, { ok: true }>;
  };

  /** An event with one venue (rule as given), one room type and confirmed rooms "1".."n". */
  async function housed(opts: { beds?: number; rooms?: number; rule?: 'hard' | 'soft'; kind?: 'hotel' | 'dorm'; policy?: 'any' | 'single_gender' | 'one_party' } = {}) {
    const eventId = await newEvent();
    const venue = ok(await createVenue(db(), eventId, { name: 'Pine Lodge', kind: opts.kind ?? 'dorm', ...(opts.rule ? { capacityRule: opts.rule } : {}) })).id;
    const type = ok(await createRoomType(db(), eventId, { venueId: venue, name: 'Bunk room', beds: opts.beds ?? 2 })).id;
    const rooms = ok(await addRooms(db(), eventId, { venueId: venue, labels: `1-${opts.rooms ?? 3}`, roomTypeId: type, policy: opts.policy ?? 'any' })).created.map((r) => r.id);
    ok(await setRoomsConfirmed(db(), eventId, { roomIds: rooms, confirmed: true }));
    return { eventId, venue, type, rooms };
  }

  describe(`event logistics (${label})`, () => {
    // ── Schema ───────────────────────────────────────────────────────────────
    describe('schema', () => {
      it('defaults the event switches off and constrains the new tables', async () => {
        const eventId = await saveEvent(db(), { title_en: 'Plain', starts_at: tsAt(30 * DAY), active: 1 });
        expect(await getLogisticsSettings(db(), eventId)).toEqual({ housing: false, seating: false, groups: false, showAssignments: false, genderQuestionId: null, version: 0 });
        const exec = (sql: string, ...binds: unknown[]) => db().prepare(sql).bind(...binds).run();
        await expect(exec(`UPDATE reg_events SET housing_enabled = 2 WHERE id = ?1`, eventId)).rejects.toThrow();
        await expect(exec(`INSERT INTO reg_venues (event_id, name, kind) VALUES (?1, 'V', 'castle')`, eventId)).rejects.toThrow();
        const venue = await one<{ id: number; kind: string; capacity_rule: string }>(`INSERT INTO reg_venues (event_id, name) VALUES (?1, 'V') RETURNING id, kind, capacity_rule`, eventId);
        expect([venue.kind, venue.capacity_rule]).toEqual(['other', 'soft']);
        await expect(exec(`INSERT INTO reg_room_types (venue_id, name, beds) VALUES (?1, 'T', 0)`, venue.id)).rejects.toThrow();
        await expect(exec(`INSERT INTO reg_rooms (venue_id, label) VALUES (?1, 'No beds')`, venue.id)).rejects.toThrow();
        await expect(exec(`INSERT INTO reg_rooms (venue_id, label, beds_override, policy) VALUES (?1, 'P', 2, 'mixed')`, venue.id)).rejects.toThrow();
        const room = await one<{ id: number; confirmed: number; policy: string }>(`INSERT INTO reg_rooms (venue_id, label, beds_override) VALUES (?1, 'R', 2) RETURNING id, confirmed, policy`, venue.id);
        expect([room.confirmed, room.policy]).toEqual([0, 'any']);
        await expect(exec(`INSERT INTO reg_rooms (venue_id, label, beds_override) VALUES (?1, 'R', 1)`, venue.id)).rejects.toThrow(/UNIQUE|duplicate/i);
        await expect(exec(`INSERT INTO reg_tables (event_id, label, seats) VALUES (?1, 'T', 0)`, eventId)).rejects.toThrow();
        await expect(exec(`INSERT INTO reg_groups (event_id, name, capacity) VALUES (?1, 'G', 0)`, eventId)).rejects.toThrow();
      });

      it('one room, seat and group per person; deleting a venue or a person cascades their rows', async () => {
        const { eventId, venue, rooms } = await housed();
        const reg = await register(eventId, ['Ann']);
        const [ann] = reg.people;
        ok(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[0] }, actor));
        await expect(db().prepare(`INSERT INTO reg_room_assignments (attendee_id, room_id) VALUES (?1, ?2)`).bind(ann, rooms[1]).run()).rejects.toThrow(/UNIQUE|duplicate|PRIMARY/i);
        await db().prepare(`DELETE FROM reg_venues WHERE id = ?1`).bind(venue).run();
        expect(await count(`SELECT COUNT(*) AS n FROM reg_rooms WHERE venue_id = ?1`, venue)).toBe(0);
        expect(await roomOf(ann)).toBeNull();
        const table = ok(await addTables(db(), eventId, { count: 1, seats: 4 })).created[0].id;
        ok(await seatAtTable(db(), eventId, { attendeeId: ann, tableId: table }, actor));
        await db().prepare(`DELETE FROM registrations WHERE id = ?1`).bind(reg.id).run();
        expect(await tableOf(ann)).toBeNull();
      });
    });

    // ── Settings ─────────────────────────────────────────────────────────────
    describe('settings', () => {
      it('switches areas on and off and only accepts a per-person single-choice question of the event as the gender question', async () => {
        const eventId = await newEvent({ housing: true });
        await mustForm(eventId, { questions: [
          { type: 'select', scope: 'attendee', labels: { en: 'Gender' }, options: [{ key: 'f', labels: { en: 'Female' } }, { key: 'm', labels: { en: 'Male' } }] },
          { type: 'select', labels: { en: 'Shirt' }, options: [{ key: 's', labels: { en: 'S' } }] },
          { type: 'text', scope: 'attendee', labels: { en: 'Nick' } },
        ] });
        const [gender, shirt, nick] = await listQuestions(db(), 'en', eventId);
        expect(await saveLogisticsSettings(db(), eventId, { genderQuestionId: shirt.id })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await saveLogisticsSettings(db(), eventId, { genderQuestionId: nick.id })).toMatchObject({ ok: false, code: 'invalid' });
        const other = await newEvent();
        await mustForm(other, { questions: [{ type: 'select', scope: 'attendee', labels: { en: 'G' }, options: [{ key: 'a', labels: { en: 'A' } }] }] });
        const [foreign] = await listQuestions(db(), 'en', other);
        expect(await saveLogisticsSettings(db(), eventId, { genderQuestionId: foreign.id })).toMatchObject({ ok: false, code: 'invalid' });
        const saved = ok(await saveLogisticsSettings(db(), eventId, { genderQuestionId: gender.id, showAssignments: true, seating: true }));
        expect(saved.settings).toMatchObject({ housing: true, seating: true, groups: false, showAssignments: true, genderQuestionId: gender.id });
        expect(await saveLogisticsSettings(db(), 999999, { housing: true })).toEqual({ ok: false, code: 'not_found' });
        // an area that is off refuses writes
        expect(await createGroup(db(), eventId, { name: 'A' })).toEqual({ ok: false, code: 'disabled' });
        ok(await saveLogisticsSettings(db(), eventId, { housing: false }));
        expect(await createVenue(db(), eventId, { name: 'V' })).toEqual({ ok: false, code: 'disabled' });
      });
    });

    // ── Housing ──────────────────────────────────────────────────────────────
    describe('housing', () => {
      it('adds rooms from range text (unconfirmed, duplicates skipped) and defaults the capacity rule by kind', async () => {
        const eventId = await newEvent();
        const hotel = ok(await createVenue(db(), eventId, { name: 'Hotel', kind: 'hotel' })).id;
        const dorm = ok(await createVenue(db(), eventId, { name: 'Dorm', kind: 'dorm' })).id;
        expect(await createVenue(db(), eventId, { name: 'Dorm' })).toMatchObject({ ok: false, code: 'duplicate' });
        const type = ok(await createRoomType(db(), eventId, { venueId: hotel, name: 'Double', beds: 2 })).id;
        expect(await addRooms(db(), eventId, { venueId: hotel, labels: '101-103' })).toMatchObject({ ok: false, code: 'invalid' }); // no beds
        expect(await addRooms(db(), eventId, { venueId: hotel, labels: '9-1', roomTypeId: type })).toMatchObject({ ok: false, code: 'invalid', errors: [{ path: 'labels', code: 'reversed' }] });
        const added = ok(await addRooms(db(), eventId, { venueId: hotel, labels: '101-103, A1-A2, Loft', roomTypeId: type }));
        expect(added.created.map((r) => r.label)).toEqual(['101', '102', '103', 'A1', 'A2', 'Loft']);
        const again = ok(await addRooms(db(), eventId, { venueId: hotel, labels: '103-104', roomTypeId: type }));
        expect([again.created.map((r) => r.label), again.skipped]).toEqual([['104'], ['103']]);
        // a room type of another venue is refused
        expect(await addRooms(db(), eventId, { venueId: dorm, labels: '1', roomTypeId: type })).toMatchObject({ ok: false, code: 'invalid' });
        ok(await addRooms(db(), eventId, { venueId: dorm, labels: 'B1', bedsOverride: 6 }));
        const venues = await listHousing(db(), eventId);
        expect(venues.map((v) => [v.name, v.capacityRule, v.rooms.length])).toEqual([['Hotel', 'soft', 7], ['Dorm', 'hard', 1]]);
        expect(venues[0].rooms.every((r) => !r.confirmed && r.beds === 2)).toBe(true);
        expect(venues[1].rooms[0].beds).toBe(6);
        ok(await updateVenue(db(), eventId, dorm, { capacityRule: 'soft' }));
        expect((await listHousing(db(), eventId))[1].capacityRule).toBe('soft');
      });

      it('only confirmed rooms take people; keep-party-together brings the party; one person can go alone', async () => {
        const eventId = await newEvent();
        const venue = ok(await createVenue(db(), eventId, { name: 'Lodge', kind: 'dorm' })).id;
        const type = ok(await createRoomType(db(), eventId, { venueId: venue, name: 'Quad', beds: 4 })).id;
        const [r1, r2] = ok(await addRooms(db(), eventId, { venueId: venue, labels: '1-2', roomTypeId: type })).created.map((r) => r.id);
        const fam = await register(eventId, ['Ann', 'Ben', 'Cal']);
        expect(await assignRoom(db(), eventId, { attendeeId: fam.people[0], roomId: r1 }, actor)).toEqual({ ok: false, code: 'room_unconfirmed' });
        ok(await setRoomsConfirmed(db(), eventId, { roomIds: [r1, r2], confirmed: true }));
        expect((await partyToBring(db(), eventId, fam.people[0], 'room')).map((p) => p.attendeeId)).toEqual(fam.people.slice(1));
        expect(await assignRoom(db(), eventId, { attendeeId: fam.people[0], roomId: r1, party: false }, actor)).toEqual({ ok: true, moved: [fam.people[0]] });
        expect(await assignRoom(db(), eventId, { attendeeId: fam.people[1], roomId: r1 }, actor)).toEqual({ ok: true, moved: [fam.people[1], fam.people[2]] });
        expect(await Promise.all(fam.people.map(roomOf))).toEqual([r1, r1, r1]);
        expect(await actionsOf(fam.id)).toEqual(['room_assigned', 'room_assigned']);
        // again: nothing to do
        expect(await assignRoom(db(), eventId, { attendeeId: fam.people[0], roomId: r1 }, actor)).toEqual({ ok: true, moved: [] });
      });

      it('a hard rule refuses the bed past capacity; a soft rule asks first and records the override', async () => {
        const hard = await housed({ beds: 2, kind: 'dorm' });
        const a = await register(hard.eventId, ['Ann', 'Ben']);
        const b = await register(hard.eventId, ['Cal']);
        ok(await assignRoom(db(), hard.eventId, { attendeeId: a.people[0], roomId: hard.rooms[0] }, actor));
        expect(await assignRoom(db(), hard.eventId, { attendeeId: b.people[0], roomId: hard.rooms[0] }, actor)).toEqual({ ok: false, code: 'ROOM_FULL' });
        expect(await assignRoom(db(), hard.eventId, { attendeeId: b.people[0], roomId: hard.rooms[0], confirm: true }, actor)).toEqual({ ok: false, code: 'ROOM_FULL' });

        const soft = await housed({ beds: 2, kind: 'hotel' });
        const c = await register(soft.eventId, ['Ann', 'Ben']);
        const d = await register(soft.eventId, ['Cal']);
        ok(await assignRoom(db(), soft.eventId, { attendeeId: c.people[0], roomId: soft.rooms[0] }, actor));
        expect(await assignRoom(db(), soft.eventId, { attendeeId: d.people[0], roomId: soft.rooms[0] }, actor)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'room_over_capacity', reasons: ['room_over_capacity'] });
        expect(await roomOf(d.people[0])).toBeNull();
        ok(await assignRoom(db(), soft.eventId, { attendeeId: d.people[0], roomId: soft.rooms[0], confirm: true }, actor));
        const history = await listActivity(db(), d.id);
        expect(history[0]).toMatchObject({ action: 'room_assigned' });
        expect(JSON.stringify(history[0])).toContain('room_over_capacity');
        expect((await listHousing(db(), soft.eventId))[0].rooms[0].occupants).toHaveLength(3);
      });

      it('room policies: one party per room, and single-gender rooms by the event gender question', async () => {
        const party = await housed({ beds: 4, policy: 'one_party' });
        const a = await register(party.eventId, ['Ann']);
        const b = await register(party.eventId, ['Ben']);
        ok(await assignRoom(db(), party.eventId, { attendeeId: a.people[0], roomId: party.rooms[0] }, actor));
        expect(await assignRoom(db(), party.eventId, { attendeeId: b.people[0], roomId: party.rooms[0] }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'room_other_party' });
        ok(await assignRoom(db(), party.eventId, { attendeeId: b.people[0], roomId: party.rooms[0], confirm: true }, actor));

        const g = await housed({ beds: 4, policy: 'single_gender' });
        await mustForm(g.eventId, { questions: [{ type: 'select', scope: 'attendee', labels: { en: 'Gender' }, options: [{ key: 'f', labels: { en: 'F' } }, { key: 'm', labels: { en: 'M' } }] }] });
        const [gender] = await listQuestions(db(), 'en', g.eventId);
        const ann = await register(g.eventId, [{ name: 'Ann', answers: [[gender.id, 'f']] }]);
        const bea = await register(g.eventId, [{ name: 'Bea', answers: [[gender.id, 'f']] }]);
        const cal = await register(g.eventId, [{ name: 'Cal', answers: [[gender.id, 'm']] }]);
        const dee = await register(g.eventId, [{ name: 'Dee' }]);
        expect(await assignRoom(db(), g.eventId, { attendeeId: ann.people[0], roomId: g.rooms[0] }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'gender_question_missing' });
        ok(await saveLogisticsSettings(db(), g.eventId, { genderQuestionId: gender.id }));
        ok(await assignRoom(db(), g.eventId, { attendeeId: ann.people[0], roomId: g.rooms[0] }, actor));
        ok(await assignRoom(db(), g.eventId, { attendeeId: bea.people[0], roomId: g.rooms[0] }, actor));
        expect(await assignRoom(db(), g.eventId, { attendeeId: cal.people[0], roomId: g.rooms[0] }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'room_mixed_gender' });
        expect(await assignRoom(db(), g.eventId, { attendeeId: dee.people[0], roomId: g.rooms[0] }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'gender_unknown' });
        ok(await assignRoom(db(), g.eventId, { attendeeId: cal.people[0], roomId: g.rooms[1] }, actor));
      });

      it('only people still on the event, on a held seat or checked in, can be housed', async () => {
        const { eventId, rooms } = await housed({ beds: 6 });
        const cancelled = await register(eventId, ['Ann', 'Ben']);
        ok(await adminRemovePerson(db(), cancelled.id, { version: 1, attendeeId: cancelled.people[1] }, actor));
        expect(await assignRoom(db(), eventId, { attendeeId: cancelled.people[1], roomId: rooms[0], party: false }, actor)).toEqual({ ok: false, code: 'not_active' });
        const waiting = await register(eventId, ['Wes']);
        await db().prepare(`UPDATE registrations SET status = 'waitlist' WHERE id = ?1`).bind(waiting.id).run();
        expect(await assignRoom(db(), eventId, { attendeeId: waiting.people[0], roomId: rooms[0] }, actor)).toEqual({ ok: false, code: 'not_eligible' });
        ok(await checkIn(db(), waiting.people[0], null, { confirm: true }));
        ok(await assignRoom(db(), eventId, { attendeeId: waiting.people[0], roomId: rooms[0] }, actor));
        const paying = await register(eventId, ['Pat']);
        await db().prepare(`UPDATE registrations SET status = 'pending' WHERE id = ?1`).bind(paying.id).run();
        expect(await assignRoom(db(), eventId, { attendeeId: paying.people[0], roomId: rooms[0] }, actor)).toEqual({ ok: false, code: 'not_eligible' });
        const review = await register(eventId, ['Rae']);
        await db().prepare(`UPDATE registrations SET status = 'review' WHERE id = ?1`).bind(review.id).run();
        ok(await assignRoom(db(), eventId, { attendeeId: review.people[0], roomId: rooms[0] }, actor));
      });

      it('moving or removing someone who is checked in needs a reason, kept in the history', async () => {
        const { eventId, rooms } = await housed({ beds: 2 });
        const reg = await register(eventId, ['Ann']);
        const [ann] = reg.people;
        ok(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[0] }, actor));
        ok(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[1] }, actor)); // not checked in: no reason needed
        ok(await checkIn(db(), ann, null));
        expect(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[0] }, actor)).toEqual({ ok: false, code: 'reason_required' });
        expect(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[0], reason: '   ' }, actor)).toEqual({ ok: false, code: 'reason_required' });
        ok(await assignRoom(db(), eventId, { attendeeId: ann, roomId: rooms[0], reason: 'Heater broken' }, actor));
        expect(await roomOf(ann)).toBe(rooms[0]);
        expect(await unassignRoom(db(), eventId, { attendeeId: ann }, actor)).toEqual({ ok: false, code: 'reason_required' });
        expect(await clearRoom(db(), eventId, { roomId: rooms[0] }, actor)).toEqual({ ok: false, code: 'reason_required' });
        ok(await unassignRoom(db(), eventId, { attendeeId: ann, reason: 'Went home' }, actor));
        const history = await listActivity(db(), reg.id);
        expect(history.map((h) => h.action).slice(0, 2)).toEqual(['room_unassigned', 'room_moved']);
        expect(JSON.stringify(history)).toContain('Heater broken');
        expect(JSON.stringify(history)).toContain('Went home');
      });

      it('swaps two people, re-checking the room policies; leaders must be occupants and lose the role when they leave', async () => {
        const { eventId, rooms } = await housed({ beds: 2, policy: 'one_party' });
        const a = await register(eventId, ['Ann', 'Amy']);
        const b = await register(eventId, ['Ben']);
        ok(await assignRoom(db(), eventId, { attendeeId: a.people[0], roomId: rooms[0] }, actor));
        ok(await assignRoom(db(), eventId, { attendeeId: b.people[0], roomId: rooms[1] }, actor));
        expect(await setRoomLeader(db(), eventId, { roomId: rooms[0], attendeeId: b.people[0] }, actor)).toEqual({ ok: false, code: 'not_occupant' });
        ok(await setRoomLeader(db(), eventId, { roomId: rooms[0], attendeeId: a.people[0] }, actor));
        // Amy stays with Ann; swapping Ann for Ben would mix two parties in each room.
        expect(await swapRooms(db(), eventId, { attendeeA: a.people[0], attendeeB: b.people[0] }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'room_other_party' });
        ok(await swapRooms(db(), eventId, { attendeeA: a.people[0], attendeeB: b.people[0], confirm: true }, actor));
        expect([await roomOf(a.people[0]), await roomOf(b.people[0]), await roomOf(a.people[1])]).toEqual([rooms[1], rooms[0], rooms[0]]);
        expect((await listHousing(db(), eventId))[0].rooms[0].leaderAttendeeId).toBeNull();
        expect(await actionsOf(b.id)).toContain('room_swapped');
        expect(await swapRooms(db(), eventId, { attendeeA: a.people[1], attendeeB: b.people[0] }, actor)).toEqual({ ok: false, code: 'invalid' }); // same room
        ok(await setRoomLeader(db(), eventId, { roomId: rooms[0], attendeeId: b.people[0] }, actor));
        ok(await unassignRoom(db(), eventId, { attendeeId: b.people[0] }, actor));
        expect((await listHousing(db(), eventId))[0].rooms[0].leaderAttendeeId).toBeNull();
      });

      it('never unconfirms or deletes an occupied room, venue or used room type', async () => {
        const { eventId, venue, type, rooms } = await housed({ beds: 2 });
        const reg = await register(eventId, ['Ann']);
        ok(await assignRoom(db(), eventId, { attendeeId: reg.people[0], roomId: rooms[0] }, actor));
        expect(await setRoomsConfirmed(db(), eventId, { roomIds: rooms, confirmed: false })).toEqual({ ok: true, changed: 2, occupied: [rooms[0]] });
        expect((await listHousing(db(), eventId))[0].rooms.map((r) => r.confirmed)).toEqual([true, false, false]);
        expect(await deleteRooms(db(), eventId, { roomIds: rooms })).toEqual({ ok: true, deleted: 2, occupied: [rooms[0]] });
        expect(await deleteVenue(db(), eventId, venue)).toEqual({ ok: false, code: 'venue_occupied' });
        expect(await deleteRoomType(db(), eventId, type)).toEqual({ ok: false, code: 'in_use' });
        ok(await clearRoom(db(), eventId, { roomId: rooms[0] }, actor));
        ok(await deleteVenue(db(), eventId, venue));
        expect(await listHousing(db(), eventId)).toEqual([]);
      });

      it('edits rooms and refuses a duplicate label', async () => {
        const { eventId, rooms } = await housed({ rooms: 2 });
        ok(await updateRoom(db(), eventId, rooms[0], { label: 'Cabin', floor: '2', bedsOverride: 5, policy: 'single_gender' }));
        expect(await updateRoom(db(), eventId, rooms[1], { label: 'Cabin' })).toMatchObject({ ok: false, code: 'duplicate' });
        const room = (await listHousing(db(), eventId))[0].rooms[0];
        expect([room.label, room.floor, room.beds, room.policy]).toEqual(['Cabin', '2', 5, 'single_gender']);
      });
    });

    // ── Seating ──────────────────────────────────────────────────────────────
    describe('seating', () => {
      it('adds tables in bulk, seats a party together, asks before a full table or a split party, and removes only empty tables', async () => {
        const eventId = await newEvent();
        const created = ok(await addTables(db(), eventId, { count: 3, seats: 3 })).created;
        expect(created.map((t) => t.label)).toEqual(['Table 1', 'Table 2', 'Table 3']);
        expect(ok(await addTables(db(), eventId, { from: 3, count: 2, seats: 3 })).skipped).toEqual(['Table 3']);
        const [t1, t2, t3] = created.map((t) => t.id);
        const fam = await register(eventId, ['Ann', 'Ben', 'Cal']);
        const solo = await register(eventId, ['Sol']);
        expect(await seatAtTable(db(), eventId, { attendeeId: fam.people[0], tableId: t1 }, actor)).toEqual({ ok: true, seated: fam.people });
        expect(await seatAtTable(db(), eventId, { attendeeId: solo.people[0], tableId: t1 }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'table_full' });
        ok(await seatAtTable(db(), eventId, { attendeeId: solo.people[0], tableId: t2 }, actor));
        expect(await seatAtTable(db(), eventId, { attendeeId: fam.people[2], tableId: t3, party: false }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'party_split' });
        ok(await seatAtTable(db(), eventId, { attendeeId: fam.people[2], tableId: t3, party: false, confirm: true }, actor));
        expect(await Promise.all(fam.people.map(tableOf))).toEqual([t1, t1, t3]);
        expect(await setTableHost(db(), eventId, { tableId: t1, attendeeId: solo.people[0] }, actor)).toEqual({ ok: false, code: 'not_seated' });
        ok(await setTableHost(db(), eventId, { tableId: t1, attendeeId: fam.people[0] }, actor));
        ok(await seatAtTable(db(), eventId, { attendeeId: fam.people[0], tableId: t3 }, actor)); // whole party moves; host role on t1 is cleared
        expect((await listSeating(db(), eventId)).find((t) => t.id === t1)!.hostAttendeeId).toBeNull();
        expect(await deleteTables(db(), eventId, { tableIds: [t1, t2] })).toEqual({ ok: true, deleted: 1, occupied: [t2] });
        ok(await unseat(db(), eventId, { attendeeId: solo.people[0] }, actor));
        ok(await updateTable(db(), eventId, t2, { label: 'Head table', seats: 10 }));
        expect(await updateTable(db(), eventId, t2, { label: 'Table 3' })).toMatchObject({ ok: false, code: 'duplicate' });
        expect(await actionsOf(fam.id)).toEqual(['table_seated', 'table_moved', 'table_host', 'table_moved']);
      });

      it('auto-seat previews deterministically, applies the same plan, and refuses a stale preview', async () => {
        const eventId = await newEvent();
        ok(await addTables(db(), eventId, { count: 2, seats: 4 }));
        const regs = [await register(eventId, ['A1', 'A2', 'A3']), await register(eventId, ['B1', 'B2']), await register(eventId, ['C1', 'C2']), await register(eventId, ['D1'])];
        const first = await previewSeating(db(), eventId, {});
        expect(first).toMatchObject({ stamp: expect.any(String) });
        const second = await previewSeating(db(), eventId, {});
        expect(second).toEqual(first);
        if (!('stamp' in first)) throw new Error('no preview');
        expect(first.plan.violations).toEqual({ partySplit: 0, noRoom: 0, spread: 0, hostMissing: 0 });
        expect(first.plan.seats).toHaveLength(8);

        // A change between preview and apply: the stamp no longer matches.
        const late = await register(eventId, ['Late']);
        expect(await applySeatingPlan(db(), eventId, { stamp: first.stamp, rules: {} }, actor)).toEqual({ ok: false, code: 'stale' });
        expect(await count(`SELECT COUNT(*) AS n FROM reg_table_seats x JOIN reg_tables t ON t.id = x.table_id WHERE t.event_id = ?1`, eventId)).toBe(0);
        await cancelRegistration(db(), late.id);

        const fresh = await previewSeating(db(), eventId, {});
        if (!('stamp' in fresh)) throw new Error('no preview');
        const applied = ok(await applySeatingPlan(db(), eventId, { stamp: fresh.stamp, rules: {} }, actor));
        expect(applied.plan).toEqual(fresh.plan);
        for (const r of regs) expect(new Set(await Promise.all(r.people.map(tableOf))).size).toBe(1);
        expect(await actionsOf(regs[0].id)).toContain('table_auto_seated');
        expect(await seatingStamp(db(), eventId)).not.toBe(fresh.stamp);
        // the same stamp cannot be applied twice
        expect(await applySeatingPlan(db(), eventId, { stamp: fresh.stamp, rules: {} }, actor)).toEqual({ ok: false, code: 'stale' });
        expect(await applySeatingPlan(db(), eventId, { stamp: 'nonsense', rules: {} }, actor)).toMatchObject({ ok: false, code: 'invalid' });
      });

      it('auto-seat applies spread and host rules with tags, and start over reseats everyone', async () => {
        const eventId = await newEvent();
        ok(await addTables(db(), eventId, { count: 2, seats: 3 }));
        const guest = ok(await createTag(db(), eventId, { label: 'Guest', color: 'info' })).id;
        const host = ok(await createTag(db(), eventId, { label: 'Host', color: 'accent' })).id;
        const h1 = await register(eventId, ['H1']);
        const h2 = await register(eventId, ['H2']);
        const g1 = await register(eventId, ['G1']);
        const g2 = await register(eventId, ['G2']);
        ok(await setTag(db(), eventId, { tagId: host, attendeeIds: [h1.people[0], h2.people[0]], on: true }, actor));
        ok(await setTag(db(), eventId, { tagId: guest, attendeeIds: [g1.people[0], g2.people[0]], on: true }, actor));
        const rules = { spread: [{ tagId: guest, max: 1 }], host: { forTagId: guest, hostTagId: host } };
        const preview = await previewSeating(db(), eventId, rules);
        if (!('stamp' in preview)) throw new Error('no preview');
        expect(preview.plan.violations).toEqual({ partySplit: 0, noRoom: 0, spread: 0, hostMissing: 0 });
        ok(await applySeatingPlan(db(), eventId, { stamp: preview.stamp, rules }, actor));
        const tables = await listSeating(db(), eventId);
        expect(tables.map((t) => t.hostAttendeeId).sort()).toEqual([h1.people[0], h2.people[0]].sort());
        expect(new Set([await tableOf(g1.people[0]), await tableOf(g2.people[0])]).size).toBe(2);
        // tag ids of another event are refused
        const other = await newEvent();
        const foreign = ok(await createTag(db(), other, { label: 'X' })).id;
        expect(await previewSeating(db(), eventId, { spread: [{ tagId: foreign, max: 1 }] })).toMatchObject({ ok: false, code: 'invalid' });
        const restart = await previewSeating(db(), eventId, { startOver: true });
        if (!('stamp' in restart)) throw new Error('no preview');
        ok(await applySeatingPlan(db(), eventId, { stamp: restart.stamp, rules: { startOver: true } }, actor));
        expect(await count(`SELECT COUNT(*) AS n FROM reg_table_seats x JOIN reg_tables t ON t.id = x.table_id WHERE t.event_id = ?1`, eventId)).toBe(4);
      });
    });

    // ── Groups ───────────────────────────────────────────────────────────────
    describe('groups', () => {
      it('joins people, asks before a full group, keeps leaders to members and deletes only empty groups', async () => {
        const eventId = await newEvent();
        const g1 = ok(await createGroup(db(), eventId, { name: 'Alpha', capacity: 1 })).id;
        const g2 = ok(await createGroup(db(), eventId, { name: 'Beta' })).id;
        expect(await createGroup(db(), eventId, { name: 'Beta' })).toMatchObject({ ok: false, code: 'duplicate' });
        const reg = await register(eventId, ['Ann', 'Ben']);
        ok(await joinGroup(db(), eventId, { attendeeId: reg.people[0], groupId: g1 }, actor));
        expect(await joinGroup(db(), eventId, { attendeeId: reg.people[1], groupId: g1 }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'group_full' });
        ok(await joinGroup(db(), eventId, { attendeeId: reg.people[1], groupId: g1, confirm: true }, actor));
        expect(await setGroupLeader(db(), eventId, { groupId: g2, attendeeId: reg.people[0] }, actor)).toEqual({ ok: false, code: 'not_member' });
        ok(await setGroupLeader(db(), eventId, { groupId: g1, attendeeId: reg.people[0] }, actor));
        ok(await joinGroup(db(), eventId, { attendeeId: reg.people[0], groupId: g2 }, actor));
        expect((await listGroups(db(), eventId)).map((g) => [g.name, g.members.length, g.leaderAttendeeId])).toEqual([['Alpha', 1, null], ['Beta', 1, null]]);
        expect(await deleteGroup(db(), eventId, g1)).toEqual({ ok: false, code: 'group_not_empty' });
        ok(await leaveGroup(db(), eventId, { attendeeId: reg.people[1] }, actor));
        ok(await deleteGroup(db(), eventId, g1));
        ok(await updateGroup(db(), eventId, g2, { name: 'Gamma', capacity: 5, notes: 'Room 3' }));
        expect((await listGroups(db(), eventId)).map((g) => [g.name, g.capacity, g.notes])).toEqual([['Gamma', 5, 'Room 3']]);
      });

      it('auto-fills groups by a per-person choice question, creating one group per option or filling mapped groups', async () => {
        const eventId = await newEvent();
        await mustForm(eventId, { questions: [{ type: 'select', scope: 'attendee', labels: { en: 'Language' }, options: [{ key: 'en', labels: { en: 'English' } }, { key: 'zh', labels: { en: 'Mandarin' } }] }] });
        const [lang] = await listQuestions(db(), 'en', eventId);
        const a = await register(eventId, [{ name: 'A1', answers: [[lang.id, 'en']] }, { name: 'A2', answers: [[lang.id, 'zh']] }]);
        const b = await register(eventId, [{ name: 'B1', answers: [[lang.id, 'zh']] }, { name: 'B2' }]);
        expect(await autoFillGroups(db(), eventId, { questionId: lang.id, capacity: 1 }, actor)).toMatchObject({ code: 'NEEDS_CONFIRM', reason: 'group_full' });
        expect(await listGroups(db(), eventId)).toEqual([]);
        const filled = await autoFillGroups(db(), eventId, { questionId: lang.id }, actor);
        expect(filled).toEqual({ ok: true, placed: 3, noAnswer: 1, created: ['English', 'Mandarin'], overCapacity: 0 });
        const groups = await listGroups(db(), eventId);
        expect(groups.map((g) => [g.name, g.members.length])).toEqual([['English', 1], ['Mandarin', 2]]);
        expect(await groupOf(b.people[1])).toBeNull();
        expect(await actionsOf(a.id)).toContain('group_auto_filled');

        // A second event: map Mandarin onto two existing groups with capacity 1 each, spread evenly.
        const other = await newEvent();
        await mustForm(other, { questions: [{ type: 'select', scope: 'attendee', labels: { en: 'Language' }, options: [{ key: 'en', labels: { en: 'English' } }, { key: 'zh', labels: { en: 'Mandarin' } }] }] });
        const [lang2] = await listQuestions(db(), 'en', other);
        const ma = ok(await createGroup(db(), other, { name: 'Mandarin A', capacity: 1 })).id;
        const mb = ok(await createGroup(db(), other, { name: 'Mandarin B', capacity: 1 })).id;
        const c = await register(other, [{ name: 'C1', answers: [[lang2.id, 'zh']] }, { name: 'C2', answers: [[lang2.id, 'zh']] }, { name: 'C3', answers: [[lang2.id, 'en']] }]);
        expect(await autoFillGroups(db(), other, { questionId: lang2.id, mapping: { zh: [ma, mb], en: [] } }, actor)).toEqual({ ok: true, placed: 2, noAnswer: 0, created: [], overCapacity: 0 });
        expect(new Set([await groupOf(c.people[0]), await groupOf(c.people[1])])).toEqual(new Set([ma, mb]));
        expect(await groupOf(c.people[2])).toBeNull();
        // a mapping to a group of another event is refused; a non-person question is refused
        expect(await autoFillGroups(db(), other, { questionId: lang2.id, mapping: { zh: [groups[0].id] } }, actor)).toEqual({ ok: false, code: 'not_found' });
        expect(await autoFillGroups(db(), other, { questionId: lang.id }, actor)).toMatchObject({ ok: false, code: 'invalid' });
      });
    });

    // ── Tags ─────────────────────────────────────────────────────────────────
    describe('tags', () => {
      it('creates tags, tags people by hand and by answer (per person and per registration)', async () => {
        const eventId = await newEvent();
        await mustForm(eventId, { questions: [
          { type: 'yesno', scope: 'attendee', labels: { en: 'First time' } },
          { type: 'checkbox', labels: { en: 'Needs' }, options: [{ key: 'ramp', labels: { en: 'Ramp' } }, { key: 'quiet', labels: { en: 'Quiet' } }] },
        ] });
        const [first, needs] = await listQuestions(db(), 'en', eventId);
        const a = await register(eventId, [{ name: 'Ann', answers: [[first.id, 'yes']] }, { name: 'Ben', answers: [[first.id, 'no']] }], { answers: [[needs.id, '["ramp","quiet"]']] });
        const b = await register(eventId, [{ name: 'Cal', answers: [[first.id, 'yes']] }]);
        const newcomer = ok(await createTag(db(), eventId, { label: 'Newcomer', color: 'info' })).id;
        const access = ok(await createTag(db(), eventId, { label: 'Access' })).id;
        expect(await createTag(db(), eventId, { label: 'Newcomer' })).toMatchObject({ ok: false, code: 'duplicate' });
        expect(await createTag(db(), eventId, { label: 'Bad', color: 'neon' })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await applyTagByAnswer(db(), eventId, { tagId: newcomer, questionId: first.id, option: 'yes' }, actor)).toEqual({ ok: true, tagged: 2, matched: 2 });
        expect(await applyTagByAnswer(db(), eventId, { tagId: newcomer, questionId: first.id, option: 'yes' }, actor)).toEqual({ ok: true, tagged: 0, matched: 2 });
        expect(await applyTagByAnswer(db(), eventId, { tagId: access, questionId: needs.id, option: 'quiet' }, actor)).toEqual({ ok: true, tagged: 2, matched: 2 });
        expect(await applyTagByAnswer(db(), eventId, { tagId: access, questionId: needs.id, option: 'stairs' }, actor)).toMatchObject({ ok: false, code: 'invalid' });
        const people = await listLogisticsPeople(db(), eventId);
        expect(people.map((p) => [p.name, p.tags.length])).toEqual([['Ann', 2], ['Ben', 1], ['Cal', 1]]);
        expect((await listTags(db(), eventId)).map((t) => [t.label, t.color, t.people])).toEqual([['Access', 'neutral', 2], ['Newcomer', 'info', 2]]);
        expect(await setTag(db(), eventId, { tagId: newcomer, attendeeIds: [a.people[0], b.people[0]], on: false }, actor)).toEqual({ ok: true, changed: 2 });
        ok(await updateTag(db(), eventId, access, { label: 'Accessibility', color: 'warn' }));
        ok(await deleteTag(db(), eventId, newcomer));
        expect((await listTags(db(), eventId)).map((t) => t.label)).toEqual(['Accessibility']);
        expect(await actionsOf(a.id)).toEqual(expect.arrayContaining(['tagged', 'untagged']));
      });
    });

    // ── Cancel cascade ───────────────────────────────────────────────────────
    describe('cancel cascade', () => {
      async function placed() {
        const { eventId, rooms } = await housed({ beds: 4 });
        const table = ok(await addTables(db(), eventId, { count: 1, seats: 6 })).created[0].id;
        const group = ok(await createGroup(db(), eventId, { name: 'G' })).id;
        const reg = await register(eventId, ['Ann', 'Ben']);
        ok(await assignRoom(db(), eventId, { attendeeId: reg.people[0], roomId: rooms[0] }, actor));
        ok(await seatAtTable(db(), eventId, { attendeeId: reg.people[0], tableId: table }, actor));
        for (const p of reg.people) ok(await joinGroup(db(), eventId, { attendeeId: p, groupId: group }, actor));
        ok(await setRoomLeader(db(), eventId, { roomId: rooms[0], attendeeId: reg.people[0] }, actor));
        ok(await setTableHost(db(), eventId, { tableId: table, attendeeId: reg.people[0] }, actor));
        ok(await setGroupLeader(db(), eventId, { groupId: group, attendeeId: reg.people[0] }, actor));
        return { eventId, reg, room: rooms[0], table, group };
      }
      const placement = async (id: number) => [await roomOf(id), await tableOf(id), await groupOf(id)];

      it('removing a person (staff) releases their room, seat, group and roles in the same batch', async () => {
        const { eventId, reg, room, table, group } = await placed();
        ok(await adminRemovePerson(db(), reg.id, { version: 1, attendeeId: reg.people[0] }, actor));
        expect(await placement(reg.people[0])).toEqual([null, null, null]);
        expect(await placement(reg.people[1])).toEqual([room, table, group]);
        expect((await listHousing(db(), eventId))[0].rooms[0].leaderAttendeeId).toBeNull();
        expect((await listSeating(db(), eventId))[0].hostAttendeeId).toBeNull();
        expect((await listGroups(db(), eventId))[0].leaderAttendeeId).toBeNull();
        expect((await actionsOf(reg.id)).slice(-2)).toEqual(['person_removed', 'logistics_released']);
      });

      it('cancelling a registration (staff, self, or by id) or declining it releases everyone', async () => {
        const staff = await placed();
        ok(await adminCancelRegistration(db(), staff.reg.id, {}, actor));
        for (const p of staff.reg.people) expect(await placement(p)).toEqual([null, null, null]);
        expect(await actionsOf(staff.reg.id)).toContain('logistics_released');

        const self = await placed();
        expect(await cancelAttendee(db(), self.reg.id, self.reg.people[1])).toMatchObject({ ok: true });
        expect(await placement(self.reg.people[1])).toEqual([null, null, null]);
        expect(await groupOf(self.reg.people[0])).toBe(self.group);
        await cancelRegistration(db(), self.reg.id);
        expect(await placement(self.reg.people[0])).toEqual([null, null, null]);

        const declined = await placed();
        await db().prepare(`UPDATE registrations SET status = 'review' WHERE id = ?1`).bind(declined.reg.id).run();
        ok(await decideRegistration(db(), declined.reg.id, 'decline', null));
        for (const p of declined.reg.people) expect(await placement(p)).toEqual([null, null, null]);
        const kept = await placed();
        await db().prepare(`UPDATE registrations SET status = 'review' WHERE id = ?1`).bind(kept.reg.id).run();
        ok(await decideRegistration(db(), kept.reg.id, 'accept', null));
        expect(await placement(kept.reg.people[0])).toEqual([kept.room, kept.table, kept.group]);
        expect(await actionsOf(kept.reg.id)).not.toContain('logistics_released');
      });
    });

    // ── What registrants and the desk see ────────────────────────────────────
    describe('visibility', () => {
      it('the summary shows room, table and group only when asked for and switched on for registrants', async () => {
        const { eventId, rooms } = await housed();
        const table = ok(await addTables(db(), eventId, { count: 1, seats: 4 })).created[0].id;
        const reg = await register(eventId, ['Ann', 'Ben']);
        ok(await assignRoom(db(), eventId, { attendeeId: reg.people[0], roomId: rooms[0], party: false }, actor));
        ok(await seatAtTable(db(), eventId, { attendeeId: reg.people[0], tableId: table }, actor));
        const hidden = await registrationSummary(db(), reg.id, 'en', undefined, { logistics: true });
        expect(hidden!.attendees.every((a) => a.assignments === undefined)).toBe(true);
        ok(await saveLogisticsSettings(db(), eventId, { showAssignments: true, groups: false }));
        expect((await registrationSummary(db(), reg.id, 'en'))!.attendees[0].assignments).toBeUndefined(); // module off: caller did not ask
        const shown = await registrationSummary(db(), reg.id, 'en', undefined, { logistics: true });
        expect(shown!.attendees.map((a) => a.assignments)).toEqual([
          { room: { label: '1', venue: 'Pine Lodge' }, table: { label: 'Table 1' } },
          { room: null, table: { label: 'Table 1' } },
        ]);
      });

      it('the desk shows room and table when the module is on', async () => {
        const { eventId, rooms } = await housed();
        const reg = await register(eventId, ['Desk Person']);
        ok(await assignRoom(db(), eventId, { attendeeId: reg.people[0], roomId: rooms[1] }, actor));
        const plain = await findForDesk(db(), eventId, 'Desk Person', 'en');
        expect(plain.parties[0].people[0].room).toBeUndefined();
        const withRooms = await findForDesk(db(), eventId, 'Desk Person', 'en', { logistics: true });
        expect(withRooms.parties[0].people[0]).toMatchObject({ room: { label: '2', venue: 'Pine Lodge' }, table: null });
        const map = await assignmentsForAttendees(db(), eventId, reg.people);
        expect(map!.get(reg.people[0])).toEqual({ room: { label: '2', venue: 'Pine Lodge' }, table: null, group: null });
      });

      it('the overview counts progress for eligible people', async () => {
        const { eventId, rooms } = await housed({ beds: 2, rooms: 2 });
        ok(await addTables(db(), eventId, { count: 2, seats: 5 }));
        const reg = await register(eventId, ['Ann', 'Ben', 'Cal']);
        ok(await assignRoom(db(), eventId, { attendeeId: reg.people[0], roomId: rooms[0], party: false }, actor));
        expect(await logisticsOverview(db(), eventId)).toEqual({
          people: 3,
          housing: { enabled: true, assigned: 1, rooms: 2, confirmedRooms: 2, beds: 4 },
          seating: { enabled: true, seated: 0, tables: 2, seats: 10 },
          groups: { enabled: true, placed: 0, groups: 0 },
        });
      });
    });

    // ── Cross-event refusal ──────────────────────────────────────────────────
    describe('cross-event ids', () => {
      it('refuses every room, table, group, tag and person of another event', async () => {
        const a = await housed();
        const b = await housed();
        const tableB = ok(await addTables(db(), b.eventId, { count: 1, seats: 4 })).created[0].id;
        const groupB = ok(await createGroup(db(), b.eventId, { name: 'B' })).id;
        const tagB = ok(await createTag(db(), b.eventId, { label: 'B' })).id;
        const personA = (await register(a.eventId, ['Ann'])).people[0];
        const personB = (await register(b.eventId, ['Bob'])).people[0];
        const notFound = { ok: false, code: 'not_found' };
        expect(await assignRoom(db(), a.eventId, { attendeeId: personA, roomId: b.rooms[0] }, actor)).toEqual(notFound);
        expect(await assignRoom(db(), a.eventId, { attendeeId: personB, roomId: a.rooms[0] }, actor)).toEqual(notFound);
        expect(await assignRoom(db(), b.eventId, { attendeeId: personA, roomId: b.rooms[0] }, actor)).toEqual(notFound);
        expect(await setRoomsConfirmed(db(), a.eventId, { roomIds: [a.rooms[0], b.rooms[0]], confirmed: false })).toEqual(notFound);
        expect(await deleteRooms(db(), a.eventId, { roomIds: [b.rooms[0]] })).toEqual(notFound);
        expect(await deleteVenue(db(), a.eventId, b.venue)).toEqual(notFound);
        expect(await setRoomLeader(db(), a.eventId, { roomId: b.rooms[0], attendeeId: null }, actor)).toEqual(notFound);
        expect(await clearRoom(db(), a.eventId, { roomId: b.rooms[0] }, actor)).toEqual(notFound);
        expect(await seatAtTable(db(), a.eventId, { attendeeId: personA, tableId: tableB }, actor)).toEqual(notFound);
        expect(await setTableHost(db(), a.eventId, { tableId: tableB, attendeeId: null }, actor)).toEqual(notFound);
        expect(await deleteTables(db(), a.eventId, { tableIds: [tableB] })).toEqual(notFound);
        expect(await joinGroup(db(), a.eventId, { attendeeId: personA, groupId: groupB }, actor)).toEqual(notFound);
        expect(await deleteGroup(db(), a.eventId, groupB)).toEqual(notFound);
        expect(await setTag(db(), a.eventId, { tagId: tagB, attendeeIds: [personA], on: true }, actor)).toEqual(notFound);
        expect(await setTag(db(), b.eventId, { tagId: tagB, attendeeIds: [personA], on: true }, actor)).toEqual(notFound);
        expect(await deleteTag(db(), a.eventId, tagB)).toEqual(notFound);
        expect(await unassignRoom(db(), b.eventId, { attendeeId: personA }, actor)).toEqual(notFound);
        // nothing was written anywhere
        expect([await roomOf(personA), await roomOf(personB), await tableOf(personA), await groupOf(personA)]).toEqual([null, null, null, null]);
        expect(await count(`SELECT COUNT(*) AS n FROM reg_attendee_tags WHERE tag_id = ?1`, tagB)).toBe(0);
        expect((await listHousing(db(), b.eventId))[0].rooms.every((r) => r.confirmed)).toBe(true);
      });
    });
  });
}
