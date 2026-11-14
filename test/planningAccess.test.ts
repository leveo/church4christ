// Who may see or manage a planning event: planning admins (with the area grant),
// event-scoped coordinators, participants of a non-draft event, and outsiders.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminAreaForPath, hasAreaAccess } from '../src/lib/adminAreas';
import { classifyRoute, canAccess } from '../src/lib/routePolicy';
import { moduleForPath } from '../src/lib/modules';
import { addCoordinator, createEvent, createSession, addSessionPeople, setEventStatus, addItem } from '../src/lib/planningDb';
import { canManage, isPlanningAdmin, planningRole } from '../src/lib/planningAccess';
import type { SessionUser } from '../src/lib/types';

const db = env.DB;

const user = (id: number, over: Partial<SessionUser> = {}): SessionUser => ({
  id,
  email: `u${id}@example.com`,
  displayName: `User ${id}`,
  role: 'member',
  isAdmin: false,
  isEditor: false,
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  isSuperAdmin: false,
  adminAreas: [],
  ...over,
});

let eventId = 0;
beforeAll(async () => {
  await db.batch([
    db.prepare(`INSERT INTO people (id, display_name, email, active) VALUES
      (301, 'Coord', 'coord@example.com', 1), (302, 'Called', 'called@example.com', 1),
      (303, 'Owner', 'owner@example.com', 1), (304, 'TeamMember', 'tm@example.com', 1),
      (305, 'Outsider', 'out@example.com', 1)`),
    db.prepare(`INSERT INTO teams (id) VALUES (801)`),
    db.prepare(`INSERT INTO team_members (team_id, person_id) VALUES (801, 304)`),
  ]);
  eventId = await createEvent(db, {
    title_en: 'Retreat', title_zh: '', event_date: '2030-09-01', start_time: '09:00', end_time: null,
    location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null,
  }, null);
  await addCoordinator(db, eventId, 301);
  const sid = await createSession(db, eventId, {
    title_en: 'Prep', title_zh: '', session_date: '2030-08-20', start_time: '19:00', end_time: '20:00',
    location_en: '', location_zh: '', note_en: '', note_zh: '',
  });
  await addSessionPeople(db, sid, [302]);
  await db.prepare(`UPDATE planning_sessions SET status = 'scheduled' WHERE id = ?`).bind(sid).run();
  await addItem(db, eventId, 1, {
    kind: 'segment', duration_min: 5, fixed_start_time: null, title_en: 'Welcome', title_zh: '', details_en: '', details_zh: '',
    owner_team_id: null, owner_person_id: 303, owner_label: null, cue_notes: '',
  });
  await addItem(db, eventId, 2, {
    kind: 'segment', duration_min: 5, fixed_start_time: null, title_en: 'Team slot', title_zh: '', details_en: '', details_zh: '',
    owner_team_id: 801, owner_person_id: null, owner_label: null, cue_notes: '',
  });
});

describe('planningRole', () => {
  const event = () => ({ id: eventId });

  it('gives drafts only to admins and coordinators', async () => {
    expect(await planningRole(db, user(1, { isAdmin: true, isSuperAdmin: true }), event())).toBe('admin');
    expect(await planningRole(db, user(301), event())).toBe('coordinator');
    expect(await planningRole(db, user(302), event())).toBeNull();
    expect(await planningRole(db, user(303), event())).toBeNull();
    expect(await planningRole(db, user(305), event())).toBeNull();
    expect(await planningRole(db, null, event())).toBeNull();
  });

  it('opens a published event to called people, item owners, and owner-team members', async () => {
    await setEventStatus(db, eventId, 3, 'published');
    expect(await planningRole(db, user(302), event())).toBe('participant');
    expect(await planningRole(db, user(303), event())).toBe('participant');
    expect(await planningRole(db, user(304, { memberTeamIds: [801] }), event())).toBe('participant');
    expect(await planningRole(db, user(305), event())).toBeNull();
    expect(canManage(await planningRole(db, user(302), event()))).toBe(false);
    expect(canManage(await planningRole(db, user(301), event()))).toBe(true);
  });

  it('keeps a coordinator of one event out of another', async () => {
    const other = await createEvent(db, {
      title_en: 'Other', title_zh: '', event_date: '2030-10-01', start_time: '09:00', end_time: null,
      location_en: '', location_zh: '', notes_en: '', notes_zh: '', plan_id: null,
    }, null);
    expect(await planningRole(db, user(301), { id: other })).toBeNull();
  });
});

describe('planning admin area and route policy', () => {
  it('needs the planning grant for limited admins; super admins pass', () => {
    const limited = user(10, { isAdmin: true, role: 'admin', adminAreas: ['groups'] });
    const granted = user(11, { isAdmin: true, role: 'admin', adminAreas: ['planning'] });
    const superAdmin = user(12, { isAdmin: true, role: 'admin', isSuperAdmin: true });
    expect(isPlanningAdmin(limited)).toBe(false);
    expect(isPlanningAdmin(granted)).toBe(true);
    expect(isPlanningAdmin(superAdmin)).toBe(true);
    expect(isPlanningAdmin(user(13, { adminAreas: ['planning'] }))).toBe(false);
    expect(hasAreaAccess(granted, 'planning')).toBe(true);
  });

  it('maps /admin/planning to the area, the module, and the admin-only class', () => {
    expect(adminAreaForPath('/admin/planning')).toBe('planning');
    expect(adminAreaForPath('/admin/planning/anything')).toBe('planning');
    expect(moduleForPath('/admin/planning')).toBe('planning');
    expect(moduleForPath('/planning/3/manage')).toBe('planning');
    expect(moduleForPath('/my/availability')).toBe('planning');
    expect(moduleForPath('/my/calendar')).toBe('serve');
    expect(classifyRoute('/admin/planning')).toBe('adminOnly');
    expect(canAccess(classifyRoute('/admin/planning'), user(5, { isEditor: true }))).toBe(false);
  });

  it('requires a session (not a role) for the event pages', () => {
    expect(classifyRoute('/planning/3')).toBe('authed');
    expect(classifyRoute('/planning/3/manage')).toBe('authed');
    expect(canAccess('authed', null)).toBe(false);
    expect(canAccess('authed', user(5))).toBe(true);
  });
});
