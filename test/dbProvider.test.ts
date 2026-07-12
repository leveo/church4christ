// Runs in the workers project so `openDb` can be handed the REAL D1 binding from
// cloudflare:test and asserted to pass it straight through (the D1 backend is a
// zero-copy passthrough — env.DB IS the AppDb). The supabase branch is exercised
// only for its guard rails here (opening a live postgres.js client needs a real
// HYPERDRIVE socket, which the pg project + deploy cover); this suite pins the
// backend selection and the missing-binding error paths.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getBackend, openDb, type DbEnv } from '../src/lib/dbProvider';

describe('getBackend', () => {
  it("defaults to 'd1' when DB_BACKEND is unset", () => {
    expect(getBackend({})).toBe('d1');
    expect(getBackend({ DB_BACKEND: '' })).toBe('d1');
  });

  it('accepts the exact d1 and supabase backend names', () => {
    expect(getBackend({ DB_BACKEND: 'supabase' })).toBe('supabase');
    expect(getBackend({ DB_BACKEND: 'd1' })).toBe('d1');
  });

  it('rejects every nonempty unknown DB_BACKEND value', () => {
    for (const value of ['postgres', 'D1', ' supabase ', 'd1 ', ' d1', ' ', 'sqlite']) {
      expect(() => getBackend({ DB_BACKEND: value })).toThrow(
        `Invalid DB_BACKEND=${JSON.stringify(value)}; expected "d1" or "supabase"`,
      );
    }
  });
});

describe('openDb', () => {
  it('returns the D1 binding unchanged on the default backend, and end() resolves', async () => {
    const { db, backend, end } = openDb(env as unknown as DbEnv);
    expect(backend).toBe('d1');
    expect(db).toBe(env.DB); // zero-copy passthrough — no adapter on D1
    await expect(end()).resolves.toBeUndefined();
  });

  it('throws a clear error when the D1 backend has no DB binding', () => {
    expect(() => openDb({})).toThrow(/DB binding/i);
  });

  it('throws a clear error when the supabase backend has no HYPERDRIVE binding', () => {
    expect(() => openDb({ DB_BACKEND: 'supabase' })).toThrow(/HYPERDRIVE/i);
  });
});
