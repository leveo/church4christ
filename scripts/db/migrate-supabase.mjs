#!/usr/bin/env node
// Applies migrations-supabase/*.sql in name order, once each, tracked in
// _migrations. Usage: SUPABASE_DB_URL=postgres://... node scripts/db/migrate-supabase.mjs
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('set SUPABASE_DB_URL (or DATABASE_URL)');
  process.exit(1);
}
const sql = postgres(url, { max: 1, fetch_types: false, onnotice: () => {} });
try {
  await sql.unsafe(
    "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at text NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))",
  );
  const done = new Set((await sql.unsafe('SELECT name FROM _migrations')).map((r) => r.name));
  const files = readdirSync('migrations-supabase').filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`applying ${f}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(`migrations-supabase/${f}`, 'utf8'));
      await tx.unsafe('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    });
  }
  console.log('migrations up to date');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
