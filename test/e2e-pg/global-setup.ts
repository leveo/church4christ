// e2e-pg global setup: runs ONCE in Node before the workers pool starts. Drops
// and recreates the public schema, then applies migrations-supabase/*.sql the
// operator way (the Task 6 migrate script via execFileSync). Per-FILE reseeding
// happens later in ./setup.ts, which runs inside the pool over the HYPERDRIVE
// binding (child_process is unavailable in workerd, so migration can't run there).
// Requires DATABASE_URL — the Postgres this whole config points the worker at.
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

export default async function () {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('test:e2e:pg requires DATABASE_URL (local Postgres)');

  const sql = postgres(url, { max: 1, fetch_types: false, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await sql.end();
  }

  // migrate-supabase.mjs reads SUPABASE_DB_URL (falls back to DATABASE_URL) and
  // resolves migrations-supabase/ relative to cwd (the repo root under vitest).
  execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
    env: { ...process.env, SUPABASE_DB_URL: url },
    stdio: 'inherit',
  });
}
