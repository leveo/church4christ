// Event logistics, small groups: groups on one event (optional capacity, leader, notes), one group per person,
// join / leave / leader by hand, and auto-fill from a per-person choice question (one group per option, or the
// staff's mapping of options to existing groups). Every rule is enforced in the claim of one guarded batch
// (regLogistics.logisticsWrite):
//   hard (refused):   not_active / not_eligible, not_found (any id of another event), not_member (a leader must be
//                     in the group), group_not_empty (only empty groups are deleted), stale (auto-fill data moved)
//   soft (confirm):   group_full (more people than the group's capacity)
// The caller has checked requireRegRole(..., 'manage') (writes) or 'view' (reads) on `eventId` and that the
// module is on. Writes also need the event's groups switch (else 'disabled').
import type { AppDb } from './appDb';
import { intLit } from './regAdminCore';
import { getRuntimeDefaultLocale } from './locales';
import { isUniqueViolation, listQuestions, optionLabel } from './regDb';
import {
  activityFor, allEligibleSql, cleanLabel, eligibleSql, fail, firstIneligible, getLogisticsSettings, inList, liveCountSql, liveSql,
  loadPeople, logisticsWrite, needsConfirm, textLit,
  type LogisticsFailure, type LogisticsPerson,
} from './regLogistics';

export const MAX_GROUP_CAPACITY = 1000;
export const MAX_GROUPS_PER_EVENT = 200;

export interface EventGroup {
  id: number;
  name: string;
  capacity: number | null;
  leaderAttendeeId: number | null;
  notes: string | null;
  /** Live members (attendee ids), in joining order. */
  members: number[];
}

export async function listGroups(db: AppDb, eventId: number): Promise<EventGroup[]> {
  const [groups, members] = await db.batch([
    db.prepare(`SELECT id, name, capacity, leader_attendee_id, notes FROM reg_groups WHERE event_id = ?1 ORDER BY sort, id`).bind(eventId),
    db
      .prepare(
        `SELECT x.group_id AS group_id, x.attendee_id AS attendee_id
         FROM reg_group_members x JOIN reg_attendees a ON a.id = x.attendee_id JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND ${liveSql()} ORDER BY x.added_at, x.attendee_id`,
      )
      .bind(eventId),
  ]);
  const byGroup = new Map<number, number[]>();
  for (const m of members.results as Array<{ group_id: number; attendee_id: number }>) (byGroup.get(m.group_id) ?? byGroup.set(m.group_id, []).get(m.group_id)!).push(m.attendee_id);
  return (groups.results as Array<{ id: number; name: string; capacity: number | null; leader_attendee_id: number | null; notes: string | null }>).map((g) => ({
    id: g.id, name: g.name, capacity: g.capacity === null ? null : Number(g.capacity), leaderAttendeeId: g.leader_attendee_id, notes: g.notes, members: byGroup.get(g.id) ?? [],
  }));
}

async function groupsContext(db: AppDb, eventId: number): Promise<{ ok: true; version: number } | LogisticsFailure> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return fail('not_found');
  return settings.groups ? { ok: true, version: settings.version } : fail('disabled');
}

const groupOfEvent = (eventId: number, groupId: number) => `EXISTS (SELECT 1 FROM reg_groups g WHERE g.id = ${intLit(groupId)} AND g.event_id = ${intLit(eventId)})`;
const validCapacity = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_GROUP_CAPACITY);
const cleanNotes = (v: unknown): string | null => (typeof v === 'string' ? v.trim().slice(0, 1000) || null : null);

async function uniqueName<T>(run: () => Promise<T>): Promise<T | LogisticsFailure> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) return fail('duplicate', [{ path: 'name', code: 'duplicate' }]);
    throw error;
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

export async function createGroup(db: AppDb, eventId: number, input: { name: unknown; capacity?: unknown; notes?: unknown }): Promise<{ ok: true; id: number } | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  const name = cleanLabel(input.name, 80);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  const capacity = input.capacity === undefined ? null : input.capacity;
  if (!validCapacity(capacity)) return fail('invalid', [{ path: 'capacity', code: 'invalid' }]);
  const room = `(SELECT COUNT(*) FROM reg_groups cg WHERE cg.event_id = ${intLit(eventId)}) < ${MAX_GROUPS_PER_EVENT}`;
  return uniqueName(async () => {
    const write = await logisticsWrite(db, eventId, 'groups', room, (held) => [
      db
        .prepare(
          `INSERT INTO reg_groups (campus_id, event_id, name, capacity, notes, sort)
           SELECT e.campus_id, e.id, CAST(?2 AS TEXT), CAST(?3 AS INTEGER), CAST(?4 AS TEXT), (SELECT COALESCE(MAX(s.sort), 0) + 1 FROM reg_groups s WHERE s.event_id = e.id)
           FROM reg_events e WHERE e.id = ?1 AND ${held} RETURNING id`,
        )
        .bind(eventId, name, capacity, cleanNotes(input.notes)),
    ]);
    return write.claimed ? { ok: true as const, id: (write.work[0].results[0] as { id: number }).id } : fail('too_many');
  });
}

export async function updateGroup(db: AppDb, eventId: number, groupId: number, input: { name?: unknown; capacity?: unknown; notes?: unknown }): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  const group = await db.prepare(`SELECT name, capacity, notes FROM reg_groups WHERE id = ?1 AND event_id = ?2`).bind(groupId, eventId).first<{ name: string; capacity: number | null; notes: string | null }>();
  if (!group) return fail('not_found');
  const name = input.name === undefined ? group.name : cleanLabel(input.name, 80);
  if (!name) return fail('invalid', [{ path: 'name', code: 'invalid' }]);
  const capacity = input.capacity === undefined ? group.capacity : input.capacity;
  if (!validCapacity(capacity)) return fail('invalid', [{ path: 'capacity', code: 'invalid' }]);
  const notes = input.notes === undefined ? group.notes : cleanNotes(input.notes);
  return uniqueName(async () => {
    const write = await logisticsWrite(db, eventId, 'groups', groupOfEvent(eventId, groupId), (held) => [
      db.prepare(`UPDATE reg_groups SET name = ?2, capacity = CAST(?3 AS INTEGER), notes = CAST(?4 AS TEXT) WHERE id = ?1 AND ${held}`).bind(groupId, name, capacity, notes),
    ]);
    return write.claimed ? { ok: true as const } : fail('not_found');
  });
}

/** Delete an empty group ('group_not_empty' otherwise). */
export async function deleteGroup(db: AppDb, eventId: number, groupId: number): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  const group = await db.prepare(`SELECT 1 AS present FROM reg_groups WHERE id = ?1 AND event_id = ?2`).bind(groupId, eventId).first();
  if (!group) return fail('not_found');
  const G = intLit(groupId);
  const write = await logisticsWrite(db, eventId, 'groups', `${groupOfEvent(eventId, G)} AND ${liveCountSql('reg_group_members', `x.group_id = ${G}`)} = 0`, (held) => [
    db.prepare(`DELETE FROM reg_groups WHERE id = ${G} AND ${held}`),
  ]);
  return write.claimed ? { ok: true } : fail('group_not_empty');
}

// ── Members ──────────────────────────────────────────────────────────────────

/** Put a person in a group (moving them out of another). Over capacity needs confirm. */
export async function joinGroup(
  db: AppDb,
  eventId: number,
  input: { attendeeId: number; groupId: number; confirm?: boolean },
  opts: { actor: number | null },
): Promise<{ ok: true; changed: boolean } | LogisticsFailure> {
  type JoinPlan = { group: { id: number; name: string }; person: LogisticsPerson; over: boolean };
  const plan = async (): Promise<JoinPlan | LogisticsFailure | { ok: true; changed: false }> => {
    const ctx = await groupsContext(db, eventId);
    if (!ctx.ok) return ctx;
    const group = await db
      .prepare(`SELECT g.id AS id, g.name AS name, g.capacity AS capacity, ${liveCountSql('reg_group_members', 'x.group_id = g.id')} AS members FROM reg_groups g WHERE g.id = ?1 AND g.event_id = ?2`)
      .bind(input.groupId, eventId)
      .first<{ id: number; name: string; capacity: number | null; members: number }>();
    if (!group) return fail('not_found');
    const [person] = await loadPeople(db, eventId, [input.attendeeId]);
    if (!person) return fail('not_found');
    if (person.groupId === group.id) return { ok: true as const, changed: false };
    const ineligible = firstIneligible([person]);
    if (ineligible) return fail(ineligible);
    if (group.capacity !== null && Number(group.members) + 1 > Number(group.capacity) && !input.confirm) return needsConfirm(['group_full']);
    return { group, person, over: group.capacity !== null && Number(group.members) + 1 > Number(group.capacity) };
  };
  const p = await plan();
  if (!('group' in p)) return p;
  const G = intLit(p.group.id);
  const A = intLit(p.person.attendeeId);
  const claim = [groupOfEvent(eventId, G), allEligibleSql(eventId, [A])];
  if (!input.confirm) claim.push(`((SELECT g.capacity FROM reg_groups g WHERE g.id = ${G}) IS NULL OR ${liveCountSql('reg_group_members', `x.group_id = ${G} AND x.attendee_id <> ${A}`)} + 1 <= (SELECT g.capacity FROM reg_groups g WHERE g.id = ${G}))`);
  const write = await logisticsWrite(db, eventId, 'groups', claim.join(' AND '), (held) => [
    db
      .prepare(
        `INSERT INTO reg_group_members (campus_id, attendee_id, group_id, added_by)
         SELECT a.campus_id, a.id, ${G}, CAST(?1 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         WHERE a.id = ${A} AND r.event_id = ${intLit(eventId)} AND ${held}
         ON CONFLICT (attendee_id) DO UPDATE SET group_id = excluded.group_id, added_by = excluded.added_by, added_at = datetime('now')`,
      )
      .bind(opts.actor),
    db.prepare(`UPDATE reg_groups SET leader_attendee_id = NULL WHERE leader_attendee_id = ${A} AND id <> ${G} AND ${held}`),
    activityFor(db, eventId, [p.person.registrationId], opts.actor, 'group_joined', {
      groupId: G, group: p.group.name, attendeeIds: [A], ...(p.person.groupId !== null ? { from: p.person.groupId } : {}), ...(p.over ? { override: ['group_full'] } : {}),
    }, held),
  ]);
  if (write.claimed) return { ok: true, changed: true };
  const again = await plan();
  return 'group' in again || ('ok' in again && again.ok) ? fail('conflict') : again;
}

/** Take a person out of their group (and off its leader role). */
export async function leaveGroup(db: AppDb, eventId: number, input: { attendeeId: number }, opts: { actor: number | null }): Promise<{ ok: true; changed: boolean } | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  const [person] = await loadPeople(db, eventId, [input.attendeeId]);
  if (!person) return fail('not_found');
  if (person.groupId === null) return { ok: true, changed: false };
  const A = intLit(person.attendeeId);
  const write = await logisticsWrite(db, eventId, 'groups', `EXISTS (SELECT 1 FROM reg_group_members x JOIN reg_groups g ON g.id = x.group_id WHERE x.attendee_id = ${A} AND g.event_id = ${intLit(eventId)})`, (held) => [
    db.prepare(`DELETE FROM reg_group_members WHERE attendee_id = ${A} AND ${held}`),
    db.prepare(`UPDATE reg_groups SET leader_attendee_id = NULL WHERE leader_attendee_id = ${A} AND ${held}`),
    activityFor(db, eventId, [person.registrationId], opts.actor, 'group_left', { groupId: person.groupId, attendeeIds: [A] }, held),
  ]);
  return { ok: true, changed: write.claimed };
}

/** Make a member the group leader (null clears it). */
export async function setGroupLeader(db: AppDb, eventId: number, input: { groupId: number; attendeeId: number | null }, opts: { actor: number | null }): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  const group = await db.prepare(`SELECT id, name, leader_attendee_id FROM reg_groups WHERE id = ?1 AND event_id = ?2`).bind(input.groupId, eventId).first<{ id: number; name: string; leader_attendee_id: number | null }>();
  if (!group) return fail('not_found');
  const G = intLit(group.id);
  const target = input.attendeeId;
  let registrationId: number | null = null;
  if (target !== null) {
    const [person] = await loadPeople(db, eventId, [target]);
    if (!person || person.groupId !== group.id || firstIneligible([person]) === 'not_active') return fail('not_member');
    registrationId = person.registrationId;
  } else if (group.leader_attendee_id !== null) {
    registrationId = (await loadPeople(db, eventId, [group.leader_attendee_id]))[0]?.registrationId ?? null;
  }
  const member = target === null ? '1 = 1' : `${liveCountSql('reg_group_members', `x.group_id = ${G} AND x.attendee_id = ${intLit(target)}`)} = 1`;
  const write = await logisticsWrite(db, eventId, 'groups', `${groupOfEvent(eventId, G)} AND ${member}`, (held) => [
    db.prepare(`UPDATE reg_groups SET leader_attendee_id = CAST(?1 AS INTEGER) WHERE id = ${G} AND ${held}`).bind(target),
    ...(registrationId !== null
      ? [activityFor(db, eventId, [registrationId], opts.actor, target === null ? 'group_leader_cleared' : 'group_leader', { groupId: G, group: group.name, attendeeId: target ?? group.leader_attendee_id }, held)]
      : []),
  ]);
  return write.claimed ? { ok: true } : fail(target === null ? 'conflict' : 'not_member');
}

// ── Auto-fill ────────────────────────────────────────────────────────────────

export interface AutoFillInput {
  /** A per-person choice question (select or yes/no) of the event. */
  questionId: number;
  /** Option key -> existing group ids to fill (spread evenly). An option left out gets a group named after the
   *  option's label (an existing group with that name is reused); an option mapped to [] is left alone. */
  mapping?: Record<string, number[]>;
  /** Capacity of the groups auto-fill creates (default none). */
  capacity?: number | null;
  /** Fill past capacity (spread over the option's groups) instead of asking. */
  confirm?: boolean;
}

export interface AutoFillResult {
  ok: true;
  /** People put in a group. */
  placed: number;
  /** Eligible people without a group who did not answer the question (left as they are). */
  noAnswer: number;
  /** Groups created, by name. */
  created: string[];
  /** People placed past a group's capacity (only with confirm). */
  overCapacity: number;
}

/**
 * Put every eligible person who has no group yet into a group for their answer to a per-person choice question,
 * spreading them over the option's groups (fewest members first) and respecting capacity: when someone would not
 * fit, nothing is written and the answer is NEEDS_CONFIRM 'group_full' until resent with confirm. The plan is made
 * from one read and written in one batch that refuses ('stale') if any logistics change happened in between.
 */
export async function autoFillGroups(db: AppDb, eventId: number, input: AutoFillInput, opts: { actor: number | null }): Promise<AutoFillResult | LogisticsFailure> {
  const ctx = await groupsContext(db, eventId);
  if (!ctx.ok) return ctx;
  if (!validCapacity(input.capacity ?? null)) return fail('invalid', [{ path: 'capacity', code: 'invalid' }]);
  const question = (await listQuestions(db, getRuntimeDefaultLocale(), eventId)).find((q) => q.id === input.questionId);
  if (!question || question.scope !== 'attendee' || (question.type !== 'select' && question.type !== 'yesno')) return fail('invalid', [{ path: 'questionId', code: 'not_person_choice' }]);
  const options = question.type === 'yesno' ? ['yes', 'no'] : (question.options ?? []);
  const groups = await listGroups(db, eventId);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const mapping = input.mapping ?? {};
  for (const [key, ids] of Object.entries(mapping)) {
    if (!options.includes(key) || !Array.isArray(ids)) return fail('invalid', [{ path: `mapping.${key}`, code: 'invalid' }]);
    if (ids.some((id) => !byId.has(id))) return fail('not_found');
  }

  // Targets per option: mapped groups, or one group named after the option (existing or to create).
  type Target = { name: string; capacity: number | null; count: number; create: boolean };
  const byName = new Map(groups.map((g) => [g.name, g]));
  const targets = new Map<string, Target[]>();
  const pending = new Map<string, Target>();
  for (const key of options) {
    if (Object.hasOwn(mapping, key)) {
      targets.set(key, mapping[key].map((id) => {
        const g = byId.get(id)!;
        return { name: g.name, capacity: g.capacity, count: g.members.length, create: false };
      }));
      continue;
    }
    const name = (cleanLabel(optionLabel(question, key), 80) ?? key.slice(0, 80));
    const existing = byName.get(name);
    const target = existing
      ? { name, capacity: existing.capacity, count: existing.members.length, create: false }
      : pending.get(name) ?? { name, capacity: input.capacity ?? null, count: 0, create: true };
    if (target.create) pending.set(name, target);
    targets.set(key, [target]);
  }
  // Targets are shared objects, so counts carry across options mapped to the same group.
  const shared = new Map<string, Target>();
  for (const [key, list] of targets) targets.set(key, list.map((t) => shared.get(t.name) ?? shared.set(t.name, t).get(t.name)!));

  const { results: people } = await db
    .prepare(
      `SELECT a.id AS attendee_id, a.registration_id AS registration_id, aa.value AS answer
       FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
       LEFT JOIN reg_attendee_answers aa ON aa.attendee_id = a.id AND aa.question_id = ?2
       WHERE r.event_id = ?1 AND ${eligibleSql()} AND NOT EXISTS (SELECT 1 FROM reg_group_members gm WHERE gm.attendee_id = a.id)
       ORDER BY a.registration_id, a.sort, a.id`,
    )
    .bind(eventId, input.questionId)
    .all<{ attendee_id: number; registration_id: number; answer: string | null }>();

  const placements: Array<{ attendeeId: number; registrationId: number; group: string }> = [];
  let noAnswer = 0;
  let over = 0;
  for (const p of people) {
    const list = p.answer === null ? undefined : targets.get(p.answer);
    if (!list) {
      if (p.answer === null) noAnswer++;
      continue;
    }
    if (list.length === 0) continue;
    const open = list.filter((t) => t.capacity === null || t.count < t.capacity);
    const pool = open.length > 0 ? open : list;
    if (open.length === 0) over++;
    const pick = [...pool].sort((a, b) => a.count - b.count || list.indexOf(a) - list.indexOf(b))[0];
    pick.count++;
    placements.push({ attendeeId: p.attendee_id, registrationId: p.registration_id, group: pick.name });
  }
  if (over > 0 && !input.confirm) return needsConfirm(['group_full']);
  const toCreate = [...shared.values()].filter((t) => t.create && placements.some((p) => p.group === t.name));
  if (placements.length === 0) return { ok: true, placed: 0, noAnswer, created: [], overCapacity: 0 };

  const E = intLit(eventId);
  const ids = placements.map((p) => p.attendeeId);
  const nameCase = `CASE a.id ${placements.map((p) => `WHEN ${intLit(p.attendeeId)} THEN ${textLit(p.group)}`).join(' ')} END`;
  const write = await logisticsWrite(db, eventId, 'groups', `logistics_version = ${intLit(ctx.version)}`, (held) => [
    ...(toCreate.length
      ? [db
          .prepare(
            `INSERT INTO reg_groups (campus_id, event_id, name, capacity, sort)
             SELECT e.campus_id, e.id, l.column1, CAST(?2 AS INTEGER), l.column2 + (SELECT COALESCE(MAX(s.sort), 0) FROM reg_groups s WHERE s.event_id = e.id)
             FROM reg_events e CROSS JOIN (VALUES ${toCreate.map((t, i) => `(${textLit(t.name)}, ${i + 1})`).join(', ')}) AS l
             WHERE e.id = ?1 AND ${held}
             ON CONFLICT (event_id, name) DO NOTHING`,
          )
          .bind(eventId, input.capacity ?? null)]
      : []),
    db
      .prepare(
        `INSERT INTO reg_group_members (campus_id, attendee_id, group_id, added_by)
         SELECT a.campus_id, a.id, g.id, CAST(?1 AS INTEGER)
         FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id JOIN reg_groups g ON g.event_id = ${E} AND g.name = ${nameCase}
         WHERE ${inList('a.id', ids)} AND r.event_id = ${E} AND ${eligibleSql()} AND ${held}
         ON CONFLICT (attendee_id) DO NOTHING`,
      )
      .bind(opts.actor),
    activityFor(db, eventId, placements.map((p) => p.registrationId), opts.actor, 'group_auto_filled', { questionId: input.questionId, ...(over > 0 ? { override: ['group_full'] } : {}) }, held),
  ]);
  if (!write.claimed) {
    const now = await getLogisticsSettings(db, eventId);
    return now && now.groups ? fail('stale') : fail('disabled');
  }
  return { ok: true, placed: write.work[toCreate.length ? 1 : 0].meta.changes, noAnswer, created: toCreate.map((t) => t.name), overCapacity: over };
}
