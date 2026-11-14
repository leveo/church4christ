// Service Planning data layer on D1: events with the optimistic lock, the run
// sheet (add / edit / delete / move / copy), sessions and called people,
// availability windows, facts for the status function, and the scheduling
// re-check. Fictional people only.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addAvailability,
  addCoordinator,
  addItem,
  addSessionPeople,
  checkSession,
  copyRunSheet,
  createEvent,
  createSession,
  deleteAvailability,
  deleteItem,
  getEvent,
  getLinkedPlan,
  getRule,
  isCoordinator,
  listAvailability,
  listItems,
  listRules,
  listSessionPeople,
  listTeamMemberIds,
  loadPersonFacts,
  moveItem,
  removeCoordinator,
  setEventStatus,
  setRule,
  updateEvent,
  updateItem,
  type EventInput,
  type ItemInput,
} from '../src/lib/planningDb';
import { cancelSession, saveSession, scheduleSession } from '../src/lib/planningService';

const db = env.DB;
const MAIL = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };

const eventInput = (over: Partial<EventInput> = {}): EventInput => ({
  title_en: 'Christmas Service',
  title_zh: '',
  event_date: '2030-12-22',
  start_time: '10:00',
  end_time: '11:30',
  location_en: '',
  location_zh: '',
  notes_en: '',
  notes_zh: '',
  plan_id: null,
  ...over,
});

const itemInput = (title: string, over: Partial<ItemInput> = {}): ItemInput => ({
  kind: 'segment',
  duration_min: 5,
  fixed_start_time: null,
  title_en: title,
  title_zh: '',
  details_en: '',
  details_zh: '',
  owner_team_id: null,
  owner_person_id: null,
  owner_label: null,
  cue_notes: '',
  ...over,
});

beforeAll(async () => {
  await db.batch([
    db.prepare(`INSERT INTO people (id, display_name, email, lang, active) VALUES
      (101, 'Ann Example', 'ann@example.com', 'en', 1),
      (102, 'Bo Example', 'bo@example.com', 'zh', 1),
      (103, 'Cy Example', 'cy@example.com', NULL, 1),
      (104, 'Inactive Person', 'off@example.com', NULL, 0)`),
    db.prepare(`INSERT INTO teams (id) VALUES (901)`),
    db.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (901, 'en', 'Test Team')`),
    db.prepare(`INSERT INTO team_members (team_id, person_id) VALUES (901, 101), (901, 102), (901, 104)`),
  ]);
});

describe('events and the optimistic lock', () => {
  it('creates a draft at revision 1 and updates with a matching revision', async () => {
    const id = await createEvent(db, eventInput(), null);
    const event = await getEvent(db, id);
    expect(event).toMatchObject({ status: 'draft', revision: 1, title_en: 'Christmas Service' });
    const result = await updateEvent(db, id, 1, eventInput({ title_en: 'Renamed' }));
    expect(result).toEqual({ ok: true, revision: 2 });
    expect((await getEvent(db, id))?.title_en).toBe('Renamed');
  });

  it('rejects a stale revision without writing and reports a missing event', async () => {
    const id = await createEvent(db, eventInput(), null);
    await updateEvent(db, id, 1, eventInput({ title_en: 'First writer' }));
    const stale = await updateEvent(db, id, 1, eventInput({ title_en: 'Second writer' }));
    expect(stale).toEqual({ ok: false, reason: 'conflict' });
    expect((await getEvent(db, id))?.title_en).toBe('First writer');
    expect(await updateEvent(db, 999999, 1, eventInput())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('bumps the revision on status changes and run-sheet writes too', async () => {
    const id = await createEvent(db, eventInput(), null);
    expect(await setEventStatus(db, id, 1, 'published')).toEqual({ ok: true, revision: 2 });
    expect(await addItem(db, id, 1, itemInput('Stale add'))).toEqual({ ok: false, reason: 'conflict' });
    expect(await listItems(db, id)).toHaveLength(0);
    expect(await addItem(db, id, 2, itemInput('Fresh add'))).toEqual({ ok: true, revision: 3 });
  });

  it('treats a soft-deleted linked plan as unlinked', async () => {
    await db.prepare(`INSERT INTO service_types (id) VALUES (950)`).run();
    await db.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (951, 950, '2030-12-22')`).run();
    const id = await createEvent(db, eventInput({ plan_id: 951 }), null);
    expect(await getLinkedPlan(db, (await getEvent(db, id))!.plan_id)).toMatchObject({ id: 951 });
    await db.prepare(`UPDATE plans SET deleted_at = datetime('now') WHERE id = 951`).run();
    expect(await getLinkedPlan(db, (await getEvent(db, id))!.plan_id)).toBeNull();
  });
});

describe('coordinators', () => {
  it('adds, dedupes, and removes event coordinators', async () => {
    const id = await createEvent(db, eventInput(), null);
    await addCoordinator(db, id, 101);
    await addCoordinator(db, id, 101);
    await addCoordinator(db, id, 104); // inactive people cannot be added
    expect(await isCoordinator(db, id, 101)).toBe(true);
    expect(await isCoordinator(db, id, 104)).toBe(false);
    await removeCoordinator(db, id, 101);
    expect(await isCoordinator(db, id, 101)).toBe(false);
  });
});

describe('run sheet', () => {
  it('adds in order, edits, moves, and deletes items', async () => {
    const id = await createEvent(db, eventInput(), null);
    let rev = 1;
    for (const title of ['A', 'B', 'C']) {
      const r = await addItem(db, id, rev, itemInput(title));
      if (r.ok) rev = r.revision;
    }
    expect((await listItems(db, id)).map((i) => i.title_en)).toEqual(['A', 'B', 'C']);

    const [a, b, c] = await listItems(db, id);
    let r = await moveItem(db, id, c.id, rev, 'up');
    if (r.ok) rev = r.revision;
    expect((await listItems(db, id)).map((i) => i.title_en)).toEqual(['A', 'C', 'B']);
    r = await moveItem(db, id, a.id, rev, 'up'); // already first: a no-op that still bumps
    if (r.ok) rev = r.revision;
    expect((await listItems(db, id)).map((i) => i.title_en)).toEqual(['A', 'C', 'B']);

    r = await updateItem(db, id, b.id, rev, itemInput('B2', { duration_min: 99999, fixed_start_time: 'bad', kind: 'song' }));
    if (r.ok) rev = r.revision;
    const edited = (await listItems(db, id)).find((i) => i.id === b.id)!;
    expect(edited).toMatchObject({ title_en: 'B2', kind: 'song', duration_min: 720, fixed_start_time: null });

    r = await deleteItem(db, id, a.id, rev);
    expect(r.ok).toBe(true);
    expect((await listItems(db, id)).map((i) => i.title_en)).toEqual(['C', 'B2']);
  });

  it('only writes items that belong to the event, and drops owners that do not exist', async () => {
    const one = await createEvent(db, eventInput(), null);
    const two = await createEvent(db, eventInput(), null);
    await addItem(db, one, 1, itemInput('Owned by one', { owner_person_id: 999999, owner_team_id: 888888 }));
    const [item] = await listItems(db, one);
    expect(item).toMatchObject({ owner_person_id: null, owner_team_id: null });
    await deleteItem(db, two, item.id, 1);
    expect(await listItems(db, one)).toHaveLength(1);
  });

  it('copies another event run sheet to the end of this one', async () => {
    const source = await createEvent(db, eventInput({ title_en: 'Last year' }), null);
    let rev = 1;
    for (const title of ['One', 'Two']) {
      const r = await addItem(db, source, rev, itemInput(title, { cue_notes: 'cue', owner_team_id: 901 }));
      if (r.ok) rev = r.revision;
    }
    const target = await createEvent(db, eventInput(), null);
    await addItem(db, target, 1, itemInput('Existing'));
    const result = await copyRunSheet(db, target, source, 2);
    expect(result).toMatchObject({ ok: true, copied: 2 });
    const items = await listItems(db, target);
    expect(items.map((i) => i.title_en)).toEqual(['Existing', 'One', 'Two']);
    expect(items[1]).toMatchObject({ cue_notes: 'cue', owner_team_id: 901 });
    expect(await copyRunSheet(db, target, target, 3)).toMatchObject({ ok: false });
    expect(await copyRunSheet(db, target, 999999, 3)).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('availability windows', () => {
  it('adds and lists windows for the owner and only deletes the owner row', async () => {
    const input = { starts_on: '2030-06-01', ends_on: '2030-06-30', weekdays: [4, 5], start_minute: 1080, end_minute: 1260, note: 'private' };
    expect(await addAvailability(db, 101, input)).toEqual({ ok: true });
    const [row] = await listAvailability(db, 101, '2030-01-01');
    expect(row).toMatchObject({ person_id: 101, weekdays: '4,5', note: 'private' });
    await deleteAvailability(db, 102, row.id); // another person cannot delete it
    expect(await listAvailability(db, 101, '2030-01-01')).toHaveLength(1);
    await deleteAvailability(db, 101, row.id);
    expect(await listAvailability(db, 101, '2030-01-01')).toHaveLength(0);
  });

  it('caps the number of windows per person', async () => {
    const input = { starts_on: '2030-06-01', ends_on: '2030-06-01', weekdays: [], start_minute: 600, end_minute: 660, note: '' };
    for (let i = 0; i < 200; i++) await addAvailability(db, 103, input);
    expect(await addAvailability(db, 103, input)).toEqual({ ok: false, reason: 'limit' });
  });
});

describe('sessions, facts, and the publish re-check', () => {
  async function newSession(over: Partial<{ date: string; start: string; end: string }> = {}) {
    const eventId = await createEvent(db, eventInput(), null);
    const sessionId = await createSession(db, eventId, {
      title_en: 'Rehearsal',
      title_zh: '',
      session_date: over.date ?? '2030-12-10',
      start_time: over.start ?? '19:00',
      end_time: over.end ?? '20:00',
      location_en: 'Room',
      location_zh: '',
      note_en: '',
      note_zh: '',
    });
    return { eventId, sessionId };
  }

  it('adds whole teams, skips inactive people, and keeps existing rows when re-adding', async () => {
    const { sessionId } = await newSession();
    const members = await listTeamMemberIds(db, 901);
    expect(members.sort()).toEqual([101, 102]);
    expect(await addSessionPeople(db, sessionId, members)).toBe(2);
    await db.prepare(`UPDATE planning_session_people SET call_time = '18:30' WHERE session_id = ? AND person_id = 101`).bind(sessionId).run();
    await addSessionPeople(db, sessionId, [101, 103, 104, 999999]);
    const people = await listSessionPeople(db, sessionId);
    expect(people.map((p) => p.person_id).sort()).toEqual([101, 102, 103]);
    expect(people.find((p) => p.person_id === 101)?.call_time).toBe('18:30');
  });

  it('loads blockouts, windows, scheduled sessions, and timed roster assignments as facts', async () => {
    const { sessionId } = await newSession();
    await addSessionPeople(db, sessionId, [101]);
    await db.prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date) VALUES (101, '2030-12-09', '2030-12-09')`).run();
    await addAvailability(db, 101, { starts_on: '2030-12-10', ends_on: '2030-12-10', weekdays: [], start_minute: 900, end_minute: 1200, note: '' });
    // Another scheduled session the person is called to on the same date.
    const other = await newSession({ start: '17:00', end: '18:00' });
    await addSessionPeople(db, other.sessionId, [101]);
    await db.prepare(`UPDATE planning_sessions SET status = 'scheduled' WHERE id = ?`).bind(other.sessionId).run();
    // A roster assignment on a service type with times, and one without times.
    await db.prepare(`INSERT INTO service_types (id, start_time, end_time) VALUES (960, '09:30', '10:45'), (961, NULL, NULL)`).run();
    await db.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (962, 960, '2030-12-10'), (963, 961, '2030-12-10')`).run();
    await db.prepare(`INSERT INTO teams (id) VALUES (964)`).run();
    await db.prepare(`INSERT INTO positions (id, team_id) VALUES (965, 964)`).run();
    await db.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (962, 965, 101, 'C'), (963, 965, 101, 'C')`).run();

    const facts = (await loadPersonFacts(db, [101], '2030-12-09', '2030-12-10', sessionId)).get(101)!;
    expect(facts.blockouts).toHaveLength(1);
    expect(facts.windows).toHaveLength(1);
    expect(facts.busy.map((b) => [b.startMin, b.endMin]).sort((a, b) => a[0] - b[0])).toEqual([[570, 645], [1020, 1080]]);
    // The session being checked is excluded from its own busy list.
    const own = (await loadPersonFacts(db, [101], '2030-12-10', '2030-12-10', other.sessionId)).get(101)!;
    expect(own.busy.map((b) => b.startMin)).toEqual([570]);
  });

  it('rejects scheduling when a called person is blocked or busy, and does not notify', async () => {
    const { sessionId } = await newSession({ date: '2030-12-11' });
    await addSessionPeople(db, sessionId, [101, 102]);
    await db.prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date) VALUES (101, '2030-12-11', '2030-12-11')`).run();
    await addAvailability(db, 102, { starts_on: '2030-12-11', ends_on: '2030-12-11', weekdays: [], start_minute: 1000, end_minute: 1300, note: '' });
    const result = await scheduleSession(MAIL, db, sessionId, true);
    expect(result).toMatchObject({ ok: false, error: 'conflict', blocked: [101], busy: [] });
    const row = await db.prepare(`SELECT status FROM planning_sessions WHERE id = ?`).bind(sessionId).first<{ status: string }>();
    expect(row?.status).toBe('draft');
    const mail = await db.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE kind = 'planningPublish'`).first<{ n: number }>();
    expect(mail?.n).toBe(0);
  });

  it('rejects busy people (a clashing scheduled session) even when unknowns are acknowledged', async () => {
    const a = await newSession({ date: '2030-12-12' });
    await addSessionPeople(db, a.sessionId, [101]);
    await db.prepare(`UPDATE planning_sessions SET status = 'scheduled' WHERE id = ?`).bind(a.sessionId).run();
    const b = await newSession({ date: '2030-12-12', start: '19:30', end: '20:30' });
    await addSessionPeople(db, b.sessionId, [101]);
    expect(await scheduleSession(MAIL, db, b.sessionId, true)).toMatchObject({ ok: false, error: 'conflict', busy: [101] });
  });

  it('requires acknowledging unknown availability, then schedules', async () => {
    const { sessionId } = await newSession({ date: '2030-12-13' });
    await addSessionPeople(db, sessionId, [101, 102]);
    await addAvailability(db, 101, { starts_on: '2030-12-13', ends_on: '2030-12-13', weekdays: [], start_minute: 1000, end_minute: 1300, note: '' });
    expect(await scheduleSession(MAIL, db, sessionId, false)).toMatchObject({ ok: false, error: 'unknown', unknown: [102] });
    expect(await scheduleSession(MAIL, db, sessionId, true)).toEqual({ ok: true });
    const row = await db.prepare(`SELECT status, acknowledged_unknown FROM planning_sessions WHERE id = ?`).bind(sessionId).first();
    expect(row).toEqual({ status: 'scheduled', acknowledged_unknown: 1 });
  });

  it('does not schedule for a cancelled event or with an invalid time range', async () => {
    const { eventId, sessionId } = await newSession({ date: '2030-12-14' });
    await db.prepare(`UPDATE planning_sessions SET end_time = '18:00' WHERE id = ?`).bind(sessionId).run();
    expect(await scheduleSession(MAIL, db, sessionId, true)).toMatchObject({ ok: false, error: 'bad_time' });
    await db.prepare(`UPDATE planning_sessions SET end_time = '20:00' WHERE id = ?`).bind(sessionId).run();
    await setEventStatus(db, eventId, 1, 'cancelled');
    expect(await scheduleSession(MAIL, db, sessionId, true)).toMatchObject({ ok: false, error: 'event_cancelled' });
    expect(await scheduleSession(MAIL, db, 999999, true)).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('re-checks when a scheduled session is moved and writes nothing on failure', async () => {
    const { sessionId } = await newSession({ date: '2030-12-15' });
    await addSessionPeople(db, sessionId, [101]);
    await addAvailability(db, 101, { starts_on: '2030-12-15', ends_on: '2030-12-16', weekdays: [], start_minute: 1000, end_minute: 1300, note: '' });
    expect(await scheduleSession(MAIL, db, sessionId, false)).toEqual({ ok: true });
    await db.prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date) VALUES (101, '2030-12-16', '2030-12-16')`).run();
    const input = { title_en: 'Rehearsal', title_zh: '', session_date: '2030-12-16', start_time: '19:00', end_time: '20:00', location_en: 'Room', location_zh: '', note_en: '', note_zh: '' };
    expect(await saveSession(MAIL, db, sessionId, input, true)).toMatchObject({ ok: false, error: 'conflict', blocked: [101] });
    const row = await db.prepare(`SELECT session_date FROM planning_sessions WHERE id = ?`).bind(sessionId).first<{ session_date: string }>();
    expect(row?.session_date).toBe('2030-12-15');
  });

  it('checkSession reports statuses per person', async () => {
    const { sessionId } = await newSession({ date: '2030-12-17' });
    await addSessionPeople(db, sessionId, [101, 102]);
    await addAvailability(db, 101, { starts_on: '2030-12-17', ends_on: '2030-12-17', weekdays: [], start_minute: 1000, end_minute: 1300, note: '' });
    const session = (await db.prepare(`SELECT * FROM planning_sessions WHERE id = ?`).bind(sessionId).first())!;
    const check = await checkSession(db, session as never, [101, 102]);
    expect(check.statuses).toEqual({ 101: 'available', 102: 'unknown' });
    await cancelSession(MAIL, db, sessionId);
  });
});

describe('notification rules', () => {
  it('seeds the four rules enabled and stores changes per campus', async () => {
    const rules = await listRules(db, 1);
    expect(rules.map((r) => [r.rule_key, r.enabled, r.lead_hours])).toEqual([
      ['publish', true, 24],
      ['change', true, 24],
      ['cancel', true, 24],
      ['remind', true, 24],
    ]);
    await setRule(db, 'remind', false, 48);
    expect(await getRule(db, 'remind', 1)).toEqual({ rule_key: 'remind', enabled: false, lead_hours: 48 });
    expect((await getRule(db, 'publish', 1)).enabled).toBe(true);
    // A campus without rows falls back to the defaults.
    expect((await getRule(db, 'cancel', 7)).enabled).toBe(true);
    await setRule(db, 'remind', true, 99999);
    expect((await getRule(db, 'remind', 1)).lead_hours).toBe(336);
  });
});
