import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { scopeDatabase } from '../src/lib/campusScope';

const db = env.DB;

beforeEach(async () => {
  await db.prepare('DELETE FROM campus_memberships WHERE campus_id >= 80000 OR person_id >= 80000').run();
  await db.prepare('DELETE FROM events WHERE campus_id >= 80000').run();
  await db.prepare('DELETE FROM groups WHERE campus_id >= 80000').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 80000').run();
  await db.prepare('DELETE FROM people WHERE id >= 80000').run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name) VALUES
       (80001, 'north-scope', 'North Scope'),
       (80002, 'south-scope', 'South Scope')`,
  ).run();
});

describe('campus-scoped AppDb', () => {
  it('injects the selected campus into writes and hides other-campus reads', async () => {
    const north = scopeDatabase(db, 80001);
    const south = scopeDatabase(db, 80002);
    const northEvent = await north.prepare(
      'INSERT INTO events (starts_at) VALUES (?1) RETURNING id, campus_id',
    ).bind('2026-09-01').first<{ id: number; campus_id: number }>();
    const southEvent = await south.prepare(
      'INSERT INTO events (starts_at) VALUES (?1) RETURNING id, campus_id',
    ).bind('2026-09-02').first<{ id: number; campus_id: number }>();

    expect(northEvent?.campus_id).toBe(80001);
    expect(southEvent?.campus_id).toBe(80002);
    expect((await north.prepare('SELECT id FROM events ORDER BY id').all()).results)
      .toEqual([{ id: northEvent!.id }]);
    expect((await south.prepare('SELECT id FROM events ORDER BY id').all()).results)
      .toEqual([{ id: southEvent!.id }]);
    expect((await db.prepare('SELECT id FROM events WHERE campus_id >= 80000 ORDER BY id').all()).results)
      .toEqual([{ id: northEvent!.id }, { id: southEvent!.id }]);
  });

  it('prevents cross-campus updates and deletes even when an id is known', async () => {
    const north = scopeDatabase(db, 80001);
    const south = scopeDatabase(db, 80002);
    const row = await south.prepare(
      "INSERT INTO groups (name) VALUES ('South Secret') RETURNING id",
    ).first<{ id: number }>();

    const updated = await north.prepare(
      "UPDATE groups SET name = 'Stolen' WHERE id = ?1",
    ).bind(row!.id).run();
    const removed = await north.prepare('DELETE FROM groups WHERE id = ?1').bind(row!.id).run();

    expect(updated.meta.changes).toBe(0);
    expect(removed.meta.changes).toBe(0);
    expect(await south.prepare('SELECT name FROM groups WHERE id = ?1').bind(row!.id).first())
      .toEqual({ name: 'South Secret' });
  });

  it('scopes shared people identities through campus memberships', async () => {
    await db.prepare(
      `INSERT INTO people (id, display_name, email) VALUES
         (80001, 'North Person', 'north-person@example.test'),
         (80002, 'South Person', 'south-person@example.test'),
         (80003, 'Both Person', 'both-person@example.test')`,
    ).run();
    await db.prepare(
      `INSERT INTO campus_memberships (campus_id, person_id) VALUES
         (80001, 80001), (80001, 80003),
         (80002, 80002), (80002, 80003)`,
    ).run();

    const north = scopeDatabase(db, 80001);
    const south = scopeDatabase(db, 80002);
    expect((await north.prepare('SELECT id FROM people WHERE id >= 80000 ORDER BY id').all()).results)
      .toEqual([{ id: 80001 }, { id: 80003 }]);
    expect((await south.prepare('SELECT id FROM people WHERE id >= 80000 ORDER BY id').all()).results)
      .toEqual([{ id: 80002 }, { id: 80003 }]);
  });

  it('attaches identities created in a scoped request to that campus', async () => {
    const north = scopeDatabase(db, 80001);
    const created = await north.prepare(
      `INSERT INTO people (display_name, email, role)
       VALUES ('New North Person', 'new-north-person@example.test', 'editor')
       RETURNING id, home_campus_id`,
    ).first<{ id: number; home_campus_id: number }>();

    expect(created?.home_campus_id).toBe(80001);
    expect(await db.prepare(
      `SELECT campus_id, role FROM campus_memberships WHERE person_id = ?1`,
    ).bind(created!.id).first()).toEqual({ campus_id: 80001, role: 'editor' });
    expect(await scopeDatabase(db, 80002).prepare(
      'SELECT id FROM people WHERE id = ?1',
    ).bind(created!.id).first()).toBeNull();
  });

  it('prevents updates and deletes of identities outside the selected campus', async () => {
    await db.prepare(
      `INSERT INTO people (id, display_name, email) VALUES
         (80011, 'North Guarded', 'north-guarded@example.test'),
         (80012, 'South Guarded', 'south-guarded@example.test')`,
    ).run();
    await db.prepare(
      `INSERT INTO campus_memberships (campus_id, person_id) VALUES
         (80001, 80011), (80002, 80012)`,
    ).run();
    const north = scopeDatabase(db, 80001);

    expect((await north.prepare(
      `UPDATE people SET display_name = 'Cross-campus edit' WHERE id = 80012`,
    ).run()).meta.changes).toBe(0);
    expect((await north.prepare('DELETE FROM people WHERE id = 80012').run()).meta.changes).toBe(0);
    expect(await db.prepare('SELECT display_name FROM people WHERE id = 80012').first())
      .toEqual({ display_name: 'South Guarded' });
  });

  it('leaves the database unscoped only for the explicit master all-campus context', () => {
    expect(scopeDatabase(db, null)).toBe(db);
  });
});
