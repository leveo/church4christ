// Service Planning in calendars: a member's rehearsal sessions and run-sheet
// duties (for /my/calendar and the ICS feed), and the data behind the team
// availability calendar on the coordinator page. Private notes (an availability
// window's note) and leader-only cue notes are never selected here.
import type { AppDb } from './appDb';
import type { Locale } from './db';
import type { ICalEvent } from './ical';
import {
  getEvent,
  listItems,
  loadPersonFacts,
  listPeopleByIds,
  type PersonLite,
  type PlanningItem,
} from './planningDb';
import { computeRunSheet, dayAvailability, type DayAvailability, EMPTY_FACTS } from './planningModel';
import { pickLocalizedText } from './locales';

export interface MemberSession {
  session_id: number;
  event_id: number;
  date: string;
  start_time: string;
  end_time: string;
  call_time: string | null;
  title_en: string;
  title_zh: string;
  location_en: string;
  location_zh: string;
  event_title_en: string;
  event_title_zh: string;
}

/** Scheduled sessions a person is called to in a date range, soonest first. */
export async function listSessionsForPerson(
  db: AppDb,
  personId: number,
  from: string,
  to: string,
): Promise<MemberSession[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id AS session_id, s.event_id AS event_id, s.session_date AS date, s.start_time AS start_time,
              s.end_time AS end_time, sp.call_time AS call_time, s.title_en AS title_en, s.title_zh AS title_zh,
              s.location_en AS location_en, s.location_zh AS location_zh,
              e.title_en AS event_title_en, e.title_zh AS event_title_zh
       FROM planning_session_people sp
       JOIN planning_sessions s ON s.id = sp.session_id AND s.status = 'scheduled'
       JOIN planning_events e ON e.id = s.event_id AND e.status <> 'cancelled'
       WHERE sp.person_id = ? AND s.session_date >= ? AND s.session_date <= ?
       ORDER BY s.session_date, s.start_time, s.id`,
    )
    .bind(personId, from, to)
    .all<MemberSession>();
  return results;
}

export interface MemberDuty {
  event_id: number;
  item_id: number;
  date: string;
  start: string;
  end: string;
  title_en: string;
  title_zh: string;
  event_title_en: string;
  event_title_zh: string;
}

/** Run-sheet items the person owns directly or through one of their teams, in published events. */
export async function listDutiesForPerson(
  db: AppDb,
  personId: number,
  from: string,
  to: string,
): Promise<MemberDuty[]> {
  const { results: events } = await db
    .prepare(
      `SELECT DISTINCT e.id AS id FROM planning_events e
       JOIN planning_items i ON i.event_id = e.id
       WHERE e.status = 'published' AND e.event_date >= ? AND e.event_date <= ?
         AND (i.owner_person_id = ?
           OR i.owner_team_id IN (SELECT tmm.team_id FROM team_members tmm WHERE tmm.person_id = ?))
       ORDER BY e.id LIMIT 60`,
    )
    .bind(from, to, personId, personId)
    .all<{ id: number }>();
  const duties: MemberDuty[] = [];
  for (const { id } of events) {
    const event = await getEvent(db, id);
    if (!event) continue;
    const items = await listItems(db, id);
    const timing = computeRunSheet(event, items);
    const teamIds = new Set(await teamIdsOfPerson(db, personId));
    items.forEach((item: PlanningItem, index) => {
      const mine = item.owner_person_id === personId || (item.owner_team_id !== null && teamIds.has(item.owner_team_id));
      if (!mine || item.kind === 'heading' || item.kind === 'note') return;
      duties.push({
        event_id: id,
        item_id: item.id,
        date: event.event_date,
        start: timing.rows[index].start,
        end: timing.rows[index].end,
        title_en: item.title_en,
        title_zh: item.title_zh,
        event_title_en: event.title_en,
        event_title_zh: event.title_zh,
      });
    });
  }
  return duties.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

async function teamIdsOfPerson(db: AppDb, personId: number): Promise<number[]> {
  const { results } = await db
    .prepare(`SELECT team_id FROM team_members WHERE person_id = ?`)
    .bind(personId)
    .all<{ team_id: number }>();
  return results.map((r) => r.team_id);
}

const label = (en: string, zh: string, locale: Locale) => pickLocalizedText({ en, zh }, locale);

/** Calendar mark label for a session (month grid and agenda). */
export function sessionLabel(s: MemberSession, locale: Locale): string {
  const title = label(s.title_en, s.title_zh, locale) || label(s.event_title_en, s.event_title_zh, locale);
  return [title, s.call_time ?? s.start_time, label(s.location_en, s.location_zh, locale)].filter(Boolean).join(' · ');
}

export function dutyLabel(d: MemberDuty, locale: Locale): string {
  return [label(d.title_en, d.title_zh, locale), d.start, label(d.event_title_en, d.event_title_zh, locale)]
    .filter(Boolean)
    .join(' · ');
}

/** ICS event for a rehearsal: summary and location only; notes are never exported. */
export function sessionToICalEvent(s: MemberSession, host: string): ICalEvent {
  return {
    uid: `c4c-planning-session-${s.session_id}@${host}`,
    date: s.date,
    summary: [label(s.title_en, s.title_zh, 'en') || 'Rehearsal', label(s.event_title_en, s.event_title_zh, 'en')]
      .filter(Boolean)
      .join(' — '),
    description: label(s.location_en, s.location_zh, 'en') || undefined,
    startTime: s.start_time,
    endTime: s.end_time,
  };
}

/** ICS event for a run-sheet duty: title and event only; cue notes and details are never exported. */
export function dutyToICalEvent(d: MemberDuty, host: string): ICalEvent {
  return {
    uid: `c4c-planning-duty-${d.event_id}-${d.item_id}@${host}`,
    date: d.date,
    summary: [label(d.title_en, d.title_zh, 'en'), label(d.event_title_en, d.event_title_zh, 'en')]
      .filter(Boolean)
      .join(' — '),
    startTime: d.start,
    endTime: d.end,
  };
}

// ── Team availability calendar ──

/** Everyone connected to an event: coordinators, called people, item owners, and owner-team members. */
export async function listEventTeam(db: AppDb, eventId: number): Promise<PersonLite[]> {
  const [coordinators, called, owners, teamMembers] = await Promise.all([
    db.prepare(`SELECT person_id FROM planning_event_coordinators WHERE event_id = ?`).bind(eventId).all<{ person_id: number }>(),
    db
      .prepare(
        `SELECT sp.person_id AS person_id FROM planning_session_people sp
         JOIN planning_sessions s ON s.id = sp.session_id WHERE s.event_id = ?`,
      )
      .bind(eventId)
      .all<{ person_id: number }>(),
    db
      .prepare(`SELECT owner_person_id AS person_id FROM planning_items WHERE event_id = ? AND owner_person_id IS NOT NULL`)
      .bind(eventId)
      .all<{ person_id: number }>(),
    db
      .prepare(
        `SELECT tmm.person_id AS person_id FROM team_members tmm
         JOIN planning_items i ON i.owner_team_id = tmm.team_id WHERE i.event_id = ?`,
      )
      .bind(eventId)
      .all<{ person_id: number }>(),
  ]);
  const ids = [...coordinators.results, ...called.results, ...owners.results, ...teamMembers.results].map(
    (r) => r.person_id,
  );
  const people = await listPeopleByIds(db, ids);
  return people.slice(0, 120);
}

export interface TeamCalendarDay {
  date: string;
  people: { person: PersonLite; availability: DayAvailability }[];
}

/** Per-day availability for the chosen people across a date list (week or month). */
export async function buildTeamCalendar(
  db: AppDb,
  people: readonly PersonLite[],
  dates: readonly string[],
): Promise<TeamCalendarDay[]> {
  if (dates.length === 0) return [];
  const facts = await loadPersonFacts(
    db,
    people.map((p) => p.id),
    dates[0],
    dates[dates.length - 1],
  );
  return dates.map((date) => ({
    date,
    people: people.map((person) => ({
      person,
      availability: dayAvailability(facts.get(person.id) ?? EMPTY_FACTS, date),
    })),
  }));
}
