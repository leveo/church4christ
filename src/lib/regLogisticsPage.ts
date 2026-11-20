// The event page's logistics side (the optional `event-logistics` module): the POST actions of the Housing, Tables
// and Groups tabs and the shared tag panel, the board filters, and the event-settings form fields. Kept out of the
// Astro pages so every gate can be tested against a real database (test/shared/regLogisticsUiCases.ts).
//
// Every action here is listed in LOGISTICS_ACTIONS, which regAdminPage.ts spreads into REG_ADMIN_ACTIONS, so the
// one dispatcher gates it like every other POST of the event page, in this order:
//   1. the role: 'manage' on this event (requireRegRole; a viewer, a desk volunteer or a stranger gets 403),
//   2. the module: event-logistics on for the campus (else 404, the module gate's answer),
//   3. the event: a real event, not a template (else 404),
//   4. the area: the event's own switch for housing / seating / groups, or any of them for tags ('lx_disabled'),
//   5. the data layer, which refuses any room, table, group, tag or person of another event ('not_found').
// Refusals come back namespaced (`lx_<code>`) so their wording never borrows a Phase 4 message.
import type { AppDb } from './appDb';
import type { Locale } from './locales';
import { decodeChoices, listQuestions, listTicketTypes, type RegQuestion, type RegTicketType } from './regDb';
import {
  applyTagByAnswer, createTag, deleteTag, getLogisticsSettings, listLogisticsPeople, listTags, setTag, updateTag,
  type BoardPerson, type LogisticsArea, type LogisticsFailure, type LogisticsSettings, type LogisticsSettingsInput, type RegTag,
} from './regLogistics';
import {
  addRooms, assignRoom, clearRoom, createRoomType, createVenue, deleteRoomType, deleteRooms, deleteVenue, listHousing, setRoomLeader, setRoomsConfirmed,
  swapRooms, unassignRoom, updateRoom, updateRoomType, updateVenue, type HousingVenue,
} from './regHousing';
import {
  addTables, applySeatingPlan, deleteTables, listSeating, previewSeating, seatAtTable, setTableHost, unseat, updateTable, type SeatingTable,
} from './regSeating';
import type { SeatingRules } from './regSeatPlanner';
import { autoFillGroups, createGroup, deleteGroup, joinGroup, leaveGroup, listGroups, setGroupLeader, updateGroup, type EventGroup } from './regGroups';
import type { ActionOutcome } from './regAdminPage';

// ── The action table ─────────────────────────────────────────────────────────

/** Which switch an action needs: one area, or (tags) any area of the event. */
export type LogisticsScope = LogisticsArea | 'tags';
export interface LogisticsActionSpec { need: 'manage'; target: 'event'; logistics: LogisticsScope }

const spec = (logistics: LogisticsScope): LogisticsActionSpec => ({ need: 'manage', target: 'event', logistics });

/** Every logistics POST of the event page (all need 'manage'). */
export const LOGISTICS_ACTIONS: Readonly<Record<string, LogisticsActionSpec>> = {
  venue_create: spec('housing'),
  venue_update: spec('housing'),
  venue_delete: spec('housing'),
  room_type_create: spec('housing'),
  room_type_update: spec('housing'),
  room_type_delete: spec('housing'),
  rooms_add: spec('housing'),
  rooms_bulk: spec('housing'),
  room_update: spec('housing'),
  room_assign: spec('housing'),
  room_unassign: spec('housing'),
  room_clear: spec('housing'),
  room_swap: spec('housing'),
  room_leader: spec('housing'),
  tables_add: spec('seating'),
  table_update: spec('seating'),
  tables_delete: spec('seating'),
  table_seat: spec('seating'),
  table_unseat: spec('seating'),
  table_host: spec('seating'),
  seat_preview: spec('seating'),
  seat_apply: spec('seating'),
  group_create: spec('groups'),
  group_update: spec('groups'),
  group_delete: spec('groups'),
  group_join: spec('groups'),
  group_leave: spec('groups'),
  group_leader: spec('groups'),
  group_autofill: spec('groups'),
  tag_create: spec('tags'),
  tag_update: spec('tags'),
  tag_delete: spec('tags'),
  tag_set: spec('tags'),
  tag_by_answer: spec('tags'),
};

/** The event page tabs of the module, and the area each one shows. */
export const LOGISTICS_TABS = { housing: 'housing', tables: 'seating', groups: 'groups' } as const satisfies Record<string, LogisticsArea>;
export type LogisticsTab = keyof typeof LOGISTICS_TABS;
export const isLogisticsTab = (value: unknown): value is LogisticsTab => typeof value === 'string' && Object.hasOwn(LOGISTICS_TABS, value);
const TAB_OF: Record<LogisticsArea, LogisticsTab> = { housing: 'housing', seating: 'tables', groups: 'groups' };

// ── Form fields ──────────────────────────────────────────────────────────────

const str = (fd: FormData, name: string): string => {
  const value = fd.get(name);
  return typeof value === 'string' ? value : '';
};
/** A positive whole number, or null (blank or anything else). */
const int = (fd: FormData, name: string): number | null => {
  const raw = str(fd, name).trim();
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
};
/** A whole number >= 0, or null. */
const count = (fd: FormData, name: string): number | null => {
  const raw = str(fd, name).trim();
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};
/** Every positive id posted under `name` (checkbox lists), de-duplicated. */
const ids = (fd: FormData, name: string): number[] =>
  [...new Set(fd.getAll(name).filter((v): v is string => typeof v === 'string' && /^\d{1,9}$/.test(v.trim())).map((v) => Number(v.trim())).filter((n) => n > 0))];
/** A checkbox posted after a hidden "0": the last value wins. */
const lastFlag = (fd: FormData, name: string, fallback: boolean): boolean => {
  const all = fd.getAll(name).filter((v): v is string => typeof v === 'string');
  return all.length === 0 ? fallback : all[all.length - 1] === '1' || all[all.length - 1] === 'on';
};
const flag = (fd: FormData, name: string): boolean => fd.getAll(name).some((v) => v === '1' || v === 'on');

function fieldsOf(fd: FormData, drop: readonly string[] = []): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of fd.entries()) if (typeof value === 'string' && key !== 'confirm' && !drop.includes(key)) out.push([key, value]);
  return out;
}

/** The auto-seat options of the Tables tab form. Null when a rule is half filled in or malformed. */
export function seatingRulesFromForm(fd: FormData): SeatingRules | null {
  const spreadTag = int(fd, 'spread_tag');
  const spreadMax = count(fd, 'spread_max');
  const hostFor = int(fd, 'host_for');
  const hostTag = int(fd, 'host_tag');
  if (spreadTag !== null && spreadMax === null) return null;
  if ((hostFor === null) !== (hostTag === null)) return null;
  return {
    startOver: str(fd, 'start_over') === '1',
    spread: spreadTag !== null ? [{ tagId: spreadTag, max: spreadMax! }] : [],
    host: hostFor !== null && hostTag !== null ? { forTagId: hostFor, hostTagId: hostTag } : null,
  };
}

/** The Logistics section of the event settings form, or null when the section was not posted (module off, or a
 *  form without it), so a save never touches the switches it did not show. */
export function logisticsSettingsFromForm(fd: FormData): LogisticsSettingsInput | null {
  if (str(fd, 'logistics_section') !== '1') return null;
  const gender = str(fd, 'gender_question_id').trim();
  return {
    housing: lastFlag(fd, 'housing_enabled', false),
    seating: lastFlag(fd, 'seating_enabled', false),
    groups: lastFlag(fd, 'groups_enabled', false),
    showAssignments: lastFlag(fd, 'show_assignments', false),
    genderQuestionId: /^\d{1,9}$/.test(gender) && Number(gender) > 0 ? Number(gender) : null,
  };
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/** A data-layer refusal as the page outcome: soft rules ask to confirm (every reason), a missing reason asks for
 *  one, everything else is a namespaced failure code. */
function refusal(fd: FormData, failure: LogisticsFailure, scope: LogisticsScope): ActionOutcome {
  if (failure.code === 'NEEDS_CONFIRM') {
    const reasons = 'reasons' in failure && Array.isArray(failure.reasons) ? failure.reasons : [failure.reason];
    return { kind: 'confirm', reason: reasons[0], reasons, fields: fieldsOf(fd), reg: null };
  }
  if (failure.code === 'reason_required') {
    // The replay keeps an earlier confirm, so typing the reason is the only step left.
    const fields: Array<[string, string]> = [];
    for (const [key, value] of fd.entries()) if (typeof value === 'string' && key !== 'reason') fields.push([key, value]);
    return { kind: 'reason', fields };
  }
  if (failure.code === 'stale') return { kind: 'failed', code: scope === 'groups' ? 'lx_stale_groups' : 'lx_stale_seating', reg: null };
  const first = 'errors' in failure ? failure.errors?.[0] : undefined;
  if (first) {
    if (first.path === 'labels') return { kind: 'failed', code: `lx_labels_${first.code}`, reg: null };
    if (first.code === 'beds_required') return { kind: 'failed', code: 'lx_beds_required', reg: null };
    if (first.code === 'duplicate') return { kind: 'failed', code: 'lx_duplicate', reg: null };
    if (first.code === 'not_person_choice' || first.code === 'not_choice') return { kind: 'failed', code: 'lx_question', reg: null };
  }
  return { kind: 'failed', code: `lx_${failure.code}`, reg: null };
}

// ── The dispatcher ───────────────────────────────────────────────────────────

export interface LogisticsActionContext {
  db: AppDb;
  eventId: number;
  /** The person acting (recorded in the history). */
  actor: number;
  /** The event-logistics module is on for this campus (logisticsModuleEnabled). */
  logistics: boolean;
}

/**
 * Run one logistics POST. The caller (runRegAdminAction) has already checked 'manage' on the event; this checks
 * the module, the event and the area switch, then calls the data layer. Never throws on a refused request.
 */
export async function runLogisticsAction(ctx: LogisticsActionContext, fd: FormData, action: string): Promise<ActionOutcome> {
  const scope = LOGISTICS_ACTIONS[action]?.logistics;
  if (!scope) return { kind: 'bad_request' };
  if (!ctx.logistics) return { kind: 'denied', status: 404 };
  const { db, eventId } = ctx;
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return { kind: 'denied', status: 404 };
  const on = scope === 'tags' ? settings.housing || settings.seating || settings.groups : settings[scope];
  if (!on) return { kind: 'failed', code: 'lx_disabled', reg: null };

  const opts = { actor: ctx.actor };
  const postedTab = str(fd, 'tab');
  const tab = scope === 'tags' ? (isLogisticsTab(postedTab) ? postedTab : 'housing') : TAB_OF[scope];
  const done = (notice: string, n?: number, m?: number): ActionOutcome => ({
    kind: 'ok', notice, extra: { tab, ...(n !== undefined ? { n: String(n) } : {}), ...(m !== undefined ? { m: String(m) } : {}) },
  });
  const fail = (failure: LogisticsFailure) => refusal(fd, failure, scope);
  const confirm = flag(fd, 'confirm');
  const reason = str(fd, 'reason');
  /** An optional positive id where blank means "none" (clears a leader or host). */
  const optionalId = (name: string): number | null | undefined => (str(fd, name).trim() === '' ? null : (int(fd, name) ?? undefined));
  const need = (value: number | null): value is number => value !== null;

  switch (action) {
    // ── Housing ──
    case 'venue_create':
    case 'venue_update': {
      const rule = str(fd, 'capacity_rule');
      const input = { name: str(fd, 'name'), kind: str(fd, 'kind') || undefined, capacityRule: rule === '' ? undefined : rule };
      if (action === 'venue_create') {
        const r = await createVenue(db, eventId, input);
        return r.ok ? done('lx_saved') : fail(r);
      }
      const venueId = int(fd, 'venue_id');
      if (!need(venueId)) return { kind: 'bad_request' };
      const r = await updateVenue(db, eventId, venueId, input);
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'venue_delete': {
      const venueId = int(fd, 'venue_id');
      if (!need(venueId)) return { kind: 'bad_request' };
      const r = await deleteVenue(db, eventId, venueId);
      return r.ok ? done('lx_deleted') : fail(r);
    }
    case 'room_type_create': {
      const venueId = int(fd, 'venue_id');
      if (!need(venueId)) return { kind: 'bad_request' };
      const r = await createRoomType(db, eventId, { venueId, name: str(fd, 'name'), beds: int(fd, 'beds') });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'room_type_update': {
      const typeId = int(fd, 'room_type_id');
      if (!need(typeId)) return { kind: 'bad_request' };
      const r = await updateRoomType(db, eventId, typeId, { name: str(fd, 'name'), beds: int(fd, 'beds') });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'room_type_delete': {
      const typeId = int(fd, 'room_type_id');
      if (!need(typeId)) return { kind: 'bad_request' };
      const r = await deleteRoomType(db, eventId, typeId);
      return r.ok ? done('lx_deleted') : fail(r);
    }
    case 'rooms_add': {
      const venueId = int(fd, 'venue_id');
      if (!need(venueId)) return { kind: 'bad_request' };
      const policy = str(fd, 'policy');
      const r = await addRooms(db, eventId, {
        venueId, labels: str(fd, 'labels'), roomTypeId: int(fd, 'room_type_id'), bedsOverride: int(fd, 'beds'),
        policy: (policy || 'any') as never, floor: str(fd, 'floor').trim() || null,
      });
      return r.ok ? done('lx_rooms_added', r.created.length, r.skipped.length) : fail(r);
    }
    case 'rooms_bulk': {
      const roomIds = ids(fd, 'room_ids');
      const op = str(fd, 'op');
      if (roomIds.length === 0) return { kind: 'failed', code: 'lx_none_selected', reg: null };
      if (op === 'confirm' || op === 'unconfirm') {
        const r = await setRoomsConfirmed(db, eventId, { roomIds, confirmed: op === 'confirm' });
        return r.ok ? done(op === 'confirm' ? 'lx_rooms_confirmed' : 'lx_rooms_unconfirmed', r.changed, r.occupied.length) : fail(r);
      }
      if (op === 'delete') {
        const r = await deleteRooms(db, eventId, { roomIds });
        return r.ok ? done('lx_rooms_deleted', r.deleted, r.occupied.length) : fail(r);
      }
      return { kind: 'bad_request' };
    }
    case 'room_update': {
      const roomId = int(fd, 'room_id');
      if (!need(roomId)) return { kind: 'bad_request' };
      const r = await updateRoom(db, eventId, roomId, {
        label: str(fd, 'label'), floor: str(fd, 'floor'), notes: str(fd, 'notes'), roomTypeId: int(fd, 'room_type_id'), bedsOverride: int(fd, 'beds'),
        policy: str(fd, 'policy') || undefined,
      });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'room_assign': {
      const attendeeId = int(fd, 'attendee_id');
      const roomId = int(fd, 'room_id');
      if (!need(attendeeId)) return { kind: 'failed', code: 'lx_no_person', reg: null };
      if (!need(roomId)) return { kind: 'failed', code: 'lx_no_target', reg: null };
      const r = await assignRoom(db, eventId, { attendeeId, roomId, party: lastFlag(fd, 'party', true), confirm, reason }, opts);
      return r.ok ? done('lx_assigned', r.moved.length) : fail(r);
    }
    case 'room_unassign': {
      const attendeeId = int(fd, 'attendee_id');
      if (!need(attendeeId)) return { kind: 'bad_request' };
      const r = await unassignRoom(db, eventId, { attendeeId, reason }, opts);
      return r.ok ? done('lx_removed') : fail(r);
    }
    case 'room_clear': {
      const roomId = int(fd, 'room_id');
      if (!need(roomId)) return { kind: 'bad_request' };
      const r = await clearRoom(db, eventId, { roomId, reason }, opts);
      return r.ok ? done('lx_cleared', r.removed) : fail(r);
    }
    case 'room_swap': {
      const a = int(fd, 'attendee_a');
      const b = int(fd, 'attendee_b');
      if (!need(a) || !need(b)) return { kind: 'failed', code: 'lx_no_person', reg: null };
      const r = await swapRooms(db, eventId, { attendeeA: a, attendeeB: b, confirm, reason }, opts);
      return r.ok ? done('lx_swapped') : fail(r);
    }
    case 'room_leader': {
      const roomId = int(fd, 'room_id');
      const leader = optionalId('attendee_id');
      if (!need(roomId) || leader === undefined) return { kind: 'bad_request' };
      const r = await setRoomLeader(db, eventId, { roomId, attendeeId: leader }, opts);
      return r.ok ? done('lx_saved') : fail(r);
    }

    // ── Tables ──
    case 'tables_add': {
      const n = int(fd, 'count');
      const seats = int(fd, 'seats');
      const from = count(fd, 'from');
      const r = await addTables(db, eventId, {
        prefix: fd.has('prefix') ? str(fd, 'prefix').trim() : undefined, count: n ?? 0, seats: seats ?? 0, ...(from !== null ? { from } : {}),
      });
      return r.ok ? done('lx_tables_added', r.created.length, r.skipped.length) : fail(r);
    }
    case 'table_update': {
      const tableId = int(fd, 'table_id');
      if (!need(tableId)) return { kind: 'bad_request' };
      const r = await updateTable(db, eventId, tableId, { label: str(fd, 'label'), seats: int(fd, 'seats') });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'tables_delete': {
      const tableIds = ids(fd, 'table_ids');
      if (tableIds.length === 0) return { kind: 'failed', code: 'lx_none_selected', reg: null };
      const r = await deleteTables(db, eventId, { tableIds });
      return r.ok ? done('lx_tables_deleted', r.deleted, r.occupied.length) : fail(r);
    }
    case 'table_seat': {
      const attendeeId = int(fd, 'attendee_id');
      const tableId = int(fd, 'table_id');
      if (!need(attendeeId)) return { kind: 'failed', code: 'lx_no_person', reg: null };
      if (!need(tableId)) return { kind: 'failed', code: 'lx_no_target', reg: null };
      const r = await seatAtTable(db, eventId, { attendeeId, tableId, party: lastFlag(fd, 'party', true), confirm }, opts);
      return r.ok ? done('lx_seated', r.seated.length) : fail(r);
    }
    case 'table_unseat': {
      const attendeeId = int(fd, 'attendee_id');
      if (!need(attendeeId)) return { kind: 'bad_request' };
      const r = await unseat(db, eventId, { attendeeId }, opts);
      return r.ok ? done('lx_removed') : fail(r);
    }
    case 'table_host': {
      const tableId = int(fd, 'table_id');
      const host = optionalId('attendee_id');
      if (!need(tableId) || host === undefined) return { kind: 'bad_request' };
      const r = await setTableHost(db, eventId, { tableId, attendeeId: host }, opts);
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'seat_preview':
    case 'seat_apply': {
      const rules = seatingRulesFromForm(fd);
      if (!rules) return { kind: 'failed', code: 'lx_rules', reg: null };
      if (action === 'seat_preview') {
        const r = await previewSeating(db, eventId, rules);
        if ('ok' in r) return fail(r);
        return { kind: 'seat_preview', stamp: r.stamp, plan: r.plan, fields: fieldsOf(fd, ['action', 'stamp']) };
      }
      const r = await applySeatingPlan(db, eventId, { stamp: str(fd, 'stamp'), rules }, opts);
      return r.ok ? done('lx_seat_applied', r.plan.changes.length, r.plan.left.length) : fail(r);
    }

    // ── Groups ──
    case 'group_create':
    case 'group_update': {
      const capacity = str(fd, 'capacity').trim() === '' ? null : (int(fd, 'capacity') ?? -1);
      const input = { name: str(fd, 'name'), capacity, notes: str(fd, 'notes') };
      if (action === 'group_create') {
        const r = await createGroup(db, eventId, input);
        return r.ok ? done('lx_saved') : fail(r);
      }
      const groupId = int(fd, 'group_id');
      if (!need(groupId)) return { kind: 'bad_request' };
      const r = await updateGroup(db, eventId, groupId, input);
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'group_delete': {
      const groupId = int(fd, 'group_id');
      if (!need(groupId)) return { kind: 'bad_request' };
      const r = await deleteGroup(db, eventId, groupId);
      return r.ok ? done('lx_deleted') : fail(r);
    }
    case 'group_join': {
      const attendeeId = int(fd, 'attendee_id');
      const groupId = int(fd, 'group_id');
      if (!need(attendeeId)) return { kind: 'failed', code: 'lx_no_person', reg: null };
      if (!need(groupId)) return { kind: 'failed', code: 'lx_no_target', reg: null };
      const r = await joinGroup(db, eventId, { attendeeId, groupId, confirm }, opts);
      return r.ok ? done('lx_assigned', r.changed ? 1 : 0) : fail(r);
    }
    case 'group_leave': {
      const attendeeId = int(fd, 'attendee_id');
      if (!need(attendeeId)) return { kind: 'bad_request' };
      const r = await leaveGroup(db, eventId, { attendeeId }, opts);
      return r.ok ? done('lx_removed') : fail(r);
    }
    case 'group_leader': {
      const groupId = int(fd, 'group_id');
      const leader = optionalId('attendee_id');
      if (!need(groupId) || leader === undefined) return { kind: 'bad_request' };
      const r = await setGroupLeader(db, eventId, { groupId, attendeeId: leader }, opts);
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'group_autofill': {
      const questionId = int(fd, 'question_id');
      if (!need(questionId)) return { kind: 'failed', code: 'lx_question', reg: null };
      const capacity = str(fd, 'capacity').trim() === '' ? null : (int(fd, 'capacity') ?? -1);
      const r = await autoFillGroups(db, eventId, { questionId, capacity, confirm }, opts);
      return r.ok ? done('lx_group_filled', r.placed, r.noAnswer) : fail(r);
    }

    // ── Tags ──
    case 'tag_create': {
      const r = await createTag(db, eventId, { label: str(fd, 'label'), color: str(fd, 'color') || undefined });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'tag_update': {
      const tagId = int(fd, 'tag_id');
      if (!need(tagId)) return { kind: 'bad_request' };
      const r = await updateTag(db, eventId, tagId, { label: str(fd, 'label'), color: str(fd, 'color') || undefined });
      return r.ok ? done('lx_saved') : fail(r);
    }
    case 'tag_delete': {
      const tagId = int(fd, 'tag_id');
      if (!need(tagId)) return { kind: 'bad_request' };
      const r = await deleteTag(db, eventId, tagId);
      return r.ok ? done('lx_deleted') : fail(r);
    }
    case 'tag_set': {
      const tagId = int(fd, 'tag_id');
      const people = ids(fd, 'attendee_id');
      if (!need(tagId)) return { kind: 'failed', code: 'lx_no_tag', reg: null };
      if (people.length === 0) return { kind: 'failed', code: 'lx_no_person', reg: null };
      const r = await setTag(db, eventId, { tagId, attendeeIds: people, on: str(fd, 'on') !== '0' }, opts);
      return r.ok ? done(str(fd, 'on') === '0' ? 'lx_untagged' : 'lx_tagged', r.changed) : fail(r);
    }
    case 'tag_by_answer': {
      const tagId = int(fd, 'tag_id');
      const answer = /^(\d{1,9}):(.{1,200})$/su.exec(str(fd, 'answer'));
      if (!need(tagId)) return { kind: 'failed', code: 'lx_no_tag', reg: null };
      if (!answer) return { kind: 'failed', code: 'lx_question', reg: null };
      const r = await applyTagByAnswer(db, eventId, { tagId, questionId: Number(answer[1]), option: answer[2] }, opts);
      return r.ok ? done('lx_tagged', r.tagged) : fail(r);
    }
  }
  return { kind: 'bad_request' };
}

// ── Board filters ────────────────────────────────────────────────────────────

/** The people-list filters of a logistics board (own query keys, so they never collide with the roster's). */
export interface BoardState {
  /** Name search. */
  q: string;
  tag: number | null;
  type: number | null;
  /** A choice answer: question id and option key (`lans=<id>:<option>`). */
  qid: number | null;
  opt: string;
}

export function parseBoardState(params: URLSearchParams): BoardState {
  const num = (name: string): number | null => (/^\d{1,9}$/.test(params.get(name) ?? '') ? Number(params.get(name)) : null);
  const ans = /^(\d{1,9}):(.{1,200})$/su.exec(params.get('lans') ?? '');
  return {
    q: (params.get('lq') ?? '').trim().slice(0, 100),
    tag: num('ltag'),
    type: num('ltype'),
    qid: ans ? Number(ans[1]) : null,
    opt: ans ? ans[2] : '',
  };
}

/** The query string of a board (tab first, then the filters that are set). */
export function boardQuery(tab: LogisticsTab, state: BoardState): string {
  const p = new URLSearchParams({ tab });
  if (state.q) p.set('lq', state.q);
  if (state.tag !== null) p.set('ltag', String(state.tag));
  if (state.type !== null) p.set('ltype', String(state.type));
  if (state.qid !== null && state.opt !== '') p.set('lans', `${state.qid}:${state.opt}`);
  return p.toString();
}

/** The people of a board who match the filters. `answered` is the set from peopleWithAnswer (null = no answer filter). */
export function filterBoardPeople(people: readonly BoardPerson[], state: BoardState, answered: ReadonlySet<number> | null): BoardPerson[] {
  const needle = state.q.toLocaleLowerCase();
  return people.filter((p) =>
    (needle === '' || p.name.toLocaleLowerCase().includes(needle) || p.registrationName.toLocaleLowerCase().includes(needle))
    && (state.tag === null || p.tags.includes(state.tag))
    && (state.type === null || p.ticketTypeId === state.type)
    && (answered === null || answered.has(p.attendeeId)));
}

/**
 * The people of event `eventId` (still on the event) who gave `option` to choice question `questionId`: a
 * per-person question matches the person, a once-per-registration question everyone on the registration. An
 * unknown question or option matches nobody.
 */
export async function peopleWithAnswer(db: AppDb, eventId: number, questionId: number, option: string): Promise<Set<number>> {
  const question = await db
    .prepare(`SELECT scope, type FROM reg_questions WHERE id = ?1 AND event_id = ?2`)
    .bind(questionId, eventId)
    .first<{ scope: 'registration' | 'attendee'; type: string }>();
  if (!question || !['select', 'checkbox', 'yesno'].includes(question.type)) return new Set();
  const live = `a.status = 'active' AND r.status NOT IN ('cancelled','declined')`;
  const { results } = question.scope === 'attendee'
    ? await db
        .prepare(
          `SELECT a.id AS attendee_id, aa.value AS value FROM reg_attendee_answers aa
           JOIN reg_attendees a ON a.id = aa.attendee_id JOIN registrations r ON r.id = a.registration_id
           WHERE aa.question_id = ?1 AND r.event_id = ?2 AND ${live}`,
        )
        .bind(questionId, eventId)
        .all<{ attendee_id: number; value: string }>()
    : await db
        .prepare(
          `SELECT a.id AS attendee_id, ans.value AS value FROM reg_answers ans
           JOIN registrations r ON r.id = ans.registration_id JOIN reg_attendees a ON a.registration_id = r.id
           WHERE ans.question_id = ?1 AND r.event_id = ?2 AND ${live}`,
        )
        .bind(questionId, eventId)
        .all<{ attendee_id: number; value: string }>();
  const hit = (raw: string) => (question.type === 'checkbox' ? decodeChoices(raw).includes(option) : raw === option);
  return new Set(results.filter((r) => hit(r.value)).map((r) => Number(r.attendee_id)));
}

/** The choice questions a board can filter or tag by (select, checkbox, yes/no; either scope). */
export const choiceQuestions = (questions: readonly RegQuestion[]): RegQuestion[] =>
  questions.filter((q) => q.type === 'select' || q.type === 'checkbox' || q.type === 'yesno');

/** The per-person single-choice questions (auto-fill groups; the single-gender room setting uses select only). */
export const personChoiceQuestions = (questions: readonly RegQuestion[], withYesNo = true): RegQuestion[] =>
  questions.filter((q) => q.scope === 'attendee' && (q.type === 'select' || (withYesNo && q.type === 'yesno')));

/** Every option of a choice question as [key, label] (yes/no as the given words). */
export function questionOptions(q: RegQuestion, yes: string, no: string): Array<[string, string]> {
  if (q.type === 'yesno') return [['yes', yes], ['no', no]];
  return (q.options ?? []).map((key) => [key, q.option_labels[key] ?? key]);
}

// ── Board data ───────────────────────────────────────────────────────────────

export interface LogisticsBoard {
  settings: LogisticsSettings;
  /** Everyone still on the event (see listLogisticsPeople), by attendee id too. */
  people: BoardPerson[];
  byId: Map<number, BoardPerson>;
  /** The people the tab's list shows: eligible, not yet placed in this tab's area, matching the filters. */
  waiting: BoardPerson[];
  /** How many eligible people (filters aside) are not yet placed in this tab's area. */
  waitingTotal: number;
  /** For each person, how many others of their party are eligible and not yet placed (what "bring their party" adds). */
  partyLeft: Map<number, number>;
  tags: RegTag[];
  types: RegTicketType[];
  questions: RegQuestion[];
  state: BoardState;
  housing: HousingVenue[];
  tables: SeatingTable[];
  groups: EventGroup[];
}

const PLACED: Record<LogisticsTab, 'roomId' | 'tableId' | 'groupId'> = { housing: 'roomId', tables: 'tableId', groups: 'groupId' };

/** Everything one logistics tab shows (only that tab's area is read). Null for an unknown event or a template. */
export async function loadLogisticsBoard(db: AppDb, eventId: number, tab: LogisticsTab, locale: Locale, params: URLSearchParams): Promise<LogisticsBoard | null> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return null;
  const state = parseBoardState(params);
  const [people, tags, types, questions, housing, tables, groups] = await Promise.all([
    listLogisticsPeople(db, eventId),
    listTags(db, eventId),
    listTicketTypes(db, locale, eventId),
    listQuestions(db, locale, eventId),
    tab === 'housing' ? listHousing(db, eventId) : Promise.resolve([]),
    tab === 'tables' ? listSeating(db, eventId) : Promise.resolve([]),
    tab === 'groups' ? listGroups(db, eventId) : Promise.resolve([]),
  ]);
  const key = PLACED[tab];
  const open = people.filter((p) => p.eligible && p[key] === null);
  const answered = state.qid !== null && state.opt !== '' ? await peopleWithAnswer(db, eventId, state.qid, state.opt) : null;
  const partyLeft = new Map<number, number>();
  const perParty = new Map<number, number>();
  const isOpen = new Set(open.map((p) => p.attendeeId));
  for (const p of open) perParty.set(p.registrationId, (perParty.get(p.registrationId) ?? 0) + 1);
  for (const p of people) partyLeft.set(p.attendeeId, (perParty.get(p.registrationId) ?? 0) - (isOpen.has(p.attendeeId) ? 1 : 0));
  return {
    settings, people, byId: new Map(people.map((p) => [p.attendeeId, p])), waiting: filterBoardPeople(open, state, answered), waitingTotal: open.length,
    partyLeft, tags, types, questions, state, housing, tables, groups,
  };
}
