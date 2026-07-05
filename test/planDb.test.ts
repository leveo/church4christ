// respondToAssignment tests (workers project, live D1): accept + decline mutate
// the row; a request whose plan is in the past is refused; a request belonging to
// another person is refused (ownership scope). Ported/adapted from
// dcfc-serve/test/planDb.test.ts to the {ok,reason} result + personId scoping.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { respondToAssignment } from '../src/lib/planDb';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare(
    `INSERT INTO people (id, display_name, email) VALUES
      (1, 'One', 'one@example.com'), (2, 'Two', 'two@example.com')`,
  ).run();
});

/** Minimal plan→position→assignment chain for `personId` on `planDate`. */
async function makeAssignment(personId: number, planDate: string): Promise<number> {
  await env.DB.prepare("INSERT INTO service_types (start_time) VALUES ('09:30')").run();
  const st = (await env.DB.prepare('SELECT id FROM service_types ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
  await env.DB.prepare('INSERT INTO plans (service_type_id, plan_date) VALUES (?, ?)').bind(st.id, planDate).run();
  const plan = (await env.DB.prepare('SELECT id FROM plans ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
  await env.DB.prepare('INSERT INTO teams (ministry_id) VALUES (NULL)').run();
  const team = (await env.DB.prepare('SELECT id FROM teams ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
  await env.DB.prepare('INSERT INTO positions (team_id) VALUES (?)').bind(team.id).run();
  const pos = (await env.DB.prepare('SELECT id FROM positions ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
  await env.DB.prepare('INSERT INTO roster_assignments (plan_id, position_id, person_id) VALUES (?, ?, ?)')
    .bind(plan.id, pos.id, personId)
    .run();
  return (await env.DB.prepare('SELECT id FROM roster_assignments ORDER BY id DESC LIMIT 1').first<{ id: number }>())!.id;
}

async function statusOf(id: number): Promise<{ status: string; decline_reason: string | null; responded_at: string | null }> {
  return (await env.DB
    .prepare('SELECT status, decline_reason, responded_at FROM roster_assignments WHERE id = ?')
    .bind(id)
    .first<{ status: string; decline_reason: string | null; responded_at: string | null }>())!;
}

describe('respondToAssignment', () => {
  it('accept sets status C, stamps responded_at, clears any decline reason', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'accept', null)).toEqual({ ok: true });
    const row = await statusOf(id);
    expect(row.status).toBe('C');
    expect(row.decline_reason).toBeNull();
    expect(row.responded_at).not.toBeNull();
  });

  it('decline sets status D and stores the reason', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'decline', 'out of town')).toEqual({ ok: true });
    const row = await statusOf(id);
    expect(row.status).toBe('D');
    expect(row.decline_reason).toBe('out of town');
  });

  it('refuses a plan already in the past and leaves the row unchanged', async () => {
    const id = await makeAssignment(1, '2000-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'accept', null)).toEqual({ ok: false, reason: 'past' });
    expect((await statusOf(id)).status).toBe('U');
  });

  it('refuses a request that belongs to a different person', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 2, 'accept', null)).toEqual({ ok: false, reason: 'notfound' });
    expect((await statusOf(id)).status).toBe('U');
  });
});
