// The backend seam's request-time factory. `getBackend` reads the DB_BACKEND var
// (D1 by default; 'supabase' opts into Postgres). `openDb` returns a per-REQUEST
// AppDb plus an `end()` drainer:
//   - d1:       env.DB IS the AppDb (D1 satisfies the seam structurally), so this
//               is a zero-copy passthrough and end() is a no-op.
//   - supabase: a fresh postgres.js client over the Hyperdrive connection string.
//               Workers sockets are request-scoped, so the client must NOT be
//               cached across requests — callers open one per request and end()
//               it after the response (see src/middleware.ts / src/worker.ts).
import postgres from 'postgres';
import type { AppDb } from './appDb';
import { PgAdapter } from './pgAdapter';

export type DbBackend = 'd1' | 'supabase';

// The env shape openDb needs, kept minimal + independent of wrangler typegen:
// HYPERDRIVE is typed structurally (only its connectionString is read) so this
// module doesn't depend on generated binding types.
export type DbEnv = {
  DB?: D1Database;
  DB_BACKEND?: string;
  HYPERDRIVE?: { connectionString: string };
};

/** 'supabase' iff DB_BACKEND === 'supabase'; every other value (incl. unset) is 'd1'. */
export function getBackend(env: DbEnv): DbBackend {
  return env.DB_BACKEND === 'supabase' ? 'supabase' : 'd1';
}

/**
 * Open the per-request AppDb for the configured backend. Returns `{ db, backend,
 * end }`; `end()` drains the backend's client (a no-op on D1). Throws a clear
 * error when the selected backend's binding is missing.
 */
export function openDb(env: DbEnv): { db: AppDb; backend: DbBackend; end: () => Promise<void> } {
  const backend = getBackend(env);

  if (backend === 'supabase') {
    if (!env.HYPERDRIVE) {
      throw new Error('DB_BACKEND=supabase but the HYPERDRIVE binding is missing');
    }
    // Request-scoped client: prepare:false (Hyperdrive pools connections, so
    // server-side prepared statements can't be reused), fetch_types:false (skip
    // the startup type-introspection round-trip), small pool + short timeouts.
    const sql = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
      prepare: false,
      connect_timeout: 10,
      // Postgres returns int8 (COUNT/SUM results) as a string to avoid precision
      // loss. This schema has no true bigint columns, so parse int8 as a JS number
      // to match D1/SQLite — where COUNT(*) is already a number and the *Db modules
      // consume these values (member_count, teamCount, …) as numbers.
      types: { int8AsNumber: { to: 20, from: [20], serialize: String, parse: Number } },
    });
    return {
      db: new PgAdapter(sql),
      backend,
      end: () => sql.end({ timeout: 5 }).catch(() => {}),
    };
  }

  if (!env.DB) {
    throw new Error('DB binding is missing (D1 backend)');
  }
  return { db: env.DB, backend, end: async () => {} };
}
