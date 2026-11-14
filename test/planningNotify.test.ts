// Service Planning email: publish / change / cancel / reminder, gated by the
// rules, written to email_log with planning* kinds, and never sent twice.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '../src/lib/email';
import { addSessionPeople, createEvent, createSession, setRule } from '../src/lib/planningDb';
import { hoursUntilSession, notifySession, sendPlanningReminders } from '../src/lib/planningNotify';
import { cancelSession, noticeAddedPeople, saveSession, scheduleSession } from '../src/lib/planningService';
import { clearModuleCache } from '../src/lib/modules';
import { setSetting } from '../src/lib/settings';

vi.mock('../src/lib/email', { spy: true });

const db = env.DB;
const MAIL = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };
const NOW = new Date('2030-06-05T17:00:00Z'); // 12:00 in Chicago on Wednesday 2030-06-05

const logCount = async (kind: string): Promise<number> =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE kind = ?`).bind(kind).first<{ n: number }>())!.n;

beforeAll(async () => {
  await db.batch([
    db.prepare(`INSERT INTO people (id, display_name, email, lang, active) VALUES
      (201, 'Dee Example', 'dee@example.com', 'en', 1),
      (202, 'Eli Example', 'eli@example.com', 'zh', 1),
      (203, 'Fay Example', 'fay@example.com', NULL, 1)`),
  ]);
});

async function scheduled(date: string, start = '19:00', end = '20:00', people = [201, 202, 203]) {
  const eventId = await createEvent(db, {
    title_en: 'Easter <b>', title_zh: '复活节', event_date: '2030-06-30', start_time: '10:00', end_time: null,
    location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null,
  }, null);
  const sessionId = await createSession(db, eventId, {
    title_en: 'Band rehearsal', title_zh: '乐队彩排', session_date: date, start_time: start, end_time: end,
    location_en: 'Rehearsal Room', location_zh: '排练室', note_en: '', note_zh: '',
  });
  await addSessionPeople(db, sessionId, people);
  await db.prepare(`UPDATE planning_session_people SET call_time = '18:45' WHERE session_id = ? AND person_id = 201`).bind(sessionId).run();
  await db.prepare(`INSERT INTO availability_windows (person_id, starts_on, ends_on, start_minute, end_minute)
    SELECT person_id, ?1, ?1, 0, 1440 FROM planning_session_people WHERE session_id = ?2`).bind(date, sessionId).run();
  return { eventId, sessionId };
}

describe('publish', () => {
  it('emails each called person once, in their language, and stamps notified_at', async () => {
    vi.mocked(sendEmail).mockClear();
    const { sessionId } = await scheduled('2030-06-12');
    expect(await scheduleSession(MAIL, db, sessionId, false)).toEqual({ ok: true });
    expect(await logCount('planningPublish')).toBe(3);

    const calls = vi.mocked(sendEmail).mock.calls.map((c) => c[2]);
    const english = calls.find((m) => m.to === 'dee@example.com')!;
    expect(english.subject).toBe('Scheduled: Band rehearsal on 2030-06-12');
    expect(english.text).toContain('arrive by 18:45');
    expect(english.text).toContain('/en/planning/');
    expect(english.html).toContain('Easter &lt;b&gt;'); // names are escaped
    const chinese = calls.find((m) => m.to === 'eli@example.com')!;
    expect(chinese.subject).toBe('已排定：2030-06-12 乐队彩排');
    const stacked = calls.find((m) => m.to === 'fay@example.com')!;
    expect(stacked.subject).toContain(' · ');

    const unset = await db.prepare(`SELECT COUNT(*) AS n FROM planning_session_people WHERE session_id = ? AND notified_at IS NULL`).bind(sessionId).first<{ n: number }>();
    expect(unset?.n).toBe(0);
  });

  it('does not email twice when notified again', async () => {
    const { sessionId } = await scheduled('2030-06-13');
    await scheduleSession(MAIL, db, sessionId, false);
    const before = await logCount('planningPublish');
    expect(await notifySession(MAIL, db, sessionId, 'publish')).toBe(0);
    expect(await scheduleSession(MAIL, db, sessionId, false)).toEqual({ ok: true });
    expect(await logCount('planningPublish')).toBe(before);
  });

  it('sends nothing when the publish rule is off, and sends later when it is back on', async () => {
    const before = await logCount('planningPublish');
    await setRule(db, 'publish', false);
    const { sessionId } = await scheduled('2030-06-14', '19:00', '20:00', [201]);
    await scheduleSession(MAIL, db, sessionId, false);
    expect(await logCount('planningPublish')).toBe(before);
    await setRule(db, 'publish', true);
    expect(await notifySession(MAIL, db, sessionId, 'publish')).toBe(1);
    expect(await logCount('planningPublish')).toBe(before + 1);
  });

  it('notifies people added to an already scheduled session', async () => {
    const { sessionId } = await scheduled('2030-06-15', '19:00', '20:00', [201]);
    await scheduleSession(MAIL, db, sessionId, false);
    const before = await logCount('planningPublish');
    await db.prepare(`INSERT INTO availability_windows (person_id, starts_on, ends_on, start_minute, end_minute) VALUES (202, '2030-06-15', '2030-06-15', 0, 1440)`).run();
    await addSessionPeople(db, sessionId, [202]);
    await noticeAddedPeople(MAIL, db, sessionId);
    expect(await logCount('planningPublish')).toBe(before + 1);
  });
});

describe('change and cancel', () => {
  const sessionInput = (over: Record<string, string> = {}) => ({
    title_en: 'Band rehearsal', title_zh: '乐队彩排', session_date: '2030-06-16', start_time: '19:00', end_time: '20:00',
    location_en: 'Rehearsal Room', location_zh: '排练室', note_en: '', note_zh: '', ...over,
  });

  it('notifies people already told on a date, time, or location change, but not on other edits', async () => {
    const { sessionId } = await scheduled('2030-06-16');
    await scheduleSession(MAIL, db, sessionId, false);
    const before = await logCount('planningChange');
    await saveSession(MAIL, db, sessionId, sessionInput({ note_en: 'Bring charts' }), true);
    expect(await logCount('planningChange')).toBe(before);
    await saveSession(MAIL, db, sessionId, sessionInput({ start_time: '19:30', end_time: '20:30' }), true);
    expect(await logCount('planningChange')).toBe(before + 3);
    await saveSession(MAIL, db, sessionId, sessionInput({ start_time: '19:30', end_time: '20:30', location_en: 'Sanctuary' }), true);
    expect(await logCount('planningChange')).toBe(before + 6);
  });

  it('does not send change notices for a draft session', async () => {
    const { sessionId } = await scheduled('2030-06-17');
    const before = await logCount('planningChange');
    await saveSession(MAIL, db, sessionId, sessionInput({ session_date: '2030-06-18' }), true);
    expect(await logCount('planningChange')).toBe(before);
  });

  it('tells notified people about a cancellation once, and nobody for a draft', async () => {
    const draft = await scheduled('2030-06-19');
    const before = await logCount('planningCancel');
    await cancelSession(MAIL, db, draft.sessionId);
    expect(await logCount('planningCancel')).toBe(before);

    const live = await scheduled('2030-06-20');
    await scheduleSession(MAIL, db, live.sessionId, false);
    await cancelSession(MAIL, db, live.sessionId);
    expect(await logCount('planningCancel')).toBe(before + 3);
    expect(await cancelSession(MAIL, db, live.sessionId)).toBe(false);
    expect(await logCount('planningCancel')).toBe(before + 3);
  });

  it('notifies everyone again when a cancelled session is rescheduled', async () => {
    const { sessionId } = await scheduled('2030-06-21', '19:00', '20:00', [201]);
    await scheduleSession(MAIL, db, sessionId, false);
    await cancelSession(MAIL, db, sessionId);
    const before = await logCount('planningPublish');
    await scheduleSession(MAIL, db, sessionId, false);
    expect(await logCount('planningPublish')).toBe(before + 1);
  });

  it('skips people without an email address and survives a failing send', async () => {
    const { sessionId } = await scheduled('2030-06-22', '19:00', '20:00', [201, 202]);
    vi.mocked(sendEmail).mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await scheduleSession(MAIL, db, sessionId, false);
    const rows = await db.prepare(`SELECT person_id, notified_at FROM planning_session_people WHERE session_id = ? ORDER BY person_id`).bind(sessionId).all<{ person_id: number; notified_at: string | null }>();
    expect(rows.results[0].notified_at).toBeNull(); // failed send: retried next time
    expect(rows.results[1].notified_at).not.toBeNull();
  });
});

describe('reminders', () => {
  it('computes hours until a session in church local time', () => {
    expect(hoursUntilSession({ session_date: '2030-06-05', start_time: '19:00' }, NOW)).toBe(7);
    expect(hoursUntilSession({ session_date: '2030-06-06', start_time: '12:00' }, NOW)).toBe(24);
    expect(hoursUntilSession({ session_date: '2030-06-05', start_time: '09:00' }, NOW)).toBe(-3);
  });

  it('reminds sessions inside the lead time once and records reminded_at', async () => {
    await setRule(db, 'remind', true, 24);
    const soon = await scheduled('2030-06-05', '19:00', '20:00', [201, 202]);
    const later = await scheduled('2030-06-09', '19:00', '20:00', [201]);
    const past = await scheduled('2030-06-05', '08:00', '09:00', [201]);
    for (const s of [soon, later, past]) await scheduleSession(MAIL, db, s.sessionId, false);
    const before = await logCount('planningRemind');

    expect(await sendPlanningReminders(MAIL, db, NOW)).toBe(2);
    expect(await logCount('planningRemind')).toBe(before + 2);
    // No duplicates on the next daily pass.
    expect(await sendPlanningReminders(MAIL, db, NOW)).toBe(0);
    expect(await logCount('planningRemind')).toBe(before + 2);
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM planning_session_people WHERE session_id = ? AND reminded_at IS NOT NULL`).bind(soon.sessionId).first<{ n: number }>();
    expect(row?.n).toBe(2);

    // Later, inside the window, the third-day session is reminded too.
    expect(await sendPlanningReminders(MAIL, db, new Date('2030-06-09T01:00:00Z'))).toBe(1);
  });

  it('honors the lead hours and sends nothing when the remind rule is off', async () => {
    const { sessionId } = await scheduled('2030-07-05', '19:00', '20:00', [201]);
    await scheduleSession(MAIL, db, sessionId, false);
    const now = new Date('2030-07-04T17:00:00Z'); // 31 hours before
    expect(await sendPlanningReminders(MAIL, db, now)).toBe(0);
    await setRule(db, 'remind', true, 48);
    await setRule(db, 'remind', false, 48);
    expect(await sendPlanningReminders(MAIL, db, now)).toBe(0);
    await setRule(db, 'remind', true, 48);
    expect(await sendPlanningReminders(MAIL, db, now)).toBe(1);
  });

  it('does nothing when the planning module is off, and skips cancelled events', async () => {
    const { eventId, sessionId } = await scheduled('2030-08-05', '19:00', '20:00', [201]);
    await scheduleSession(MAIL, db, sessionId, false);
    const now = new Date('2030-08-04T20:00:00Z');
    await setSetting(db, 'module.planning', '0');
    clearModuleCache();
    expect(await sendPlanningReminders(MAIL, db, now)).toBe(0);
    await setSetting(db, 'module.planning', '1');
    clearModuleCache();
    await db.prepare(`UPDATE planning_events SET status = 'cancelled' WHERE id = ?`).bind(eventId).run();
    expect(await sendPlanningReminders(MAIL, db, now)).toBe(0);
  });
});
