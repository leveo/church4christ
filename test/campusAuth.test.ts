import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyCampusContextToUser } from '../src/lib/campusAuth';
import { resolveCampusContext, upsertCampusMembership } from '../src/lib/campusDb';
import type { SessionUser } from '../src/lib/types';

const db = env.DB;

const baseUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 79001,
  email: 'campus-auth@example.test',
  displayName: 'Campus Auth',
  role: 'member',
  isAdmin: false,
  isEditor: false,
  isSuperAdmin: false,
  adminAreas: [],
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  ...over,
});

beforeEach(async () => {
  await db.prepare('DELETE FROM team_members WHERE person_id >= 79000').run();
  await db.prepare('DELETE FROM teams WHERE id >= 79000').run();
  await db.prepare('DELETE FROM campus_memberships WHERE campus_id >= 79000 OR person_id >= 79000').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 79000').run();
  await db.prepare('DELETE FROM people WHERE id >= 79000').run();
  await db.prepare(
    `INSERT INTO people (id, display_name, email, role, super_admin) VALUES
       (79001, 'Campus Auth', 'campus-auth@example.test', 'member', 0),
       (79002, 'Master Auth', 'master-auth@example.test', 'admin', 1)`,
  ).run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name) VALUES
       (79001, 'north-auth', 'North Auth'),
       (79002, 'south-auth', 'South Auth')`,
  ).run();
  await upsertCampusMembership(db, {
    campusId: 79001,
    personId: 79001,
    role: 'admin',
    finance: true,
    adminAreas: ['groups', 'people'],
    active: true,
  });
  await upsertCampusMembership(db, {
    campusId: 79002,
    personId: 79001,
    role: 'member',
    finance: false,
    adminAreas: ['newcomers'],
    active: true,
  });
  await db.prepare(
    `INSERT INTO teams (id, ministry_id, campus_id) VALUES
       (79001, NULL, 79001),
       (79002, NULL, 79002)`,
  ).run();
  await db.prepare(
    `INSERT INTO team_members (team_id, person_id, is_leader) VALUES
       (79001, 79001, 1),
       (79002, 79001, 1)`,
  ).run();
});

describe('campus session authority', () => {
  it('derives admin, finance, areas, and teams from the selected campus membership', async () => {
    const context = await resolveCampusContext(db, 'north-auth', {
      personId: 79001,
      isMasterAdmin: false,
    });
    const user = await applyCampusContextToUser(db, baseUser(), context!);

    expect(user).toMatchObject({
      role: 'admin',
      isAdmin: true,
      isEditor: false,
      finance: 1,
      adminAreas: ['groups', 'people'],
      memberTeamIds: [79001],
      leaderTeamIds: [79001],
      campusMode: 'campus',
      campus: { id: 79001, slug: 'north-auth', name: 'North Auth' },
    });
  });

  it('drops North authority when the same person selects South', async () => {
    const context = await resolveCampusContext(db, 'south-auth', {
      personId: 79001,
      isMasterAdmin: false,
    });
    const user = await applyCampusContextToUser(db, baseUser(), context!);

    expect(user).toMatchObject({
      role: 'member',
      isAdmin: false,
      isEditor: false,
      finance: 0,
      adminAreas: ['newcomers'],
      memberTeamIds: [79002],
      leaderTeamIds: [79002],
      campus: { id: 79002, slug: 'south-auth' },
    });
  });

  it('refuses a non-master session with no active membership in the context', async () => {
    const publicContext = await resolveCampusContext(db, 'north-auth', null);
    const wrongPerson = baseUser({ id: 79999, email: 'wrong@example.test' });
    expect(await applyCampusContextToUser(db, wrongPerson, publicContext!)).toBeNull();
  });

  it('preserves master authority in all-campus mode and loads every team', async () => {
    await db.prepare(
      `INSERT INTO team_members (team_id, person_id, is_leader) VALUES
         (79001, 79002, 1),
         (79002, 79002, 0)`,
    ).run();
    const context = await resolveCampusContext(db, 'all', {
      personId: 79002,
      isMasterAdmin: true,
    });
    const master = baseUser({
      id: 79002,
      email: 'master-auth@example.test',
      role: 'admin',
      isAdmin: true,
      isSuperAdmin: true,
    });
    const user = await applyCampusContextToUser(db, master, context!);

    expect(user).toMatchObject({
      isAdmin: true,
      isSuperAdmin: true,
      campusMode: 'all',
      campus: null,
      memberTeamIds: [79001, 79002],
      leaderTeamIds: [79001],
    });
  });
});
