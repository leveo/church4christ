// Migration 0003 schema (workers project, live migrated D1). Asserts the people
// ALTERs (new columns + membership_status CHECK/DEFAULT), the households +
// household_members + person_notes tables, and the two partial unique indexes:
// one household per real person, while name-only dependents (person_id NULL) are
// exempt.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM person_notes'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}
beforeEach(reset);

async function person(id: number, email: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)`).bind(id, `P${id}`, email).run();
}
async function household(name = 'Smith'): Promise<number> {
  const r = await env.DB.prepare(`INSERT INTO households (name) VALUES (?)`).bind(name).run();
  return r.meta.last_row_id as number;
}

describe('migration 0003: table presence', () => {
  it('creates households, household_members, person_notes', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>();
    const names = results.map((r) => r.name);
    for (const table of ['households', 'household_members', 'person_notes']) {
      expect(names).toContain(table);
    }
  });

  it('indexes household_members.household_id and person_notes.person_id', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{
      name: string;
    }>();
    const names = results.map((r) => r.name);
    expect(names).toContain('idx_household_members_household');
    expect(names).toContain('idx_person_notes_person');
  });
});

describe('people membership columns', () => {
  it('adds birthday/address/membership_status/joined_on', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(people)').all<{ name: string }>();
    const cols = results.map((r) => r.name);
    for (const col of ['birthday', 'address', 'membership_status', 'joined_on']) {
      expect(cols).toContain(col);
    }
  });

  it("defaults membership_status to 'visitor'", async () => {
    await person(1, 'a@example.com');
    const row = await env.DB.prepare('SELECT membership_status FROM people WHERE id = 1').first<{
      membership_status: string;
    }>();
    expect(row?.membership_status).toBe('visitor');
  });

  it('rejects a membership_status outside the enum', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO people (display_name, email, membership_status) VALUES ('X', 'x@example.com', 'guest')",
      ).run(),
    ).rejects.toThrow();
  });

  it('accepts every valid membership_status', async () => {
    for (const [i, s] of ['visitor', 'regular', 'member', 'inactive'].entries()) {
      await expect(
        env.DB.prepare('INSERT INTO people (display_name, email, membership_status) VALUES (?, ?, ?)')
          .bind(`P${i}`, `s${i}@example.com`, s)
          .run(),
      ).resolves.not.toThrow();
    }
  });
});

// Migration 0004 keeps the shared `people` schema identical on both backends: the
// giving module is Supabase-only, but these two columns land on D1 too.
describe('people giving columns (migration 0004)', () => {
  it('adds finance and stripe_customer_id', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(people)').all<{ name: string }>();
    const cols = results.map((r) => r.name);
    for (const col of ['finance', 'stripe_customer_id']) {
      expect(cols).toContain(col);
    }
  });

  it('defaults finance to 0 and stripe_customer_id to NULL', async () => {
    await person(1, 'f@example.com');
    const row = await env.DB.prepare('SELECT finance, stripe_customer_id FROM people WHERE id = 1').first<{
      finance: number;
      stripe_customer_id: string | null;
    }>();
    expect(row?.finance).toBe(0);
    expect(row?.stripe_customer_id).toBeNull();
  });
});

describe('household_members constraints', () => {
  it('rejects a role outside adult/child', async () => {
    const h = await household();
    await expect(
      env.DB.prepare("INSERT INTO household_members (household_id, display_name, role) VALUES (?, 'Kid', 'infant')")
        .bind(h)
        .run(),
    ).rejects.toThrow();
  });

  it('rejects a second household for the same real person (one-household-per-person)', async () => {
    await person(1, 'p1@example.com');
    const a = await household('A');
    const b = await household('B');
    await env.DB.prepare('INSERT INTO household_members (household_id, person_id, display_name) VALUES (?, 1, ?)')
      .bind(a, 'P1')
      .run();
    await expect(
      env.DB.prepare('INSERT INTO household_members (household_id, person_id, display_name) VALUES (?, 1, ?)')
        .bind(b, 'P1')
        .run(),
    ).rejects.toThrow();
  });

  it('allows many name-only dependents (person_id NULL) in one household', async () => {
    const h = await household();
    await expect(
      env.DB.batch([
        env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role) VALUES (?, NULL, 'Kid A', 'child')").bind(h),
        env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role) VALUES (?, NULL, 'Kid B', 'child')").bind(h),
      ]),
    ).resolves.not.toThrow();
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?').bind(h).first<{
      n: number;
    }>();
    expect(n?.n).toBe(2);
  });
});
