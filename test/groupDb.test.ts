// groupDb (workers project, live D1). Covers Task 1's group data layer: public/
// portal group listings + localized fallback, admin CRUD (slug_taken), and the
// membership/application flows. member_groups/member_group_i18n come from the D1
// migration (migrations/0007_member_portal.sql); group_members/group_applications
// are Supabase-only (migrations-supabase/0006_member_portal.sql has no D1
// counterpart) — no CREATE-TABLE precedent exists for fabricating Supabase-only
// tables in the SQLite unit harness elsewhere in test/, so per the task brief's
// documented fallback we CREATE TABLE IF NOT EXISTS them here, matching the PG
// DDL minus identity (plain INTEGER PRIMARY KEY). The real PG DDL is covered by
// the pg e2e suite (Task 6).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addGroupMember,
  applyToGroup,
  decideGroupApplication,
  getGroup,
  getGroupAdmin,
  getGroupBySlug,
  hasPendingGroupApplication,
  isGroupLeader,
  isGroupMember,
  listGroupMembers,
  listGroups,
  listGroupsAdmin,
  listMeetingOccurrencesForPerson,
  listMyGroups,
  listPendingApplicationsForGroups,
  removeGroupMember,
  saveGroup,
  setGroupLeader,
  softDeleteGroup,
  type GroupInput,
} from '../src/lib/groupDb';

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
  `CREATE TABLE IF NOT EXISTS group_applications (
     id INTEGER PRIMARY KEY,
     group_id INTEGER NOT NULL REFERENCES member_groups(id),
     person_id INTEGER NOT NULL REFERENCES people(id),
     status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
     note TEXT,
     decided_by INTEGER REFERENCES people(id),
     decided_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
).run();

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_applications'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM member_group_i18n'),
    env.DB.prepare('DELETE FROM member_groups'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const rows = [1, 2, 3, 4].map((id) =>
    env.DB
      .prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)')
      .bind(id, `Person ${id}`, `p${id}@example.com`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

const baseInput: GroupInput = {
  slug: 'fellowship-1',
  kind: 'fellowship',
  termLabel: null,
  termStart: null,
  termEnd: null,
  meetingWeekday: 0,
  meetingTime: '10:00',
  meetingFrequency: 'weekly',
  meetingLocation: 'Room 1',
  openSignup: true,
  active: true,
  sort: 1,
  nameEn: 'Grace Fellowship',
  nameZh: '恩典团契',
  descEn: 'A fellowship group',
  descZh: null,
};

describe('listGroups', () => {
  it('falls back to en when the zh i18n row is missing', async () => {
    await saveGroup(env.DB, null, { ...baseInput, nameZh: null });
    const [en] = await listGroups(env.DB, 'en');
    const [zh] = await listGroups(env.DB, 'zh');
    expect(en.name).toBe('Grace Fellowship');
    expect(zh.name).toBe('Grace Fellowship'); // no zh row -> en fallback
  });

  it('uses the localized name when present', async () => {
    await saveGroup(env.DB, null, baseInput);
    const [zh] = await listGroups(env.DB, 'zh');
    expect(zh.name).toBe('恩典团契');
  });

  it('filters by kind', async () => {
    await saveGroup(env.DB, null, { ...baseInput, slug: 'f-1', kind: 'fellowship' });
    await saveGroup(env.DB, null, { ...baseInput, slug: 's-1', kind: 'sunday_school', nameEn: 'Sunday School' });
    const fellowships = await listGroups(env.DB, 'en', { kind: 'fellowship' });
    const classes = await listGroups(env.DB, 'en', { kind: 'sunday_school' });
    expect(fellowships.map((g) => g.slug)).toEqual(['f-1']);
    expect(classes.map((g) => g.slug)).toEqual(['s-1']);
  });

  it('excludes inactive and soft-deleted groups', async () => {
    const activeId = await saveGroup(env.DB, null, { ...baseInput, slug: 'active-1' });
    const inactiveId = await saveGroup(env.DB, null, { ...baseInput, slug: 'inactive-1', active: false });
    const deletedId = await saveGroup(env.DB, null, { ...baseInput, slug: 'deleted-1' });
    await softDeleteGroup(env.DB, deletedId);
    const groups = await listGroups(env.DB, 'en');
    expect(groups.map((g) => g.id)).toEqual([activeId]);
    expect(groups.map((g) => g.id)).not.toContain(inactiveId);
  });

  it('orders by sort then id', async () => {
    await saveGroup(env.DB, null, { ...baseInput, slug: 'c', sort: 3, nameEn: 'C' });
    await saveGroup(env.DB, null, { ...baseInput, slug: 'a', sort: 1, nameEn: 'A' });
    await saveGroup(env.DB, null, { ...baseInput, slug: 'b', sort: 2, nameEn: 'B' });
    const groups = await listGroups(env.DB, 'en');
    expect(groups.map((g) => g.slug)).toEqual(['a', 'b', 'c']);
  });
});

describe('getGroupBySlug / getGroup', () => {
  it('finds an active group by slug; returns null for an inactive one', async () => {
    await saveGroup(env.DB, null, { ...baseInput, slug: 'active-1' });
    await saveGroup(env.DB, null, { ...baseInput, slug: 'inactive-1', active: false });
    expect((await getGroupBySlug(env.DB, 'active-1', 'en'))?.slug).toBe('active-1');
    expect(await getGroupBySlug(env.DB, 'inactive-1', 'en')).toBeNull();
    expect(await getGroupBySlug(env.DB, 'nope', 'en')).toBeNull();
  });

  it('getGroup finds an inactive group by id (admin/portal), not a deleted one', async () => {
    const id = await saveGroup(env.DB, null, { ...baseInput, active: false });
    expect((await getGroup(env.DB, id, 'en'))?.id).toBe(id);
    await softDeleteGroup(env.DB, id);
    expect(await getGroup(env.DB, id, 'en')).toBeNull();
  });
});

describe('listGroupsAdmin', () => {
  it('includes inactive groups but excludes soft-deleted ones', async () => {
    const activeId = await saveGroup(env.DB, null, { ...baseInput, slug: 'active-1' });
    const inactiveId = await saveGroup(env.DB, null, { ...baseInput, slug: 'inactive-1', active: false });
    const deletedId = await saveGroup(env.DB, null, { ...baseInput, slug: 'deleted-1' });
    await softDeleteGroup(env.DB, deletedId);
    const groups = await listGroupsAdmin(env.DB);
    expect(groups.map((g) => g.id).sort()).toEqual([activeId, inactiveId].sort());
    expect(groups.map((g) => g.id)).not.toContain(deletedId);
  });
});

describe('getGroupAdmin', () => {
  it('returns raw (uncoalesced) en/zh name and description pairs', async () => {
    const id = await saveGroup(env.DB, null, baseInput);
    const row = await getGroupAdmin(env.DB, id);
    expect(row?.name_en).toBe('Grace Fellowship');
    expect(row?.name_zh).toBe('恩典团契');
    expect(row?.desc_en).toBe('A fellowship group');
    expect(row?.desc_zh).toBeNull();
  });

  it('finds an inactive group by id, not a deleted one', async () => {
    const id = await saveGroup(env.DB, null, { ...baseInput, active: false });
    expect((await getGroupAdmin(env.DB, id))?.id).toBe(id);
    await softDeleteGroup(env.DB, id);
    expect(await getGroupAdmin(env.DB, id)).toBeNull();
  });
});

describe('saveGroup', () => {
  it('creates, then updates the same row', async () => {
    const id = await saveGroup(env.DB, null, baseInput);
    await saveGroup(env.DB, id, { ...baseInput, nameEn: 'Renamed', sort: 9 });
    const group = await getGroup(env.DB, id, 'en');
    expect(group?.name).toBe('Renamed');
    expect(group?.sort).toBe(9);
  });

  it('throws slug_taken on a duplicate slug', async () => {
    await saveGroup(env.DB, null, { ...baseInput, slug: 'dup' });
    await expect(saveGroup(env.DB, null, { ...baseInput, slug: 'dup', nameEn: 'Other' })).rejects.toThrow(
      'slug_taken',
    );
  });
});

describe('membership', () => {
  it('adds, lists (leaders first), flips leader, and removes; add is idempotent', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    await addGroupMember(env.DB, groupId, 1);
    await addGroupMember(env.DB, groupId, 2, true);
    await addGroupMember(env.DB, groupId, 1); // dedupe: no-op, no error

    let members = await listGroupMembers(env.DB, groupId);
    expect(members.map((m) => m.person_id)).toEqual([2, 1]); // leader first
    expect(members.find((m) => m.person_id === 2)?.is_leader).toBe(1);

    await setGroupLeader(env.DB, groupId, 1, true);
    members = await listGroupMembers(env.DB, groupId);
    expect(members.every((m) => m.is_leader === 1)).toBe(true);

    expect(await isGroupMember(env.DB, groupId, 1)).toBe(true);
    expect(await isGroupLeader(env.DB, groupId, 1)).toBe(true);
    expect(await isGroupMember(env.DB, groupId, 3)).toBe(false);

    await removeGroupMember(env.DB, groupId, 1);
    members = await listGroupMembers(env.DB, groupId);
    expect(members.map((m) => m.person_id)).toEqual([2]);
  });

  it('excludes inactive/soft-deleted people from the roster', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    await addGroupMember(env.DB, groupId, 1);
    await addGroupMember(env.DB, groupId, 2);
    await env.DB.prepare('UPDATE people SET active = 0 WHERE id = ?').bind(1).run();
    await env.DB.prepare(`UPDATE people SET deleted_at = datetime('now') WHERE id = ?`).bind(2).run();
    const members = await listGroupMembers(env.DB, groupId);
    expect(members).toEqual([]);
  });

  it('listMyGroups joins localized group i18n and the leader flag', async () => {
    const g1 = await saveGroup(env.DB, null, { ...baseInput, slug: 'g1', sort: 1 });
    const g2 = await saveGroup(env.DB, null, { ...baseInput, slug: 'g2', sort: 2, nameEn: 'Second', nameZh: null });
    await addGroupMember(env.DB, g1, 1, true);
    await addGroupMember(env.DB, g2, 1, false);

    const mine = await listMyGroups(env.DB, 1, 'zh');
    expect(mine.map((g) => g.id)).toEqual([g1, g2]);
    expect(mine[0].name).toBe('恩典团契');
    expect(mine[0].is_leader).toBe(1);
    expect(mine[1].name).toBe('Second'); // no zh row -> en fallback
    expect(mine[1].is_leader).toBe(0);
  });
});

describe('listMeetingOccurrencesForPerson', () => {
  it("computes occurrences across all of a person's groups, localized and sorted by date", async () => {
    const g1 = await saveGroup(env.DB, null, { ...baseInput, slug: 'g1' }); // weekly, Sunday
    const g2 = await saveGroup(env.DB, null, {
      ...baseInput,
      slug: 'g2',
      meetingWeekday: 3, // Wednesday
      meetingFrequency: 'monthly',
      meetingTime: null,
      meetingLocation: null,
      nameEn: 'Wednesday Class',
      nameZh: null,
    });
    const otherGroup = await saveGroup(env.DB, null, { ...baseInput, slug: 'g3' });
    await addGroupMember(env.DB, g1, 1, false);
    await addGroupMember(env.DB, g2, 1, false);
    await addGroupMember(env.DB, otherGroup, 2, false); // person 1 is not a member of this one

    const occurrences = await listMeetingOccurrencesForPerson(env.DB, 1, '2026-07-01', '2026-07-15', 'zh');
    expect(occurrences).toEqual([
      { date: '2026-07-01', group_id: g2, group_name: 'Wednesday Class', meeting_time: null, meeting_location: null },
      { date: '2026-07-05', group_id: g1, group_name: '恩典团契', meeting_time: '10:00', meeting_location: 'Room 1' },
      { date: '2026-07-12', group_id: g1, group_name: '恩典团契', meeting_time: '10:00', meeting_location: 'Room 1' },
    ]);
  });

  it('returns [] for a person with no groups', async () => {
    const occurrences = await listMeetingOccurrencesForPerson(env.DB, 99, '2026-07-01', '2026-07-15', 'en');
    expect(occurrences).toEqual([]);
  });
});

describe('applyToGroup', () => {
  it('creates a pending application on the happy path', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const appId = await applyToGroup(env.DB, 1, groupId, 'I would like to join');
    expect(appId).not.toBeNull();
    expect(await hasPendingGroupApplication(env.DB, 1, groupId)).toBe(true);
  });

  it('rejects with closed when open_signup is 0', async () => {
    const groupId = await saveGroup(env.DB, null, { ...baseInput, openSignup: false });
    await expect(applyToGroup(env.DB, 1, groupId, null)).rejects.toThrow('closed');
  });

  it('rejects with closed when the group is inactive', async () => {
    const groupId = await saveGroup(env.DB, null, { ...baseInput, active: false });
    await expect(applyToGroup(env.DB, 1, groupId, null)).rejects.toThrow('closed');
  });

  it('rejects with already_member when the person is already a member', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    await addGroupMember(env.DB, groupId, 1);
    await expect(applyToGroup(env.DB, 1, groupId, null)).rejects.toThrow('already_member');
  });

  it('silently no-ops (returns null) on a double-apply while pending', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const first = await applyToGroup(env.DB, 1, groupId, null);
    const second = await applyToGroup(env.DB, 1, groupId, null);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const { results } = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM group_applications WHERE person_id = ? AND group_id = ?')
      .bind(1, groupId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it('allows a re-apply after the prior application was rejected', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const firstId = await applyToGroup(env.DB, 1, groupId, null);
    await decideGroupApplication(env.DB, firstId!, false, 4);
    const secondId = await applyToGroup(env.DB, 1, groupId, 'second try');
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);
    expect(await hasPendingGroupApplication(env.DB, 1, groupId)).toBe(true);
  });
});

describe('listPendingApplicationsForGroups', () => {
  it('returns pending applications with localized group name + applicant info', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    await applyToGroup(env.DB, 1, groupId, 'note-1');
    const rows = await listPendingApplicationsForGroups(env.DB, [groupId], 'zh');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      group_id: groupId,
      person_id: 1,
      status: 'P',
      note: 'note-1',
      applicant_name: 'Person 1',
      applicant_email: 'p1@example.com',
      group_name: '恩典团契',
    });
  });

  it('returns [] for an empty group id list', async () => {
    expect(await listPendingApplicationsForGroups(env.DB, [], 'en')).toEqual([]);
  });
});

describe('decideGroupApplication', () => {
  it('approve: flips status to A and inserts a group_members row', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const appId = await applyToGroup(env.DB, 1, groupId, null);
    const result = await decideGroupApplication(env.DB, appId!, true, 4);
    expect(result).toEqual({ person_id: 1, group_id: groupId });
    expect(await isGroupMember(env.DB, groupId, 1)).toBe(true);
    const app = await env.DB.prepare('SELECT status, decided_by FROM group_applications WHERE id = ?').bind(appId).first<{
      status: string;
      decided_by: number;
    }>();
    expect(app?.status).toBe('A');
    expect(app?.decided_by).toBe(4);
  });

  it('reject: flips status to R and does not create a member row', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const appId = await applyToGroup(env.DB, 1, groupId, null);
    const result = await decideGroupApplication(env.DB, appId!, false, 4);
    expect(result).toEqual({ person_id: 1, group_id: groupId });
    expect(await isGroupMember(env.DB, groupId, 1)).toBe(false);
    const app = await env.DB.prepare('SELECT status FROM group_applications WHERE id = ?').bind(appId).first<{
      status: string;
    }>();
    expect(app?.status).toBe('R');
  });

  it('returns null for a wrong expectedGroupId', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const otherGroupId = await saveGroup(env.DB, null, { ...baseInput, slug: 'other' });
    const appId = await applyToGroup(env.DB, 1, groupId, null);
    const result = await decideGroupApplication(env.DB, appId!, true, 4, otherGroupId);
    expect(result).toBeNull();
    expect(await isGroupMember(env.DB, groupId, 1)).toBe(false);
  });

  it('returns null for an already-decided application', async () => {
    const groupId = await saveGroup(env.DB, null, baseInput);
    const appId = await applyToGroup(env.DB, 1, groupId, null);
    await decideGroupApplication(env.DB, appId!, true, 4);
    const second = await decideGroupApplication(env.DB, appId!, true, 4);
    expect(second).toBeNull();
  });
});
