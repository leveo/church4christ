// Shared plumbing for the registration back office data layer (regAdmin.ts, regCheckin.ts, regOutbox.ts):
// the activity history writer, the seat-fit predicates behind every "soft confirm", and the version-guarded
// batch every drawer operation runs through.
//
// Optimistic concurrency without an interactive transaction: AppDb batches are one transaction but cannot
// branch, so a guarded write is  [lock the event row] -> [claim: version = -(expected + 1) WHERE version =
// expected] -> [work, each statement guarded on the claim] -> [release: version = expected + 1]. A negative
// version exists only inside the transaction, so the claim can never be mistaken for a concurrent writer's
// result, and a stale `expected` makes the claim, and so every statement after it, a no-op. The event lock
// serializes every seat-changing batch on the event, so a seat check inside a guarded write is exact.
//
// Nothing in a guarded batch may touch registrations.version except the claim and the release.
import type { AppDb, AppDbResult, AppStatement } from './appDb';
import { SEAT_STATUSES, seatsTakenSql, ticketTakenSql } from './regDb';

/** A soft failure: the caller shows `reason` and resends with confirm:true to override. */
export type NeedsConfirm = { ok: false; code: 'NEEDS_CONFIRM'; reason: string };
export type OpFailure =
  | { ok: false; code: 'not_found' | 'version_conflict' | 'not_editable' | 'invalid' | 'paid_registration' | 'ticket_type_invalid' | 'party_too_large' | 'approval_requires_free' | 'payment_method_required' | 'event_not_found' | 'person_not_found'; errors?: Array<{ path: string; code: string }> }
  | NeedsConfirm;

export const SEAT_LIST = SEAT_STATUSES.map((s) => `'${s}'`).join(',');

/** A positive integer safe to inline in SQL (every inlined value goes through this). */
export function intLit(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('not_an_integer');
  return value;
}

/** `detail` is serialized as JSON; callers never put tokens, links or free text in it. */
export type ActivityDetail = Record<string, unknown> | null;

/** The activity row for registration `registrationId`, selected from the registration so the event and campus
 *  come from the row, never from the caller. `guardSql` (optional) is ANDed into the WHERE. */
export function activityStatement(
  db: AppDb,
  registrationId: number,
  actorId: number | null,
  action: string,
  detail: ActivityDetail = null,
  guardSql = '1 = 1',
): AppStatement {
  return db
    .prepare(
      `INSERT INTO reg_activity (campus_id, event_id, registration_id, actor_person_id, action, detail_json)
       SELECT r.campus_id, r.event_id, r.id, CAST(?2 AS INTEGER), CAST(?3 AS TEXT), CAST(?4 AS TEXT)
       FROM registrations r WHERE r.id = ?1 AND ${guardSql}`,
    )
    .bind(registrationId, actorId, action, detail === null ? null : JSON.stringify(detail));
}

export async function logActivity(db: AppDb, registrationId: number, actorId: number | null, action: string, detail: ActivityDetail = null): Promise<void> {
  await activityStatement(db, registrationId, actorId, action, detail).run();
}

// ── Seat fit ─────────────────────────────────────────────────────────────────

/** What a change adds to the seats in use: whole seats on the event and people on ticket types. */
export interface SeatDemand {
  seats: number;
  types: Map<number, number>;
}

export function demandOf(seats: number, typeIds: Array<number | null>): SeatDemand {
  const types = new Map<number, number>();
  for (const id of typeIds) if (id !== null) types.set(id, (types.get(id) ?? 0) + 1);
  return { seats, types };
}

/** SQL predicate (true when the demand fits) for event `eventId`: the event capacity, then every ticket type's limit. */
export function fitSql(eventId: number, demand: SeatDemand): string {
  const parts: string[] = [];
  if (demand.seats > 0) {
    parts.push(
      `COALESCE((SELECT CASE WHEN ev.capacity IS NULL THEN 1
                 WHEN ${seatsTakenSql('ev.id')} + ${intLit(demand.seats)} <= ev.capacity THEN 1 ELSE 0 END
                 FROM reg_events ev WHERE ev.id = ${intLit(eventId)}), 1) = 1`,
    );
  }
  for (const [typeId, count] of demand.types) {
    if (count <= 0) continue;
    parts.push(
      `COALESCE((SELECT CASE WHEN tt.capacity IS NULL THEN 1
                 WHEN ${ticketTakenSql('tt.id')} + ${intLit(count)} <= tt.capacity THEN 1 ELSE 0 END
                 FROM reg_ticket_types tt WHERE tt.id = ${intLit(typeId)}), 1) = 1`,
    );
  }
  return parts.length > 0 ? parts.join(' AND ') : '1 = 1';
}

/** Read-side twin of fitSql: why a demand does not fit right now, or null when it fits. */
export async function shortfall(db: AppDb, eventId: number, demand: SeatDemand): Promise<'event_full' | 'ticket_type_full' | null> {
  if (demand.seats > 0) {
    const row = await db
      .prepare(`SELECT e.capacity AS capacity, ${seatsTakenSql('e.id')} AS taken FROM reg_events e WHERE e.id = ?1`)
      .bind(eventId)
      .first<{ capacity: number | null; taken: number }>();
    if (row && row.capacity !== null && Number(row.taken) + demand.seats > row.capacity) return 'event_full';
  }
  for (const [typeId, count] of demand.types) {
    if (count <= 0) continue;
    const row = await db
      .prepare(`SELECT t.capacity AS capacity, ${ticketTakenSql('t.id')} AS taken FROM reg_ticket_types t WHERE t.id = ?1 AND t.event_id = ?2`)
      .bind(typeId, eventId)
      .first<{ capacity: number | null; taken: number }>();
    if (row && row.capacity !== null && Number(row.taken) + count > row.capacity) return 'ticket_type_full';
  }
  return null;
}

// ── The version-guarded batch ────────────────────────────────────────────────

export interface GuardedWrite {
  /** False when the claim matched nothing: a stale version, or `claimSql` (a capacity guard) failed. */
  claimed: boolean;
  results: AppDbResult[];
  /** The guarded statements' results (without lock, claim and release). */
  work: AppDbResult[];
}

/**
 * Run `build(held)` under the version guard for registration `reg` at `expected`. `held` is a SQL
 * predicate that is true only inside this batch after a successful claim: AND it into the WHERE of every
 * statement `build` returns. `claimSql` (optional) is ANDed into the claim itself, so a failing capacity
 * guard claims nothing and the whole batch is a no-op. On success the version becomes expected + 1.
 */
export async function guardedWrite(
  db: AppDb,
  reg: { id: number; event_id: number },
  expected: number,
  build: (held: string) => AppStatement[],
  claimSql = '1 = 1',
): Promise<GuardedWrite> {
  const id = intLit(reg.id);
  const marker = -(intLit(expected) + 1);
  const held = `EXISTS (SELECT 1 FROM registrations hv WHERE hv.id = ${id} AND hv.version = ${marker})`;
  const work = build(held);
  const results = await db.batch([
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ${intLit(reg.event_id)}`),
    db.prepare(`UPDATE registrations SET version = ${marker}, updated_at = datetime('now') WHERE id = ${id} AND version = ${expected} AND (${claimSql})`),
    ...work,
    db.prepare(`UPDATE registrations SET version = ${expected + 1} WHERE id = ${id} AND version = ${marker}`),
  ]);
  return { claimed: results[1].meta.changes === 1, results, work: results.slice(2, 2 + work.length) };
}

/** A failed claim: the version moved (conflict) or the capacity guard refused (needs confirm). Both are
 *  re-read so the answer is exact: the batch has committed nothing either way. */
export async function claimFailure(db: AppDb, registrationId: number, expected: number): Promise<{ ok: false; code: 'version_conflict' } | NeedsConfirm | { ok: false; code: 'not_found' }> {
  const row = await db.prepare(`SELECT version FROM registrations WHERE id = ?1`).bind(registrationId).first<{ version: number }>();
  if (!row) return { ok: false, code: 'not_found' };
  if (row.version !== expected) return { ok: false, code: 'version_conflict' };
  return { ok: false, code: 'NEEDS_CONFIRM', reason: 'capacity' };
}

// ── LIKE ─────────────────────────────────────────────────────────────────────

/** Escape a user term for `LIKE ... ESCAPE '\'` (both backends) and lower-case it; compare with LOWER(column).
 *  SQLite folds only ASCII in LOWER, Postgres folds everything: a term with non-ASCII capitals matches
 *  exactly on D1 and case-insensitively on Postgres. */
export function likeTerm(term: string): string {
  return `%${term.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The clause text for one escaped LIKE comparison of `column` against a bound `placeholder`. */
export const likeSql = (column: string, placeholder: string): string => `LOWER(${column}) LIKE CAST(${placeholder} AS TEXT) ESCAPE '\\'`;
