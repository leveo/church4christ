// Event logistics, tables and seating: add tables in bulk, edit and remove empty ones, seat a party (default) or
// one person, unseat, table host, and auto-seat (preview + apply through the pure planner in regSeatPlanner.ts).
// Every rule is enforced in the claim of one guarded batch (regLogistics.logisticsWrite):
//   hard (refused):   not_active / not_eligible (see regLogistics.eligibility), not_found (any id of another
//                     event), not_seated (a host must sit at the table), stale (auto-seat data changed since preview)
//   soft (confirm):   table_full (more people than seats), party_split (the party would sit at more than one table)
// The caller has checked requireRegRole(..., 'manage') (writes) or 'view' (reads) on `eventId` and that the
// module is on. Writes also need the event's seating switch (else 'disabled').
import type { AppDb } from './appDb';
import { intLit } from './regAdminCore';
import { isUniqueViolation } from './regDb';
import { planSeating, type PlanParty, type SeatingPlan, type SeatingRules, MAX_SPREAD_RULES } from './regSeatPlanner';
import {
  activityFor, allEligibleSql, cleanLabel, eligibility, eligibleSql, fail, firstIneligible, getLogisticsSettings, inList,
  liveCountSql, liveSql, loadParty, loadPeople, logisticsWrite, needsConfirm, notInList, textLit,
  type LogisticsFailure, type LogisticsPerson,
} from './regLogistics';

export const MAX_TABLES_PER_CALL = 200;
export const MAX_SEATS_PER_TABLE = 100;

export interface SeatingTable {
  id: number;
  label: string;
  seats: number;
  hostAttendeeId: number | null;
  /** Live people at the table (attendee ids), in seating order. */
  occupants: number[];
}

/** Every table of the event in board order with who sits there. */
export async function listSeating(db: AppDb, eventId: number): Promise<SeatingTable[]> {
  const [tables, seats] = await db.batch([
    db.prepare(`SELECT id, label, seats, host_attendee_id FROM reg_tables WHERE event_id = ?1 ORDER BY sort, id`).bind(eventId),
    db
      .prepare(
        `SELECT x.table_id AS table_id, x.attendee_id AS attendee_id
         FROM reg_table_seats x JOIN reg_attendees a ON a.id = x.attendee_id JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND ${liveSql()} ORDER BY x.seated_at, x.attendee_id`,
      )
      .bind(eventId),
  ]);
  const byTable = new Map<number, number[]>();
  for (const s of seats.results as Array<{ table_id: number; attendee_id: number }>) (byTable.get(s.table_id) ?? byTable.set(s.table_id, []).get(s.table_id)!).push(s.attendee_id);
  return (tables.results as Array<{ id: number; label: string; seats: number; host_attendee_id: number | null }>).map((t) => ({
    id: t.id, label: t.label, seats: Number(t.seats), hostAttendeeId: t.host_attendee_id, occupants: byTable.get(t.id) ?? [],
  }));
}

async function seatingContext(db: AppDb, eventId: number): Promise<{ ok: true } | LogisticsFailure> {
  const settings = await getLogisticsSettings(db, eventId);
  if (!settings) return fail('not_found');
  return settings.seating ? { ok: true } : fail('disabled');
}

const tableOfEvent = (eventId: number, tableId: number) => `EXISTS (SELECT 1 FROM reg_tables t WHERE t.id = ${intLit(tableId)} AND t.event_id = ${intLit(eventId)})`;
const validSeats = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SEATS_PER_TABLE;

// ── Tables ───────────────────────────────────────────────────────────────────

/** Add `count` tables "<prefix> <from>" .. "<prefix> <from + count - 1>" with `seats` each. Labels the event
 *  already has are skipped. */
export async function addTables(
  db: AppDb,
  eventId: number,
  input: { prefix?: unknown; from?: number; count: number; seats: number },
): Promise<{ ok: true; created: Array<{ id: number; label: string }>; skipped: string[] } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const prefix = input.prefix === undefined ? 'Table' : input.prefix === '' ? '' : cleanLabel(input.prefix, 30);
  if (prefix === null) return fail('invalid', [{ path: 'prefix', code: 'invalid' }]);
  const from = input.from ?? 1;
  if (!Number.isSafeInteger(from) || from < 0 || from > 100000) return fail('invalid', [{ path: 'from', code: 'invalid' }]);
  if (!Number.isSafeInteger(input.count) || input.count < 1) return fail('invalid', [{ path: 'count', code: 'invalid' }]);
  if (input.count > MAX_TABLES_PER_CALL) return fail('too_many');
  if (!validSeats(input.seats)) return fail('invalid', [{ path: 'seats', code: 'invalid' }]);
  const labels = Array.from({ length: input.count }, (_, i) => (prefix === '' ? String(from + i) : `${prefix} ${from + i}`));
  const values = labels.map((label, i) => `(${textLit(label)}, ${i + 1})`).join(', ');
  const write = await logisticsWrite(db, eventId, 'seating', '1 = 1', (held) => [
    db
      .prepare(
        `INSERT INTO reg_tables (campus_id, event_id, label, seats, sort)
         SELECT e.campus_id, e.id, l.column1, CAST(?2 AS INTEGER), l.column2 + (SELECT COALESCE(MAX(s.sort), 0) FROM reg_tables s WHERE s.event_id = e.id)
         FROM reg_events e CROSS JOIN (VALUES ${values}) AS l
         WHERE e.id = ?1 AND ${held}
         ON CONFLICT (event_id, label) DO NOTHING
         RETURNING id, label`,
      )
      .bind(eventId, input.seats),
  ]);
  if (!write.claimed) return fail('not_found');
  const created = (write.work[0].results as Array<{ id: number; label: string }>).map((r) => ({ id: r.id, label: r.label }));
  created.sort((a, b) => labels.indexOf(a.label) - labels.indexOf(b.label));
  const made = new Set(created.map((r) => r.label));
  return { ok: true, created, skipped: labels.filter((l) => !made.has(l)) };
}

/** Rename a table or change its seats (fewer seats than people at it is allowed; the board shows it as over). */
export async function updateTable(db: AppDb, eventId: number, tableId: number, input: { label?: unknown; seats?: unknown }): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const table = await db.prepare(`SELECT label, seats FROM reg_tables WHERE id = ?1 AND event_id = ?2`).bind(tableId, eventId).first<{ label: string; seats: number }>();
  if (!table) return fail('not_found');
  const label = input.label === undefined ? table.label : cleanLabel(input.label, 40);
  if (!label) return fail('invalid', [{ path: 'label', code: 'invalid' }]);
  const seats = input.seats === undefined ? Number(table.seats) : input.seats;
  if (!validSeats(seats)) return fail('invalid', [{ path: 'seats', code: 'invalid' }]);
  try {
    const write = await logisticsWrite(db, eventId, 'seating', tableOfEvent(eventId, tableId), (held) => [
      db.prepare(`UPDATE reg_tables SET label = ?2, seats = ?3 WHERE id = ?1 AND ${held}`).bind(tableId, label, seats),
    ]);
    return write.claimed ? { ok: true } : fail('not_found');
  } catch (error) {
    if (isUniqueViolation(error)) return fail('duplicate', [{ path: 'label', code: 'duplicate' }]);
    throw error;
  }
}

/** Remove tables in bulk; only empty tables go, the others are reported in `occupied`. */
export async function deleteTables(db: AppDb, eventId: number, input: { tableIds: number[] }): Promise<{ ok: true; deleted: number; occupied: number[] } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const ids = [...new Set(input.tableIds)];
  if (ids.length === 0 || ids.length > MAX_TABLES_PER_CALL || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return fail('invalid');
  const { results } = await db
    .prepare(`SELECT t.id AS id, ${liveCountSql('reg_table_seats', 'x.table_id = t.id')} AS seated FROM reg_tables t WHERE ${inList('t.id', ids)} AND t.event_id = ?1`)
    .bind(eventId)
    .all<{ id: number; seated: number }>();
  if (results.length !== ids.length) return fail('not_found');
  const write = await logisticsWrite(db, eventId, 'seating', '1 = 1', (held) => [
    db.prepare(`DELETE FROM reg_tables WHERE ${inList('id', ids)} AND event_id = ${intLit(eventId)} AND ${liveCountSql('reg_table_seats', 'x.table_id = reg_tables.id')} = 0 AND ${held}`),
  ]);
  if (!write.claimed) return fail('disabled');
  return { ok: true, deleted: write.work[0].meta.changes, occupied: results.filter((r) => Number(r.seated) > 0).map((r) => r.id) };
}

// ── Seat / unseat / host ─────────────────────────────────────────────────────

async function tableOccupants(db: AppDb, eventId: number, tableId: number): Promise<LogisticsPerson[]> {
  const { results } = await db
    .prepare(
      `SELECT x.attendee_id AS id FROM reg_table_seats x JOIN reg_attendees a ON a.id = x.attendee_id JOIN registrations r ON r.id = a.registration_id
       WHERE x.table_id = ?1 AND ${liveSql()}`,
    )
    .bind(tableId)
    .all<{ id: number }>();
  return loadPeople(db, eventId, results.map((r) => r.id));
}

export interface SeatInput {
  attendeeId: number;
  tableId: number;
  /** Seat the whole party (default true): every eligible person on the registration moves to this table. */
  party?: boolean;
  confirm?: boolean;
}

type SeatPlan = { table: { id: number; label: string; seats: number }; movers: LogisticsPerson[]; soft: string[]; registrationId: number };

async function planSeat(db: AppDb, eventId: number, input: SeatInput): Promise<SeatPlan | LogisticsFailure | { ok: true; seated: number[] }> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const table = await db.prepare(`SELECT id, label, seats FROM reg_tables WHERE id = ?1 AND event_id = ?2`).bind(input.tableId, eventId).first<{ id: number; label: string; seats: number }>();
  if (!table) return fail('not_found');
  const [person] = await loadPeople(db, eventId, [input.attendeeId]);
  if (!person) return fail('not_found');
  const party = await loadParty(db, eventId, person.registrationId);
  let movers = [person];
  if (input.party !== false) movers = [person, ...party.filter((p) => p.attendeeId !== person.attendeeId && eligibility(p) === null)];
  movers = movers.filter((p) => p.tableId !== table.id);
  if (movers.length === 0) return { ok: true, seated: [] };
  const ineligible = firstIneligible(movers);
  if (ineligible) return fail(ineligible);
  const moving = new Set(movers.map((p) => p.attendeeId));
  const stay = (await tableOccupants(db, eventId, table.id)).filter((p) => !moving.has(p.attendeeId));
  const soft: string[] = [];
  if (stay.length + movers.length > Number(table.seats)) soft.push('table_full');
  const elsewhere = party.some((p) => !moving.has(p.attendeeId) && p.tableId !== null && p.tableId !== table.id && p.status === 'active' && eligibility(p) !== 'not_active');
  if (elsewhere) soft.push('party_split');
  if (soft.length > 0 && !input.confirm) return needsConfirm(soft);
  return { table: { id: table.id, label: table.label, seats: Number(table.seats) }, movers, soft, registrationId: person.registrationId };
}

/** Seat a party (default) or one person at a table, moving them from another table if needed. */
export async function seatAtTable(db: AppDb, eventId: number, input: SeatInput, opts: { actor: number | null }): Promise<{ ok: true; seated: number[] } | LogisticsFailure> {
  const plan = await planSeat(db, eventId, input);
  if (!('movers' in plan)) return plan;
  const T = intLit(plan.table.id);
  const ids = plan.movers.map((p) => p.attendeeId);
  const claim = [tableOfEvent(eventId, T), allEligibleSql(eventId, ids)];
  if (!input.confirm) {
    claim.push(`${liveCountSql('reg_table_seats', `x.table_id = ${T} AND ${notInList('x.attendee_id', ids)}`)} + ${ids.length} <= (SELECT t.seats FROM reg_tables t WHERE t.id = ${T})`);
    claim.push(`NOT EXISTS (SELECT 1 FROM reg_table_seats x JOIN reg_attendees xa ON xa.id = x.attendee_id JOIN registrations xr ON xr.id = xa.registration_id
                 WHERE xa.registration_id = ${intLit(plan.registrationId)} AND ${liveSql('xa', 'xr')} AND x.table_id <> ${T} AND ${notInList('x.attendee_id', ids)})`);
  }
  const from = plan.movers.filter((p) => p.tableId !== null).map((p) => ({ attendeeId: p.attendeeId, tableId: p.tableId }));
  const write = await logisticsWrite(db, eventId, 'seating', claim.join(' AND '), (held) => [
    db
      .prepare(
        `INSERT INTO reg_table_seats (campus_id, attendee_id, table_id, seated_by)
         SELECT a.campus_id, a.id, ${T}, CAST(?1 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         WHERE ${inList('a.id', ids)} AND r.event_id = ${intLit(eventId)} AND ${held}
         ON CONFLICT (attendee_id) DO UPDATE SET table_id = excluded.table_id, seated_by = excluded.seated_by, seated_at = datetime('now')`,
      )
      .bind(opts.actor),
    db.prepare(`UPDATE reg_tables SET host_attendee_id = NULL WHERE ${inList('host_attendee_id', ids)} AND id <> ${T} AND ${held}`),
    activityFor(db, eventId, [plan.registrationId], opts.actor, from.length > 0 ? 'table_moved' : 'table_seated', {
      tableId: T, table: plan.table.label, attendeeIds: ids, ...(from.length > 0 ? { from } : {}), ...(plan.soft.length > 0 ? { override: plan.soft } : {}),
    }, held),
  ]);
  if (write.claimed) return { ok: true, seated: ids };
  const again = await planSeat(db, eventId, input);
  return 'movers' in again || ('ok' in again && again.ok) ? fail('conflict') : again;
}

/** Take a person off their table (and off its host role). */
export async function unseat(db: AppDb, eventId: number, input: { attendeeId: number }, opts: { actor: number | null }): Promise<{ ok: true; changed: boolean } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const [person] = await loadPeople(db, eventId, [input.attendeeId]);
  if (!person) return fail('not_found');
  if (person.tableId === null) return { ok: true, changed: false };
  const A = intLit(person.attendeeId);
  const write = await logisticsWrite(db, eventId, 'seating', `EXISTS (SELECT 1 FROM reg_table_seats x JOIN reg_tables t ON t.id = x.table_id WHERE x.attendee_id = ${A} AND t.event_id = ${intLit(eventId)})`, (held) => [
    db.prepare(`DELETE FROM reg_table_seats WHERE attendee_id = ${A} AND ${held}`),
    db.prepare(`UPDATE reg_tables SET host_attendee_id = NULL WHERE host_attendee_id = ${A} AND ${held}`),
    activityFor(db, eventId, [person.registrationId], opts.actor, 'table_unseated', { tableId: person.tableId, attendeeIds: [A] }, held),
  ]);
  return { ok: true, changed: write.claimed };
}

/** Make someone seated at the table its host (null clears it). */
export async function setTableHost(db: AppDb, eventId: number, input: { tableId: number; attendeeId: number | null }, opts: { actor: number | null }): Promise<{ ok: true } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const table = await db.prepare(`SELECT id, label, host_attendee_id FROM reg_tables WHERE id = ?1 AND event_id = ?2`).bind(input.tableId, eventId).first<{ id: number; label: string; host_attendee_id: number | null }>();
  if (!table) return fail('not_found');
  const T = intLit(table.id);
  const target = input.attendeeId;
  let registrationId: number | null = null;
  if (target !== null) {
    const host = (await tableOccupants(db, eventId, T)).find((p) => p.attendeeId === target);
    if (!host) return fail('not_seated');
    registrationId = host.registrationId;
  } else if (table.host_attendee_id !== null) {
    registrationId = (await loadPeople(db, eventId, [table.host_attendee_id]))[0]?.registrationId ?? null;
  }
  const seated = target === null ? '1 = 1' : `${liveCountSql('reg_table_seats', `x.table_id = ${T} AND x.attendee_id = ${intLit(target)}`)} = 1`;
  const write = await logisticsWrite(db, eventId, 'seating', `${tableOfEvent(eventId, T)} AND ${seated}`, (held) => [
    db.prepare(`UPDATE reg_tables SET host_attendee_id = CAST(?1 AS INTEGER) WHERE id = ${T} AND ${held}`).bind(target),
    ...(registrationId !== null
      ? [activityFor(db, eventId, [registrationId], opts.actor, target === null ? 'table_host_cleared' : 'table_host', { tableId: T, table: table.label, attendeeId: target ?? table.host_attendee_id }, held)]
      : []),
  ]);
  return write.claimed ? { ok: true } : fail(target === null ? 'conflict' : 'not_seated');
}

// ── Auto-seat ────────────────────────────────────────────────────────────────

/** The data version an auto-seat preview was made from: logistics changes, registrations (count and versions,
 *  which move on every cancel, edit and status change) and check-ins (a waitlisted person becomes seatable). */
export async function seatingStamp(db: AppDb, eventId: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT e.logistics_version AS lv,
              (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS regs,
              (SELECT COALESCE(SUM(r.version), 0) FROM registrations r WHERE r.event_id = e.id) AS versions,
              (SELECT COUNT(*) FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = e.id) AS checkins
       FROM reg_events e WHERE e.id = ?1 AND e.is_template = 0`,
    )
    .bind(eventId)
    .first<{ lv: number; regs: number; versions: number; checkins: number }>();
  return row ? `${Number(row.lv)}.${Number(row.regs)}.${Number(row.versions)}.${Number(row.checkins)}` : null;
}

const STAMP_RE = /^(\d+)\.(\d+)\.(-?\d+)\.(\d+)$/;

function stampSql(eventId: number, stamp: string): string | null {
  const m = STAMP_RE.exec(stamp);
  if (!m) return null;
  const [lv, regs, versions, checkins] = m.slice(1).map(Number);
  if (![lv, regs, versions, checkins].every(Number.isSafeInteger)) return null;
  const E = intLit(eventId);
  return `logistics_version = ${lv}
    AND (SELECT COUNT(*) FROM registrations sr WHERE sr.event_id = ${E}) = ${regs}
    AND (SELECT COALESCE(SUM(sr.version), 0) FROM registrations sr WHERE sr.event_id = ${E}) = ${versions}
    AND (SELECT COUNT(*) FROM reg_checkins sc JOIN reg_attendees sa ON sa.id = sc.attendee_id JOIN registrations sr ON sr.id = sa.registration_id WHERE sr.event_id = ${E}) = ${checkins}`;
}

/** Validate staff rules from a request: tag ids must be tags of this event. */
async function checkRules(db: AppDb, eventId: number, rules: SeatingRules): Promise<SeatingRules | null> {
  const spread = rules.spread ?? [];
  if (!Array.isArray(spread) || spread.length > MAX_SPREAD_RULES) return null;
  const tagIds = [...spread.map((r) => r?.tagId), ...(rules.host ? [rules.host.forTagId, rules.host.hostTagId] : [])];
  if (tagIds.some((id) => !Number.isSafeInteger(id) || id < 1)) return null;
  if (spread.some((r) => !Number.isSafeInteger(r.max) || r.max < 0 || r.max > MAX_SEATS_PER_TABLE)) return null;
  if (tagIds.length > 0) {
    const { results } = await db.prepare(`SELECT id FROM reg_tags WHERE event_id = ?1 AND ${inList('id', [...new Set(tagIds)])}`).bind(eventId).all<{ id: number }>();
    if (results.length !== new Set(tagIds).size) return null;
  }
  return { startOver: rules.startOver === true, spread: spread.map((r) => ({ tagId: r.tagId, max: r.max })), host: rules.host ? { forTagId: rules.host.forTagId, hostTagId: rules.host.hostTagId } : null };
}

async function seatingInput(db: AppDb, eventId: number): Promise<{ tables: SeatingTable[]; parties: PlanParty[]; registrations: Map<number, number> }> {
  const tables = await listSeating(db, eventId);
  const tableIds = new Set(tables.map((t) => t.id));
  const { results: people } = await db
    .prepare(
      `SELECT a.id AS attendee_id, a.registration_id AS registration_id, ts.table_id AS table_id
       FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id LEFT JOIN reg_table_seats ts ON ts.attendee_id = a.id
       WHERE r.event_id = ?1 AND ${eligibleSql()} ORDER BY a.registration_id, a.sort, a.id`,
    )
    .bind(eventId)
    .all<{ attendee_id: number; registration_id: number; table_id: number | null }>();
  const { results: tagRows } = await db
    .prepare(`SELECT at.attendee_id AS attendee_id, at.tag_id AS tag_id FROM reg_attendee_tags at JOIN reg_tags t ON t.id = at.tag_id WHERE t.event_id = ?1 ORDER BY at.tag_id`)
    .bind(eventId)
    .all<{ attendee_id: number; tag_id: number }>();
  const tags = new Map<number, number[]>();
  for (const r of tagRows) (tags.get(r.attendee_id) ?? tags.set(r.attendee_id, []).get(r.attendee_id)!).push(r.tag_id);
  const parties = new Map<number, PlanParty>();
  const registrations = new Map<number, number>();
  for (const p of people) {
    registrations.set(p.attendee_id, p.registration_id);
    const party = parties.get(p.registration_id) ?? parties.set(p.registration_id, { registrationId: p.registration_id, people: [] }).get(p.registration_id)!;
    party.people.push({ attendeeId: p.attendee_id, tags: tags.get(p.attendee_id) ?? [], tableId: p.table_id !== null && tableIds.has(p.table_id) ? p.table_id : null });
  }
  return { tables, parties: [...parties.values()], registrations };
}

export interface SeatingPreview {
  /** Send it back with applySeatingPlan; the apply refuses ('stale') once anything it depends on changed. */
  stamp: string;
  plan: SeatingPlan;
}

/** What auto-seat would do now (nothing is written). */
export async function previewSeating(db: AppDb, eventId: number, rules: SeatingRules): Promise<SeatingPreview | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const checked = await checkRules(db, eventId, rules);
  if (!checked) return fail('invalid', [{ path: 'rules', code: 'invalid' }]);
  const stamp = await seatingStamp(db, eventId);
  if (!stamp) return fail('not_found');
  const input = await seatingInput(db, eventId);
  return { stamp, plan: planSeating({ tables: input.tables.map((t) => ({ id: t.id, seats: t.seats, hostAttendeeId: t.hostAttendeeId })), parties: input.parties, rules: checked }) };
}

/**
 * Apply auto-seat: the plan is recomputed on the server from the same rules (the planner is deterministic) and
 * written in one guarded batch that also proves the data still matches `stamp`; a preview made from older data
 * answers 'stale' and writes nothing.
 */
export async function applySeatingPlan(
  db: AppDb,
  eventId: number,
  input: { stamp: string; rules: SeatingRules },
  opts: { actor: number | null },
): Promise<{ ok: true; plan: SeatingPlan } | LogisticsFailure> {
  const ctx = await seatingContext(db, eventId);
  if (!ctx.ok) return ctx;
  const checked = await checkRules(db, eventId, input.rules);
  if (!checked) return fail('invalid', [{ path: 'rules', code: 'invalid' }]);
  const guard = typeof input.stamp === 'string' ? stampSql(eventId, input.stamp) : null;
  if (!guard) return fail('invalid', [{ path: 'stamp', code: 'invalid' }]);
  if ((await seatingStamp(db, eventId)) !== input.stamp) return fail('stale');
  const data = await seatingInput(db, eventId);
  const plan = planSeating({ tables: data.tables.map((t) => ({ id: t.id, seats: t.seats, hostAttendeeId: t.hostAttendeeId })), parties: data.parties, rules: checked });
  const E = intLit(eventId);
  // Starting over clears every seat first, so every planned seat is written; otherwise only the differences.
  const writes = checked.startOver ? plan.seats : plan.changes;
  const changeIds = writes.map((c) => c.attendeeId);
  // One branch per table (not per person) keeps the statement short for large events (D1 caps statement length).
  const byTable = new Map<number, number[]>();
  for (const c of writes) (byTable.get(c.tableId) ?? byTable.set(c.tableId, []).get(c.tableId)!).push(c.attendeeId);
  const tableCase = writes.length ? `CASE ${[...byTable].map(([t, ids]) => `WHEN ${inList('a.id', ids)} THEN ${intLit(t)}`).join(' ')} END` : 'NULL';
  const hostCase = plan.hosts.length ? `CASE id ${plan.hosts.map((h) => `WHEN ${intLit(h.tableId)} THEN ${h.attendeeId === null ? 'CAST(NULL AS INTEGER)' : intLit(h.attendeeId)}`).join(' ')} END` : 'NULL';
  const touched = [...new Set([...changeIds, ...plan.unseated].map((id) => data.registrations.get(id)).filter((id): id is number => id !== undefined))];
  const write = await logisticsWrite(db, eventId, 'seating', guard, (held) => [
    ...(checked.startOver ? [db.prepare(`DELETE FROM reg_table_seats WHERE table_id IN (SELECT t.id FROM reg_tables t WHERE t.event_id = ${E}) AND ${held}`)] : []),
    ...(writes.length
      ? [db
          .prepare(
            `INSERT INTO reg_table_seats (campus_id, attendee_id, table_id, seated_by)
             SELECT a.campus_id, a.id, ${tableCase}, CAST(?1 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
             WHERE ${inList('a.id', changeIds)} AND r.event_id = ${E} AND ${eligibleSql()} AND ${held}
             ON CONFLICT (attendee_id) DO UPDATE SET table_id = excluded.table_id, seated_by = excluded.seated_by, seated_at = datetime('now')`,
          )
          .bind(opts.actor)]
      : []),
    ...(plan.hosts.length
      ? [db.prepare(`UPDATE reg_tables SET host_attendee_id = ${hostCase} WHERE ${inList('id', plan.hosts.map((h) => h.tableId))} AND event_id = ${E} AND ${held}`)]
      : []),
    activityFor(db, eventId, touched, opts.actor, 'table_auto_seated', { startOver: checked.startOver === true }, held),
  ]);
  if (!write.claimed) return (await seatingStamp(db, eventId)) !== input.stamp ? fail('stale') : fail('disabled');
  return { ok: true, plan };
}

