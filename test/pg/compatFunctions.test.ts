import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('SQLite-compat datetime()/date()', () => {
  const sql = hasPg ? pgClient() : (null as never);
  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe(readFileSync('migrations-supabase/0001_init.sql', 'utf8'));
  });
  afterAll(async () => { await sql?.end(); });

  const one = async (expr: string) => (await sql.unsafe(`SELECT ${expr} AS v`))[0].v as string;

  it("datetime('now') is UTC YYYY-MM-DD HH:MM:SS", async () => {
    const v = await one("datetime('now')");
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const drift = Math.abs(Date.now() - Date.parse(v.replace(' ', 'T') + 'Z'));
    expect(drift).toBeLessThan(15_000);
  });
  it('applies fixed-offset modifiers', async () => {
    expect(await one("datetime('2026-01-10 12:00:00', '+15 minutes')")).toBe('2026-01-10 12:15:00');
    expect(await one("datetime('2026-01-10 12:00:00', '-7 days')")).toBe('2026-01-03 12:00:00');
    expect(await one("date('2026-01-10', '-9 years')")).toBe('2017-01-10');
  });
  it('chains modifiers left to right like SQLite', async () => {
    // SQLite: date('2026-01-07','weekday 0') -> next Sunday (or same day if Sunday)
    expect(await one("date('2026-01-07', 'weekday 0')")).toBe('2026-01-11'); // Wed -> Sun
    expect(await one("date('2026-01-11', 'weekday 0')")).toBe('2026-01-11'); // Sun stays
    expect(await one("date('2026-01-07', 'weekday 0', '-14 days')")).toBe('2025-12-28');
    expect(await one("datetime('2026-01-07 22:30:00', 'start of day', '+8 hours')")).toBe('2026-01-07 08:00:00');
  });
  it("date('now','start of day') resolves to our function (text)", async () => {
    // CONTROLLER AMENDMENT: PostgreSQL parses bare date('literal') as a CAST at
    // parse time — no function overload can intercept it. Bare date('now') call
    // sites are therefore rewritten to the 2-arg form date('now','start of day')
    // (identical semantics on SQLite/D1), which always resolves via function
    // lookup. A tripwire test bans bare date('now') from src/ + seed/.
    const v = await one("date('now','start of day')");
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('works as a column DEFAULT', async () => {
    await sql.unsafe("CREATE TABLE dtest (id integer, created_at text NOT NULL DEFAULT (datetime('now')))");
    await sql.unsafe('INSERT INTO dtest (id) VALUES (1)');
    const v = (await sql.unsafe('SELECT created_at FROM dtest'))[0].created_at as string;
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

// Tripwire — deliberately NOT gated on hasPg, so it runs on every `npm test`.
// PostgreSQL parses bare date('literal') as a CAST to the date type at parse
// time ('now'::date), so a bare single-arg date('now') can never reach our
// compat function — on Postgres it returns a `date` and breaks text-column
// comparisons (`operator does not exist: text >= date`). App SQL must use the
// 2-arg form date('now', 'start of day'), which is identical on SQLite/D1 and
// always resolves via function lookup. (datetime('now') is safe: `datetime`
// is not a Postgres type name.)
describe("no bare single-arg date('now') in src/ or seed/", () => {
  it('every date(\'now\'…) call uses the 2-arg form', () => {
    const offenders: string[] = [];
    for (const root of ['src', 'seed']) {
      for (const rel of readdirSync(root, { recursive: true }) as string[]) {
        if (!/\.(ts|tsx|js|mjs|astro|sql)$/.test(rel)) continue;
        const path = join(root, rel);
        if (!statSync(path).isFile()) continue;
        readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
          if (/date\('now'\)/.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      "Bare date('now') found. Postgres parses date('literal') as a cast ('now'::date), " +
        "bypassing the SQLite-compat function and returning a date instead of text. " +
        "Use date('now', 'start of day') instead (same result on SQLite/D1):\n" +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
