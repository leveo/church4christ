// Member Portal on D1 (workers project, live D1 harness). Verifies migration 0039
// created the two portal tables and that prayerDb never touches Registration
// tables (reg_events, reg_event_i18n, registrations, event_admins) when the
// registration module is off. This file deliberately creates NO reg_* stubs, so
// any such query would fail with "no such table".
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decidePrayerItem,
  deletePrayerItem,
  listChurchPrayers,
  listEventPrayersForPerson,
  listGroupPrayersForPerson,
  listMyPrayerItems,
  listPendingForApprover,
  postPrayerItem,
} from '../src/lib/prayerDb';

const OFF = { registration: false } as const;

async function tableNames(): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prayer_items'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.batch(
    [1, 2, 3].map((id) =>
      env.DB.prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)').bind(id, `Person ${id}`, `p${id}@example.com`),
    ),
  );
});

describe('migration 0039_member_portal_d1', () => {
  it('creates group_files and prayer_items with a defaulted campus_id', async () => {
    const names = await tableNames();
    expect(names.has('group_files')).toBe(true);
    expect(names.has('prayer_items')).toBe(true);
    for (const table of ['group_files', 'prayer_items']) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; notnull: number; dflt_value: string | null }>();
      expect(results.find((c) => c.name === 'campus_id'), table).toMatchObject({ notnull: 1, dflt_value: '1' });
    }
  });

  it('keeps Registration tables off D1 and prayer_items.reg_event_id a plain column', async () => {
    const names = await tableNames();
    for (const table of ['reg_events', 'reg_event_i18n', 'registrations', 'event_admins']) expect(names.has(table), table).toBe(false);
    const { results } = await env.DB.prepare('PRAGMA foreign_key_list(prayer_items)').all<{ from: string }>();
    expect(results.map((r) => r.from).sort()).toEqual(['approved_by', 'author_person_id', 'group_id']);
  });

  it('accepts a NULL reg_event_id insert even though reg_events does not exist', async () => {
    const row = await env.DB
      .prepare(`INSERT INTO prayer_items (author_person_id, scope, body) VALUES (1, 'church', 'hello') RETURNING id, reg_event_id, campus_id, status`)
      .first<{ id: number; reg_event_id: number | null; campus_id: number; status: string }>();
    expect(row).toMatchObject({ reg_event_id: null, campus_id: 1, status: 'pending' });
  });
});

describe('prayerDb with registration off (no reg_* / event_admins tables)', () => {
  it('posts, lists, approves and deletes church, group and private prayers', async () => {
    await env.DB.prepare(`INSERT INTO groups (id, name) VALUES (1, 'Alpha')`).run();
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (1, 2, 'Person 2', 1), (1, 3, 'Person 3', 0)`).run();

    const church = await postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'church', body: 'church', ...OFF });
    const group = await postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'group', groupId: 1, body: 'group', ...OFF });
    const priv = await postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'private', body: 'private', ...OFF });

    const pendingForAdmin = await listPendingForApprover(env.DB, 1, { isSuperAdmin: true }, 'en', OFF);
    expect(pendingForAdmin.map((i) => i.id).sort()).toEqual([church, group].sort());
    expect(pendingForAdmin.every((i) => i.event_title === null)).toBe(true);
    // A group admin sees only their group's item.
    const pendingForGroupAdmin = await listPendingForApprover(env.DB, 2, { isSuperAdmin: false }, 'en', OFF);
    expect(pendingForGroupAdmin.map((i) => i.id)).toEqual([group]);

    expect(await decidePrayerItem(env.DB, { itemId: church, approve: true, approverId: 1, moderator: { isSuperAdmin: true }, ...OFF })).toBe(true);
    expect(await decidePrayerItem(env.DB, { itemId: group, approve: true, approverId: 2, moderator: { isSuperAdmin: false }, ...OFF })).toBe(true);
    await expect(
      decidePrayerItem(env.DB, { itemId: church, approve: true, approverId: 2, moderator: { isSuperAdmin: false }, ...OFF }),
    ).rejects.toThrow('not_authorized');

    expect((await listChurchPrayers(env.DB, 'en', OFF)).map((i) => i.id)).toEqual([church]);
    expect((await listGroupPrayersForPerson(env.DB, 3, 'en', OFF)).map((i) => i.id)).toEqual([group]);
    expect((await listMyPrayerItems(env.DB, 3, 'en', OFF)).map((i) => i.id).sort()).toEqual([church, group, priv].sort());
    expect(await listEventPrayersForPerson(env.DB, 3, 'p3@example.com', 'en', OFF)).toEqual([]);

    expect(await deletePrayerItem(env.DB, { itemId: priv, actorId: 3, moderator: { isSuperAdmin: false }, ...OFF })).toBe(true);
  });

  it("rejects scope='event' before reading any Registration table", async () => {
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'event', regEventId: 5, body: 'x', ...OFF }),
    ).rejects.toThrow('invalid');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM prayer_items').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('does not let a limited admin moderate a legacy event item without Registration', async () => {
    const id = (await env.DB
      .prepare(`INSERT INTO prayer_items (author_person_id, scope, reg_event_id, body) VALUES (1, 'event', 9, 'legacy') RETURNING id`)
      .first<{ id: number }>())!.id;
    await expect(
      decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 2, moderator: { isSuperAdmin: false }, ...OFF }),
    ).rejects.toThrow('not_authorized');
    expect(await decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 1, moderator: { isSuperAdmin: true }, ...OFF })).toBe(true);
  });
});
