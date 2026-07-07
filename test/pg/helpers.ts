// Shared helpers for the Postgres test layer. All test/pg suites are skipped
// when DATABASE_URL is unset so `npm test` works with no Postgres around.
import postgres from 'postgres';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const hasPg = DATABASE_URL.length > 0;

/** A fresh postgres.js client for one suite. Callers must `await sql.end()`.
 *  int8 is parsed as a JS number (not the default string) so a PgAdapter built
 *  over this client matches production (src/lib/dbProvider.ts) — the schema has
 *  no true bigint columns, and the *Db modules read COUNT results as numbers. */
export function pgClient() {
  return postgres(DATABASE_URL, {
    max: 2,
    fetch_types: false,
    onnotice: () => {},
    types: { int8AsNumber: { to: 20, from: [20], serialize: String, parse: Number } },
  });
}

/** Drop + recreate the public schema — every suite starts from nothing. */
export async function resetSchema(sql: ReturnType<typeof pgClient>) {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
