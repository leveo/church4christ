// One-time token tests (workers project, live D1). Ported + adapted from
// the reference stack's test/auth.test.ts: raw is never stored (only sha256Hex), peek does
// not consume, consume is single-use, wrong-purpose/expired/unknown → null, and
// createLoginToken enforces the 3-per-15-min rate limit (respond tokens exempt).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeToken,
  createLoginToken,
  createRespondToken,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MIN,
  peekToken,
  sha256Hex,
} from '../src/lib/auth';

// Storage is isolated per test file (not per test) in this pool config, so reset
// tokens + the FK chain and re-seed person 1 before each test for determinism.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tokens'),
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare(
    `INSERT INTO people (id, display_name, email) VALUES (1, 'Tester', 'tester@example.com')`,
  ).run();
});

function rawOf(res: { raw: string } | { rateLimited: true }): string {
  if ('rateLimited' in res) throw new Error('expected a token, got rateLimited');
  return res.raw;
}

// Build the minimal plan→position→assignment chain so a respond token has a real
// assignment_id to reference (survives FK enforcement whether on or off).
async function makeAssignment(): Promise<number> {
  await env.DB.prepare("INSERT INTO service_types (start_time) VALUES ('09:30')").run();
  const st = await env.DB.prepare('SELECT id FROM service_types').first<{ id: number }>();
  await env.DB.prepare('INSERT INTO plans (service_type_id, plan_date) VALUES (?, ?)')
    .bind(st!.id, '2026-01-01')
    .run();
  const plan = await env.DB.prepare('SELECT id FROM plans').first<{ id: number }>();
  await env.DB.prepare('INSERT INTO teams (ministry_id) VALUES (NULL)').run();
  const team = await env.DB.prepare('SELECT id FROM teams').first<{ id: number }>();
  await env.DB.prepare('INSERT INTO positions (team_id) VALUES (?)').bind(team!.id).run();
  const pos = await env.DB.prepare('SELECT id FROM positions').first<{ id: number }>();
  await env.DB.prepare(
    'INSERT INTO roster_assignments (plan_id, position_id, person_id) VALUES (?, ?, ?)',
  )
    .bind(plan!.id, pos!.id, 1)
    .run();
  const a = await env.DB.prepare('SELECT id FROM roster_assignments').first<{ id: number }>();
  return a!.id;
}

describe('one-time tokens', () => {
  it('stores only the sha256 hash, never the raw token', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));
    expect(raw.length).toBeGreaterThanOrEqual(40);
    const row = await env.DB.prepare(`SELECT token_hash FROM tokens ORDER BY id DESC LIMIT 1`).first<{
      token_hash: string;
    }>();
    expect(row!.token_hash).not.toBe(raw);
    expect(row!.token_hash).toBe(await sha256Hex(raw));
  });

  it('peek validates without consuming; consume is single-use', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));
    expect(await peekToken(env.DB, raw, 'login')).toMatchObject({ person_id: 1 });
    expect(await peekToken(env.DB, raw, 'login')).toMatchObject({ person_id: 1 }); // still unused
    expect(await consumeToken(env.DB, raw, 'login')).toMatchObject({ person_id: 1 });
    expect(await consumeToken(env.DB, raw, 'login')).toBeNull(); // second consume fails
    expect(await peekToken(env.DB, raw, 'login')).toBeNull(); // used tokens don't peek
  });

  it('rejects the wrong purpose', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));
    expect(await peekToken(env.DB, raw, 'respond')).toBeNull();
    expect(await consumeToken(env.DB, raw, 'respond')).toBeNull();
    expect(await consumeToken(env.DB, raw, 'login')).not.toBeNull();
  });

  it('rejects expired tokens', async () => {
    const raw = rawOf(await createLoginToken(env.DB, 1));
    await env.DB.prepare(
      `UPDATE tokens SET expires_at = datetime('now', '-1 minute') WHERE token_hash = ?`,
    )
      .bind(await sha256Hex(raw))
      .run();
    expect(await peekToken(env.DB, raw, 'login')).toBeNull();
    expect(await consumeToken(env.DB, raw, 'login')).toBeNull();
  });

  it('rejects unknown tokens', async () => {
    expect(await peekToken(env.DB, 'not-a-real-token', 'login')).toBeNull();
    expect(await consumeToken(env.DB, 'not-a-real-token', 'login')).toBeNull();
  });

  it('createRespondToken stores a respond token carrying the assignment_id', async () => {
    const assignmentId = await makeAssignment();
    const { raw } = await createRespondToken(env.DB, 1, assignmentId);
    const row = await env.DB.prepare(
      `SELECT token_hash, purpose, assignment_id FROM tokens ORDER BY id DESC LIMIT 1`,
    ).first<{ token_hash: string; purpose: string; assignment_id: number }>();
    expect(row!.token_hash).toBe(await sha256Hex(raw));
    expect(row!.purpose).toBe('respond');
    expect(row!.assignment_id).toBe(assignmentId);

    // Round-trips through peek/consume under the respond purpose only.
    expect(await peekToken(env.DB, raw, 'respond')).toMatchObject({
      person_id: 1,
      assignment_id: assignmentId,
    });
    expect(await peekToken(env.DB, raw, 'login')).toBeNull();
    expect(await consumeToken(env.DB, raw, 'respond')).toMatchObject({
      person_id: 1,
      assignment_id: assignmentId,
    });
  });
});

describe('login rate limit', () => {
  it('allows LOGIN_RATE_LIMIT logins, blocks the next, and reopens after the window', async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT; i++) {
      expect(await createLoginToken(env.DB, 1)).toHaveProperty('raw');
    }
    expect(await createLoginToken(env.DB, 1)).toEqual({ rateLimited: true });

    // Age the existing login tokens past the window → a new one is allowed again.
    await env.DB.prepare(`UPDATE tokens SET created_at = datetime('now', ?)`)
      .bind(`-${LOGIN_RATE_WINDOW_MIN + 1} minutes`)
      .run();
    expect(await createLoginToken(env.DB, 1)).toHaveProperty('raw');
  });

  it('does not count respond tokens toward the login rate limit', async () => {
    const assignmentId = await makeAssignment();
    await createRespondToken(env.DB, 1, assignmentId);
    await createRespondToken(env.DB, 1, assignmentId);
    for (let i = 0; i < LOGIN_RATE_LIMIT; i++) {
      expect(await createLoginToken(env.DB, 1)).toHaveProperty('raw');
    }
    expect(await createLoginToken(env.DB, 1)).toEqual({ rateLimited: true });
  });
});
