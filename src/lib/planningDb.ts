// Service Planning data layer: events, the run sheet, rehearsal sessions with
// called people, availability windows, and notification rules. Every function
// takes an AppDb (the request-scoped database on D1 or Supabase), uses only
// portable SQL, and never trusts ids that came from a form without scoping the
// WHERE clause to the owning event / person.
//
// Optimistic lock: every event or run-sheet write passes the revision the editor
// loaded. The guard bumps planning_events.revision only when it still matches,
// so two people editing at once cannot silently overwrite each other.
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';
import {
  EMPTY_FACTS,
  MAX_ITEM_MINUTES,
  parseHM,
  parseWeekdays,
  serializeWeekdays,
  summarizeStatuses,
  timeStatus,
  type BlockoutFact,
  type BusyFact,
  type PersonFacts,
  type RunItemKind,
  type SlotStatus,
} from './planningModel';

export const EVENT_STATUSES = ['draft', 'published', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const SESSION_STATUSES = ['draft', 'scheduled', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const ITEM_KINDS: readonly RunItemKind[] = ['segment', 'song', 'heading', 'note'];
export const RULE_KEYS = ['publish', 'change', 'cancel', 'remind'] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

const MAX_CALLED_PEOPLE = 200;
const MAX_IN = 400;

// ── Shapes ──

export interface PlanningEvent {
  id: number;
  title_en: string;
  title_zh: string;
  event_date: string;
  start_time: string;
  end_time: string | null;
  location_en: string;
  location_zh: string;
  notes_en: string;
  notes_zh: string;
  plan_id: number | null;
  status: EventStatus;
  revision: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  campus_id: number;
}

export interface EventInput {
  title_en: string;
  title_zh: string;
  event_date: string;
  start_time: string;
  end_time: string | null;
  location_en: string;
  location_zh: string;
  notes_en: string;
  notes_zh: string;
  plan_id: number | null;
}

export interface PlanningItem {
  id: number;
  event_id: number;
  sort: number;
  kind: RunItemKind;
  duration_min: number;
  fixed_start_time: string | null;
  title_en: string;
  title_zh: string;
  details_en: string;
  details_zh: string;
  owner_team_id: number | null;
  owner_person_id: number | null;
  owner_label: string | null;
  cue_notes: string;
  campus_id: number;
}

export type ItemInput = Omit<PlanningItem, 'id' | 'event_id' | 'sort' | 'campus_id'>;

export interface PlanningSession {
  id: number;
  event_id: number;
  title_en: string;
  title_zh: string;
  session_date: string;
  start_time: string;
  end_time: string;
  location_en: string;
  location_zh: string;
  note_en: string;
  note_zh: string;
  status: SessionStatus;
  acknowledged_unknown: number;
  campus_id: number;
}

export type SessionInput = Omit<PlanningSession, 'id' | 'event_id' | 'status' | 'acknowledged_unknown' | 'campus_id'>;

export interface SessionPerson {
  person_id: number;
  display_name: string;
  email: string | null;
  lang: string | null;
  call_time: string | null;
  notified_at: string | null;
  reminded_at: string | null;
}

export interface AvailabilityRow {
  id: number;
  person_id: number;
  starts_on: string;
  ends_on: string;
  weekdays: string;
  start_minute: number;
  end_minute: number;
  note: string;
}

export interface PersonLite {
  id: number;
  display_name: string;
}

type WriteResult = { ok: true; revision: number } | { ok: false; reason: 'conflict' | 'not_found' };

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function changes(res: { meta?: { changes?: number } }): number {
  return res.meta?.changes ?? 0;
}

// ── Events ──

const EVENT_COLS = `id, title_en, title_zh, event_date, start_time, end_time, location_en, location_zh,
  notes_en, notes_zh, plan_id, status, revision, created_by, created_at, updated_at, campus_id`;

export async function listEvents(
  db: AppDb,
  opts: { from?: string; status?: EventStatus; ids?: readonly number[]; limit?: number } = {},
): Promise<PlanningEvent[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.from) {
    where.push('event_date >= ?');
    binds.push(opts.from);
  }
  if (opts.status) {
    where.push('status = ?');
    binds.push(opts.status);
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(`id IN (${placeholders(opts.ids.length)})`);
    binds.push(...opts.ids);
  }
  const { results } = await db
    .prepare(
      `SELECT ${EVENT_COLS} FROM planning_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY event_date DESC, start_time DESC, id DESC LIMIT ${Math.min(opts.limit ?? 200, 500)}`,
    )
    .bind(...binds)
    .all<PlanningEvent>();
  return results;
}

export async function getEvent(db: AppDb, id: number): Promise<PlanningEvent | null> {
  return db.prepare(`SELECT ${EVENT_COLS} FROM planning_events WHERE id = ?`).bind(id).first<PlanningEvent>();
}

/** The linked serve plan, or null when none is linked or it was soft-deleted. */
export async function getLinkedPlan(
  db: AppDb,
  planId: number | null,
): Promise<{ id: number; plan_date: string; title: string | null } | null> {
  if (planId === null) return null;
  return db
    .prepare(`SELECT id, plan_date, title FROM plans WHERE id = ? AND deleted_at IS NULL`)
    .bind(planId)
    .first<{ id: number; plan_date: string; title: string | null }>();
}

export async function listLinkablePlans(
  db: AppDb,
  fromDate: string,
): Promise<{ id: number; plan_date: string; title: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, plan_date, title FROM plans WHERE deleted_at IS NULL AND plan_date >= ?
       ORDER BY plan_date, id LIMIT 60`,
    )
    .bind(fromDate)
    .all<{ id: number; plan_date: string; title: string | null }>();
  return results;
}

export async function createEvent(db: AppDb, input: EventInput, createdBy: number | null): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO planning_events
         (title_en, title_zh, event_date, start_time, end_time, location_en, location_zh,
          notes_en, notes_zh, plan_id, status, revision, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?)
       RETURNING id`,
    )
    .bind(
      input.title_en,
      input.title_zh,
      input.event_date,
      input.start_time,
      input.end_time,
      input.location_en,
      input.location_zh,
      input.notes_en,
      input.notes_zh,
      input.plan_id,
      createdBy,
    )
    .first<{ id: number }>();
  return res!.id;
}

/**
 * Bump the revision when it still matches. Returns the new revision, or a reason
 * the write must not proceed. This is the single optimistic-lock gate.
 */
export async function bumpRevision(db: AppDb, eventId: number, expected: number): Promise<WriteResult> {
  const res = await db
    .prepare(
      `UPDATE planning_events SET revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .bind(nowSql(), eventId, expected)
    .run();
  if (changes(res) === 1) return { ok: true, revision: expected + 1 };
  const exists = await db.prepare(`SELECT id FROM planning_events WHERE id = ?`).bind(eventId).first();
  return { ok: false, reason: exists ? 'conflict' : 'not_found' };
}

export async function updateEvent(
  db: AppDb,
  id: number,
  expectedRevision: number,
  input: EventInput,
): Promise<WriteResult> {
  const gate = await bumpRevision(db, id, expectedRevision);
  if (!gate.ok) return gate;
  await db
    .prepare(
      `UPDATE planning_events SET title_en = ?, title_zh = ?, event_date = ?, start_time = ?, end_time = ?,
         location_en = ?, location_zh = ?, notes_en = ?, notes_zh = ?, plan_id = ?
       WHERE id = ?`,
    )
    .bind(
      input.title_en,
      input.title_zh,
      input.event_date,
      input.start_time,
      input.end_time,
      input.location_en,
      input.location_zh,
      input.notes_en,
      input.notes_zh,
      input.plan_id,
      id,
    )
    .run();
  return gate;
}

export async function setEventStatus(
  db: AppDb,
  id: number,
  expectedRevision: number,
  status: EventStatus,
): Promise<WriteResult> {
  const gate = await bumpRevision(db, id, expectedRevision);
  if (!gate.ok) return gate;
  await db.prepare(`UPDATE planning_events SET status = ? WHERE id = ?`).bind(status, id).run();
  return gate;
}

// ── People helpers ──

export async function searchPeople(db: AppDb, query: string, limit = 12): Promise<PersonLite[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT id, display_name FROM people
       WHERE deleted_at IS NULL AND active = 1
         AND (LOWER(display_name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')
       ORDER BY display_name LIMIT ${Math.min(limit, 30)}`,
    )
    .bind(like, like)
    .all<PersonLite>();
  return results;
}

export async function listTeams(db: AppDb, locale: Locale): Promise<{ id: number; name: string }[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT tm.id AS id, ${tmJ.select} FROM teams tm ${tmJ.joins}
       WHERE tm.deleted_at IS NULL ORDER BY tm.sort, tm.id`,
    )
    .all<{ id: number; name: string }>();
  return results;
}

export async function listTeamMemberIds(db: AppDb, teamId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT tmm.person_id AS person_id FROM team_members tmm
       JOIN people p ON p.id = tmm.person_id AND p.deleted_at IS NULL AND p.active = 1
       WHERE tmm.team_id = ? ORDER BY p.display_name LIMIT ${MAX_CALLED_PEOPLE}`,
    )
    .bind(teamId)
    .all<{ person_id: number }>();
  return results.map((r) => r.person_id);
}

export async function listPeopleByIds(db: AppDb, ids: readonly number[]): Promise<PersonLite[]> {
  const unique = [...new Set(ids)].slice(0, MAX_IN);
  if (unique.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT id, display_name FROM people WHERE id IN (${placeholders(unique.length)}) ORDER BY display_name`)
    .bind(...unique)
    .all<PersonLite>();
  return results;
}

// ── Coordinators ──

export async function listCoordinators(db: AppDb, eventId: number): Promise<PersonLite[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS id, p.display_name AS display_name
       FROM planning_event_coordinators c JOIN people p ON p.id = c.person_id
       WHERE c.event_id = ? ORDER BY p.display_name`,
    )
    .bind(eventId)
    .all<PersonLite>();
  return results;
}

export async function addCoordinator(db: AppDb, eventId: number, personId: number): Promise<void> {
  const person = await db
    .prepare(`SELECT id FROM people WHERE id = ? AND deleted_at IS NULL AND active = 1`)
    .bind(personId)
    .first();
  if (!person) return;
  await db
    .prepare(
      `INSERT INTO planning_event_coordinators (event_id, person_id) VALUES (?, ?)
       ON CONFLICT (event_id, person_id) DO NOTHING`,
    )
    .bind(eventId, personId)
    .run();
}

export async function removeCoordinator(db: AppDb, eventId: number, personId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM planning_event_coordinators WHERE event_id = ? AND person_id = ?`)
    .bind(eventId, personId)
    .run();
}

export async function isCoordinator(db: AppDb, eventId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM planning_event_coordinators WHERE event_id = ? AND person_id = ?`)
    .bind(eventId, personId)
    .first();
  return row !== null;
}

/** Event ids a person coordinates. */
export async function listCoordinatedEventIds(db: AppDb, personId: number): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT event_id FROM planning_event_coordinators WHERE person_id = ?`)
    .bind(personId)
    .all<{ event_id: number }>();
  return results.map((r) => r.event_id);
}

// ── Run sheet ──

const ITEM_COLS = `id, event_id, sort, kind, duration_min, fixed_start_time, title_en, title_zh, details_en,
  details_zh, owner_team_id, owner_person_id, owner_label, cue_notes, campus_id`;

export async function listItems(db: AppDb, eventId: number): Promise<PlanningItem[]> {
  const { results } = await db
    .prepare(`SELECT ${ITEM_COLS} FROM planning_items WHERE event_id = ? ORDER BY sort, id`)
    .bind(eventId)
    .all<PlanningItem>();
  return results;
}

/** Clamp an item input to the schema's limits (the form parser also validates). */
export function normalizeItem(input: ItemInput): ItemInput {
  const duration = Math.max(0, Math.min(MAX_ITEM_MINUTES, Math.trunc(Number(input.duration_min)) || 0));
  return {
    ...input,
    kind: ITEM_KINDS.includes(input.kind) ? input.kind : 'segment',
    duration_min: duration,
    fixed_start_time: parseHM(input.fixed_start_time) !== null ? input.fixed_start_time : null,
  };
}

async function ownersExist(db: AppDb, item: ItemInput): Promise<ItemInput> {
  let teamId = item.owner_team_id;
  let personId = item.owner_person_id;
  if (teamId !== null) {
    const team = await db.prepare(`SELECT id FROM teams WHERE id = ? AND deleted_at IS NULL`).bind(teamId).first();
    if (!team) teamId = null;
  }
  if (personId !== null) {
    const person = await db
      .prepare(`SELECT id FROM people WHERE id = ? AND deleted_at IS NULL`)
      .bind(personId)
      .first();
    if (!person) personId = null;
  }
  return { ...item, owner_team_id: teamId, owner_person_id: personId };
}

export async function addItem(
  db: AppDb,
  eventId: number,
  expectedRevision: number,
  input: ItemInput,
): Promise<WriteResult> {
  const gate = await bumpRevision(db, eventId, expectedRevision);
  if (!gate.ok) return gate;
  const item = await ownersExist(db, normalizeItem(input));
  const max = await db
    .prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM planning_items WHERE event_id = ?`)
    .bind(eventId)
    .first<{ m: number }>();
  await db
    .prepare(
      `INSERT INTO planning_items (event_id, sort, kind, duration_min, fixed_start_time, title_en, title_zh,
         details_en, details_zh, owner_team_id, owner_person_id, owner_label, cue_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventId,
      (max?.m ?? 0) + 10,
      item.kind,
      item.duration_min,
      item.fixed_start_time,
      item.title_en,
      item.title_zh,
      item.details_en,
      item.details_zh,
      item.owner_team_id,
      item.owner_person_id,
      item.owner_label,
      item.cue_notes,
    )
    .run();
  return gate;
}

export async function updateItem(
  db: AppDb,
  eventId: number,
  itemId: number,
  expectedRevision: number,
  input: ItemInput,
): Promise<WriteResult> {
  const gate = await bumpRevision(db, eventId, expectedRevision);
  if (!gate.ok) return gate;
  const item = await ownersExist(db, normalizeItem(input));
  await db
    .prepare(
      `UPDATE planning_items SET kind = ?, duration_min = ?, fixed_start_time = ?, title_en = ?, title_zh = ?,
         details_en = ?, details_zh = ?, owner_team_id = ?, owner_person_id = ?, owner_label = ?, cue_notes = ?
       WHERE id = ? AND event_id = ?`,
    )
    .bind(
      item.kind,
      item.duration_min,
      item.fixed_start_time,
      item.title_en,
      item.title_zh,
      item.details_en,
      item.details_zh,
      item.owner_team_id,
      item.owner_person_id,
      item.owner_label,
      item.cue_notes,
      itemId,
      eventId,
    )
    .run();
  return gate;
}

export async function deleteItem(
  db: AppDb,
  eventId: number,
  itemId: number,
  expectedRevision: number,
): Promise<WriteResult> {
  const gate = await bumpRevision(db, eventId, expectedRevision);
  if (!gate.ok) return gate;
  await db.prepare(`DELETE FROM planning_items WHERE id = ? AND event_id = ?`).bind(itemId, eventId).run();
  return gate;
}

/** Swap an item with its neighbour. Re-spaces `sort` so ties can never occur. */
export async function moveItem(
  db: AppDb,
  eventId: number,
  itemId: number,
  expectedRevision: number,
  direction: 'up' | 'down',
): Promise<WriteResult> {
  const gate = await bumpRevision(db, eventId, expectedRevision);
  if (!gate.ok) return gate;
  const ordered = await listItems(db, eventId);
  const index = ordered.findIndex((item) => item.id === itemId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) return gate;
  const ids = ordered.map((item) => item.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await db.batch(
    ids.map((id, position) =>
      db.prepare(`UPDATE planning_items SET sort = ? WHERE id = ? AND event_id = ?`).bind((position + 1) * 10, id, eventId),
    ),
  );
  return gate;
}

/** Append a copy of another event's run sheet. Source and target must differ. */
export async function copyRunSheet(
  db: AppDb,
  targetEventId: number,
  sourceEventId: number,
  expectedRevision: number,
): Promise<WriteResult & { copied?: number }> {
  if (targetEventId === sourceEventId) return { ok: false, reason: 'not_found' };
  const source = await getEvent(db, sourceEventId);
  if (!source) return { ok: false, reason: 'not_found' };
  const gate = await bumpRevision(db, targetEventId, expectedRevision);
  if (!gate.ok) return gate;
  const items = await listItems(db, sourceEventId);
  const max = await db
    .prepare(`SELECT COALESCE(MAX(sort), 0) AS m FROM planning_items WHERE event_id = ?`)
    .bind(targetEventId)
    .first<{ m: number }>();
  const base = max?.m ?? 0;
  if (items.length > 0) {
    await db.batch(
      items.map((item, i) =>
        db
          .prepare(
            `INSERT INTO planning_items (event_id, sort, kind, duration_min, fixed_start_time, title_en, title_zh,
               details_en, details_zh, owner_team_id, owner_person_id, owner_label, cue_notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            targetEventId,
            base + (i + 1) * 10,
            item.kind,
            item.duration_min,
            item.fixed_start_time,
            item.title_en,
            item.title_zh,
            item.details_en,
            item.details_zh,
            item.owner_team_id,
            item.owner_person_id,
            item.owner_label,
            item.cue_notes,
          ),
      ),
    );
  }
  return { ...gate, copied: items.length };
}

// ── Sessions ──

const SESSION_COLS = `id, event_id, title_en, title_zh, session_date, start_time, end_time, location_en, location_zh,
  note_en, note_zh, status, acknowledged_unknown, campus_id`;

export async function listSessions(db: AppDb, eventId: number): Promise<PlanningSession[]> {
  const { results } = await db
    .prepare(`SELECT ${SESSION_COLS} FROM planning_sessions WHERE event_id = ? ORDER BY session_date, start_time, id`)
    .bind(eventId)
    .all<PlanningSession>();
  return results;
}

export async function getSession(db: AppDb, id: number): Promise<PlanningSession | null> {
  return db.prepare(`SELECT ${SESSION_COLS} FROM planning_sessions WHERE id = ?`).bind(id).first<PlanningSession>();
}

export async function createSession(db: AppDb, eventId: number, input: SessionInput): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO planning_sessions (event_id, title_en, title_zh, session_date, start_time, end_time,
         location_en, location_zh, note_en, note_zh, status, acknowledged_unknown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0) RETURNING id`,
    )
    .bind(
      eventId,
      input.title_en,
      input.title_zh,
      input.session_date,
      input.start_time,
      input.end_time,
      input.location_en,
      input.location_zh,
      input.note_en,
      input.note_zh,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function updateSessionFields(db: AppDb, eventId: number, id: number, input: SessionInput): Promise<void> {
  await db
    .prepare(
      `UPDATE planning_sessions SET title_en = ?, title_zh = ?, session_date = ?, start_time = ?, end_time = ?,
         location_en = ?, location_zh = ?, note_en = ?, note_zh = ?, updated_at = ?
       WHERE id = ? AND event_id = ?`,
    )
    .bind(
      input.title_en,
      input.title_zh,
      input.session_date,
      input.start_time,
      input.end_time,
      input.location_en,
      input.location_zh,
      input.note_en,
      input.note_zh,
      nowSql(),
      id,
      eventId,
    )
    .run();
}

export async function setSessionStatus(
  db: AppDb,
  eventId: number,
  id: number,
  status: SessionStatus,
  acknowledgedUnknown = 0,
): Promise<void> {
  await db
    .prepare(
      `UPDATE planning_sessions SET status = ?, acknowledged_unknown = ?, updated_at = ?
       WHERE id = ? AND event_id = ?`,
    )
    .bind(status, acknowledgedUnknown ? 1 : 0, nowSql(), id, eventId)
    .run();
}

export async function listSessionPeople(db: AppDb, sessionId: number): Promise<SessionPerson[]> {
  const { results } = await db
    .prepare(
      `SELECT sp.person_id AS person_id, p.display_name AS display_name, p.email AS email, p.lang AS lang,
              sp.call_time AS call_time, sp.notified_at AS notified_at, sp.reminded_at AS reminded_at
       FROM planning_session_people sp JOIN people p ON p.id = sp.person_id
       WHERE sp.session_id = ? ORDER BY p.display_name, p.id`,
    )
    .bind(sessionId)
    .all<SessionPerson>();
  return results;
}

/** Called people for a session; adds new people, keeps existing rows (and their notified state). */
export async function addSessionPeople(
  db: AppDb,
  sessionId: number,
  personIds: readonly number[],
): Promise<number> {
  const current = await db
    .prepare(`SELECT COUNT(*) AS n FROM planning_session_people WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ n: number }>();
  const room = MAX_CALLED_PEOPLE - (current?.n ?? 0);
  const unique = [...new Set(personIds)].slice(0, Math.max(0, room));
  if (unique.length === 0) return 0;
  const valid = await db
    .prepare(
      `SELECT id FROM people WHERE deleted_at IS NULL AND active = 1 AND id IN (${placeholders(unique.length)})`,
    )
    .bind(...unique)
    .all<{ id: number }>();
  const ids = valid.results.map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `INSERT INTO planning_session_people (session_id, person_id) VALUES (?, ?)
           ON CONFLICT (session_id, person_id) DO NOTHING`,
        )
        .bind(sessionId, id),
    ),
  );
  return ids.length;
}

export async function removeSessionPerson(db: AppDb, sessionId: number, personId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM planning_session_people WHERE session_id = ? AND person_id = ?`)
    .bind(sessionId, personId)
    .run();
}

export async function setCallTime(
  db: AppDb,
  sessionId: number,
  personId: number,
  callTime: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE planning_session_people SET call_time = ? WHERE session_id = ? AND person_id = ?`)
    .bind(parseHM(callTime) !== null ? callTime : null, sessionId, personId)
    .run();
}

// ── Availability windows ──

const WINDOW_COLS = 'id, person_id, starts_on, ends_on, weekdays, start_minute, end_minute, note';

export async function listAvailability(db: AppDb, personId: number, fromDate: string): Promise<AvailabilityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${WINDOW_COLS} FROM availability_windows
       WHERE person_id = ? AND ends_on >= ? ORDER BY starts_on, start_minute, id`,
    )
    .bind(personId, fromDate)
    .all<AvailabilityRow>();
  return results;
}

export interface AvailabilityInput {
  starts_on: string;
  ends_on: string;
  weekdays: readonly number[];
  start_minute: number;
  end_minute: number;
  note: string;
}

const MAX_WINDOWS_PER_PERSON = 200;

/** Add a window for the OWNING person only (the page passes the session user id). */
export async function addAvailability(
  db: AppDb,
  personId: number,
  input: AvailabilityInput,
): Promise<{ ok: true } | { ok: false; reason: 'limit' }> {
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM availability_windows WHERE person_id = ?`)
    .bind(personId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_WINDOWS_PER_PERSON) return { ok: false, reason: 'limit' };
  await db
    .prepare(
      `INSERT INTO availability_windows (person_id, kind, starts_on, ends_on, weekdays, start_minute, end_minute, note)
       VALUES (?, 'available', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      personId,
      input.starts_on,
      input.ends_on,
      serializeWeekdays(input.weekdays),
      input.start_minute,
      input.end_minute,
      input.note,
    )
    .run();
  return { ok: true };
}

export async function deleteAvailability(db: AppDb, personId: number, id: number): Promise<void> {
  await db.prepare(`DELETE FROM availability_windows WHERE id = ? AND person_id = ?`).bind(id, personId).run();
}

// ── Facts for status / find-a-time ──

interface BlockoutRowFact extends BlockoutFact {
  person_id: number;
}

/**
 * Everything the status function needs for a set of people over a date range:
 * their blockouts, their available windows, and busy intervals from other
 * scheduled planning sessions and serve roster assignments whose service has
 * known start and end times.
 */
export async function loadPersonFacts(
  db: AppDb,
  personIds: readonly number[],
  dateFrom: string,
  dateTo: string,
  excludeSessionId: number | null = null,
): Promise<Map<number, PersonFacts>> {
  const ids = [...new Set(personIds)].slice(0, MAX_IN);
  const facts = new Map<number, { blockouts: BlockoutFact[]; busy: BusyFact[]; windows: AvailabilityRow[] }>();
  for (const id of ids) facts.set(id, { blockouts: [], busy: [], windows: [] });
  if (ids.length === 0) return facts as unknown as Map<number, PersonFacts>;
  const marks = placeholders(ids.length);

  const [blockouts, windows, sessions, roster] = await Promise.all([
    db
      .prepare(
        `SELECT person_id, start_date, end_date, start_time, end_time FROM blockout_dates
         WHERE person_id IN (${marks}) AND end_date >= ? AND start_date <= ?`,
      )
      .bind(...ids, dateFrom, dateTo)
      .all<BlockoutRowFact>(),
    db
      .prepare(
        `SELECT ${WINDOW_COLS} FROM availability_windows
         WHERE person_id IN (${marks}) AND ends_on >= ? AND starts_on <= ?`,
      )
      .bind(...ids, dateFrom, dateTo)
      .all<AvailabilityRow>(),
    db
      .prepare(
        `SELECT sp.person_id AS person_id, s.session_date AS date, s.start_time AS start_time, s.end_time AS end_time
         FROM planning_session_people sp
         JOIN planning_sessions s ON s.id = sp.session_id AND s.status = 'scheduled'
         WHERE sp.person_id IN (${marks}) AND s.session_date >= ? AND s.session_date <= ? AND s.id <> ?`,
      )
      .bind(...ids, dateFrom, dateTo, excludeSessionId ?? -1)
      .all<{ person_id: number; date: string; start_time: string; end_time: string }>(),
    db
      .prepare(
        `SELECT ra.person_id AS person_id, plans.plan_date AS date, st.start_time AS start_time, st.end_time AS end_time
         FROM roster_assignments ra
         JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
         JOIN service_types st ON st.id = plans.service_type_id
         WHERE ra.person_id IN (${marks}) AND ra.status <> 'D' AND ra.deleted_at IS NULL
           AND plans.plan_date >= ? AND plans.plan_date <= ?
           AND st.start_time IS NOT NULL AND st.end_time IS NOT NULL`,
      )
      .bind(...ids, dateFrom, dateTo)
      .all<{ person_id: number; date: string; start_time: string; end_time: string }>(),
  ]);

  for (const b of blockouts.results) facts.get(b.person_id)?.blockouts.push(b);
  for (const w of windows.results) facts.get(w.person_id)?.windows.push(w);
  for (const row of [...sessions.results, ...roster.results]) {
    const start = parseHM(row.start_time);
    const end = parseHM(row.end_time);
    if (start === null || end === null || end <= start) continue;
    facts.get(row.person_id)?.busy.push({ date: row.date, startMin: start, endMin: end });
  }
  return facts as unknown as Map<number, PersonFacts>;
}

export interface SessionCheck {
  statuses: Record<number, SlotStatus>;
  blocked: number[];
  busy: number[];
  unknown: number[];
}

/** Status of every called person for one session's date and time. */
export async function checkSession(db: AppDb, session: PlanningSession, personIds: readonly number[]): Promise<SessionCheck> {
  const start = parseHM(session.start_time);
  const end = parseHM(session.end_time);
  const facts = await loadPersonFacts(db, personIds, session.session_date, session.session_date, session.id);
  const statuses: Record<number, SlotStatus> = {};
  for (const id of personIds) {
    statuses[id] =
      start === null || end === null || end <= start
        ? 'unknown'
        : timeStatus(facts.get(id) ?? EMPTY_FACTS, session.session_date, start, end);
  }
  return { statuses, ...summarizeStatuses(statuses) };
}

// ── Notification rules ──

export interface NotificationRule {
  rule_key: RuleKey;
  enabled: boolean;
  lead_hours: number;
}

const RULE_DEFAULTS: Record<RuleKey, { enabled: boolean; lead_hours: number }> = {
  publish: { enabled: true, lead_hours: 24 },
  change: { enabled: true, lead_hours: 24 },
  cancel: { enabled: true, lead_hours: 24 },
  remind: { enabled: true, lead_hours: 24 },
};

/** Rules for one campus (the request-scoped db filters by campus; pass campusId for raw/cron reads). */
export async function listRules(db: AppDb, campusId?: number): Promise<NotificationRule[]> {
  const { results } = await db
    .prepare(
      campusId === undefined
        ? `SELECT rule_key, enabled, lead_hours FROM planning_notification_rules`
        : `SELECT rule_key, enabled, lead_hours FROM planning_notification_rules WHERE campus_id = ?`,
    )
    .bind(...(campusId === undefined ? [] : [campusId]))
    .all<{ rule_key: RuleKey; enabled: number; lead_hours: number }>();
  const stored = new Map(results.map((r) => [r.rule_key, r]));
  return RULE_KEYS.map((key) => {
    const row = stored.get(key);
    return row
      ? { rule_key: key, enabled: row.enabled === 1, lead_hours: row.lead_hours }
      : { rule_key: key, ...RULE_DEFAULTS[key] };
  });
}

export async function getRule(db: AppDb, key: RuleKey, campusId?: number): Promise<NotificationRule> {
  const rules = await listRules(db, campusId);
  return rules.find((r) => r.rule_key === key)!;
}

export async function setRule(db: AppDb, key: RuleKey, enabled: boolean, leadHours?: number): Promise<void> {
  if (!RULE_KEYS.includes(key)) return;
  const lead = Math.max(1, Math.min(336, Math.trunc(leadHours ?? RULE_DEFAULTS[key].lead_hours) || 24));
  await db
    .prepare(
      `INSERT INTO planning_notification_rules (rule_key, enabled, lead_hours) VALUES (?, ?, ?)
       ON CONFLICT (campus_id, rule_key) DO UPDATE SET enabled = excluded.enabled, lead_hours = excluded.lead_hours`,
    )
    .bind(key, enabled ? 1 : 0, lead)
    .run();
}

// ── Weekday helper re-exported for pages ──

export { parseWeekdays };

/** Active people for owner / coordinator / called-person pickers (bounded). */
export async function listPeopleLite(db: AppDb, limit = 400): Promise<PersonLite[]> {
  const { results } = await db
    .prepare(
      `SELECT id, display_name FROM people WHERE deleted_at IS NULL AND active = 1
       ORDER BY display_name, id LIMIT ${Math.min(limit, 500)}`,
    )
    .all<PersonLite>();
  return results;
}
