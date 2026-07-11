// prayerDb (workers project, live D1 unit harness). Covers the prayer-wall data
// layer: post eligibility per scope, scoped tab visibility, the approver's
// moderation queue, decide/delete authority, and the event_admins helpers.
// prayer_items/event_admins and the reg_events/reg_event_i18n/registrations and
// group_members they lean on are Supabase-only (migrations-supabase/
// 0007_member_portal.sql / 0003_registration.sql have no D1 counterpart), so per
// groupDb.test.ts's documented fallback we CREATE TABLE IF NOT EXISTS them here,
// matching the PG DDL minus identity (plain INTEGER PRIMARY KEY). member_groups/
// member_group_i18n/people already exist in the D1 schema. The real PG DDL is
// covered by the pg e2e suite (Task 6).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEventAdmin,
  decidePrayerItem,
  deletePrayerItem,
  isEventAdmin,
  listChurchPrayers,
  listEventAdmins,
  listEventPrayersForPerson,
  listGroupPrayersForPerson,
  listMyPrayerItems,
  listPendingForApprover,
  postPrayerItem,
  removeEventAdmin,
  type PrayerScope,
} from '../src/lib/prayerDb';

await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS group_members (
     id INTEGER PRIMARY KEY,
     group_id INTEGER NOT NULL REFERENCES member_groups(id),
     person_id INTEGER NOT NULL REFERENCES people(id),
     is_leader INTEGER NOT NULL DEFAULT 0,
     joined_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (group_id, person_id)
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS reg_events (
     id INTEGER PRIMARY KEY,
     starts_at TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS reg_event_i18n (
     event_id INTEGER NOT NULL REFERENCES reg_events(id),
     locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
     title TEXT NOT NULL,
     description TEXT,
     PRIMARY KEY (event_id, locale)
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS registrations (
     id INTEGER PRIMARY KEY,
     event_id INTEGER NOT NULL REFERENCES reg_events(id),
     person_id INTEGER REFERENCES people(id),
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
     amount_cents INTEGER NOT NULL DEFAULT 0,
     currency TEXT NOT NULL DEFAULT 'usd',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS event_admins (
     id INTEGER PRIMARY KEY,
     reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
     person_id INTEGER NOT NULL REFERENCES people(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (reg_event_id, person_id)
   )`,
).run();
await env.DB.prepare(
  `CREATE TABLE IF NOT EXISTS prayer_items (
     id INTEGER PRIMARY KEY,
     author_person_id INTEGER NOT NULL REFERENCES people(id),
     scope TEXT NOT NULL CHECK (scope IN ('church','group','event','private')),
     group_id INTEGER REFERENCES member_groups(id),
     reg_event_id INTEGER REFERENCES reg_events(id),
     body TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
     approved_by INTEGER REFERENCES people(id),
     approved_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     deleted_at TEXT
   )`,
).run();

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prayer_items'),
    env.DB.prepare('DELETE FROM event_admins'),
    env.DB.prepare('DELETE FROM registrations'),
    env.DB.prepare('DELETE FROM reg_event_i18n'),
    env.DB.prepare('DELETE FROM reg_events'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM member_group_i18n'),
    env.DB.prepare('DELETE FROM member_groups'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const rows = [1, 2, 3, 4, 5, 6].map((id) =>
    env.DB.prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)').bind(id, `Person ${id}`, `p${id}@example.com`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

// ── seed helpers ──────────────────────────────────────────────────────────────
async function seedGroup(id: number, slug: string, nameEn: string, nameZh?: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO member_groups (id, slug, kind, active, sort) VALUES (?, ?, 'fellowship', 1, 0)`).bind(id, slug).run();
  await env.DB.prepare(`INSERT INTO member_group_i18n (group_id, locale, name) VALUES (?, 'en', ?)`).bind(id, nameEn).run();
  if (nameZh) await env.DB.prepare(`INSERT INTO member_group_i18n (group_id, locale, name) VALUES (?, 'zh', ?)`).bind(id, nameZh).run();
}
async function addMember(groupId: number, personId: number, isLeader = false): Promise<void> {
  await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, is_leader) VALUES (?, ?, ?)`).bind(groupId, personId, isLeader ? 1 : 0).run();
}
async function seedEvent(id: number, titleEn: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO reg_events (id, starts_at) VALUES (?, '2026-09-01 09:00:00')`).bind(id).run();
  await env.DB.prepare(`INSERT INTO reg_event_i18n (event_id, locale, title) VALUES (?, 'en', ?)`).bind(id, titleEn).run();
}
async function register(eventId: number, personId: number | null, email: string, status = 'confirmed'): Promise<void> {
  await env.DB.prepare(`INSERT INTO registrations (event_id, person_id, name, email, status) VALUES (?, ?, 'Reg', ?, ?)`).bind(eventId, personId, email, status).run();
}
async function insertPrayer(opts: {
  author?: number;
  scope: PrayerScope;
  group_id?: number | null;
  event_id?: number | null;
  body?: string;
  status?: 'pending' | 'approved' | 'rejected';
  deleted?: boolean;
}): Promise<number> {
  const r = await env.DB
    .prepare(
      `INSERT INTO prayer_items (author_person_id, scope, group_id, reg_event_id, body, status, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      opts.author ?? 1,
      opts.scope,
      opts.group_id ?? null,
      opts.event_id ?? null,
      opts.body ?? 'pray for me',
      opts.status ?? 'approved',
      opts.deleted ? '2026-01-01 00:00:00' : null,
    )
    .first<{ id: number }>();
  return r!.id;
}
async function statusOf(id: number): Promise<string | undefined> {
  const r = await env.DB.prepare('SELECT status FROM prayer_items WHERE id = ?').bind(id).first<{ status: string }>();
  return r?.status;
}

// ── postPrayerItem: eligibility per scope ──────────────────────────────────────
describe('postPrayerItem', () => {
  it('church: any signed-in member may post; enters pending', async () => {
    const id = await postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'church', body: 'heal us' });
    expect(await statusOf(id)).toBe('pending');
  });

  it('private: auto-approved', async () => {
    const id = await postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'private', body: 'secret' });
    expect(await statusOf(id)).toBe('approved');
  });

  it('group: a member may post (pending); a non-member is not_eligible', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 1);
    const id = await postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'group', groupId: 10, body: 'group pray' });
    expect(await statusOf(id)).toBe('pending');
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'group', groupId: 10, body: 'nope' }),
    ).rejects.toThrow('not_eligible');
  });

  it('event: a registrant (by person_id) may post; enters pending', async () => {
    await seedEvent(20, 'Retreat');
    await register(20, 4, 'p4@example.com');
    const id = await postPrayerItem(env.DB, { authorPersonId: 4, authorEmail: 'p4@example.com', scope: 'event', regEventId: 20, body: 'event pray' });
    expect(await statusOf(id)).toBe('pending');
  });

  it('event: a registrant matched by email (no person_id link) may post', async () => {
    await seedEvent(20, 'Retreat');
    await register(20, null, 'P4@EXAMPLE.COM'); // anonymous, case-different email
    const id = await postPrayerItem(env.DB, { authorPersonId: 4, authorEmail: 'p4@example.com', scope: 'event', regEventId: 20, body: 'via email' });
    expect(await statusOf(id)).toBe('pending');
  });

  it('event: an event admin (not registered) may post', async () => {
    await seedEvent(20, 'Retreat');
    await addEventAdmin(env.DB, 20, 5);
    const id = await postPrayerItem(env.DB, { authorPersonId: 5, authorEmail: 'p5@example.com', scope: 'event', regEventId: 20, body: 'admin pray' });
    expect(await statusOf(id)).toBe('pending');
  });

  it('event: an unregistered non-admin is not_eligible', async () => {
    await seedEvent(20, 'Retreat');
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 3, authorEmail: 'p3@example.com', scope: 'event', regEventId: 20, body: 'nope' }),
    ).rejects.toThrow('not_eligible');
  });

  it('event: a cancelled registration does not confer eligibility', async () => {
    await seedEvent(20, 'Retreat');
    await register(20, 4, 'p4@example.com', 'cancelled');
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 4, authorEmail: 'p4@example.com', scope: 'event', regEventId: 20, body: 'nope' }),
    ).rejects.toThrow('not_eligible');
  });

  it('rejects too_long past 2000 chars', async () => {
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'church', body: 'x'.repeat(2001) }),
    ).rejects.toThrow('too_long');
    // exactly 2000 is allowed
    const id = await postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'church', body: 'x'.repeat(2000) });
    expect(await statusOf(id)).toBe('pending');
  });

  it('rejects a blank body as invalid', async () => {
    await expect(
      postPrayerItem(env.DB, { authorPersonId: 1, authorEmail: 'p1@example.com', scope: 'church', body: '   ' }),
    ).rejects.toThrow('invalid');
  });

  it('rejects scope/id mismatches as invalid', async () => {
    const base = { authorPersonId: 1, authorEmail: 'p1@example.com', body: 'x' };
    await expect(postPrayerItem(env.DB, { ...base, scope: 'group' })).rejects.toThrow('invalid'); // group without groupId
    await expect(postPrayerItem(env.DB, { ...base, scope: 'group', groupId: 10, regEventId: 20 })).rejects.toThrow('invalid'); // group carries an event
    await expect(postPrayerItem(env.DB, { ...base, scope: 'event' })).rejects.toThrow('invalid'); // event without regEventId
    await expect(postPrayerItem(env.DB, { ...base, scope: 'church', groupId: 10 })).rejects.toThrow('invalid'); // church carries a group
    await expect(postPrayerItem(env.DB, { ...base, scope: 'private', regEventId: 20 })).rejects.toThrow('invalid'); // private carries an event
  });
});

// ── tab visibility ─────────────────────────────────────────────────────────────
describe('listChurchPrayers', () => {
  it('shows approved church items newest first; hides pending/rejected/deleted', async () => {
    const first = await insertPrayer({ scope: 'church', status: 'approved', body: 'first' });
    const second = await insertPrayer({ scope: 'church', status: 'approved', body: 'second' });
    await insertPrayer({ scope: 'church', status: 'pending' });
    await insertPrayer({ scope: 'church', status: 'rejected' });
    await insertPrayer({ scope: 'church', status: 'approved', deleted: true });
    const rows = await listChurchPrayers(env.DB, 'en');
    expect(rows.map((r) => r.id)).toEqual([second, first]); // newest first
  });

  it('does not leak private items into the church tab', async () => {
    await insertPrayer({ scope: 'private', status: 'approved' });
    expect(await listChurchPrayers(env.DB, 'en')).toEqual([]);
  });

  it('localizes the author name (display_name)', async () => {
    await insertPrayer({ author: 2, scope: 'church', status: 'approved' });
    const [row] = await listChurchPrayers(env.DB, 'en');
    expect(row.author_name).toBe('Person 2');
    expect(row.group_name).toBeNull();
    expect(row.event_title).toBeNull();
  });
});

describe('listGroupPrayersForPerson', () => {
  it('a member sees the localized group items; a non-member sees none', async () => {
    await seedGroup(10, 'g10', 'Grace', '恩典');
    await addMember(10, 1);
    await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'approved' });
    const mine = await listGroupPrayersForPerson(env.DB, 1, 'zh');
    expect(mine).toHaveLength(1);
    expect(mine[0].group_name).toBe('恩典');
    expect(await listGroupPrayersForPerson(env.DB, 3, 'zh')).toEqual([]); // person 3 not a member
  });

  it('hides pending group items from the tab', async () => {
    await seedGroup(10, 'g10', 'Grace');
    await addMember(10, 1);
    await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    expect(await listGroupPrayersForPerson(env.DB, 1, 'en')).toEqual([]);
  });
});

describe('listEventPrayersForPerson', () => {
  it('a registrant sees the event items; an unregistered non-admin sees none', async () => {
    await seedEvent(20, 'Retreat');
    await register(20, 4, 'p4@example.com');
    await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'approved' });
    const mine = await listEventPrayersForPerson(env.DB, 4, 'p4@example.com', 'en');
    expect(mine).toHaveLength(1);
    expect(mine[0].event_title).toBe('Retreat');
    expect(await listEventPrayersForPerson(env.DB, 3, 'p3@example.com', 'en')).toEqual([]);
  });

  it('an event admin sees the event items even without a registration', async () => {
    await seedEvent(20, 'Retreat');
    await addEventAdmin(env.DB, 20, 5);
    await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'approved' });
    const mine = await listEventPrayersForPerson(env.DB, 5, 'p5@example.com', 'en');
    expect(mine).toHaveLength(1);
  });

  it('matches a registrant by case-insensitive email with no person_id link', async () => {
    await seedEvent(20, 'Retreat');
    await register(20, null, 'P4@EXAMPLE.COM');
    await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'approved' });
    const mine = await listEventPrayersForPerson(env.DB, 4, 'p4@example.com', 'en');
    expect(mine).toHaveLength(1);
  });
});

describe('listMyPrayerItems', () => {
  it('returns all own items (private/pending/rejected/approved, any scope), newest first; excludes others and deleted', async () => {
    await seedGroup(10, 'g10', 'Grace');
    await addMember(10, 1);
    const a = await insertPrayer({ author: 1, scope: 'private', status: 'approved' });
    const b = await insertPrayer({ author: 1, scope: 'church', status: 'pending' });
    const c = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'rejected' });
    await insertPrayer({ author: 1, scope: 'church', status: 'approved', deleted: true }); // hidden
    await insertPrayer({ author: 2, scope: 'church', status: 'approved' }); // someone else
    const mine = await listMyPrayerItems(env.DB, 1, 'en');
    expect(mine.map((r) => r.id)).toEqual([c, b, a]); // newest first
    expect(mine.map((r) => r.status).sort()).toEqual(['approved', 'pending', 'rejected']);
  });
});

// ── moderation queue ───────────────────────────────────────────────────────────
describe('listPendingForApprover', () => {
  it('a leader sees only their own group\'s pending items', async () => {
    await seedGroup(10, 'g10', 'G10');
    await seedGroup(11, 'g11', 'G11');
    await addMember(10, 2, true); // person 2 leads g10
    await addMember(11, 3, true); // person 3 leads g11
    const mine = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    await insertPrayer({ author: 1, scope: 'group', group_id: 11, status: 'pending' }); // other group
    const rows = await listPendingForApprover(env.DB, 2, false, 'en');
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it('an event admin sees only their own event\'s pending items', async () => {
    await seedEvent(20, 'E20');
    await seedEvent(21, 'E21');
    await addEventAdmin(env.DB, 20, 5);
    const mine = await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'pending' });
    await insertPrayer({ author: 4, scope: 'event', event_id: 21, status: 'pending' }); // other event
    const rows = await listPendingForApprover(env.DB, 5, false, 'en');
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it('a plain member with no leadership/admin authority sees nothing', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 1, false);
    await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    expect(await listPendingForApprover(env.DB, 1, false, 'en')).toEqual([]);
  });

  it('an admin sees every pending item (church + group + event), oldest first; approved excluded', async () => {
    await seedGroup(10, 'g10', 'G10');
    await seedEvent(20, 'E20');
    const c = await insertPrayer({ scope: 'church', status: 'pending' });
    const g = await insertPrayer({ scope: 'group', group_id: 10, status: 'pending' });
    const e = await insertPrayer({ scope: 'event', event_id: 20, status: 'pending' });
    await insertPrayer({ scope: 'church', status: 'approved' }); // excluded
    const rows = await listPendingForApprover(env.DB, 999, true, 'en');
    expect(rows.map((r) => r.id)).toEqual([c, g, e]); // oldest first (insertion order)
  });
});

// ── decide ──────────────────────────────────────────────────────────────────────
describe('decidePrayerItem', () => {
  it('a leader approves their own group item; a double-decide is a no-op', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 2, true);
    const id = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    expect(await decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 2, isAdmin: false })).toBe(true);
    expect(await statusOf(id)).toBe('approved');
    expect(await decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 2, isAdmin: false })).toBe(false); // already decided
  });

  it('a leader rejects their own group item', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 2, true);
    const id = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    expect(await decidePrayerItem(env.DB, { itemId: id, approve: false, approverId: 2, isAdmin: false })).toBe(true);
    expect(await statusOf(id)).toBe('rejected');
  });

  it('a leader of another group is not_authorized', async () => {
    await seedGroup(10, 'g10', 'G10');
    await seedGroup(11, 'g11', 'G11');
    await addMember(11, 3, true); // person 3 leads g11, not g10
    const id = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    await expect(decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 3, isAdmin: false })).rejects.toThrow('not_authorized');
    expect(await statusOf(id)).toBe('pending');
  });

  it('a non-leader member of the group is not_authorized', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 1, false);
    const id = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'pending' });
    await expect(decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 1, isAdmin: false })).rejects.toThrow('not_authorized');
  });

  it('an event admin decides their own event item; another event\'s admin cannot', async () => {
    await seedEvent(20, 'E20');
    await seedEvent(21, 'E21');
    await addEventAdmin(env.DB, 20, 5);
    await addEventAdmin(env.DB, 21, 6);
    const id = await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'pending' });
    await expect(decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 6, isAdmin: false })).rejects.toThrow('not_authorized');
    expect(await decidePrayerItem(env.DB, { itemId: id, approve: true, approverId: 5, isAdmin: false })).toBe(true);
  });

  it('an admin decides any scope, church included; a non-admin cannot touch church', async () => {
    const church = await insertPrayer({ scope: 'church', status: 'pending' });
    await expect(decidePrayerItem(env.DB, { itemId: church, approve: true, approverId: 3, isAdmin: false })).rejects.toThrow('not_authorized');
    expect(await decidePrayerItem(env.DB, { itemId: church, approve: true, approverId: 6, isAdmin: true })).toBe(true);
    expect(await statusOf(church)).toBe('approved');
  });

  it('returns false for a missing item', async () => {
    expect(await decidePrayerItem(env.DB, { itemId: 12345, approve: true, approverId: 999, isAdmin: true })).toBe(false);
  });
});

// ── delete ──────────────────────────────────────────────────────────────────────
describe('deletePrayerItem', () => {
  it('the author soft-deletes their own item (drops out of the tab and my-list)', async () => {
    const id = await insertPrayer({ author: 1, scope: 'church', status: 'approved' });
    expect(await deletePrayerItem(env.DB, { itemId: id, actorId: 1, isAdmin: false })).toBe(true);
    expect(await listChurchPrayers(env.DB, 'en')).toEqual([]);
    expect(await listMyPrayerItems(env.DB, 1, 'en')).toEqual([]);
  });

  it('a group leader deletes a group item they moderate', async () => {
    await seedGroup(10, 'g10', 'G10');
    await addMember(10, 2, true);
    const id = await insertPrayer({ author: 1, scope: 'group', group_id: 10, status: 'approved' });
    expect(await deletePrayerItem(env.DB, { itemId: id, actorId: 2, isAdmin: false })).toBe(true);
  });

  it('an event admin deletes an event item they moderate', async () => {
    await seedEvent(20, 'E20');
    await addEventAdmin(env.DB, 20, 5);
    const id = await insertPrayer({ author: 4, scope: 'event', event_id: 20, status: 'approved' });
    expect(await deletePrayerItem(env.DB, { itemId: id, actorId: 5, isAdmin: false })).toBe(true);
  });

  it('an admin deletes any item', async () => {
    const id = await insertPrayer({ author: 1, scope: 'church', status: 'approved' });
    expect(await deletePrayerItem(env.DB, { itemId: id, actorId: 999, isAdmin: true })).toBe(true);
  });

  it('an unrelated member is not_authorized', async () => {
    const id = await insertPrayer({ author: 1, scope: 'church', status: 'approved' });
    await expect(deletePrayerItem(env.DB, { itemId: id, actorId: 3, isAdmin: false })).rejects.toThrow('not_authorized');
  });

  it('returns false for a missing or already-deleted item', async () => {
    expect(await deletePrayerItem(env.DB, { itemId: 12345, actorId: 999, isAdmin: true })).toBe(false);
    const id = await insertPrayer({ author: 1, scope: 'church', status: 'approved', deleted: true });
    expect(await deletePrayerItem(env.DB, { itemId: id, actorId: 1, isAdmin: false })).toBe(false);
  });
});

// ── event_admins helpers ─────────────────────────────────────────────────────────
describe('event_admins helpers', () => {
  it('adds (idempotently), lists name-sorted excluding deleted people, checks, and removes', async () => {
    await seedEvent(20, 'E20');
    await addEventAdmin(env.DB, 20, 5);
    await addEventAdmin(env.DB, 20, 2);
    await addEventAdmin(env.DB, 20, 5); // dedupe: no-op, no error

    let admins = await listEventAdmins(env.DB, 20);
    expect(admins.map((a) => a.person_id)).toEqual([2, 5]); // Person 2 < Person 5 by name
    expect(admins[0].display_name).toBe('Person 2');

    expect(await isEventAdmin(env.DB, 20, 5)).toBe(true);
    expect(await isEventAdmin(env.DB, 20, 3)).toBe(false);

    // soft-deleted person drops out of the roster
    await env.DB.prepare(`UPDATE people SET deleted_at = datetime('now') WHERE id = ?`).bind(2).run();
    admins = await listEventAdmins(env.DB, 20);
    expect(admins.map((a) => a.person_id)).toEqual([5]);

    await removeEventAdmin(env.DB, 20, 5);
    expect(await isEventAdmin(env.DB, 20, 5)).toBe(false);
    expect(await listEventAdmins(env.DB, 20)).toEqual([]);
  });
});
