// Service Planning email: publish, change (reschedule), cancel, and the daily
// reminder pass. Every send is gated by planning_notification_rules and is
// best-effort per recipient. notified_at / reminded_at on planning_session_people
// make each notice idempotent: a person is told once per state, never twice.
import type { AppDb } from './appDb';
import { getBackend, type DbEnv } from './dbProvider';
import { sendEmail, type EmailEnv } from './email';
import { getEffectiveCampusModules } from './campusDb';
import { todayInTz, addDays } from './dates';
import { getEnabledModules } from './modules';
import { bilingualEmail } from './notify';
import { pickPair } from './locales';
import { emailLanguagesFor } from './emailLocales';
import { getEvent, getRule, getSession, listSessionPeople, type PlanningEvent, type PlanningSession, type RuleKey } from './planningDb';
import { parseHM } from './planningModel';
import type { Locale } from './locales';

const TZ = 'America/Chicago';

export type PlanningNoticeKind = RuleKey;

const KIND_LOG: Record<PlanningNoticeKind, string> = {
  publish: 'planningPublish',
  change: 'planningChange',
  cancel: 'planningCancel',
  remind: 'planningRemind',
};


function both(en: string, zh: string, only: Locale | null): string {
  if (only) return pickPair(only, en, zh);
  return en && zh && en !== zh ? `${en} / ${zh}` : en || zh;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Send one kind of notice for a session to the people who should get it:
 * publish -> not yet notified; change/cancel -> already notified;
 * remind -> not yet reminded. Returns how many mails were accepted.
 */
export async function notifySession(
  env: EmailEnv,
  db: AppDb,
  sessionId: number,
  kind: PlanningNoticeKind,
): Promise<number> {
  try {
    const session = await getSession(db, sessionId);
    if (!session) return 0;
    const event = await getEvent(db, session.event_id);
    if (!event) return 0;
    const rule = await getRule(db, kind, session.campus_id);
    if (!rule.enabled) return 0;
    const people = (await listSessionPeople(db, sessionId)).filter((p) => {
      if (!p.email) return false;
      if (kind === 'publish') return p.notified_at === null;
      if (kind === 'remind') return p.reminded_at === null;
      return p.notified_at !== null;
    });
    let sent = 0;
    for (const person of people) {
      try {
        if (await sendOne(env, db, session, event, person, kind)) sent++;
      } catch (e) {
        console.error(`planning ${kind} notice failed for person ${person.person_id}`, e);
      }
    }
    return sent;
  } catch (e) {
    console.error(`planning ${kind} notice failed for session ${sessionId}`, e);
    return 0;
  }
}

async function sendOne(
  env: EmailEnv,
  db: AppDb,
  session: PlanningSession,
  event: PlanningEvent,
  person: { person_id: number; display_name: string; email: string | null; lang: string | null; call_time: string | null },
  kind: PlanningNoticeKind,
): Promise<boolean> {
  const langs = await emailLanguagesFor(db, person.lang);
  const only: Locale | null = langs.length === 1 ? langs[0] : null;
  const call = person.call_time && parseHM(person.call_time) !== null ? person.call_time : session.start_time;
  const built = bilingualEmail({
    subjectKey: `planning.email.${kind}Subject`,
    bodyKey: `planning.email.${kind}Body`,
    vars: {
      name: person.display_name,
      title: both(session.title_en, session.title_zh, only),
      event: both(event.title_en, event.title_zh, only),
      date: session.session_date,
      time: `${session.start_time}-${session.end_time}`,
      call,
      location: both(session.location_en, session.location_zh, only) || '-',
    },
    link: `${env.APP_ORIGIN ?? ''}/${only ?? 'en'}/planning/${event.id}`,
    only,
    langs,
  });
  const ok = await sendEmail(env, db, {
    to: person.email!,
    toName: person.display_name,
    kind: KIND_LOG[kind],
    detail: `${session.session_date} ${session.start_time} #${session.id}`,
    ...built,
  });
  if (!ok) return false;
  if (kind === 'remind') {
    await db
      .prepare(`UPDATE planning_session_people SET reminded_at = ? WHERE session_id = ? AND person_id = ?`)
      .bind(stamp(), session.id, person.person_id)
      .run();
  } else if (kind === 'publish' || kind === 'change') {
    // A change makes any earlier reminder stale, so the person is reminded again.
    await db
      .prepare(
        `UPDATE planning_session_people SET notified_at = ?, reminded_at = NULL
         WHERE session_id = ? AND person_id = ?`,
      )
      .bind(stamp(), session.id, person.person_id)
      .run();
  }
  return true;
}

/** Hours from `now` until the session starts, both read as church-local wall clock. */
export function hoursUntilSession(session: Pick<PlanningSession, 'session_date' | 'start_time'>, now: Date): number | null {
  const start = parseHM(session.start_time);
  if (start === null) return null;
  const [y, m, d] = session.session_date.split('-').map(Number);
  const sessionMs = Date.UTC(y, m - 1, d, Math.floor(start / 60), start % 60);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const nowMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return (sessionMs - nowMs) / 3_600_000;
}

/**
 * Daily reminder pass (called from the existing reminder cron): remind called
 * people of scheduled sessions that start within the rule's lead time. Skipped
 * entirely when the planning module is off.
 */
export async function sendPlanningReminders(env: EmailEnv, db: AppDb, now: Date = new Date()): Promise<number> {
  const globalModules = await getEnabledModules(db, getBackend(env as unknown as DbEnv));
  if (!globalModules.has('planning')) return 0;
  const today = todayInTz(TZ, now);
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.session_date AS session_date, s.start_time AS start_time, s.campus_id AS campus_id
       FROM planning_sessions s
       JOIN planning_events e ON e.id = s.event_id AND e.status <> 'cancelled'
       WHERE s.status = 'scheduled' AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY s.session_date, s.start_time, s.id`,
    )
    .bind(today, addDays(today, 15))
    .all<{ id: number; session_date: string; start_time: string; campus_id: number }>();
  const campusModules = new Map<number, Set<string>>();
  let sent = 0;
  for (const row of results) {
    let modules = campusModules.get(row.campus_id);
    if (!modules) {
      modules = await getEffectiveCampusModules(db, row.campus_id, globalModules);
      campusModules.set(row.campus_id, modules);
    }
    if (!modules.has('planning')) continue;
    const rule = await getRule(db, 'remind', row.campus_id);
    if (!rule.enabled) continue;
    const hours = hoursUntilSession(row, now);
    if (hours === null || hours < 0 || hours > rule.lead_hours) continue;
    sent += await notifySession(env, db, row.id, 'remind');
  }
  return sent;
}
