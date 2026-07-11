// householdDb (workers project, live D1). Covers the interfaces Tasks 2-3
// consume: creator auto-membership, adult-member-or-admin authorization, name-only
// dependents, leave semantics (incl. last-real-member soft-delete + dependent
// cascade), one-household-per-person on link, and primary exclusivity.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDependent,
  createHousehold,
  getHousehold,
  getHouseholdForPerson,
  leaveHousehold,
  linkPersonToHousehold,
  listHouseholds,
  removeDependent,
  setMemberRole,
  setPrimary,
  unlinkPerson,
  updateHousehold,
} from '../src/lib/householdDb';
import { setOwner } from '../src/lib/portalDb';

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const rows = [1, 2, 3, 4].map((id) =>
    env.DB.prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)').bind(id, `Person ${id}`, `p${id}@example.com`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

const HH = { name: 'Chen Family', address: '1 Main St', phone: '555-1000' };

describe('createHousehold + getHouseholdForPerson', () => {
  it('adds the creator as an adult + primary member with their display_name', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const hh = await getHouseholdForPerson(env.DB, 1);
    expect(hh).not.toBeNull();
    expect(hh!.id).toBe(id);
    expect(hh!.name).toBe('Chen Family');
    expect(hh!.members).toHaveLength(1);
    expect(hh!.members[0]).toMatchObject({ person_id: 1, display_name: 'Person 1', role: 'adult', is_primary: 1 });
  });

  it('rejects creating a second household for someone already in one', async () => {
    await createHousehold(env.DB, HH, 1);
    await expect(createHousehold(env.DB, HH, 1)).rejects.toThrow('already_in_household');
  });

  it('returns null for a person in no household', async () => {
    expect(await getHouseholdForPerson(env.DB, 2)).toBeNull();
  });

  it('orders members primary → adults → children', async () => {
    const id = await createHousehold(env.DB, HH, 1); // Person 1: adult+primary
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    await addDependent(env.DB, id, 'Kiddo', 'child', 1, false);
    const hh = await getHousehold(env.DB, id);
    expect(hh!.members.map((m) => m.display_name)).toEqual(['Person 1', 'Person 2', 'Kiddo']);
  });
});

describe('updateHousehold authorization', () => {
  it('lets an adult member edit', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const ok = await updateHousehold(env.DB, id, { name: 'New Name', address: null, phone: null }, 1, false);
    expect(ok).toBe(true);
    expect((await getHousehold(env.DB, id))!.name).toBe('New Name');
  });

  it('rejects a non-member actor', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await expect(updateHousehold(env.DB, id, HH, 2, false)).rejects.toThrow('not_authorized');
  });

  it('allows an admin regardless of membership', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const ok = await updateHousehold(env.DB, id, { name: 'Admin Edit', address: null, phone: null }, 999, true);
    expect(ok).toBe(true);
  });

  it('rejects a child dependent-holder... i.e. only adult members qualify', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'child'); // Person 2 linked as a child role
    await expect(updateHousehold(env.DB, id, HH, 2, false)).rejects.toThrow('not_authorized');
  });
});

describe('dependents', () => {
  it('adds a name-only child dependent (person_id NULL)', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const depId = await addDependent(env.DB, id, 'Little One', 'child', 1, false);
    const hh = await getHousehold(env.DB, id);
    const dep = hh!.members.find((m) => m.id === depId)!;
    expect(dep).toMatchObject({ person_id: null, display_name: 'Little One', role: 'child' });
  });

  it('rejects addDependent from a non-member', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await expect(addDependent(env.DB, id, 'X', 'child', 2, false)).rejects.toThrow('not_authorized');
  });

  it('removes a dependent but refuses to remove a real member via removeDependent', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const depId = await addDependent(env.DB, id, 'Kid', 'child', 1, false);
    const realMemberId = (await getHousehold(env.DB, id))!.members.find((m) => m.person_id === 1)!.id;

    await expect(removeDependent(env.DB, realMemberId, 1, false)).rejects.toThrow('not_a_dependent');
    expect(await removeDependent(env.DB, depId, 1, false)).toBe(true);
    expect((await getHousehold(env.DB, id))!.members).toHaveLength(1);
  });
});

describe('leaveHousehold', () => {
  it('removes the leaving member but keeps a household with other real members', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    expect(await leaveHousehold(env.DB, 2)).toBe(true);
    const hh = await getHousehold(env.DB, id);
    expect(hh).not.toBeNull();
    expect(hh!.members.map((m) => m.person_id)).toEqual([1]);
  });

  it('soft-deletes the household and hard-deletes dependents when the last real member leaves', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await addDependent(env.DB, id, 'Kid', 'child', 1, false);
    expect(await leaveHousehold(env.DB, 1)).toBe(true);

    expect(await getHousehold(env.DB, id)).toBeNull(); // soft-deleted
    const deleted = await env.DB.prepare('SELECT deleted_at FROM households WHERE id = ?').bind(id).first<{
      deleted_at: string | null;
    }>();
    expect(deleted?.deleted_at).not.toBeNull();
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?').bind(id).first<{
      n: number;
    }>();
    expect(remaining?.n).toBe(0); // dependent cascade-deleted
  });

  it('returns false when the person is in no household', async () => {
    expect(await leaveHousehold(env.DB, 3)).toBe(false);
  });

  it('promotes the oldest remaining adult real member to primary when the primary leaves', async () => {
    const id = await createHousehold(env.DB, HH, 1); // Person 1: adult + primary
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    await linkPersonToHousehold(env.DB, id, 3, 'adult');
    expect(await leaveHousehold(env.DB, 1)).toBe(true);

    const hh = await getHousehold(env.DB, id);
    const primaries = hh!.members.filter((m) => m.is_primary === 1);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].person_id).toBe(2); // oldest remaining adult wins
  });
});

// Deterministic double-submit simulation, same shape as savePerson's race test:
// blind the FIRST membership pre-check (memberRowForPerson's join query) so the
// member INSERT hits the partial UNIQUE(person_id) index on real D1 and the
// catch must map the constraint error to the clean 'already_in_household'.
function blindPrecheckDb(): D1Database {
  let blinded = false;
  return {
    prepare(sql: string) {
      if (!blinded && sql.includes('FROM household_members hm')) {
        blinded = true;
        return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement;
      }
      return env.DB.prepare(sql);
    },
    batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
  } as unknown as D1Database;
}

describe('pre-check ↔ INSERT race mapping', () => {
  it('createHousehold maps the race to already_in_household and removes the orphan household', async () => {
    await createHousehold(env.DB, { name: 'First', address: null, phone: null }, 1);
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<{ n: number }>();

    await expect(
      createHousehold(blindPrecheckDb(), { name: 'Second', address: null, phone: null }, 1),
    ).rejects.toThrow('already_in_household');

    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<{ n: number }>();
    expect(after?.n).toBe(before?.n); // orphan household row cleaned up
    expect((await getHouseholdForPerson(env.DB, 1))!.name).toBe('First'); // original untouched
  });

  it('linkPersonToHousehold maps the race to already_in_household', async () => {
    await createHousehold(env.DB, { name: 'A', address: null, phone: null }, 1);
    const b = await createHousehold(env.DB, { name: 'B', address: null, phone: null }, 2);

    await expect(linkPersonToHousehold(blindPrecheckDb(), b, 1)).rejects.toThrow('already_in_household');
    // No stray membership row was created.
    expect((await getHouseholdForPerson(env.DB, 1))!.name).toBe('A');
  });
});

describe('admin link / unlink', () => {
  it('rejects linking a person already in a household', async () => {
    const a = await createHousehold(env.DB, { name: 'A', address: null, phone: null }, 1);
    const b = await createHousehold(env.DB, { name: 'B', address: null, phone: null }, 2);
    await expect(linkPersonToHousehold(env.DB, b, 1)).rejects.toThrow('already_in_household');
    void a;
  });

  it('rejects linking into a soft-deleted (or missing) household', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await leaveHousehold(env.DB, 1); // last real member → household soft-deleted
    await expect(linkPersonToHousehold(env.DB, id, 2)).rejects.toThrow('household_not_found');
    await expect(linkPersonToHousehold(env.DB, 99999, 2)).rejects.toThrow('household_not_found');
  });

  it('unlinks a real person, freeing them to join elsewhere', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    expect(await unlinkPerson(env.DB, 2)).toBe(true);
    expect(await getHouseholdForPerson(env.DB, 2)).toBeNull();
    // free to be linked again
    await expect(linkPersonToHousehold(env.DB, id, 2, 'adult')).resolves.toBeGreaterThan(0);
  });
});

describe('setMemberRole + setPrimary', () => {
  it('changes a member role', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const depId = await addDependent(env.DB, id, 'Teen', 'child', 1, false);
    expect(await setMemberRole(env.DB, depId, 'adult')).toBe(true);
    expect((await getHousehold(env.DB, id))!.members.find((m) => m.id === depId)!.role).toBe('adult');
  });

  it('makes primary exclusive — setting a new primary clears the old one', async () => {
    const id = await createHousehold(env.DB, HH, 1); // Person 1 primary
    const m2 = await linkPersonToHousehold(env.DB, id, 2, 'adult');
    expect(await setPrimary(env.DB, id, m2)).toBe(true);
    const hh = await getHousehold(env.DB, id);
    const primaries = hh!.members.filter((m) => m.is_primary === 1);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].person_id).toBe(2);
  });

  it('returns false for a member not in the household', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    expect(await setPrimary(env.DB, id, 99999)).toBe(false);
  });
});

describe('listHouseholds', () => {
  it('lists live households with member counts, filtered by name', async () => {
    const chen = await createHousehold(env.DB, { name: 'Chen Family', address: null, phone: null }, 1);
    await addDependent(env.DB, chen, 'Kid', 'child', 1, false); // count 2
    await createHousehold(env.DB, { name: 'Wang Family', address: null, phone: null }, 2); // count 1

    const all = await listHouseholds(env.DB);
    expect(all.map((h) => h.name)).toEqual(['Chen Family', 'Wang Family']);
    expect(all.find((h) => h.name === 'Chen Family')!.member_count).toBe(2);

    const filtered = await listHouseholds(env.DB, { q: 'wang' });
    expect(filtered.map((h) => h.name)).toEqual(['Wang Family']);
  });

  it('reports owner_count per household, 0 until a member is promoted', async () => {
    const chen = await createHousehold(env.DB, { name: 'Chen Family', address: null, phone: null }, 1);
    const wang = await createHousehold(env.DB, { name: 'Wang Family', address: null, phone: null }, 2);

    const before = await listHouseholds(env.DB);
    expect(before.every((h) => h.owner_count === 0)).toBe(true);

    const chenHh = await getHousehold(env.DB, chen);
    const m1 = chenHh!.members.find((m) => m.person_id === 1)!.id;
    await setOwner(env.DB, { householdId: chen, memberId: m1, isOwner: true, actorPersonId: 1, isAdmin: true });

    const after = await listHouseholds(env.DB);
    expect(after.find((h) => h.id === chen)!.owner_count).toBe(1);
    expect(after.find((h) => h.id === wang)!.owner_count).toBe(0);
  });

  it('excludes soft-deleted households', async () => {
    await createHousehold(env.DB, { name: 'Solo', address: null, phone: null }, 1);
    await leaveHousehold(env.DB, 1); // last member → soft-delete
    expect(await listHouseholds(env.DB)).toHaveLength(0);
  });
});
