// Email-change flow (workers project, live D1). Email is the login identity, so
// this is the security-critical path: request normalizes + validates + rejects
// taken addresses + rate-limits, GET only peeks (never consumes), and consume
// atomically swaps the address, re-checks uniqueness, and revokes sessions.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/auth';
import { consumeEmailChange, peekEmailChange, requestEmailChange } from '../src/lib/emailChange';

async function reset(): Promise<void> {
  await env.DB.batch([env.DB.prepare('DELETE FROM tokens'), env.DB.prepare('DELETE FROM people')]);
  const rows = [1, 2, 3].map((id) =>
    env.DB
      .prepare('INSERT INTO people (id, display_name, email) VALUES (?, ?, ?)')
      .bind(id, `Person ${id}`, `p${id}@example.com`),
  );
  await env.DB.batch(rows);
}
beforeEach(reset);

async function readPerson(id: number): Promise<{ email: string; pending_email: string | null; session_epoch: number }> {
  return (await env.DB
    .prepare('SELECT email, pending_email, session_epoch FROM people WHERE id = ?')
    .bind(id)
    .first())!;
}

describe('requestEmailChange', () => {
  it('normalizes (trim+lowercase), stores pending_email, returns the raw token', async () => {
    const res = await requestEmailChange(env.DB, 1, '  New@Example.COM  ');
    expect('raw' in res && res.raw.length).toBeTruthy();
    expect((res as { newEmail: string }).newEmail).toBe('new@example.com');
    expect((await readPerson(1)).pending_email).toBe('new@example.com');
  });

  it('rejects an invalid email format', async () => {
    expect(await requestEmailChange(env.DB, 1, 'not-an-email')).toEqual({ error: 'invalid' });
    expect((await readPerson(1)).pending_email).toBeNull();
  });

  it('rejects an address already used by another live person (taken)', async () => {
    expect(await requestEmailChange(env.DB, 1, 'p2@example.com')).toEqual({ error: 'taken' });
    expect((await readPerson(1)).pending_email).toBeNull();
  });

  it('rate-limits the 4th request in the window', async () => {
    for (let i = 0; i < 3; i++) {
      expect('raw' in (await requestEmailChange(env.DB, 1, `new${i}@example.com`))).toBe(true);
    }
    expect(await requestEmailChange(env.DB, 1, 'new4@example.com')).toEqual({ error: 'rate_limited' });
  });

  it('re-issuing invalidates the earlier token (old raw no longer peeks)', async () => {
    const first = (await requestEmailChange(env.DB, 1, 'first@example.com')) as { raw: string };
    const second = (await requestEmailChange(env.DB, 1, 'second@example.com')) as { raw: string };
    expect(await peekEmailChange(env.DB, first.raw)).toBeNull();
    expect(await peekEmailChange(env.DB, second.raw)).toEqual({ personId: 1, newEmail: 'second@example.com' });
  });
});

describe('peekEmailChange', () => {
  it('returns { personId, newEmail } for a valid token and never consumes it', async () => {
    const req = (await requestEmailChange(env.DB, 1, 'peek@example.com')) as { raw: string };
    expect(await peekEmailChange(env.DB, req.raw)).toEqual({ personId: 1, newEmail: 'peek@example.com' });
    // peek is non-mutating: peek twice, then consume still succeeds.
    expect(await peekEmailChange(env.DB, req.raw)).toEqual({ personId: 1, newEmail: 'peek@example.com' });
    const consumed = await consumeEmailChange(env.DB, req.raw);
    expect(consumed).toEqual({ personId: 1, oldEmail: 'p1@example.com', newEmail: 'peek@example.com' });
  });

  it('returns null for an unknown token', async () => {
    expect(await peekEmailChange(env.DB, 'garbage')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const raw = 'expired-raw-token';
    await env.DB
      .prepare(
        `INSERT INTO tokens (person_id, token_hash, purpose, expires_at) VALUES (?1, ?2, 'email_change', datetime('now', '-1 hour'))`,
      )
      .bind(1, await sha256Hex(raw))
      .run();
    await env.DB.prepare('UPDATE people SET pending_email = ? WHERE id = 1').bind('exp@example.com').run();
    expect(await peekEmailChange(env.DB, raw)).toBeNull();
  });
});

describe('consumeEmailChange', () => {
  it('swaps people.email, clears pending_email, bumps session_epoch, returns old+new (happy path)', async () => {
    const before = await readPerson(1);
    const req = (await requestEmailChange(env.DB, 1, 'happy@example.com')) as { raw: string };
    const res = await consumeEmailChange(env.DB, req.raw);
    expect(res).toEqual({ personId: 1, oldEmail: 'p1@example.com', newEmail: 'happy@example.com' });
    const after = await readPerson(1);
    expect(after.email).toBe('happy@example.com');
    expect(after.pending_email).toBeNull();
    expect(after.session_epoch).toBe(before.session_epoch + 1);
  });

  it('returns invalid for an unknown token and does not mutate', async () => {
    expect(await consumeEmailChange(env.DB, 'garbage')).toEqual({ error: 'invalid' });
    expect((await readPerson(1)).email).toBe('p1@example.com');
  });

  it('returns invalid for an expired token', async () => {
    const raw = 'expired-consume-token';
    await env.DB
      .prepare(
        `INSERT INTO tokens (person_id, token_hash, purpose, expires_at) VALUES (?1, ?2, 'email_change', datetime('now', '-1 hour'))`,
      )
      .bind(1, await sha256Hex(raw))
      .run();
    await env.DB.prepare('UPDATE people SET pending_email = ? WHERE id = 1').bind('exp@example.com').run();
    expect(await consumeEmailChange(env.DB, raw)).toEqual({ error: 'invalid' });
    expect((await readPerson(1)).email).toBe('p1@example.com');
  });

  it('re-checks uniqueness at consume time: taken → clears pending, leaves email unchanged', async () => {
    // Request while the address is free, then let another person claim it before consume.
    const req = (await requestEmailChange(env.DB, 1, 'collide@example.com')) as { raw: string };
    await env.DB.prepare('UPDATE people SET email = ? WHERE id = 3').bind('collide@example.com').run();
    const res = await consumeEmailChange(env.DB, req.raw);
    expect(res).toEqual({ error: 'taken' });
    const after = await readPerson(1);
    expect(after.email).toBe('p1@example.com'); // unchanged
    expect(after.pending_email).toBeNull(); // cleared
  });

  it('a soft-deleted occupant still holding the address degrades to taken instead of throwing', async () => {
    // Person 3 holds the target address, then is soft-deleted: the deleted_at
    // IS NULL pre-check now passes, but the UNIQUE(email) index still blocks
    // the final UPDATE — must degrade to `taken`, not an unhandled 500.
    await env.DB.prepare("UPDATE people SET deleted_at = datetime('now') WHERE id = ?").bind(3).run();
    const req = (await requestEmailChange(env.DB, 1, 'p3@example.com')) as { raw: string };
    const res = await consumeEmailChange(env.DB, req.raw);
    expect(res).toEqual({ error: 'taken' });
    const after = await readPerson(1);
    expect(after.email).toBe('p1@example.com'); // unchanged
    expect(after.pending_email).toBeNull(); // cleared
  });

  it('a superseded token fails to consume directly', async () => {
    const first = (await requestEmailChange(env.DB, 1, 'first@example.com')) as { raw: string };
    await requestEmailChange(env.DB, 1, 'second@example.com');
    expect(await consumeEmailChange(env.DB, first.raw)).toEqual({ error: 'invalid' });
    expect((await readPerson(1)).email).toBe('p1@example.com');
  });
});
