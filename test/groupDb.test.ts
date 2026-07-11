// groupDb (workers project, live D1). Groups CRUD + soft delete, membership
// (real person, name-only, inline email reuse/create), join-request lifecycle
// incl. duplicate-pending race, visibility queries, scoped people search, and the
// profile person-activity read.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMemberByPerson,
  addMemberInline,
  createGroup,
  createJoinRequest,
  decideJoinRequest,
  getGroup,
  isGroupAdmin,
  listGroups,
  listGroupsForPerson,
  listJoinRequests,
  listMembers,
  listPersonGroupActivity,
  listPublicGroups,
  removeMember,
  searchPeopleForGroup,
  setMemberAdmin,
  softDeleteGroup,
  updateGroup,
} from '../src/lib/groupDb';

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_attendance'),
    env.DB.prepare('DELETE FROM group_attendance_tokens'),
    env.DB.prepare('DELETE FROM group_event_occurrences'),
    env.DB.prepare('DELETE FROM group_events'),
    env.DB.prepare('DELETE FROM group_join_requests'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.batch(
    [1, 2, 3, 4].map((id) =>
      env.DB.prepare('INSERT INTO people (id, display_name, email, role) VALUES (?, ?, ?, ?)').bind(
        id,
        `Person ${id}`,
        `p${id}@example.com`,
        id === 1 ? 'admin' : 'member',
      ),
    ),
  );
}
beforeEach(reset);

const G = {
  name: 'Young Adults', description: 'Grow together', isPublic: true,
  kind: 'fellowship' as const, termLabel: null, termStart: null, termEnd: null,
};

describe('groups CRUD + visibility', () => {
  it('creates, reads, updates, and soft-deletes a group', async () => {
    const id = await createGroup(env.DB, G);
    const g = await getGroup(env.DB, id);
    expect(g).toMatchObject({ name: 'Young Adults', is_public: 1 });

    expect(await updateGroup(env.DB, id, { ...G, name: 'YA', description: 'x', isPublic: false })).toBe(true);
    expect((await getGroup(env.DB, id))!.is_public).toBe(0);

    await softDeleteGroup(env.DB, id);
    expect(await getGroup(env.DB, id)).toBeNull();
  });

  it('listGroups counts active members; listPublicGroups hides private + deleted', async () => {
    const pub = await createGroup(env.DB, G);
    const priv = await createGroup(env.DB, { ...G, name: 'Prayer', description: '', isPublic: false });
    await addMemberByPerson(env.DB, pub, 1);
    await addMemberByPerson(env.DB, pub, 2);

    const admin = await listGroups(env.DB);
    expect(admin.map((g) => g.name)).toEqual(['Prayer', 'Young Adults']);
    expect(admin.find((g) => g.id === pub)!.member_count).toBe(2);

    const publicOnly = await listPublicGroups(env.DB);
    expect(publicOnly.map((g) => g.name)).toEqual(['Young Adults']);
    void priv;
  });
});

describe('membership', () => {
  it('addMemberByPerson is idempotent for an active member', async () => {
    const id = await createGroup(env.DB, G);
    const m1 = await addMemberByPerson(env.DB, id, 2);
    const m2 = await addMemberByPerson(env.DB, id, 2);
    expect(m1).toBe(m2);
    expect((await listMembers(env.DB, id))).toHaveLength(1);
  });

  it('addMemberInline creates a name-only member when no email is given', async () => {
    const id = await createGroup(env.DB, G);
    const memberId = await addMemberInline(env.DB, id, { firstName: 'Hannah', lastName: 'Guest', email: null, phone: '555' });
    const member = (await listMembers(env.DB, id)).find((m) => m.id === memberId)!;
    expect(member).toMatchObject({ person_id: null, display_name: 'Hannah Guest', phone: '555' });
  });

  it('addMemberInline REUSES an existing person by (lowercased) email', async () => {
    const id = await createGroup(env.DB, G);
    const memberId = await addMemberInline(env.DB, id, { firstName: 'Person', lastName: '3', email: 'P3@Example.com', phone: null });
    const member = (await listMembers(env.DB, id)).find((m) => m.id === memberId)!;
    expect(member.person_id).toBe(3); // reused, no new people row
    const people = await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<{ n: number }>();
    expect(people?.n).toBe(4);
  });

  it('addMemberInline CREATES a new person when the email is unknown', async () => {
    const id = await createGroup(env.DB, G);
    const memberId = await addMemberInline(env.DB, id, { firstName: 'New', lastName: 'Bie', email: 'newbie@example.com', phone: null });
    const member = (await listMembers(env.DB, id)).find((m) => m.id === memberId)!;
    const created = await env.DB.prepare("SELECT id, role, membership_status FROM people WHERE email = 'newbie@example.com'").first<{
      id: number;
      role: string;
      membership_status: string;
    }>();
    expect(created).toMatchObject({ role: 'member', membership_status: 'visitor' });
    expect(member.person_id).toBe(created!.id);
  });

  it('removeMember hides the row; a person can be re-added afterward', async () => {
    const id = await createGroup(env.DB, G);
    const m = await addMemberByPerson(env.DB, id, 2);
    expect(await removeMember(env.DB, m)).toBe(true);
    expect(await listMembers(env.DB, id)).toHaveLength(0);
    const again = await addMemberByPerson(env.DB, id, 2); // partial unique index only spans active rows
    expect(again).not.toBe(m);
    expect(await listMembers(env.DB, id)).toHaveLength(1);
  });

  it('setMemberAdmin + isGroupAdmin, and listGroupsForPerson surfaces the admin flag', async () => {
    const id = await createGroup(env.DB, { ...G, name: 'Private', description: '', isPublic: false });
    const m = await addMemberByPerson(env.DB, id, 2);
    expect(await isGroupAdmin(env.DB, id, 2)).toBe(false);
    expect(await setMemberAdmin(env.DB, m, true)).toBe(true);
    expect(await isGroupAdmin(env.DB, id, 2)).toBe(true);

    const mine = await listGroupsForPerson(env.DB, 2);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id, is_admin: 1, is_public: 0 });
  });

  it('listMembers orders admins first, then by name', async () => {
    const id = await createGroup(env.DB, G);
    await addMemberByPerson(env.DB, id, 2);
    const adminMember = await addMemberByPerson(env.DB, id, 3);
    await setMemberAdmin(env.DB, adminMember, true);
    const names = (await listMembers(env.DB, id)).map((m) => m.display_name);
    expect(names[0]).toBe('Person 3'); // admin first
  });
});

describe('join requests', () => {
  it('runs the full lifecycle and is idempotent on duplicate pending', async () => {
    const id = await createGroup(env.DB, G);
    expect(await createJoinRequest(env.DB, id, 2)).toBe('created');
    expect(await createJoinRequest(env.DB, id, 2)).toBe('pending'); // duplicate-pending race → idempotent

    const pending = await listJoinRequests(env.DB, id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ person_id: 2, email: 'p2@example.com' });

    expect(await decideJoinRequest(env.DB, pending[0].id, true, 1)).toBe(true);
    expect(await listJoinRequests(env.DB, id)).toHaveLength(0); // decided
    expect(await isGroupAdmin(env.DB, id, 2)).toBe(false);
    expect((await listMembers(env.DB, id)).some((m) => m.person_id === 2)).toBe(true); // approved → member

    // Deciding an already-decided request is a no-op.
    expect(await decideJoinRequest(env.DB, pending[0].id, true, 1)).toBe(false);
  });

  it('returns already_member when the requester already belongs', async () => {
    const id = await createGroup(env.DB, G);
    await addMemberByPerson(env.DB, id, 2);
    expect(await createJoinRequest(env.DB, id, 2)).toBe('already_member');
  });

  it('reject marks the request rejected without adding a member', async () => {
    const id = await createGroup(env.DB, G);
    await createJoinRequest(env.DB, id, 3);
    const [req] = await listJoinRequests(env.DB, id);
    expect(await decideJoinRequest(env.DB, req.id, false, 1)).toBe(true);
    expect(await listMembers(env.DB, id)).toHaveLength(0);
    const row = await env.DB.prepare('SELECT status FROM group_join_requests WHERE id = ?').bind(req.id).first<{ status: string }>();
    expect(row?.status).toBe('rejected');
  });
});

describe('searchPeopleForGroup', () => {
  it('matches name/email case-insensitively and escapes LIKE wildcards', async () => {
    const hits = await searchPeopleForGroup(env.DB, 'PERSON 2');
    expect(hits.map((h) => h.email)).toEqual(['p2@example.com']);
    // A literal '%' matches itself — nothing here has one.
    expect(await searchPeopleForGroup(env.DB, '%')).toHaveLength(0);
    expect(await searchPeopleForGroup(env.DB, '  ')).toHaveLength(0);
  });
});

describe('listPersonGroupActivity', () => {
  it('returns memberships and attendance history for a person', async () => {
    const id = await createGroup(env.DB, G);
    const m = await addMemberByPerson(env.DB, id, 2);
    const ev = await env.DB
      .prepare(
        `INSERT INTO group_events (group_id, title, recurrence, starts_on, start_time, track_attendance)
         VALUES (?1, 'Study', 'weekly', '2030-06-07', '19:00', 1) RETURNING id`,
      )
      .bind(id)
      .first<{ id: number }>();
    const occ = await env.DB
      .prepare(
        `INSERT INTO group_event_occurrences (event_id, occurs_on, starts_at, ends_at)
         VALUES (?1, '2030-06-07', '2030-06-08 00:00:00', '2030-06-08 01:30:00') RETURNING id`,
      )
      .bind(ev!.id)
      .first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (?1, ?2, 1)`).bind(occ!.id, m).run();

    const activity = await listPersonGroupActivity(env.DB, 2);
    expect(activity.memberships).toEqual([{ group_id: id, group_name: 'Young Adults', is_admin: 0 }]);
    expect(activity.attendance).toEqual([
      { group_name: 'Young Adults', event_title: 'Study', occurs_on: '2030-06-07', present: 1 },
    ]);
  });
});
