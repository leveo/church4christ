// portalDb (workers project, live D1). Covers Task 3's household-ownership
// data layer: promote/demote co-owners (eligibility, the 2-owner cap, actor
// authorization, self-demotion) and self-service profile edits (linked
// members write through to `people`; dependents only take display_name/role).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDependent, createHousehold, getHousehold, linkPersonToHousehold } from '../src/lib/householdDb';
import { getPortalHousehold, isHouseholdOwner, setOwner, updateMemberProfile, type MemberProfilePatch } from '../src/lib/portalDb';

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const rows = [1, 2, 3, 4, 5].map((id) =>
    env.DB
      .prepare('INSERT INTO people (id, display_name, email, phone) VALUES (?, ?, ?, ?)')
      .bind(id, `Person ${id}`, `p${id}@example.com`, `555-100${id}`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

const HH = { name: 'Chen Family', address: '1 Main St', phone: '555-1000' };

/** Member id for a real person's live row in a household. */
async function memberIdFor(householdId: number, personId: number): Promise<number> {
  const hh = await getHousehold(env.DB, householdId);
  return hh!.members.find((m) => m.person_id === personId)!.id;
}

describe('getPortalHousehold', () => {
  it('returns null for a person in no household', async () => {
    expect(await getPortalHousehold(env.DB, 1)).toBeNull();
  });

  it('returns the household with viewerIsOwner false by default', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const portal = await getPortalHousehold(env.DB, 1);
    expect(portal!.id).toBe(id);
    expect(portal!.viewerIsOwner).toBe(false);
  });

  it('reflects viewerIsOwner true once promoted', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 1, isAdmin: true });
    const portal = await getPortalHousehold(env.DB, 1);
    expect(portal!.viewerIsOwner).toBe(true);
  });
});

describe('isHouseholdOwner', () => {
  it('is true for an owner in their live household', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    expect(await isHouseholdOwner(env.DB, 1)).toBe(true);
  });

  it('is false for a non-owner member', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    expect(await isHouseholdOwner(env.DB, 2)).toBe(false);
  });

  it('is false once the owner\'s household is soft-deleted', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    expect(await isHouseholdOwner(env.DB, 1)).toBe(true);

    await env.DB.prepare(`UPDATE households SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
    expect(await isHouseholdOwner(env.DB, 1)).toBe(false);
  });

  it('is false for a person in no household', async () => {
    expect(await isHouseholdOwner(env.DB, 1)).toBe(false);
  });
});

describe('setOwner', () => {
  it('lets an admin bootstrap the first owner even though no owner exists yet', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    const hh = await getHousehold(env.DB, id);
    expect(hh!.members.find((m) => m.id === m1)!.is_owner).toBe(1);
  });

  it('lets an existing owner promote a second eligible adult', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 1, isAdmin: true });

    await setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 1, isAdmin: false });

    const hh = await getHousehold(env.DB, id);
    expect(hh!.members.find((m) => m.id === m1)!.is_owner).toBe(1);
    expect(hh!.members.find((m) => m.id === m2)!.is_owner).toBe(1);
  });

  it('throws owner_limit when a third owner is promoted', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    await linkPersonToHousehold(env.DB, id, 3, 'adult');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    const m3 = await memberIdFor(id, 3);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    await setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 1, isAdmin: false });

    await expect(
      setOwner(env.DB, { householdId: id, memberId: m3, isOwner: true, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('owner_limit');
  });

  it('throws not_eligible for a dependent (person_id NULL) or a linked child', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const depId = await addDependent(env.DB, id, 'Kid', 'child', 1, false);
    await linkPersonToHousehold(env.DB, id, 2, 'child');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });

    await expect(
      setOwner(env.DB, { householdId: id, memberId: depId, isOwner: true, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('not_eligible');
    await expect(
      setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('not_eligible');
  });

  it('rejects a non-owner actor; an admin actor may promote regardless of ownership', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m2 = await memberIdFor(id, 2);

    await expect(
      setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('not_authorized');

    await setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 999, isAdmin: true });
    const hh = await getHousehold(env.DB, id);
    expect(hh!.members.find((m) => m.id === m2)!.is_owner).toBe(1);
  });

  it('lets an owner demote a co-owner but not themselves', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    await setOwner(env.DB, { householdId: id, memberId: m2, isOwner: true, actorPersonId: 1, isAdmin: false });

    await setOwner(env.DB, { householdId: id, memberId: m2, isOwner: false, actorPersonId: 1, isAdmin: false });
    expect((await getHousehold(env.DB, id))!.members.find((m) => m.id === m2)!.is_owner).toBe(0);

    await expect(
      setOwner(env.DB, { householdId: id, memberId: m1, isOwner: false, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('cannot_demote_self');
  });

  it('lets an admin demote an owner even from themselves (no self-demote guard)', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: false, actorPersonId: 1, isAdmin: true });
    expect((await getHousehold(env.DB, id))!.members.find((m) => m.id === m1)!.is_owner).toBe(0);
  });

  it('throws not_found for a memberId not in the household', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await expect(
      setOwner(env.DB, { householdId: id, memberId: 99999, isOwner: true, actorPersonId: 1, isAdmin: true }),
    ).rejects.toThrow('not_found');
  });

  it('throws not_found for a real memberId that belongs to a different household', async () => {
    const idA = await createHousehold(env.DB, HH, 1);
    const idB = await createHousehold(env.DB, HH, 5);
    const m1A = await memberIdFor(idA, 1);
    const m5B = await memberIdFor(idB, 5);
    await setOwner(env.DB, { householdId: idA, memberId: m1A, isOwner: true, actorPersonId: 999, isAdmin: true });

    await expect(
      setOwner(env.DB, { householdId: idA, memberId: m5B, isOwner: true, actorPersonId: 1, isAdmin: false }),
    ).rejects.toThrow('not_found');
  });

  it('rejects a non-owner actor demoting a co-owner', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });

    await expect(
      setOwner(env.DB, { householdId: id, memberId: m1, isOwner: false, actorPersonId: 2, isAdmin: false }),
    ).rejects.toThrow('not_authorized');
  });
});

describe('updateMemberProfile', () => {
  it('lets an owner edit a linked member\'s phone on the people row', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });

    await updateMemberProfile(env.DB, {
      actorPersonId: 1,
      isAdmin: false,
      memberId: m2,
      patch: { phone: '555-9000' },
    });

    const person = await env.DB.prepare('SELECT phone, email FROM people WHERE id = ?').bind(2).first<{
      phone: string | null;
      email: string;
    }>();
    expect(person?.phone).toBe('555-9000');
    expect(person?.email).toBe('p2@example.com'); // untouched
  });

  it('ignores a raw email field on the patch (not part of MemberProfilePatch)', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m1 = await memberIdFor(id, 1);
    const m2 = await memberIdFor(id, 2);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });

    const patch = { phone: '555-9100', email: 'hacked@example.com' } as MemberProfilePatch;
    await updateMemberProfile(env.DB, { actorPersonId: 1, isAdmin: false, memberId: m2, patch });

    const person = await env.DB.prepare('SELECT phone, email FROM people WHERE id = ?').bind(2).first<{
      phone: string | null;
      email: string;
    }>();
    expect(person?.phone).toBe('555-9100');
    expect(person?.email).toBe('p2@example.com');
  });

  it('rejects a non-owner editing someone else', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    await linkPersonToHousehold(env.DB, id, 3, 'adult');
    const m2 = await memberIdFor(id, 2);

    await expect(
      updateMemberProfile(env.DB, {
        actorPersonId: 3,
        isAdmin: false,
        memberId: m2,
        patch: { phone: '555-0000' },
      }),
    ).rejects.toThrow('not_authorized');
  });

  it('allows self-edit without ownership', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m2 = await memberIdFor(id, 2);

    await updateMemberProfile(env.DB, {
      actorPersonId: 2,
      isAdmin: false,
      memberId: m2,
      patch: { phone: '555-0002' },
    });
    const person = await env.DB.prepare('SELECT phone FROM people WHERE id = ?').bind(2).first<{
      phone: string | null;
    }>();
    expect(person?.phone).toBe('555-0002');
  });

  it('applies only display_name/role to a dependent row, ignoring people-only patch fields', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    const depId = await addDependent(env.DB, id, 'Kid', 'child', 1, false);
    const m1 = await memberIdFor(id, 1);
    await setOwner(env.DB, { householdId: id, memberId: m1, isOwner: true, actorPersonId: 999, isAdmin: true });

    await updateMemberProfile(env.DB, {
      actorPersonId: 1,
      isAdmin: false,
      memberId: depId,
      patch: { display_name: 'Big Kid', phone: '555-4444' },
      dependentRole: 'adult',
    });

    const hh = await getHousehold(env.DB, id);
    const dep = hh!.members.find((m) => m.id === depId)!;
    expect(dep.display_name).toBe('Big Kid');
    expect(dep.role).toBe('adult');
  });

  it('throws not_found for a missing memberId', async () => {
    await expect(
      updateMemberProfile(env.DB, { actorPersonId: 1, isAdmin: true, memberId: 99999, patch: {} }),
    ).rejects.toThrow('not_found');
  });

  it('lets an admin actor edit a member profile directly', async () => {
    const id = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, id, 2, 'adult');
    const m2 = await memberIdFor(id, 2);

    await updateMemberProfile(env.DB, {
      actorPersonId: 999,
      isAdmin: true,
      memberId: m2,
      patch: { phone: '555-8888' },
    });

    const person = await env.DB.prepare('SELECT phone FROM people WHERE id = ?').bind(2).first<{
      phone: string | null;
    }>();
    expect(person?.phone).toBe('555-8888');
  });

  it('throws (not_found) when an actor who owned a now-soft-deleted household reuses a stale memberId from it', async () => {
    const idA = await createHousehold(env.DB, HH, 1);
    await linkPersonToHousehold(env.DB, idA, 2, 'adult');
    const m1A = await memberIdFor(idA, 1);
    const m2A = await memberIdFor(idA, 2);
    await setOwner(env.DB, { householdId: idA, memberId: m1A, isOwner: true, actorPersonId: 999, isAdmin: true });

    await env.DB.prepare(`UPDATE households SET deleted_at = datetime('now') WHERE id = ?`).bind(idA).run();

    await expect(
      updateMemberProfile(env.DB, {
        actorPersonId: 1,
        isAdmin: false,
        memberId: m2A,
        patch: { phone: '555-6666' },
      }),
    ).rejects.toThrow('not_found');

    const person = await env.DB.prepare('SELECT phone FROM people WHERE id = ?').bind(2).first<{
      phone: string | null;
    }>();
    expect(person?.phone).not.toBe('555-6666');
  });
});
