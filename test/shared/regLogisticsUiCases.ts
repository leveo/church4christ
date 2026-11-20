// The event page's logistics actions (Housing, Tables, Groups, tags) through the ONE dispatcher, on BOTH backends:
// the access matrix (stranger, desk volunteer and viewer refused on every action, registrar and area admin let
// through), the module gate (off = 404), the per-event area switch, cross-event ids, the outcome shapes the page
// renders (confirm with every reason, a reason for a checked-in move, the auto-seat preview and its stale stamp),
// the board filters and the settings form. Run against D1 (test/regLogisticsUi.d1.test.ts) and Postgres
// (test/pg/regLogisticsUi.pg.test.ts). No cloudflare:test or node imports, and the name does not end in .test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbBackend } from '../../src/lib/dbProvider';
import type { SessionUser } from '../../src/lib/types';
import { createRegistration, listQuestions, saveEvent, saveEventForm, type EventFormPayload, type RegAttendeeInput } from '../../src/lib/regDb';
import { grantEventRole } from '../../src/lib/regAccess';
import { listActivity } from '../../src/lib/regAdmin';
import { checkIn } from '../../src/lib/regCheckin';
import { REG_ADMIN_ACTIONS, runRegAdminAction, safeBack, type ActionOutcome, type RegActionContext } from '../../src/lib/regAdminPage';
import { activityKey, failureKey, noticeKey, reasonKey } from '../../src/lib/regAdminView';
import { listLogisticsPeople, saveLogisticsSettings, type LogisticsSettingsInput } from '../../src/lib/regLogistics';
import { listHousing } from '../../src/lib/regHousing';
import { listSeating } from '../../src/lib/regSeating';
import { listGroups } from '../../src/lib/regGroups';
import {
  LOGISTICS_ACTIONS, boardQuery, filterBoardPeople, logisticsSettingsFromForm, parseBoardState, peopleWithAnswer, seatingRulesFromForm,
} from '../../src/lib/regLogisticsPage';

const DAY = 24 * 3600_000;
const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1, email: 'x@example.com', displayName: 'X', role: 'member', isAdmin: false, isEditor: false, finance: 0,
  memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: [], ...over,
});

const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) fd.append(k, value);
  return fd;
};

export function defineRegLogisticsUiCases(label: string, getDb: () => AppDb, backend: DbBackend): void {
  const env = { DB_BACKEND: backend, APP_ORIGIN: 'https://church.example' } as RegActionContext['env'];
  const db = () => getDb();
  const run = (u: SessionUser, eventId: number, fields: Record<string, string | string[]>, logistics = true) =>
    runRegAdminAction({ db: db(), env, user: u, eventId, portal: false, defaultLocale: 'en', logistics }, form(fields));
  const newEvent = async (flags: LogisticsSettingsInput = { housing: true, seating: true, groups: true }) => {
    const id = await saveEvent(db(), { title_en: 'Summer Retreat', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 8 });
    expect(await saveLogisticsSettings(db(), id, flags)).toMatchObject({ ok: true });
    return id;
  };
  const register = async (eventId: number, names: Array<string | RegAttendeeInput>) => {
    const attendees = names.map((n) => (typeof n === 'string' ? { name: n } : n));
    const n = ++seq;
    const reg = await createRegistration(db(), {
      eventId, personId: null, name: attendees[0].name, email: `lxui-${n}-${Date.now()}@example.com`, status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], attendees, submissionKey: `lxui-${Date.now()}-${n}`, allowWaitlist: false,
    });
    const { results } = await db().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`).bind(reg.id).all<{ id: number }>();
    return { id: reg.id, people: results.map((r) => Number(r.id)) };
  };
  const person = async (name: string) => {
    const row = await db().prepare(`INSERT INTO people (display_name, email) VALUES (?1, ?2) RETURNING id`).bind(name, `${name.toLowerCase()}-${++seq}-${Date.now()}@example.com`).first<{ id: number }>();
    return Number(row!.id);
  };
  const mustForm = async (eventId: number, payload: EventFormPayload) => expect(await saveEventForm(db(), eventId, payload, { backend })).toEqual({ ok: true });
  const n = async (sql: string, ...binds: unknown[]) => Number((await db().prepare(sql).bind(...binds).first<{ n: number }>())!.n);
  const okNotice = (outcome: ActionOutcome, notice: string) => {
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'ok', notice });
    return outcome as Extract<ActionOutcome, { kind: 'ok' }>;
  };

  const areaAdmin = user({ id: 9201, role: 'admin', isAdmin: true, adminAreas: ['registration'] });

  /** An event with one venue ("Pine Lodge", dorm = hard beds), a 2-bed room type and confirmed rooms 101-103. */
  async function housed(admin: SessionUser) {
    const eventId = await newEvent();
    okNotice(await run(admin, eventId, { action: 'venue_create', name: 'Pine Lodge', kind: 'dorm' }), 'lx_saved');
    const [venue] = await listHousing(db(), eventId);
    okNotice(await run(admin, eventId, { action: 'room_type_create', venue_id: String(venue.id), name: 'Bunk room', beds: '2' }), 'lx_saved');
    const type = (await listHousing(db(), eventId))[0].roomTypes[0];
    const added = okNotice(await run(admin, eventId, { action: 'rooms_add', venue_id: String(venue.id), labels: '101-103', room_type_id: String(type.id), policy: 'any' }), 'lx_rooms_added');
    expect(added.extra).toMatchObject({ tab: 'housing', n: '3', m: '0' });
    const rooms = (await listHousing(db(), eventId))[0].rooms;
    okNotice(await run(admin, eventId, { action: 'rooms_bulk', op: 'confirm', room_ids: rooms.map((r) => String(r.id)) }), 'lx_rooms_confirmed');
    return { eventId, venueId: venue.id, rooms: rooms.map((r) => r.id) };
  }

  describe(`event page logistics actions (${label})`, () => {
    beforeEach(async () => {
      // The registration admin who acts is recorded in the history (a foreign key to people).
      await db().prepare(`INSERT INTO people (id, display_name, email) VALUES (?1, 'Staff', 'staff9201@example.com') ON CONFLICT (id) DO NOTHING`).bind(areaAdmin.id).run();
    });

    it('every logistics action is in the one table and needs manage', () => {
      for (const [name, spec] of Object.entries(LOGISTICS_ACTIONS)) {
        expect(REG_ADMIN_ACTIONS[name], name).toEqual(spec);
        expect(spec.need).toBe('manage');
      }
    });

    it('a stranger, a desk volunteer and a viewer are refused (403) on every logistics action, and nothing is written', async () => {
      const { eventId } = await housed(areaAdmin);
      const stranger = user({ id: await person('Stranger') });
      const desk = user({ id: await person('Desk') });
      const viewer = user({ id: await person('Viewer') });
      await grantEventRole(db(), eventId, desk.id, 'desk');
      await grantEventRole(db(), eventId, viewer.id, 'viewer');
      const before = await n(`SELECT logistics_version AS n FROM reg_events WHERE id = ?1`, eventId);
      for (const action of Object.keys(LOGISTICS_ACTIONS)) {
        for (const [who, u] of [['stranger', stranger], ['desk', desk], ['viewer', viewer]] as const) {
          expect(await run(u, eventId, { action, name: 'X', label: 'X', labels: '1-2', count: '2', seats: '4' }), `${who} ${action}`).toEqual({ kind: 'denied', status: 403 });
        }
      }
      expect(await n(`SELECT logistics_version AS n FROM reg_events WHERE id = ?1`, eventId)).toBe(before);
    });

    it('with the module off every logistics action answers 404, even for a registration admin', async () => {
      const eventId = await newEvent();
      for (const action of Object.keys(LOGISTICS_ACTIONS)) {
        expect(await run(areaAdmin, eventId, { action, name: 'X' }, false), action).toEqual({ kind: 'denied', status: 404 });
      }
      expect(await n(`SELECT COUNT(*) AS n FROM reg_venues WHERE event_id = ?1`, eventId)).toBe(0);
    });

    it('an area switched off for the event refuses its actions; tags need any area', async () => {
      const eventId = await newEvent({ housing: true });
      expect(await run(areaAdmin, eventId, { action: 'tables_add', count: '2', seats: '8' })).toEqual({ kind: 'failed', code: 'lx_disabled', reg: null });
      expect(await run(areaAdmin, eventId, { action: 'group_create', name: 'Blue' })).toEqual({ kind: 'failed', code: 'lx_disabled', reg: null });
      okNotice(await run(areaAdmin, eventId, { action: 'venue_create', name: 'Cedar Hall' }), 'lx_saved');
      okNotice(await run(areaAdmin, eventId, { action: 'tag_create', label: 'Volunteer', color: 'info', tab: 'housing' }), 'lx_saved');
      const none = await newEvent({ housing: false, seating: false, groups: false });
      expect(await run(areaAdmin, none, { action: 'tag_create', label: 'Volunteer' })).toEqual({ kind: 'failed', code: 'lx_disabled', reg: null });
      expect(await run(areaAdmin, none, { action: 'venue_create', name: 'Pine Lodge' })).toEqual({ kind: 'failed', code: 'lx_disabled', reg: null });
      // A template is no event for logistics.
      const template = await saveEvent(db(), { title_en: 'Template', starts_at: tsAt(30 * DAY), active: 0 });
      await db().prepare(`UPDATE reg_events SET is_template = 1 WHERE id = ?1`).bind(template).run();
      expect(await run(areaAdmin, template, { action: 'venue_create', name: 'X' })).toEqual({ kind: 'denied', status: 404 });
    });

    it('a per-event registrar houses a party together, is asked to confirm a soft limit, and is refused a hard one', async () => {
      const registrar = user({ id: await person('Registrar') });
      const eventId = await newEvent();
      await grantEventRole(db(), eventId, registrar.id, 'registrar');
      okNotice(await run(registrar, eventId, { action: 'venue_create', name: 'Pine Lodge', kind: 'hotel' }), 'lx_saved'); // hotel: soft
      okNotice(await run(registrar, eventId, { action: 'venue_create', name: 'Cedar Hall', kind: 'dorm' }), 'lx_saved'); // dorm: hard
      const [pine, cedar] = await listHousing(db(), eventId);
      expect([pine.capacityRule, cedar.capacityRule]).toEqual(['soft', 'hard']);
      // Range entry: reversed and missing beds are explained; a good range adds every room, unconfirmed.
      expect(await run(registrar, eventId, { action: 'rooms_add', venue_id: String(pine.id), labels: '120-101', beds: '2' })).toEqual({ kind: 'failed', code: 'lx_labels_reversed', reg: null });
      expect(await run(registrar, eventId, { action: 'rooms_add', venue_id: String(pine.id), labels: '101-102' })).toEqual({ kind: 'failed', code: 'lx_beds_required', reg: null });
      okNotice(await run(registrar, eventId, { action: 'rooms_add', venue_id: String(pine.id), labels: '201', beds: '2' }), 'lx_rooms_added');
      okNotice(await run(registrar, eventId, { action: 'rooms_add', venue_id: String(cedar.id), labels: 'A1', beds: '2' }), 'lx_rooms_added');
      const [pineRoom, cedarRoom] = (await listHousing(db(), eventId)).map((v) => v.rooms[0].id);
      const family = await register(eventId, ['Ana Lopez', 'Ben Lopez', 'Cara Lopez']);
      // An unconfirmed room takes nobody.
      expect(await run(registrar, eventId, { action: 'room_assign', attendee_id: String(family.people[0]), room_id: String(pineRoom), party: '1' }))
        .toEqual({ kind: 'failed', code: 'lx_room_unconfirmed', reg: null });
      okNotice(await run(registrar, eventId, { action: 'rooms_bulk', op: 'confirm', room_ids: [String(pineRoom), String(cedarRoom)] }), 'lx_rooms_confirmed');
      // Hard beds: refused outright.
      expect(await run(registrar, eventId, { action: 'room_assign', attendee_id: String(family.people[0]), room_id: String(cedarRoom), party: ['0', '1'] }))
        .toEqual({ kind: 'failed', code: 'lx_ROOM_FULL', reg: null });
      // Soft beds: asked, with every reason, and the replay carries the fields; nothing written yet.
      const asked = await run(registrar, eventId, { action: 'room_assign', attendee_id: String(family.people[0]), room_id: String(pineRoom), party: ['0', '1'], tab: 'housing' });
      expect(asked).toMatchObject({ kind: 'confirm', reason: 'room_over_capacity', reasons: ['room_over_capacity'] });
      expect((asked as { fields: Array<[string, string]> }).fields).toEqual(expect.arrayContaining([['action', 'room_assign'], ['room_id', String(pineRoom)]]));
      expect(await n(`SELECT COUNT(*) AS n FROM reg_room_assignments WHERE room_id = ?1`, pineRoom)).toBe(0);
      const placed = okNotice(await run(registrar, eventId, { action: 'room_assign', attendee_id: String(family.people[0]), room_id: String(pineRoom), party: ['0', '1'], confirm: '1' }), 'lx_assigned');
      expect(placed.extra).toMatchObject({ tab: 'housing', n: '3' });
      expect(await n(`SELECT COUNT(*) AS n FROM reg_room_assignments WHERE room_id = ?1`, pineRoom)).toBe(3);
      expect((await listActivity(db(), family.id)).map((a) => a.action)).toContain('room_assigned');
      // "Bring the rest of their party" off: only the one person moves.
      const pair = await register(eventId, ['Dan Kim', 'Eve Kim']);
      await db().prepare(`UPDATE reg_rooms SET beds_override = 4 WHERE id = ?1`).bind(cedarRoom).run();
      okNotice(await run(registrar, eventId, { action: 'room_assign', attendee_id: String(pair.people[0]), room_id: String(cedarRoom), party: '0' }), 'lx_assigned');
      expect(await n(`SELECT COUNT(*) AS n FROM reg_room_assignments WHERE room_id = ?1`, cedarRoom)).toBe(1);
      // Moving someone who is checked in asks for a reason, then records it.
      await checkIn(db(), pair.people[0], null);
      const why = await run(registrar, eventId, { action: 'room_assign', attendee_id: String(pair.people[0]), room_id: String(pineRoom), party: '0', confirm: '1' });
      expect(why).toMatchObject({ kind: 'reason' });
      expect((why as { fields: Array<[string, string]> }).fields).toContainEqual(['confirm', '1']);
      okNotice(await run(registrar, eventId, { action: 'room_assign', attendee_id: String(pair.people[0]), room_id: String(pineRoom), party: '0', confirm: '1', reason: 'Asked to be near family' }), 'lx_assigned');
      const moved = (await listActivity(db(), pair.id)).find((a) => a.action === 'room_moved');
      expect(moved?.detail).toMatchObject({ reason: 'Asked to be near family' });
      // An occupied room cannot be unconfirmed or deleted (reported, kept).
      expect(okNotice(await run(registrar, eventId, { action: 'rooms_bulk', op: 'delete', room_ids: [String(pineRoom)] }), 'lx_rooms_deleted').extra).toMatchObject({ n: '0', m: '1' });
      expect(await run(registrar, eventId, { action: 'rooms_bulk', op: 'confirm' })).toEqual({ kind: 'failed', code: 'lx_none_selected', reg: null });
    });

    it('refuses rooms, tables, groups, tags and people of another event (lx_not_found), whoever asks', async () => {
      const mine = await housed(areaAdmin);
      const other = await housed(areaAdmin);
      const foreigner = await register(other.eventId, ['Fay Other']);
      const local = await register(mine.eventId, ['Lee Local']);
      expect(await run(areaAdmin, mine.eventId, { action: 'room_assign', attendee_id: String(foreigner.people[0]), room_id: String(mine.rooms[0]) })).toEqual({ kind: 'failed', code: 'lx_not_found', reg: null });
      expect(await run(areaAdmin, mine.eventId, { action: 'room_assign', attendee_id: String(local.people[0]), room_id: String(other.rooms[0]) })).toEqual({ kind: 'failed', code: 'lx_not_found', reg: null });
      expect(await run(areaAdmin, mine.eventId, { action: 'venue_delete', venue_id: String(other.venueId) })).toEqual({ kind: 'failed', code: 'lx_not_found', reg: null });
      expect(await run(areaAdmin, mine.eventId, { action: 'rooms_bulk', op: 'delete', room_ids: [String(other.rooms[1])] })).toEqual({ kind: 'failed', code: 'lx_not_found', reg: null });
      expect(await n(`SELECT COUNT(*) AS n FROM reg_rooms WHERE venue_id = ?1`, other.venueId)).toBe(3);
    });

    it('tables: add, seat a party, preview auto-seat, apply it, and refuse a stale preview', async () => {
      const eventId = await newEvent({ seating: true });
      okNotice(await run(areaAdmin, eventId, { action: 'tables_add', count: '3', seats: '4', prefix: 'Table' }), 'lx_tables_added');
      const tables = await listSeating(db(), eventId);
      expect(tables.map((t) => t.label)).toEqual(['Table 1', 'Table 2', 'Table 3']);
      const a = await register(eventId, ['Gus Park', 'Hana Park']);
      const b = await register(eventId, ['Ivy Chen', 'Jay Chen', 'Kai Chen']);
      await register(eventId, ['Lou Diaz']);
      okNotice(await run(areaAdmin, eventId, { action: 'table_seat', attendee_id: String(a.people[0]), table_id: String(tables[0].id), party: ['0', '1'] }), 'lx_seated');
      expect((await listSeating(db(), eventId))[0].occupants).toEqual(a.people);
      // Seating one person of a party elsewhere asks first (party split).
      expect(await run(areaAdmin, eventId, { action: 'table_seat', attendee_id: String(a.people[1]), table_id: String(tables[1].id), party: '0' }))
        .toMatchObject({ kind: 'confirm', reasons: ['party_split'] });
      const preview = await run(areaAdmin, eventId, { action: 'seat_preview', start_over: '0', tab: 'tables' });
      expect(preview.kind).toBe('seat_preview');
      const { stamp, plan, fields } = preview as Extract<ActionOutcome, { kind: 'seat_preview' }>;
      expect(plan.left).toEqual([]);
      expect(fields).not.toContainEqual(['action', 'seat_preview']);
      // Nothing was written by the preview.
      expect(await n(`SELECT COUNT(*) AS n FROM reg_table_seats x JOIN reg_tables t ON t.id = x.table_id WHERE t.event_id = ?1`, eventId)).toBe(2);
      // Data changes after the preview: the apply is refused and writes nothing.
      await register(eventId, ['Mia Late']);
      expect(await run(areaAdmin, eventId, { action: 'seat_apply', start_over: '0', stamp })).toEqual({ kind: 'failed', code: 'lx_stale_seating', reg: null });
      expect(await n(`SELECT COUNT(*) AS n FROM reg_table_seats x JOIN reg_tables t ON t.id = x.table_id WHERE t.event_id = ?1`, eventId)).toBe(2);
      const fresh = (await run(areaAdmin, eventId, { action: 'seat_preview', start_over: '0' })) as Extract<ActionOutcome, { kind: 'seat_preview' }>;
      const applied = okNotice(await run(areaAdmin, eventId, { action: 'seat_apply', start_over: '0', stamp: fresh.stamp }), 'lx_seat_applied');
      expect(applied.extra).toMatchObject({ tab: 'tables', n: '5', m: '0' });
      const seated = await listSeating(db(), eventId);
      expect(seated.flatMap((t) => t.occupants)).toHaveLength((await listLogisticsPeople(db(), eventId)).length);
      // Keep-party-together: the Chens share one table.
      expect(new Set(b.people.map((id) => seated.find((t) => t.occupants.includes(id))!.id)).size).toBe(1);
      // A half-filled rule is refused before anything runs.
      expect(await run(areaAdmin, eventId, { action: 'seat_preview', spread_tag: '5' })).toEqual({ kind: 'failed', code: 'lx_rules', reg: null });
      // Only empty tables go.
      const deleted = okNotice(await run(areaAdmin, eventId, { action: 'tables_delete', table_ids: seated.map((t) => String(t.id)) }), 'lx_tables_deleted');
      expect(deleted.extra).toMatchObject({ m: String(seated.filter((t) => t.occupants.length > 0).length) });
    });

    it('groups: auto-fill by a per-person question asks before going over capacity; tags by hand and by answer', async () => {
      const eventId = await newEvent({ groups: true });
      await mustForm(eventId, { questions: [{ type: 'select', scope: 'attendee', labels: { en: 'Language' }, options: [{ key: 'en', labels: { en: 'English' } }, { key: 'zh', labels: { en: 'Mandarin' } }] }] });
      const [language] = await listQuestions(db(), 'en', eventId);
      const a = await register(eventId, [{ name: 'Nia Ross', answers: [[language.id, 'en']] }, { name: 'Oli Ross', answers: [[language.id, 'zh']] }]);
      await register(eventId, [{ name: 'Pat Wu', answers: [[language.id, 'zh']] }, { name: 'Quinn Wu' }]);
      expect(await run(areaAdmin, eventId, { action: 'group_autofill', question_id: String(language.id), capacity: '1' })).toMatchObject({ kind: 'confirm', reasons: ['group_full'] });
      expect(await listGroups(db(), eventId)).toEqual([]);
      const filled = okNotice(await run(areaAdmin, eventId, { action: 'group_autofill', question_id: String(language.id), capacity: '1', confirm: '1' }), 'lx_group_filled');
      expect(filled.extra).toMatchObject({ tab: 'groups', n: '3', m: '1' });
      const groups = await listGroups(db(), eventId);
      expect(groups.map((g) => [g.name, g.members.length])).toEqual([['English', 1], ['Mandarin', 2]]);
      expect(await run(areaAdmin, eventId, { action: 'group_delete', group_id: String(groups[0].id) })).toEqual({ kind: 'failed', code: 'lx_group_not_empty', reg: null });
      okNotice(await run(areaAdmin, eventId, { action: 'group_leave', attendee_id: String(a.people[0]) }), 'lx_removed');
      expect(await run(areaAdmin, eventId, { action: 'group_join', attendee_id: String(a.people[0]), group_id: String(groups[1].id) })).toMatchObject({ kind: 'confirm', reasons: ['group_full'] });
      // Tags: create, put on by hand, then "everyone who answered Mandarin".
      okNotice(await run(areaAdmin, eventId, { action: 'tag_create', label: 'Mandarin speaker', color: 'accent', tab: 'groups' }), 'lx_saved');
      const tagId = await n(`SELECT id AS n FROM reg_tags WHERE event_id = ?1`, eventId);
      expect(await run(areaAdmin, eventId, { action: 'tag_create', label: 'Mandarin speaker', tab: 'groups' })).toEqual({ kind: 'failed', code: 'lx_duplicate', reg: null });
      const tagged = okNotice(await run(areaAdmin, eventId, { action: 'tag_by_answer', tag_id: String(tagId), answer: `${language.id}:zh`, tab: 'groups' }), 'lx_tagged');
      expect(tagged.extra).toMatchObject({ tab: 'groups', n: '2' });
      okNotice(await run(areaAdmin, eventId, { action: 'tag_set', tag_id: String(tagId), attendee_id: String(a.people[0]), on: '1' }), 'lx_tagged');
      okNotice(await run(areaAdmin, eventId, { action: 'tag_set', tag_id: String(tagId), attendee_id: String(a.people[0]), on: '0' }), 'lx_untagged');
      expect((await listActivity(db(), a.id)).map((x) => x.action)).toEqual(expect.arrayContaining(['group_auto_filled', 'tagged', 'untagged']));
      expect(await run(areaAdmin, eventId, { action: 'tag_set', tag_id: String(tagId) })).toEqual({ kind: 'failed', code: 'lx_no_person', reg: null });
    });

    it('filters a board by name, tag, ticket type and answer, with its own query keys', async () => {
      const eventId = await newEvent({ housing: true });
      await mustForm(eventId, { questions: [
        { type: 'select', scope: 'attendee', labels: { en: 'Diet' }, options: [{ key: 'veg', labels: { en: 'Vegetarian' } }, { key: 'any', labels: { en: 'Anything' } }] },
        { type: 'yesno', labels: { en: 'Need a ride?' } },
      ] });
      const [diet, ride] = await listQuestions(db(), 'en', eventId);
      const a = await register(eventId, [{ name: 'Rae Silva', answers: [[diet.id, 'veg']] }, { name: 'Sam Silva', answers: [[diet.id, 'any']] }]);
      await db().prepare(`INSERT INTO reg_answers (registration_id, question_id, value) VALUES (?1, ?2, 'yes')`).bind(a.id, ride.id).run();
      const b = await register(eventId, ['Tom Byrne']);
      expect([...(await peopleWithAnswer(db(), eventId, diet.id, 'veg'))]).toEqual([a.people[0]]);
      expect([...(await peopleWithAnswer(db(), eventId, ride.id, 'yes'))].sort()).toEqual([...a.people].sort());
      expect((await peopleWithAnswer(db(), eventId, 999999, 'veg')).size).toBe(0);
      const people = await listLogisticsPeople(db(), eventId);
      const state = parseBoardState(new URLSearchParams(`tab=housing&lq=silva&lans=${diet.id}:veg&q=roster`));
      expect(state).toEqual({ q: 'silva', tag: null, type: null, qid: diet.id, opt: 'veg' });
      expect(filterBoardPeople(people, state, await peopleWithAnswer(db(), eventId, diet.id, 'veg')).map((p) => p.attendeeId)).toEqual([a.people[0]]);
      expect(filterBoardPeople(people, parseBoardState(new URLSearchParams('lq=BYRNE')), null).map((p) => p.attendeeId)).toEqual(b.people);
      expect(boardQuery('housing', state)).toBe(`tab=housing&lq=silva&lans=${diet.id}%3Aveg`);
      expect(safeBack(`tab=tables&lq=x&ltag=3&ltype=4&lans=1:a&evil=1`)).toBe('tab=tables&lq=x&ltag=3&ltype=4&lans=1%3Aa');
    });
  });

  describe(`logistics forms and wording (${label})`, () => {
    it('reads the settings section only when it was posted, last checkbox value winning', () => {
      expect(logisticsSettingsFromForm(form({ housing_enabled: '1' }))).toBeNull();
      expect(logisticsSettingsFromForm(form({ logistics_section: '1', housing_enabled: ['0', '1'], seating_enabled: '0', show_assignments: ['0', '1'], gender_question_id: '12' })))
        .toEqual({ housing: true, seating: false, groups: false, showAssignments: true, genderQuestionId: 12 });
      expect(logisticsSettingsFromForm(form({ logistics_section: '1', gender_question_id: '' }))!.genderQuestionId).toBeNull();
    });

    it('reads the auto-seat options and refuses a half-filled rule', () => {
      expect(seatingRulesFromForm(form({}))).toEqual({ startOver: false, spread: [], host: null });
      expect(seatingRulesFromForm(form({ start_over: '1', spread_tag: '3', spread_max: '1', host_for: '4', host_tag: '5' })))
        .toEqual({ startOver: true, spread: [{ tagId: 3, max: 1 }], host: { forTagId: 4, hostTagId: 5 } });
      expect(seatingRulesFromForm(form({ spread_tag: '3' }))).toBeNull();
      expect(seatingRulesFromForm(form({ host_for: '4' }))).toBeNull();
    });

    it('names every history action the logistics data layer writes, and words its refusals and confirms', () => {
      for (const action of ['room_assigned', 'room_moved', 'room_unassigned', 'room_swapped', 'room_leader', 'room_leader_cleared', 'table_seated', 'table_moved',
        'table_unseated', 'table_host', 'table_host_cleared', 'table_auto_seated', 'group_joined', 'group_left', 'group_leader', 'group_leader_cleared',
        'group_auto_filled', 'tagged', 'untagged', 'logistics_released']) {
        expect(activityKey(action), action).not.toBe('admin.reg.act.other');
      }
      for (const reason of ['room_over_capacity', 'room_other_party', 'room_mixed_gender', 'gender_unknown', 'gender_question_missing', 'table_full', 'party_split', 'group_full']) {
        expect(reasonKey(reason), reason).toMatch(/^admin\.reg\.lx\.c\./);
      }
      expect(failureKey('lx_too_many')).toBe('admin.reg.lx.e.tooMany');
      expect(failureKey('too_many')).toBe('admin.reg.bo.e.tooManyRecipients');
      expect(failureKey('lx_something_new')).toBe('admin.reg.lx.e.invalid');
      expect(noticeKey('lx_rooms_added')).toBe('admin.reg.lx.n.roomsAdded');
    });
  });
}
