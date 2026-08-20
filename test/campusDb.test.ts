import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCampus,
  getCampusModules,
  listCampusMemberships,
  listCampusesForUser,
  resolveCampusContext,
  setCampusModules,
  upsertCampusMembership,
} from '../src/lib/campusDb';

const db = env.DB;

beforeEach(async () => {
  await db.prepare('DELETE FROM campus_modules WHERE campus_id >= 78000').run();
  await db.prepare('DELETE FROM campus_memberships WHERE campus_id >= 78000 OR person_id >= 78000').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 78000').run();
  await db.prepare('DELETE FROM people WHERE id >= 78000').run();
  await db.prepare(
    `INSERT INTO people (id, display_name, email, role, super_admin) VALUES
       (78001, 'Master Admin', 'master-campus@example.test', 'admin', 1),
       (78002, 'North Admin', 'north-admin@example.test', 'member', 0),
       (78003, 'Multi Campus', 'multi-campus@example.test', 'member', 0)`,
  ).run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name, active) VALUES
       (78001, 'north', 'North Campus', 1),
       (78002, 'south', 'South Campus', 1),
       (78003, 'closed', 'Closed Campus', 0)`,
  ).run();
});

describe('campus visibility', () => {
  it('lets a master admin list every campus without memberships', async () => {
    const rows = await listCampusesForUser(db, 78001, true);
    expect(rows.map(({ slug }) => slug)).toEqual(['main', 'north', 'south', 'closed']);
  });

  it('returns only active campus memberships to a non-master user', async () => {
    await upsertCampusMembership(db, {
      campusId: 78001,
      personId: 78003,
      role: 'admin',
      finance: false,
      adminAreas: ['groups'],
      active: true,
    });
    await upsertCampusMembership(db, {
      campusId: 78003,
      personId: 78003,
      role: 'admin',
      finance: false,
      adminAreas: ['people'],
      active: true,
    });

    const rows = await listCampusesForUser(db, 78003, false);
    expect(rows.map(({ slug }) => slug)).toEqual(['main', 'north']);
  });

  it('gives only a master admin an all-campus context', async () => {
    expect(await resolveCampusContext(db, 'all', { personId: 78001, isMasterAdmin: true }))
      .toEqual({ mode: 'all', campus: null, membership: null });
    expect(await resolveCampusContext(db, 'all', { personId: 78002, isMasterAdmin: false }))
      .toBeNull();
  });

  it('rejects a campus the user does not administer and resolves an allowed one', async () => {
    await upsertCampusMembership(db, {
      campusId: 78001,
      personId: 78002,
      role: 'admin',
      finance: true,
      adminAreas: ['groups', 'people'],
      active: true,
    });

    expect(await resolveCampusContext(db, 'south', { personId: 78002, isMasterAdmin: false }))
      .toBeNull();
    expect(await resolveCampusContext(db, 'north', { personId: 78002, isMasterAdmin: false }))
      .toMatchObject({
        mode: 'campus',
        campus: { id: 78001, slug: 'north', name: 'North Campus' },
        membership: { role: 'admin', finance: 1, adminAreas: ['groups', 'people'] },
      });
  });

  it('allows anonymous public requests to select any active campus but not an inactive one', async () => {
    expect(await resolveCampusContext(db, 'south', null)).toMatchObject({
      mode: 'campus',
      campus: { id: 78002, slug: 'south' },
      membership: null,
    });
    expect(await resolveCampusContext(db, 'closed', null)).toBeNull();
  });
});

describe('campus administration', () => {
  it('creates normalized campus slugs and rejects invalid slugs', async () => {
    const campus = await createCampus(db, { name: '  Downtown  ', slug: '  Down-Town  ' });
    expect(campus).toMatchObject({ name: 'Downtown', slug: 'down-town', active: 1 });
    await expect(createCampus(db, { name: 'Bad', slug: '../bad' })).rejects.toThrow('invalid_campus_slug');
  });

  it('stores campus-local roles and filters grants against the resulting role', async () => {
    await upsertCampusMembership(db, {
      campusId: 78001,
      personId: 78002,
      role: 'member',
      finance: true,
      adminAreas: ['groups', 'newcomers', 'settings'],
      active: true,
    });
    const row = await db.prepare(
      `SELECT role, finance, admin_areas, active FROM campus_memberships
       WHERE campus_id = 78001 AND person_id = 78002`,
    ).first<{ role: string; finance: number; admin_areas: string; active: number }>();
    expect(row).toEqual({ role: 'member', finance: 1, admin_areas: 'newcomers', active: 1 });
  });

  it('stores feature enablement independently for each campus', async () => {
    await setCampusModules(db, 78001, new Set(['groups', 'people']));
    await setCampusModules(db, 78002, new Set(['sermons']));

    expect(await getCampusModules(db, 78001)).toEqual(new Set(['groups', 'people']));
    expect(await getCampusModules(db, 78002)).toEqual(new Set(['sermons']));
  });

  it('lists campus role assignments with their shared identity details', async () => {
    await upsertCampusMembership(db, {
      campusId: 78001,
      personId: 78002,
      role: 'admin',
      finance: true,
      adminAreas: ['groups'],
      active: true,
    });
    await upsertCampusMembership(db, {
      campusId: 78001,
      personId: 78003,
      role: 'editor',
      finance: false,
      adminAreas: ['newcomers'],
      active: false,
    });

    expect(await listCampusMemberships(db, 78001)).toEqual([
      expect.objectContaining({
        personId: 78003,
        displayName: 'Multi Campus',
        email: 'multi-campus@example.test',
        role: 'editor',
        active: 0,
      }),
      expect.objectContaining({
        personId: 78002,
        displayName: 'North Admin',
        email: 'north-admin@example.test',
        role: 'admin',
        finance: 1,
        adminAreas: ['groups'],
        active: 1,
      }),
    ]);
  });
});
