// Planning in calendars: a member's sessions and run-sheet duties in the month
// marks and the ICS events, the team availability calendar, and what is NOT
// exported (cue notes, details, availability notes, other people's sessions).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCalendarMarks } from '../src/lib/calendar';
import { buildICal } from '../src/lib/ical';
import {
  buildTeamCalendar,
  dutyLabel,
  dutyToICalEvent,
  listDutiesForPerson,
  listEventTeam,
  listSessionsForPerson,
  sessionLabel,
  sessionToICalEvent,
} from '../src/lib/planningCalendar';
import { addAvailability, addCoordinator, addItem, addSessionPeople, createEvent, createSession, setEventStatus } from '../src/lib/planningDb';
import { monthDates } from '../src/lib/planningModel';

const db = env.DB;
let eventId = 0;

beforeAll(async () => {
  await db.batch([
    db.prepare(`INSERT INTO people (id, display_name, email, active) VALUES
      (401, 'Gil Example', 'gil@example.com', 1), (402, 'Hal Example', 'hal@example.com', 1), (403, 'Ivy Example', 'ivy@example.com', 1)`),
    db.prepare(`INSERT INTO teams (id) VALUES (850)`),
    db.prepare(`INSERT INTO team_members (team_id, person_id) VALUES (850, 402)`),
  ]);
  eventId = await createEvent(db, {
    title_en: 'Spring Concert', title_zh: '春季音乐会', event_date: '2030-04-20', start_time: '18:00', end_time: null,
    location_en: 'Hall', location_zh: '礼堂', notes_en: '', notes_zh: '', plan_id: null,
  }, null);
  const sid = await createSession(db, eventId, {
    title_en: 'Soundcheck', title_zh: '音响测试', session_date: '2030-04-18', start_time: '19:00', end_time: '20:00',
    location_en: 'Hall', location_zh: '', note_en: 'PRIVATE-SESSION-NOTE', note_zh: '', 
  });
  await addSessionPeople(db, sid, [401]);
  await db.prepare(`UPDATE planning_sessions SET status = 'scheduled' WHERE id = ?`).bind(sid).run();
  const draft = await createSession(db, eventId, {
    title_en: 'Draft prep', title_zh: '', session_date: '2030-04-19', start_time: '19:00', end_time: '20:00',
    location_en: '', location_zh: '', note_en: '', note_zh: '',
  });
  await addSessionPeople(db, draft, [401]);
  let rev = 1;
  for (const [title, owner] of [['Opening', { owner_person_id: 401 }], ['Team song', { owner_team_id: 850 }], ['Heading', { owner_person_id: 401, kind: 'heading' as const }]] as const) {
    const r = await addItem(db, eventId, rev, {
      kind: 'segment', duration_min: 10, fixed_start_time: null, title_en: title, title_zh: '', details_en: 'PRIVATE-DETAILS', details_zh: '',
      owner_team_id: null, owner_person_id: null, owner_label: null, cue_notes: 'PRIVATE-CUE', ...owner,
    });
    if (r.ok) rev = r.revision;
  }
  await addCoordinator(db, eventId, 403);
  await addAvailability(db, 401, { starts_on: '2030-04-01', ends_on: '2030-04-30', weekdays: [4], start_minute: 1080, end_minute: 1260, note: 'PRIVATE-WINDOW-NOTE' });
  await db.prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date) VALUES (401, '2030-04-11', '2030-04-11')`).run();
});

describe('member sessions and duties', () => {
  it('lists only scheduled sessions the person is called to', async () => {
    const sessions = await listSessionsForPerson(db, 401, '2030-04-01', '2030-04-30');
    expect(sessions.map((s) => s.title_en)).toEqual(['Soundcheck']);
    expect(await listSessionsForPerson(db, 402, '2030-04-01', '2030-04-30')).toEqual([]);
  });

  it('shows duties only once the event is published, for the owner and the owner team', async () => {
    expect(await listDutiesForPerson(db, 401, '2030-04-01', '2030-04-30')).toEqual([]);
    await setEventStatus(db, eventId, 4, 'published');
    const mine = await listDutiesForPerson(db, 401, '2030-04-01', '2030-04-30');
    expect(mine.map((d) => [d.title_en, d.start])).toEqual([['Opening', '18:00']]); // headings are not duties
    const team = await listDutiesForPerson(db, 402, '2030-04-01', '2030-04-30');
    expect(team.map((d) => [d.title_en, d.start, d.end])).toEqual([['Team song', '18:10', '18:20']]);
    expect(await listDutiesForPerson(db, 403, '2030-04-01', '2030-04-30')).toEqual([]);
  });

  it('adds planning marks to the month grid without changing the other marks', async () => {
    const sessions = await listSessionsForPerson(db, 401, '2030-04-01', '2030-04-30');
    const duties = await listDutiesForPerson(db, 401, '2030-04-01', '2030-04-30');
    const planning = [
      ...sessions.map((s) => ({ date: s.date, title: sessionLabel(s, 'en') })),
      ...duties.map((d) => ({ date: d.date, title: dutyLabel(d, 'en') })),
    ];
    const marks = buildCalendarMarks([], [], '2030-04', { planning });
    expect(marks.get('2030-04-18')?.planning).toEqual(['Soundcheck · 19:00 · Hall']);
    expect(marks.get('2030-04-20')?.planning).toEqual(['Opening · 18:00 · Spring Concert']);
    expect(buildCalendarMarks([], [], '2030-05', { planning }).size).toBe(0);
    expect(buildCalendarMarks([], [], '2030-04').get('2030-04-18')).toBeUndefined();
  });

  it('exports sessions and duties to ICS and leaves every private note out', async () => {
    const sessions = await listSessionsForPerson(db, 401, '2030-04-01', '2030-04-30');
    const duties = await listDutiesForPerson(db, 401, '2030-04-01', '2030-04-30');
    const ics = buildICal('Feed', [...sessions.map((s) => sessionToICalEvent(s, 'church.example')), ...duties.map((d) => dutyToICalEvent(d, 'church.example'))], '20300401T000000Z');
    expect(ics).toContain('SUMMARY:Soundcheck — Spring Concert');
    expect(ics).toContain('DTSTART:20300418T190000');
    expect(ics).toContain('DTEND:20300418T200000');
    expect(ics).toContain('SUMMARY:Opening — Spring Concert');
    expect(ics).toContain('UID:c4c-planning-session-');
    expect(ics).toContain('UID:c4c-planning-duty-');
    for (const secret of ['PRIVATE-CUE', 'PRIVATE-DETAILS', 'PRIVATE-SESSION-NOTE', 'PRIVATE-WINDOW-NOTE']) expect(ics).not.toContain(secret);
  });
});

describe('team availability calendar', () => {
  it('collects coordinators, called people, item owners, and owner-team members', async () => {
    const team = await listEventTeam(db, eventId);
    expect(team.map((p) => p.id)).toEqual([401, 402, 403]);
  });

  it('summarises blockouts and windows per person and day, never exposing the note', async () => {
    const team = await listEventTeam(db, eventId);
    const days = await buildTeamCalendar(db, team, monthDates('2030-04'));
    const thursday = days.find((d) => d.date === '2030-04-11')!; // blocked and a Thursday window
    const gil = thursday.people.find((p) => p.person.id === 401)!.availability;
    expect(gil.blocked).toEqual([{ allDay: true, start: null, end: null }]);
    expect(gil.available).toEqual([{ start: '18:00', end: '21:00' }]);
    const friday = days.find((d) => d.date === '2030-04-12')!.people.find((p) => p.person.id === 401)!.availability;
    expect(friday.available).toEqual([]);
    const soundcheck = days.find((d) => d.date === '2030-04-18')!.people.find((p) => p.person.id === 401)!.availability;
    expect(soundcheck.busy).toEqual([{ start: '19:00', end: '20:00' }]);
    expect(JSON.stringify(days)).not.toContain('PRIVATE-WINDOW-NOTE');
  });
});
