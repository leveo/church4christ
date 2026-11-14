// Service Planning workflows that combine data writes with checks and email:
// scheduling (publishing) a session re-checks every called person; rescheduling
// does the same and tells the people already notified; cancelling tells them too.
import type { AppDb } from './appDb';
import type { EmailEnv } from './email';
import {
  checkSession,
  getEvent,
  getSession,
  listSessionPeople,
  listSessions,
  setSessionStatus,
  updateSessionFields,
  type PlanningSession,
  type SessionInput,
} from './planningDb';
import { notifySession } from './planningNotify';
import { parseHM } from './planningModel';

export type ScheduleResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'event_cancelled' | 'bad_time' }
  | { ok: false; error: 'conflict'; blocked: number[]; busy: number[] }
  | { ok: false; error: 'unknown'; unknown: number[] };

function validTimes(session: Pick<PlanningSession, 'start_time' | 'end_time'>): boolean {
  const start = parseHM(session.start_time);
  const end = parseHM(session.end_time);
  return start !== null && end !== null && end > start;
}

/**
 * Re-check a session's called people and return the failure (blocked/busy always
 * rejects; unknown people reject unless acknowledged), or null when it may go ahead.
 */
async function gate(
  db: AppDb,
  session: PlanningSession,
  acknowledgeUnknown: boolean,
): Promise<ScheduleResult | null> {
  if (!validTimes(session)) return { ok: false, error: 'bad_time' };
  const people = await listSessionPeople(db, session.id);
  const check = await checkSession(db, session, people.map((p) => p.person_id));
  if (check.blocked.length > 0 || check.busy.length > 0) {
    return { ok: false, error: 'conflict', blocked: check.blocked, busy: check.busy };
  }
  if (check.unknown.length > 0 && !acknowledgeUnknown) {
    return { ok: false, error: 'unknown', unknown: check.unknown };
  }
  return null;
}

/** Move a session to `scheduled` (draft or cancelled before) and notify the called people. */
export async function scheduleSession(
  env: EmailEnv,
  db: AppDb,
  sessionId: number,
  acknowledgeUnknown: boolean,
): Promise<ScheduleResult> {
  const session = await getSession(db, sessionId);
  if (!session) return { ok: false, error: 'not_found' };
  const event = await getEvent(db, session.event_id);
  if (!event) return { ok: false, error: 'not_found' };
  if (event.status === 'cancelled') return { ok: false, error: 'event_cancelled' };
  if (session.status === 'scheduled') return { ok: true };
  const failure = await gate(db, session, acknowledgeUnknown);
  if (failure) return failure;
  const people = await listSessionPeople(db, sessionId);
  const check = await checkSession(db, session, people.map((p) => p.person_id));
  await setSessionStatus(db, session.event_id, sessionId, 'scheduled', check.unknown.length > 0 ? 1 : 0);
  if (session.status === 'cancelled') {
    // A rescheduled-after-cancel session starts fresh: everyone hears about it again.
    await db
      .prepare(`UPDATE planning_session_people SET notified_at = NULL, reminded_at = NULL WHERE session_id = ?`)
      .bind(sessionId)
      .run();
  }
  await notifySession(env, db, sessionId, 'publish');
  return { ok: true };
}

/**
 * Save edits to a session. A scheduled session whose date or time changes is
 * re-checked first (nothing is written when it fails); a date/time/location
 * change then notifies the people already told, and people added since get the
 * publish notice.
 */
export async function saveSession(
  env: EmailEnv,
  db: AppDb,
  sessionId: number,
  input: SessionInput,
  acknowledgeUnknown: boolean,
): Promise<ScheduleResult> {
  const before = await getSession(db, sessionId);
  if (!before) return { ok: false, error: 'not_found' };
  const slotChanged =
    before.session_date !== input.session_date ||
    before.start_time !== input.start_time ||
    before.end_time !== input.end_time;
  const placeChanged = before.location_en !== input.location_en || before.location_zh !== input.location_zh;
  if (before.status === 'scheduled' && slotChanged) {
    const failure = await gate(db, { ...before, ...input }, acknowledgeUnknown);
    if (failure) return failure;
  }
  await updateSessionFields(db, before.event_id, sessionId, input);
  if (before.status === 'scheduled') {
    if (slotChanged || placeChanged) {
      await db
        .prepare(`UPDATE planning_session_people SET reminded_at = NULL WHERE session_id = ?`)
        .bind(sessionId)
        .run();
      await notifySession(env, db, sessionId, 'change');
    }
    await notifySession(env, db, sessionId, 'publish');
  }
  return { ok: true };
}

/** Cancel a session; people who were notified are told. */
export async function cancelSession(env: EmailEnv, db: AppDb, sessionId: number): Promise<boolean> {
  const session = await getSession(db, sessionId);
  if (!session || session.status === 'cancelled') return false;
  await setSessionStatus(db, session.event_id, sessionId, 'cancelled', 0);
  if (session.status === 'scheduled') await notifySession(env, db, sessionId, 'cancel');
  return true;
}

/** Cancel every scheduled or draft session of an event (used when the event is cancelled). */
export async function cancelEventSessions(env: EmailEnv, db: AppDb, eventId: number): Promise<number> {
  let n = 0;
  for (const session of await listSessions(db, eventId)) {
    if (session.status !== 'cancelled' && (await cancelSession(env, db, session.id))) n++;
  }
  return n;
}

/** After adding people to an already scheduled session, send them the publish notice. */
export async function noticeAddedPeople(env: EmailEnv, db: AppDb, sessionId: number): Promise<void> {
  const session = await getSession(db, sessionId);
  if (session?.status === 'scheduled') await notifySession(env, db, sessionId, 'publish');
}
