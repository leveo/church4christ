// People admin data-access (workers project, live D1). Covers adminDb.ts:
// create + read-back, the email-collision → errors.emailTaken mapping (both the
// create and the update path), reviving a soft-deleted person on an email
// match, role/active flag updates, soft-delete hiding a row from the list, and
// the case-insensitive name/email search.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  countPeople,
  getPerson,
  listPeople,
  savePerson,
  setPersonFlags,
  softDeletePerson,
  type SavePersonInput,
  type SavePersonResult,
} from '../src/lib/adminDb';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM people').run();
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

  it('maps a duplicate LIVE email to errors.emailTaken', async () => {
    await savePerson(env.DB, input({ email: 'dup@example.com' }), 'x');
    const r = await savePerson(env.DB, input({ email: 'dup@example.com', displayName: 'Other' }), 'x');
    expect(r).toEqual({ ok: false, errors: { email: 'errors.emailTaken' } });
  });

  it('revives a soft-deleted person on an email match (same id, fields overwritten)', async () => {
    const first = idOf(await savePerson(env.DB, input({ email: 'revive@example.com', displayName: 'First' }), 'x'));
    await softDeletePerson(env.DB, first);
    expect(await getPerson(env.DB, first)).toBeNull(); // hidden while deleted

    const again = await savePerson(env.DB, input({ email: 'revive@example.com', displayName: 'Second' }), 'x');
    expect(again).toEqual({ ok: true, id: first }); // same row reclaimed
    expect(await getPerson(env.DB, first)).toMatchObject({ display_name: 'Second', active: 1 });
  });

  it('maps a pre-check ↔ INSERT race on a live email to emailTaken (no throw)', async () => {
    // Deterministic double-submit simulation: the wrapper blinds the FIRST
    // pre-check SELECT (as if the colliding row landed between the SELECT and
    // the INSERT), so the INSERT hits the live UNIQUE(email) index on real D1
    // and the create branch's catch must map the constraint error.
    await savePerson(env.DB, input({ email: 'race@example.com', displayName: 'Winner' }), 'x');
    let blinded = false;
    const raceDb = {
      prepare(sql: string) {
        if (!blinded && sql.includes('SELECT id, deleted_at FROM people WHERE email')) {
          blinded = true;
          return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement;
        }
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;

    const r = await savePerson(raceDb, input({ email: 'race@example.com', displayName: 'Loser' }), 'x');
    expect(blinded).toBe(true); // the pre-check really was bypassed
    expect(r).toEqual({ ok: false, errors: { email: 'errors.emailTaken' } });
    // The original row is untouched.
    const rows = await listPeople(env.DB, { q: 'race@example.com' });
    expect(rows.map((p) => p.display_name)).toEqual(['Winner']);
  });
});

describe('savePerson — update', () => {
  it('blocks moving onto another live person’s email', async () => {
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    await savePerson(env.DB, input({ email: 'b@example.com', displayName: 'B' }), 'x');
    const r = await savePerson(env.DB, input({ id: a, email: 'b@example.com', displayName: 'A' }), 'x');
    expect(r).toEqual({ ok: false, errors: { email: 'errors.emailTaken' } });
  });

  it('updates identity fields on the same email', async () => {
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    const r = await savePerson(env.DB, input({ id: a, email: 'a@example.com', displayName: 'A Renamed', phone: '555' }), 'x');
    expect(r).toEqual({ ok: true, id: a });
    expect(await getPerson(env.DB, a)).toMatchObject({ display_name: 'A Renamed', phone: '555' });
  });

  it('maps moving onto a SOFT-DELETED occupant’s email to emailTaken (real D1 constraint, no throw)', async () => {
    // The pre-check only blocks LIVE holders, so this edit reaches the UPDATE,
    // where the soft-deleted row still holds UNIQUE(email) — validating the
    // 'UNIQUE constraint failed' string-match on the exact never-500 path.
    const a = idOf(await savePerson(env.DB, input({ email: 'a@example.com', displayName: 'A' }), 'x'));
    const b = idOf(await savePerson(env.DB, input({ email: 'x@example.com', displayName: 'B' }), 'x'));
    await softDeletePerson(env.DB, b);

    const r = await savePerson(env.DB, input({ id: a, email: 'x@example.com', displayName: 'A' }), 'x');
    expect(r).toEqual({ ok: false, errors: { email: 'errors.emailTaken' } });
    // A is unchanged; B stays soft-deleted.
    expect(await getPerson(env.DB, a)).toMatchObject({ email: 'a@example.com' });
    expect(await getPerson(env.DB, b)).toBeNull();
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
