import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { savePerson, setPersonFlags, softDeletePerson } from '../src/lib/adminDb';

const db = env.DB;
beforeEach(async () => {
  await db.prepare(`DELETE FROM people`).run();
  await db.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (1, 'S', 'One', 'S One', 's1@example.com', 'admin', 1, ''),
            (2, 'L', 'Two', 'L Two', 'l2@example.com', 'admin', 0, ''),
            (3, 'M', 'Three', 'M Three', 'm3@example.com', 'member', 0, '')`,
  ).run();
});

const superCount = async () =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM people WHERE role='admin' AND super_admin=1 AND active=1 AND deleted_at IS NULL`).first<{ n: number }>())!.n;

describe('setPersonFlags: permission writes', () => {
  it('writes superAdmin and validated adminAreas', async () => {
    await setPersonFlags(db, 2, { superAdmin: true });
    await setPersonFlags(db, 3, { adminAreas: ['groups', 'junk', 'settings', 'events'] });
    const two = await db.prepare(`SELECT super_admin FROM people WHERE id=2`).first<{ super_admin: number }>();
    expect(two!.super_admin).toBe(1);
    const three = await db.prepare(`SELECT admin_areas FROM people WHERE id=3`).first<{ admin_areas: string }>();
    expect(three!.admin_areas).toBe('groups,events');
  });
  it('leaves untouched fields alone (partial update)', async () => {
    await setPersonFlags(db, 2, { adminAreas: ['bulletins'] });
    const row = await db.prepare(`SELECT role, super_admin FROM people WHERE id=2`).first<{ role: string; super_admin: number }>();
    expect(row).toEqual({ role: 'admin', super_admin: 0 });
  });
  it('adminAreas: [] clears existing grants', async () => {
    await setPersonFlags(db, 3, { adminAreas: ['groups', 'events'] });
    await setPersonFlags(db, 3, { adminAreas: [] });
    const three = await db.prepare(`SELECT admin_areas FROM people WHERE id=3`).first<{ admin_areas: string }>();
    expect(three!.admin_areas).toBe('');
  });
});

describe('last super admin guard', () => {
  it('rejects unsetting the flag / demoting / deactivating the last super admin', async () => {
    await expect(setPersonFlags(db, 1, { superAdmin: false })).rejects.toThrow(/last_super_admin/);
    await expect(setPersonFlags(db, 1, { role: 'member' })).rejects.toThrow(/last_super_admin/);
    await expect(setPersonFlags(db, 1, { active: false })).rejects.toThrow(/last_super_admin/);
    await expect(softDeletePerson(db, 1)).rejects.toThrow(/last_super_admin/);
    expect(await superCount()).toBe(1);
  });
  it('allows all of those once another super admin exists', async () => {
    await setPersonFlags(db, 2, { superAdmin: true });
    await setPersonFlags(db, 1, { superAdmin: false });
    expect(await superCount()).toBe(1);
  });
  it('non-super rows are unaffected by the guard', async () => {
    await setPersonFlags(db, 2, { active: false });
    await softDeletePerson(db, 3);
  });
  it('rejects a combined multi-flag call on the last super admin, throwing once and leaving the row unchanged', async () => {
    await expect(setPersonFlags(db, 1, { role: 'member', active: false })).rejects.toThrow(/last_super_admin/);
    const one = await db.prepare(`SELECT role, active FROM people WHERE id=1`).first<{ role: string; active: number }>();
    expect(one).toEqual({ role: 'admin', active: 1 });
  });
  it('the atomic WHERE backstop still lets a legitimate demote through when another super admin exists', async () => {
    await setPersonFlags(db, 2, { superAdmin: true });
    await setPersonFlags(db, 1, { superAdmin: false });
    const one = await db.prepare(`SELECT super_admin FROM people WHERE id=1`).first<{ super_admin: number }>();
    expect(one!.super_admin).toBe(0);
  });
});

describe('savePerson: reviving a soft-deleted person', () => {
  it('clears super_admin and admin_areas instead of inheriting them from the deleted row', async () => {
    // A soft-deleted row that used to be an active super admin with grants.
    await db.prepare(
      `INSERT INTO people (id, first_name, last_name, display_name, email, role, active, super_admin, admin_areas, deleted_at)
       VALUES (4, 'R', 'Four', 'R Four', 'revive@example.com', 'admin', 1, 1, 'groups', datetime('now'))`,
    ).run();

    // "Create" a new person that collides on the soft-deleted email — the revive path.
    const r = await savePerson(
      db,
      {
        id: null,
        firstName: 'R',
        lastName: 'Four',
        displayName: 'R Four',
        email: 'revive@example.com',
        phone: null,
        role: 'admin',
        active: true,
        lang: null,
        birthday: null,
        address: null,
      },
      'actor@example.com',
    );

    expect(r).toEqual({ ok: true, id: 4 });
    const row = await db
      .prepare(`SELECT deleted_at, active, super_admin, admin_areas FROM people WHERE id = 4`)
      .first<{ deleted_at: string | null; active: number; super_admin: number; admin_areas: string }>();
    expect(row).toEqual({ deleted_at: null, active: 1, super_admin: 0, admin_areas: '' });
  });
});
