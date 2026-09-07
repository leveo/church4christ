// People admin data-access (workers project, live D1). Covers adminDb.ts:
// create + read-back, the email-collision → errors.emailTaken mapping (both the
// create and the update path), reviving a soft-deleted person on an email
// match, role/active flag updates, soft-delete hiding a row from the list, and
// the case-insensitive name/email search.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countPeople,
  canPerformSensitivePersonAction,
  getPerson,
  listVerifiedAuthContacts,
  listPeople,
  savePerson,
  setPersonFlags,
  softDeletePerson,
  type SavePersonInput,
  type SavePersonResult,
} from '../src/lib/adminDb';
import { findVerifiedContactOwner } from '../src/lib/identityDb';

beforeEach(async () => {
  // Clear FK children (some tests link people into teams/households) before the
  // people rows, or the DELETE trips the foreign-key constraint.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM verified_contact_owners'),
    env.DB.prepare('DELETE FROM person_contact_links'),
    env.DB.prepare('DELETE FROM contact_points'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

function input(overrides: Partial<SavePersonInput> = {}): SavePersonInput {
  return {
    id: null,
    firstName: '',
    lastName: '',
    displayName: 'Person',
    email: 'person@example.com',
    phone: null,
    role: 'member',
    active: true,
    lang: null,
    birthday: null,
    address: null,
    ...overrides,
  };
}

function idOf(r: SavePersonResult): number {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.id;
}

describe('savePerson — create', () => {
  it('inserts a person and reads it back with flags', async () => {
    const r = await savePerson(env.DB, input({ displayName: 'Alice', email: 'alice@example.com', role: 'editor' }), 'admin@example.com');
    expect(r.ok).toBe(true);
    const p = await getPerson(env.DB, idOf(r));
    expect(p).toMatchObject({ display_name: 'Alice', email: 'alice@example.com', role: 'editor', active: 1 });
  });

  it('routes a duplicate live email to identity review', async () => {
    await savePerson(env.DB, input({ email: 'dup@example.com' }), 'x');
    const r = await savePerson(env.DB, input({ email: 'dup@example.com', displayName: 'Other' }), 'x');
    expect(r).toEqual({ ok: false, code: 'identity_review_required', errors: { email: 'errors.identityReviewRequired' } });
  });

  it('routes a soft-deleted legacy email collision to identity review without reviving it', async () => {
    const first = idOf(await savePerson(env.DB, input({ email: 'revive@example.com', displayName: 'First' }), 'x'));
    await softDeletePerson(env.DB, first);
    expect(await getPerson(env.DB, first)).toBeNull(); // hidden while deleted

    const again = await savePerson(env.DB, input({ email: 'revive@example.com', displayName: 'Second' }), 'x');
    expect(again).toEqual({ ok: false, code: 'identity_review_required', errors: { email: 'errors.identityReviewRequired' } });
    expect(await getPerson(env.DB, first)).toBeNull();
  });

  it('routes an existing contact-point collision to review and creates no person', async () => {
    await env.DB.prepare(`INSERT INTO contact_points(kind, normalized_value, display_value)
      VALUES('email','shared@example.com','shared@example.com')`).run();
    const result = await savePerson(env.DB, input({ email: 'shared@example.com', displayName: 'Not Yet Known' }), 'x');
    expect(result).toEqual({ ok: false, code: 'identity_review_required', errors: { email: 'errors.identityReviewRequired' } });
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM people WHERE display_name='Not Yet Known'`).first()).toEqual({ n: 0 });
  });

  it('uses normalizeEmail parity for decomposed Unicode and non-ASCII case legacy collisions', async () => {
    await env.DB.prepare(`INSERT INTO people(display_name,email) VALUES('José','  JOSÉ@EXAMPLE.COM  ')`).run();
    const result = await savePerson(env.DB, input({ email: 'josé@example.com', displayName: 'Duplicate José' }), 'x');
    expect(result).toEqual({ ok: false, code: 'identity_review_required', errors: { email: 'errors.identityReviewRequired' } });
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM people WHERE display_name='Duplicate José'`).first()).toEqual({ n: 0 });
  });

  it('creates a clean person as provisional/auth-disabled with notification reachability but no auth owner', async () => {
    const result = await savePerson(env.DB, input({ email: 'reach-only@example.com', displayName: 'Reach Only' }), 'x');
    const id = idOf(result);
    expect(await env.DB.prepare(`SELECT identity_state, auth_disabled_at, provisional_source FROM people WHERE id=?1`)
      .bind(id).first()).toMatchObject({ identity_state: 'provisional', provisional_source: 'admin_people' });
    expect((await env.DB.prepare(`SELECT auth_disabled_at FROM people WHERE id=?1`).bind(id).first<{ auth_disabled_at: string | null }>())?.auth_disabled_at).not.toBeNull();
    expect(await env.DB.prepare(`SELECT l.notification_enabled
      FROM person_contact_links l JOIN contact_points c ON c.id=l.contact_point_id
      WHERE l.person_id=?1 AND c.kind='email' AND c.normalized_value='reach-only@example.com' AND l.ended_at IS NULL`)
      .bind(id).first()).toEqual({ notification_enabled: 1 });
    expect(await findVerifiedContactOwner(env.DB, { kind: 'email', value: 'reach-only@example.com' })).toBeNull();
  });

  it('maps a pre-check ↔ INSERT race to identity review (no throw)', async () => {
    // Deterministic double-submit simulation: the wrapper blinds the FIRST
    // pre-check SELECT (as if the colliding row landed between the SELECT and
    // the INSERT), so the INSERT hits the live UNIQUE(email) index on real D1
    // and the create branch's catch must map the constraint error.
    await savePerson(env.DB, input({ email: 'race@example.com', displayName: 'Winner' }), 'x');
    let blinded = 0;
    const raceDb = {
      batch(statements: D1PreparedStatement[]) { return env.DB.batch(statements); },
      prepare(sql: string) {
        if (blinded === 0 && sql.includes('SELECT id, email AS identifier FROM people')) {
          blinded += 1;
          return { all: async () => ({ results: [] }) } as unknown as D1PreparedStatement;
        }
        if (blinded === 1 && sql.includes('FROM contact_points')) {
          blinded += 1;
          return { all: async () => ({ results: [] }) } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;

    const r = await savePerson(raceDb, input({ email: 'race@example.com', displayName: 'Loser' }), 'x');
    expect(blinded).toBe(2); // both pre-checks really were bypassed
    expect(r).toEqual({ ok: false, code: 'identity_review_required', errors: { email: 'errors.identityReviewRequired' } });
    // The original row is untouched.
    const rows = await listPeople(env.DB, { q: 'race@example.com' });
    expect(rows.map((p) => p.display_name)).toEqual(['Winner']);
  });
});

describe('savePerson — update', () => {
  it('ignores a forged email field while updating demographics', async () => {
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    await savePerson(env.DB, input({ email: 'b@example.com', displayName: 'B' }), 'x');
    const r = await savePerson(env.DB, input({ id: a, email: 'b@example.com', displayName: 'A Renamed' }), 'x');
    expect(r).toEqual({ ok: true, id: a });
    expect(await getPerson(env.DB, a)).toMatchObject({ email: 'a@example.com', display_name: 'A Renamed' });
  });

  it('updates identity fields on the same email', async () => {
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    const r = await savePerson(env.DB, input({ id: a, email: 'a@example.com', displayName: 'A Renamed', phone: '555' }), 'x');
    expect(r).toEqual({ ok: true, id: a });
    expect(await getPerson(env.DB, a)).toMatchObject({ display_name: 'A Renamed', phone: '555' });
  });

  it('ignores a forged soft-deleted occupant email and leaves both identities unchanged', async () => {
    // The pre-check only blocks LIVE holders, so this edit reaches the UPDATE,
    // where the soft-deleted row still holds UNIQUE(email) — validating the
    // 'UNIQUE constraint failed' string-match on the exact never-500 path.
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    const b = idOf(await savePerson(env.DB, input({ email: 'x@example.com', displayName: 'B' }), 'x'));
    await softDeletePerson(env.DB, b);

    const r = await savePerson(env.DB, input({ id: a, email: 'x@example.com', displayName: 'A' }), 'x');
    expect(r).toEqual({ ok: true, id: a });
    // A is unchanged; B stays soft-deleted.
    expect(await getPerson(env.DB, a)).toMatchObject({ email: 'a@example.com' });
    expect(await getPerson(env.DB, b)).toBeNull();
  });

  it('cannot move a verified victim owner by forging a notification-only attacker email', async () => {
    const victim = idOf(await savePerson(env.DB, input({ email: 'victim@example.com', displayName: 'Victim' }), 'x'));
    await env.DB.prepare(`UPDATE people SET identity_state='active', auth_disabled_at=NULL WHERE id=?1`).bind(victim).run();
    const victimContact = await env.DB.prepare(`SELECT id FROM contact_points WHERE normalized_value='victim@example.com'`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
      VALUES(?1,?2,'email_link')`).bind(victimContact!.id, victim).run();
    const attackerContact = await env.DB.prepare(`INSERT INTO contact_points(kind,normalized_value,display_value)
      VALUES('email','attacker@example.com','attacker@example.com') RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,notification_enabled)
      VALUES(?1,?2,'email','admin_people',1)`).bind(victim, attackerContact!.id).run();

    expect(await savePerson(env.DB, input({ id: victim, email: 'attacker@example.com', displayName: 'Victim Updated' }), 'x'))
      .toEqual({ ok: true, id: victim });
    expect((await getPerson(env.DB, victim))?.email).toBe('victim@example.com');
    expect((await findVerifiedContactOwner(env.DB, { kind: 'email', value: 'victim@example.com' }))?.personId).toBe(victim);
    expect(await findVerifiedContactOwner(env.DB, { kind: 'email', value: 'attacker@example.com' })).toBeNull();
  });
});

describe('setPersonFlags', () => {
  it('updates role and active independently and together, and no-ops on empty', async () => {
    const id = idOf(await savePerson(env.DB, input({ email: 'flag@example.com', role: 'member', active: true }), 'x'));

    await setPersonFlags(env.DB, id, { role: 'admin' });
    expect(await getPerson(env.DB, id)).toMatchObject({ role: 'admin', active: 1 });

    await setPersonFlags(env.DB, id, { active: false });
    expect(await getPerson(env.DB, id)).toMatchObject({ role: 'admin', active: 0 });

    await setPersonFlags(env.DB, id, { role: 'editor', active: true });
    expect(await getPerson(env.DB, id)).toMatchObject({ role: 'editor', active: 1 });

    await setPersonFlags(env.DB, id, {}); // nothing to change
    expect(await getPerson(env.DB, id)).toMatchObject({ role: 'editor', active: 1 });
  });

  it('sets the finance flag independently, defaulting to 0 and never clobbered by other flag updates', async () => {
    const id = idOf(await savePerson(env.DB, input({ email: 'fin@example.com' }), 'x'));
    expect(await getPerson(env.DB, id)).toMatchObject({ finance: 0 });

    await setPersonFlags(env.DB, id, { finance: true });
    expect(await getPerson(env.DB, id)).toMatchObject({ finance: 1, active: 1 });

    await setPersonFlags(env.DB, id, { role: 'editor' }); // finance stays set
    expect(await getPerson(env.DB, id)).toMatchObject({ finance: 1, role: 'editor' });

    await setPersonFlags(env.DB, id, { finance: false });
    expect(await getPerson(env.DB, id)).toMatchObject({ finance: 0 });
  });
});

describe('sensitive People actions', () => {
  const recent = {
    schemaVersion: 2 as const,
    sessionId: '123e4567-e89b-42d3-a456-426614174000',
    authMethod: 'email_otp' as const,
    authTime: 1_000,
    stepUpTime: null,
  };

  it('requires a current active super admin and recent assurance', async () => {
    const superId = idOf(await savePerson(env.DB, input({ email: 'super@example.com' }), 'x'));
    await env.DB.prepare(`UPDATE people SET identity_state='active',auth_disabled_at=NULL,role='admin',super_admin=1 WHERE id=?1`).bind(superId).run();
    expect(await canPerformSensitivePersonAction(env.DB, superId, recent, 1_600)).toBe(true);
    expect(await canPerformSensitivePersonAction(env.DB, superId, recent, 1_601)).toBe(false);
    await env.DB.prepare(`UPDATE people SET active=0 WHERE id=?1`).bind(superId).run();
    expect(await canPerformSensitivePersonAction(env.DB, superId, recent, 1_000)).toBe(false);
  });

  it('lists only verified auth contacts separately from notification links', async () => {
    const personId = idOf(await savePerson(env.DB, input({ email: 'owner@example.com' }), 'x'));
    await env.DB.prepare(`UPDATE people SET identity_state='active',auth_disabled_at=NULL WHERE id=?1`).bind(personId).run();
    const ownerContact = await env.DB.prepare(`SELECT id FROM contact_points WHERE normalized_value='owner@example.com'`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
      VALUES(?1,?2,'email_link')`).bind(ownerContact!.id, personId).run();
    const notification = await env.DB.prepare(`INSERT INTO contact_points(kind,normalized_value,display_value)
      VALUES('email','notify@example.com','Notify@Example.com') RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,notification_enabled)
      VALUES(?1,?2,'email','admin_people',1)`).bind(personId, notification!.id).run();
    expect(await listVerifiedAuthContacts(env.DB, personId)).toEqual([
      { kind: 'email', displayValue: 'owner@example.com', verifiedAt: expect.any(String) },
    ]);
  });
});

describe('savePerson — membership depth (admin variant)', () => {
  it('persists birthday/address/membership_status/joined_on on create', async () => {
    const r = await savePerson(
      env.DB,
      input({
        email: 'depth@example.com',
        birthday: '1990-05-15',
        address: '42 Grace St',
        membershipStatus: 'member',
        joinedOn: '2020-01-01',
      }),
      'admin@example.com',
    );
    expect(await getPerson(env.DB, idOf(r))).toMatchObject({
      birthday: '1990-05-15',
      address: '42 Grace St',
      membership_status: 'member',
      joined_on: '2020-01-01',
    });
  });

  it('updates membership fields on edit', async () => {
    const id = idOf(await savePerson(env.DB, input({ email: 'u@example.com', membershipStatus: 'visitor' }), 'x'));
    await savePerson(
      env.DB,
      input({ id, email: 'u@example.com', membershipStatus: 'member', joinedOn: '2021-02-02', birthday: '1985-01-01' }),
      'x',
    );
    expect(await getPerson(env.DB, id)).toMatchObject({
      membership_status: 'member',
      joined_on: '2021-02-02',
      birthday: '1985-01-01',
    });
  });

  it('a non-admin save (no membershipStatus) never clobbers the admin-set fields', async () => {
    const id = idOf(
      await savePerson(
        env.DB,
        input({ email: 'keep@example.com', membershipStatus: 'member', joinedOn: '2019-03-03', birthday: '1970-07-07', address: 'Old Addr' }),
        'x',
      ),
    );
    // Self-service style save: membershipStatus absent (undefined) → the four
    // membership-depth columns must be left exactly as the admin set them.
    await savePerson(env.DB, input({ id, email: 'keep@example.com', displayName: 'Renamed' }), 'x');
    expect(await getPerson(env.DB, id)).toMatchObject({
      display_name: 'Renamed',
      membership_status: 'member',
      joined_on: '2019-03-03',
      birthday: '1970-07-07',
      address: 'Old Addr',
    });
  });
});

describe('listPeople — people-module filters', () => {
  it('filters by status, serving (team_members), and household, and reads the household name', async () => {
    const alice = idOf(await savePerson(env.DB, input({ email: 'alice@x.com', displayName: 'Alice', membershipStatus: 'member' }), 'x'));
    const bob = idOf(await savePerson(env.DB, input({ email: 'bob@x.com', displayName: 'Bob', membershipStatus: 'visitor' }), 'x'));
    await env.DB.prepare('INSERT INTO teams (id) VALUES (1)').run();
    await env.DB.prepare('INSERT INTO team_members (team_id, person_id) VALUES (1, ?)').bind(alice).run();
    await env.DB.prepare("INSERT INTO households (id, name) VALUES (1, 'Bob Home')").run();
    await env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name) VALUES (1, ?, 'Bob')").bind(bob).run();

    const names = (opts: Parameters<typeof listPeople>[1]) =>
      listPeople(env.DB, opts).then((rows) => rows.map((p) => p.display_name));
    expect(await names({ status: 'member' })).toEqual(['Alice']);
    expect(await names({ serving: true })).toEqual(['Alice']);
    expect(await names({ serving: false })).toEqual(['Bob']);
    expect(await names({ household: true })).toEqual(['Bob']);
    expect(await names({ household: false })).toEqual(['Alice']);
    expect((await listPeople(env.DB, { household: true }))[0].household_name).toBe('Bob Home');
  });
});

describe('listPeople / countPeople', () => {
  it('soft delete hides the row from the list and the count', async () => {
    const id = idOf(await savePerson(env.DB, input({ email: 'gone@example.com', displayName: 'Gone' }), 'x'));
    expect((await listPeople(env.DB)).some((p) => p.id === id)).toBe(true);
    expect(await countPeople(env.DB)).toBe(1);

    await softDeletePerson(env.DB, id);
    expect((await listPeople(env.DB)).some((p) => p.id === id)).toBe(false);
    expect(await countPeople(env.DB)).toBe(0);
  });

  it('search matches name AND email case-insensitively, ordered by display_name', async () => {
    await savePerson(env.DB, input({ displayName: 'Alice Chen', email: 'alice@example.com' }), 'x');
    await savePerson(env.DB, input({ displayName: 'Bob Smith', email: 'bob@work.org' }), 'x');
    await savePerson(env.DB, input({ displayName: 'Carol', email: 'carol@example.com' }), 'x');

    // name match, mixed-case query
    expect((await listPeople(env.DB, { q: 'aLiCe' })).map((p) => p.email)).toEqual(['alice@example.com']);
    // email-domain match, upper-case query (emails are stored lowercase)
    expect((await listPeople(env.DB, { q: 'WORK.ORG' })).map((p) => p.display_name)).toEqual(['Bob Smith']);
    // a shared token matches multiple rows, ordered by display_name
    expect((await listPeople(env.DB, { q: 'example.com' })).map((p) => p.display_name)).toEqual(['Alice Chen', 'Carol']);
    // no match
    expect(await listPeople(env.DB, { q: 'zzz' })).toEqual([]);
  });
});
