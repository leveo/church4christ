// Service Planning on Postgres: the same data layer, scheduling re-check, and
// notification path that the D1 suites cover, against a migrated and seeded
// Postgres. Self-skips when DATABASE_URL is unset.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
// The mail module imports the Workers `cloudflare:email` runtime, which the
// plain-Node PG project cannot resolve. Keep the real email_log write so the
// assertions still see one row per accepted message.
vi.mock('../../src/lib/email', async () => {
  const { logEmail } = await import('../../src/lib/emailSettingsDb');
  return {
    escapeHtml: (value: string) => value,
    sendEmail: async (_env: unknown, db: AppDb, msg: { to: string; toName?: string; kind: string; detail?: string }) => {
      await logEmail(db, { to_email: msg.to, to_name: msg.toName, kind: msg.kind, detail: msg.detail, status: 'devlog' });
      return true;
    },
  };
});

import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import {
  addAvailability,
  addItem,
  addSessionPeople,
  copyRunSheet,
  createEvent,
  createSession,
  getEvent,
  getRule,
  listAvailability,
  listItems,
  listRules,
  moveItem,
  setRule,
  updateEvent,
} from '../../src/lib/planningDb';
import { listDutiesForPerson, listSessionsForPerson } from '../../src/lib/planningCalendar';
import { planningRole } from '../../src/lib/planningAccess';
import { sendPlanningReminders } from '../../src/lib/planningNotify';
import { scheduleSession } from '../../src/lib/planningService';
import { clearModuleCache } from '../../src/lib/modules';
import type { SessionUser } from '../../src/lib/types';

const MAIL = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };

describe.skipIf(!hasPg)('service planning (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
    clearModuleCache();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('seeds the demo event, run sheet, rehearsals, and four default rules', async () => {
    const event = await getEvent(db, 31000);
    expect(event).toMatchObject({ title_en: 'Christmas Service', status: 'published', revision: 1 });
    expect(await listItems(db, 31000)).toHaveLength(9);
    expect((await listRules(db, 1)).every((r) => r.enabled)).toBe(true);
  });

  it('applies the optimistic lock to events and run-sheet writes', async () => {
    const id = await createEvent(db, {
      title_en: 'PG event', title_zh: '', event_date: '2031-05-01', start_time: '10:00', end_time: null,
      location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null,
    }, 1);
    const input = { title_en: 'Renamed', title_zh: '', event_date: '2031-05-01', start_time: '10:00', end_time: null, location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null };
    expect(await updateEvent(db, id, 1, input)).toEqual({ ok: true, revision: 2 });
    expect(await updateEvent(db, id, 1, input)).toEqual({ ok: false, reason: 'conflict' });
    const item = (title: string) => ({ kind: 'segment' as const, duration_min: 5, fixed_start_time: null, title_en: title, title_zh: '', details_en: '', details_zh: '', owner_team_id: null, owner_person_id: null, owner_label: null, cue_notes: '' });
    expect(await addItem(db, id, 2, item('A'))).toEqual({ ok: true, revision: 3 });
    expect(await addItem(db, id, 3, item('B'))).toEqual({ ok: true, revision: 4 });
    const [a] = await listItems(db, id);
    expect(await moveItem(db, id, a.id, 4, 'down')).toEqual({ ok: true, revision: 5 });
    expect((await listItems(db, id)).map((i) => i.title_en)).toEqual(['B', 'A']);
    const copy = await createEvent(db, { ...input, title_en: 'Copy' }, 1);
    expect(await copyRunSheet(db, copy, id, 1)).toMatchObject({ ok: true, copied: 2 });
  });

  it('schedules with a conflict re-check and reminds once', async () => {
    const eventId = await createEvent(db, {
      title_en: 'PG rehearsal event', title_zh: '', event_date: '2031-05-20', start_time: '10:00', end_time: null,
      location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null,
    }, 1);
    const sessionId = await createSession(db, eventId, {
      title_en: 'PG rehearsal', title_zh: '', session_date: '2031-05-10', start_time: '19:00', end_time: '20:00',
      location_en: 'Room', location_zh: '', note_en: '', note_zh: '',
    });
    await addSessionPeople(db, sessionId, [3, 8]);
    await sql.unsafe(`INSERT INTO blockout_dates (person_id, start_date, end_date) VALUES (8, '2031-05-10', '2031-05-10')`);
    expect(await scheduleSession(MAIL, db, sessionId, true)).toMatchObject({ ok: false, error: 'conflict', blocked: [8] });
    await sql.unsafe(`DELETE FROM blockout_dates WHERE person_id = 8 AND start_date = '2031-05-10'`);
    await addAvailability(db, 3, { starts_on: '2031-05-10', ends_on: '2031-05-10', weekdays: [], start_minute: 1000, end_minute: 1300, note: '' });
    expect(await scheduleSession(MAIL, db, sessionId, false)).toMatchObject({ ok: false, error: 'unknown', unknown: [8] });
    expect(await scheduleSession(MAIL, db, sessionId, true)).toEqual({ ok: true });
    const sent = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM email_log WHERE kind = 'planningPublish'`);
    expect(sent[0].n).toBe(2);

    expect(await sendPlanningReminders(MAIL, db, new Date('2031-05-10T01:00:00Z'))).toBe(2);
    expect(await sendPlanningReminders(MAIL, db, new Date('2031-05-10T01:00:00Z'))).toBe(0);
    expect((await listSessionsForPerson(db, 3, '2031-05-01', '2031-05-31')).map((s) => s.title_en)).toEqual(['PG rehearsal']);
  });

  it('stores availability, rules, and role checks on Postgres', async () => {
    await addAvailability(db, 5, { starts_on: '2031-06-01', ends_on: '2031-06-30', weekdays: [1, 3], start_minute: 1080, end_minute: 1260, note: 'n' });
    expect((await listAvailability(db, 5, '2031-01-01'))[0]).toMatchObject({ weekdays: '1,3', start_minute: 1080 });
    await setRule(db, 'remind', false, 12);
    expect(await getRule(db, 'remind', 1)).toEqual({ rule_key: 'remind', enabled: false, lead_hours: 12 });
    const user = (id: number): SessionUser => ({
      id, email: `u${id}@example.com`, displayName: 'U', role: 'member', isAdmin: false, isEditor: false, finance: 0,
      memberTeamIds: [], leaderTeamIds: [], lang: 'en', isSuperAdmin: false, adminAreas: [],
    });
    expect(await planningRole(db, user(3), { id: 31000 })).toBe('coordinator');
    expect(await planningRole(db, user(5), { id: 31000 })).toBe('participant'); // called to a rehearsal and on the Worship team
    expect(await planningRole(db, user(10), { id: 31000 })).toBeNull();
    expect(await listDutiesForPerson(db, 3, '2000-01-01', '2999-12-31')).not.toEqual([]);
  });
});
