# Phase 1: Supabase (Postgres) Database Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every existing module runs unchanged on either Cloudflare D1 (default) or Supabase Postgres, selected by a `DB_BACKEND` var, via a D1-shaped adapter over postgres.js + Hyperdrive.

**Architecture:** A structural `AppDb` interface (the subset of `D1Database` the app uses) is satisfied by `D1Database` as-is and implemented for Postgres by `PgAdapter` (placeholder translation `?`→`$n`, `batch()` as a real transaction, D1-shaped results). Postgres gets SQLite-compat `datetime()`/`date()` SQL functions so the ~120 existing date-SQL call sites run unchanged. The DB is created per request in middleware (`locals.db`) because Workers sockets cannot be reused across request contexts.

**Tech Stack:** Astro 7 SSR on Cloudflare Workers, `postgres` (postgres.js ^3.4), Cloudflare Hyperdrive, vitest (+ a new `pg` node project), plpgsql.

**Spec:** `docs/superpowers/specs/2026-07-06-supabase-giving-registration-design.md`

## Global Constraints

- Never break the D1 path: after every task `npm test` (D1 workers pool, 490+ tests) must pass.
- No ORM. All SQL stays raw. Postgres schema keeps `TEXT` timestamps (`YYYY-MM-DD HH:MM:SS`, UTC) and `INTEGER` 0/1 booleans for cross-backend SQL parity. No `bigint` columns (postgres.js returns them as strings).
- All Postgres tests live in `test/pg/` and are **skipped when `DATABASE_URL` is unset** (`describe.skipIf`). Local dev DB: `docker run -d --name c4c-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16` then `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`.
- Code comments and commit messages in English. Match existing file style (heavy explanatory header comments, single quotes, 2-space indent).
- Commit after every task with a conventional-commit message.
- `npm run check` (astro check) must stay clean.

---

### Task 1: `AppDb` interface + `postgres` dependency + `pg` vitest project

**Files:**
- Create: `src/lib/appDb.ts`
- Modify: `vitest.config.ts` (add third project `pg`), `package.json` (dependency)
- Create: `test/pg/helpers.ts`, `test/pg/appDb.test.ts`

**Interfaces (Produces):**
```ts
// src/lib/appDb.ts
export interface AppDbMeta { changes: number; last_row_id?: number; [k: string]: unknown }
export interface AppDbResult<T = unknown> { results: T[]; meta: AppDbMeta; success?: boolean }
export interface AppStatement {
  bind(...values: unknown[]): AppStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<AppDbResult<T>>;
  run<T = unknown>(): Promise<AppDbResult<T>>;
}
export interface AppDb {
  prepare(sql: string): AppStatement;
  batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]>;
}
```

- [ ] **Step 1:** `npm install postgres@^3.4.5` (runtime dependency).
- [ ] **Step 2:** Write `src/lib/appDb.ts` exactly as above, with a header comment explaining it is the D1-shaped seam both backends satisfy. Add a compile-time assignability check at the bottom (type-only, no runtime cost):

```ts
// Compile-time proof that the real D1 binding satisfies AppDb — if a future
// D1 type bump breaks structural compatibility, `astro check` fails here.
type _AssertD1IsAppDb = D1Database extends AppDb ? true : never;
const _d1IsAppDb: _AssertD1IsAppDb = true;
void _d1IsAppDb;
```

- [ ] **Step 3:** Add the `pg` vitest project. In `vitest.config.ts`, next to the existing two projects:

```ts
{
  test: {
    name: 'pg',
    include: ['test/pg/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
},
```

and add `'test/pg/**'` to the workers project `exclude` list.

- [ ] **Step 4:** Write `test/pg/helpers.ts`:

```ts
// Shared helpers for the Postgres test layer. All test/pg suites are skipped
// when DATABASE_URL is unset so `npm test` works with no Postgres around.
import postgres from 'postgres';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const hasPg = DATABASE_URL.length > 0;

/** A fresh postgres.js client for one suite. Callers must `await sql.end()`. */
export function pgClient() {
  return postgres(DATABASE_URL, { max: 2, fetch_types: false, onnotice: () => {} });
}

/** Drop + recreate the public schema — every suite starts from nothing. */
export async function resetSchema(sql: ReturnType<typeof pgClient>) {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
```

- [ ] **Step 5:** Write `test/pg/appDb.test.ts` — a smoke test that the pg project itself runs and skips correctly:

```ts
import { describe, it, expect } from 'vitest';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('pg project wiring', () => {
  it('connects and round-trips a value', async () => {
    const sql = pgClient();
    try {
      await resetSchema(sql);
      const rows = await sql.unsafe('SELECT 1 + 1 AS two');
      expect(rows[0].two).toBe(2);
    } finally {
      await sql.end();
    }
  });
});
```

- [ ] **Step 6:** Run `npm test` — all projects pass (pg suite skips without DATABASE_URL). Run `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project pg` — passes against local Postgres.
- [ ] **Step 7:** Run `npm run check` — clean (proves the D1 assignability assertion compiles).
- [ ] **Step 8:** Commit: `feat(db): AppDb interface, postgres dependency, pg test project`

---

### Task 2: Placeholder translation (pure function)

**Files:**
- Create: `src/lib/pgAdapter.ts` (translation function only this task)
- Create: `test/pg/translate.test.ts` (pure — runs even without DATABASE_URL, so do NOT skipIf)

**Interfaces (Produces):** `export function translatePlaceholders(sql: string): string` — rewrites D1's `?` / `?N` params to `$n`, skipping string literals, quoted identifiers, and comments.

- [ ] **Step 1:** Write failing tests in `test/pg/translate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { translatePlaceholders } from '../../src/lib/pgAdapter';

describe('translatePlaceholders', () => {
  it('numbers anonymous placeholders in order', () => {
    expect(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });
  it('maps numbered placeholders directly', () => {
    expect(translatePlaceholders('WHERE (?1 = \'\' OR name LIKE ?2)')).toBe(
      "WHERE ($1 = '' OR name LIKE $2)",
    );
  });
  it('ignores ? inside single-quoted strings (with escaped quotes)', () => {
    expect(translatePlaceholders("SELECT 'a?b', 'it''s?' , ?")).toBe("SELECT 'a?b', 'it''s?' , $1");
  });
  it('ignores ? inside double-quoted identifiers and comments', () => {
    expect(translatePlaceholders('SELECT "we?ird" FROM t -- what?\nWHERE x = ?')).toBe(
      'SELECT "we?ird" FROM t -- what?\nWHERE x = $1',
    );
    expect(translatePlaceholders('SELECT /* ?? */ ?')).toBe('SELECT /* ?? */ $1');
  });
});
```

- [ ] **Step 2:** Run `npx vitest run --project pg -t translatePlaceholders` — FAILS (function not defined).
- [ ] **Step 3:** Implement in `src/lib/pgAdapter.ts`:

```ts
/**
 * Rewrite D1/SQLite parameter placeholders (`?`, `?3`) to Postgres `$n`.
 * A tiny scanner tracks string/identifier/comment state so a `?` inside
 * quotes or comments is never rewritten. Anonymous `?` are numbered in
 * appearance order (D1 forbids mixing anonymous and numbered in one query,
 * so we don't handle the mix specially).
 */
export function translatePlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  type Mode = 'code' | 'sq' | 'dq' | 'line' | 'block';
  let mode: Mode = 'code';
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (mode === 'code') {
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      else if (c === '-' && next === '-') mode = 'line';
      else if (c === '/' && next === '*') mode = 'block';
      else if (c === '?') {
        let j = i + 1;
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j++;
        if (j > i + 1) {
          out += '$' + sql.slice(i + 1, j);
          i = j;
          continue;
        }
        n += 1;
        out += '$' + n;
        i += 1;
        continue;
      }
    } else if (mode === 'sq' && c === "'") {
      mode = next === "'" ? mode : 'code'; // '' is an escaped quote
      if (next === "'") { out += c + next; i += 2; continue; }
    } else if (mode === 'dq' && c === '"') mode = 'code';
    else if (mode === 'line' && c === '\n') mode = 'code';
    else if (mode === 'block' && c === '*' && next === '/') { out += '*/'; i += 2; mode = 'code'; continue; }
    out += c;
    i += 1;
  }
  return out;
}
```

- [ ] **Step 4:** Run the tests — PASS.
- [ ] **Step 5:** Commit: `feat(db): D1→Postgres placeholder translation`

---

### Task 3: `PgAdapter` — statements, results, batch-as-transaction, error shape

**Files:**
- Modify: `src/lib/pgAdapter.ts`
- Create: `test/pg/pgAdapter.test.ts`

**Interfaces (Produces):**
```ts
export class PgAdapter implements AppDb {
  constructor(sql: postgres.Sql); // an already-configured postgres.js client
  prepare(sql: string): AppStatement;
  batch<T>(statements: AppStatement[]): Promise<AppDbResult<T>[]>;
}
```
**Consumes:** `AppDb`/`AppStatement`/`AppDbResult` from Task 1, `translatePlaceholders` from Task 2.

Semantics to implement (and test):
- `first()` → first row or `null`; `first('col')` → that column of the first row or `null`.
- `all()` → `{ results, meta: { changes } }`; `run()` same shape (D1's `run()` also carries results — some call sites use it interchangeably). `meta.changes` = `result.count` (affected rows) for DML, `0` for SELECT.
- `batch()` → all statements inside one `sql.begin()` transaction, results in order; any error rolls back the whole batch and rethrows (matches D1 batch atomicity that admin revision snapshots rely on).
- Postgres errors pass through untouched (postgres.js errors carry `.code`, e.g. `'23505'`) — `isUniqueViolation` is updated in Task 7.
- Values bound with `.bind()` pass through as-is; `undefined` is rejected with a clear error (D1 also rejects it).

- [ ] **Step 1:** Write failing tests in `test/pg/pgAdapter.test.ts` (skipIf no DATABASE_URL). Cover, against a real table:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('PgAdapter', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: PgAdapter;
  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe(
      'CREATE TABLE t (id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY, name text UNIQUE, n integer)',
    );
    db = new PgAdapter(sql);
  });
  afterAll(async () => { await sql?.end(); });

  it('run() inserts and reports meta.changes', async () => {
    const r = await db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('a', 1).run();
    expect(r.meta.changes).toBe(1);
  });
  it('first() returns row, column form, and null when empty', async () => {
    expect(await db.prepare('SELECT name FROM t WHERE name = ?').bind('a').first<{ name: string }>()).toEqual({ name: 'a' });
    expect(await db.prepare('SELECT name FROM t WHERE name = ?').bind('a').first('name')).toBe('a');
    expect(await db.prepare('SELECT name FROM t WHERE name = ?').bind('zz').first()).toBeNull();
  });
  it('all() returns results array', async () => {
    await db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('b', 2).run();
    const { results } = await db.prepare('SELECT name FROM t ORDER BY name').all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
  });
  it('INSERT ... RETURNING id works through first()', async () => {
    const row = await db.prepare('INSERT INTO t (name) VALUES (?) RETURNING id').bind('c').first<{ id: number }>();
    expect(typeof row?.id).toBe('number');
  });
  it('batch() is atomic — a failing statement rolls back the whole batch', async () => {
    await expect(
      db.batch([
        db.prepare('INSERT INTO t (name) VALUES (?)').bind('batch-ok'),
        db.prepare('INSERT INTO t (name) VALUES (?)').bind('a'), // UNIQUE violation
      ]),
    ).rejects.toThrow();
    expect(await db.prepare('SELECT 1 AS x FROM t WHERE name = ?').bind('batch-ok').first()).toBeNull();
  });
  it('batch() returns per-statement results in order', async () => {
    const [r1, r2] = await db.batch([
      db.prepare('INSERT INTO t (name) VALUES (?)').bind('b1'),
      db.prepare('SELECT count(*)::int AS c FROM t'),
    ]);
    expect(r1.meta.changes).toBe(1);
    expect((r2.results[0] as { c: number }).c).toBeGreaterThan(0);
  });
  it('unique violations surface postgres code 23505', async () => {
    const err = await db.prepare('INSERT INTO t (name) VALUES (?)').bind('a').run().catch((e) => e);
    expect((err as { code?: string }).code).toBe('23505');
  });
  it('rejects undefined bind values like D1 does', async () => {
    await expect(db.prepare('SELECT ?').bind(undefined).run()).rejects.toThrow(/undefined/i);
  });
});
```

- [ ] **Step 2:** Run — FAILS (PgAdapter not defined).
- [ ] **Step 3:** Implement `PgAdapter` in `src/lib/pgAdapter.ts`:

```ts
import type postgres from 'postgres';
import type { AppDb, AppDbResult, AppStatement } from './appDb';

/** One prepared statement: holds SQL + bound values; executes lazily. */
class PgStatement implements AppStatement {
  constructor(
    private readonly exec: (sql: string, params: unknown[]) => Promise<postgres.RowList<postgres.Row[]>>,
    readonly sqlText: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...values: unknown[]): AppStatement {
    for (const v of values) {
      if (v === undefined) throw new TypeError('cannot bind undefined (use null)');
    }
    return new PgStatement(this.exec, this.sqlText, values);
  }
  private async execute(): Promise<postgres.RowList<postgres.Row[]>> {
    return this.exec(translatePlaceholders(this.sqlText), this.params);
  }
  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rows = await this.execute();
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return (colName !== undefined ? (row[colName] as T) : (row as T)) ?? null;
  }
  async all<T = unknown>(): Promise<AppDbResult<T>> {
    const rows = await this.execute();
    return { results: rows as T[], meta: { changes: rows.count ?? 0 }, success: true };
  }
  async run<T = unknown>(): Promise<AppDbResult<T>> {
    return this.all<T>();
  }
}

/** AppDb over a postgres.js client. `batch` = one real transaction. */
export class PgAdapter implements AppDb {
  constructor(private readonly sql: postgres.Sql) {}
  prepare(sqlText: string): AppStatement {
    return new PgStatement((q, p) => this.sql.unsafe(q, p as never[]), sqlText);
  }
  async batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    const stmts = statements as PgStatement[];
    return this.sql.begin(async (tx) => {
      const out: AppDbResult<T>[] = [];
      for (const s of stmts) {
        const rows = await tx.unsafe(translatePlaceholders(s.sqlText), s.params as never[]);
        out.push({ results: rows as T[], meta: { changes: rows.count ?? 0 }, success: true });
      }
      return out;
    }) as Promise<AppDbResult<T>[]>;
  }
}
```

Note: `rows.count` is postgres.js's affected-row count; for SELECT it equals the row count, which D1 also reports loosely — no call site reads `meta.changes` after a SELECT, so this is safe.

- [ ] **Step 4:** Run tests — PASS (with DATABASE_URL). Run plain `npm test` — everything else still green.
- [ ] **Step 5:** Commit: `feat(db): PgAdapter with D1-shaped statements and transactional batch`

---

### Task 4: SQLite-compat `datetime()` / `date()` functions for Postgres

**Files:**
- Create: `migrations-supabase/0001_init.sql` (compat functions only this task — schema appended in Task 5)
- Create: `test/pg/compatFunctions.test.ts`

**Produces:** Postgres functions `datetime(text, VARIADIC text[]) RETURNS text` and `date(text, VARIADIC text[]) RETURNS text` implementing exactly the SQLite modifier forms used in this repo (grep basis: `datetime\('now'|date\('now'` across `src/ migrations/ seed/`): `±N minutes/hours/days/months/years` (also space-padded like `'-7 days'`), `'weekday 0'`, `'start of day'`.

- [ ] **Step 1:** Write failing tests `test/pg/compatFunctions.test.ts` (skipIf no pg). Apply the functions file, then assert behavior mirrors SQLite:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it("date('now') resolves to our function (text), not the date-type cast", async () => {
    const v = await one("date('now')");
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
```

- [ ] **Step 2:** Run — FAILS (file missing).
- [ ] **Step 3:** Create `migrations-supabase/0001_init.sql` starting with this preamble:

```sql
-- church4christ Postgres schema (Supabase backend).
-- Part 1: SQLite-compat functions. The app's SQL (and this schema's DEFAULTs)
-- call datetime('now', ...)/date('now', ...) exactly as they do on D1; these
-- functions implement the SQLite modifier forms the repo actually uses:
--   ±N minutes/hours/days/months/years, 'weekday N', 'start of day'.
-- All math is UTC, matching SQLite's datetime('now').

CREATE OR REPLACE FUNCTION sqlite_compat_apply(base timestamp, mods text[])
RETURNS timestamp
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text;
  mm text[];
BEGIN
  FOREACH m IN ARRAY mods LOOP
    m := lower(btrim(m));
    mm := regexp_match(m, '^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$');
    IF mm IS NOT NULL THEN
      base := base + (mm[1] || ' ' || mm[2])::interval;
      CONTINUE;
    END IF;
    mm := regexp_match(m, '^weekday\s+(\d)$');
    IF mm IS NOT NULL THEN
      base := base + make_interval(days => ((mm[1]::int - EXTRACT(dow FROM base)::int) % 7 + 7) % 7);
      CONTINUE;
    END IF;
    IF m = 'start of day' THEN base := date_trunc('day', base); CONTINUE; END IF;
    IF m = 'start of month' THEN base := date_trunc('month', base); CONTINUE; END IF;
    IF m = 'start of year' THEN base := date_trunc('year', base); CONTINUE; END IF;
    RAISE EXCEPTION 'unsupported sqlite datetime modifier: %', m;
  END LOOP;
  RETURN base;
END;
$$;

CREATE OR REPLACE FUNCTION sqlite_compat_base(ts text)
RETURNS timestamp
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN lower(btrim(ts)) = 'now' THEN (now() AT TIME ZONE 'utc')
    ELSE ts::timestamp
  END;
$$;

CREATE OR REPLACE FUNCTION datetime(ts text, VARIADIC mods text[] DEFAULT '{}')
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_compat_apply(sqlite_compat_base(ts), mods), 'YYYY-MM-DD HH24:MI:SS');
$$;

CREATE OR REPLACE FUNCTION date(ts text, VARIADIC mods text[] DEFAULT '{}')
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_compat_apply(sqlite_compat_base(ts), mods), 'YYYY-MM-DD');
$$;
```

Watch out: SQLite's `weekday N` moves **forward** to the next matching weekday, staying put when already on it — the `((target - dow) % 7 + 7) % 7` days formula above encodes that; the tests pin it.

- [ ] **Step 4:** Run tests — PASS. If `date('now')` resolves to the built-in date-type cast instead of our function (test 4 fails with a non-string), qualify nothing — instead rename is NOT an option (call sites are fixed); fix by ensuring the function is created in `public` and `search_path` puts `public` first (Supabase default does). Record findings in the commit message.
- [ ] **Step 5:** Commit: `feat(db): SQLite-compat datetime()/date() for Postgres`

---

### Task 5: Full Postgres schema port (~42 tables)

**Files:**
- Modify: `migrations-supabase/0001_init.sql` (append schema after the compat functions)
- Create: `test/pg/schema.test.ts`

**Porting rules** (source of truth: `migrations/0001_init.sql`, `migrations/0002_email.sql`, `migrations/0003_people.sql` — port ALL tables/indexes from all three into the single `0001_init.sql`, in the same order):
1. `INTEGER PRIMARY KEY` (with or without `AUTOINCREMENT`) → `integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY` (BY DEFAULT, not ALWAYS — the seed inserts explicit IDs).
2. Keep `TEXT`, `INTEGER`, `REAL` column types verbatim. Keep every `CHECK`, `NOT NULL`, `UNIQUE`, `DEFAULT`, `REFERENCES ... ON DELETE ...` clause verbatim.
3. `DEFAULT (datetime('now'))` stays exactly as written (compat function from Task 4).
4. Partial indexes (`CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`) are valid Postgres — keep verbatim.
5. Drop any SQLite pragmas and `WITHOUT ROWID` if present. Do not add Postgres-isms (no `timestamptz`, no `boolean`, no `serial`).
6. If a D1 migration uses `ALTER TABLE ... ADD COLUMN`, fold the column into the base `CREATE TABLE` here (this file is a fresh consolidated snapshot).

- [ ] **Step 1:** Write failing test `test/pg/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('Postgres schema port', () => {
  const sql = hasPg ? pgClient() : (null as never);
  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe(readFileSync('migrations-supabase/0001_init.sql', 'utf8'));
  });
  afterAll(async () => { await sql?.end(); });

  it('creates every table the D1 migrations create', async () => {
    // Parse table names straight out of the D1 migration files so this test
    // can never drift from the source of truth.
    const d1Sql = ['0001_init.sql', '0002_email.sql', '0003_people.sql']
      .map((f) => readFileSync(`migrations/${f}`, 'utf8'))
      .join('\n');
    const wanted = [...d1Sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(wanted.length).toBeGreaterThan(35);
    const rows = await sql.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const have = new Set(rows.map((r) => (r.table_name as string).toLowerCase()));
    const missing = wanted.filter((t) => !have.has(t));
    expect(missing).toEqual([]);
  });

  it('ports every column of every table', async () => {
    // Column-level parity: extract "name TYPE" pairs per table from the D1 SQL
    // (including ALTER TABLE ADD COLUMN lines) and check information_schema.
    const d1Sql = ['0001_init.sql', '0002_email.sql', '0003_people.sql']
      .map((f) => readFileSync(`migrations/${f}`, 'utf8'))
      .join('\n');
    const cols: Array<[string, string]> = [];
    for (const m of d1Sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\(([\s\S]*?)\);/gi)) {
      const table = m[1].toLowerCase();
      for (const line of m[2].split('\n')) {
        const cm = line.match(/^\s*(\w+)\s+(TEXT|INTEGER|REAL|BLOB)/i);
        if (cm && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(cm[1])) cols.push([table, cm[1].toLowerCase()]);
      }
    }
    for (const m of d1Sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)) cols.push([m[1].toLowerCase(), m[2].toLowerCase()]);
    const rows = await sql.unsafe(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = cols.filter(([t, c]) => !have.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);
    expect(missing).toEqual([]);
  });

  it('identity columns accept explicit ids and still autogenerate afterwards', async () => {
    await sql.unsafe("INSERT INTO settings (key, value) VALUES ('probe', '1')");
    await sql.unsafe("INSERT INTO people (id, first_name, last_name, email) VALUES (9000, 'A', 'B', 'probe@example.com')");
    await sql.unsafe("SELECT setval(pg_get_serial_sequence('people', 'id'), (SELECT max(id) FROM people))");
    const r = await sql.unsafe(
      "INSERT INTO people (first_name, last_name, email) VALUES ('C', 'D', 'probe2@example.com') RETURNING id",
    );
    expect(Number(r[0].id)).toBeGreaterThan(9000);
  });
});
```

(If `people` requires more NOT NULL columns than shown, adjust the INSERT to satisfy the real schema — read `migrations/0001_init.sql` first.)

- [ ] **Step 2:** Run — FAILS (tables missing).
- [ ] **Step 3:** Port the schema following the rules above. Work table-by-table through `migrations/0001_init.sql`, then `0002_email.sql`, then fold `0003_people.sql` (its ALTERs become base columns; its new tables append).
- [ ] **Step 4:** Run the schema tests — PASS.
- [ ] **Step 5:** Commit: `feat(db): full Postgres schema port for the Supabase backend`

---

### Task 6: Migration runner + seed script for Supabase

**Files:**
- Create: `scripts/db/migrate-supabase.mjs`, `scripts/db/seed-supabase.mjs`
- Modify: `package.json` (scripts `db:migrate:supabase`, `db:seed:supabase`)
- Create: `test/pg/runner.test.ts`

**Produces:** `node scripts/db/migrate-supabase.mjs` applies every `migrations-supabase/*.sql` (sorted) not yet recorded in a `_migrations(name text primary key, applied_at text)` table, inside a transaction per file, using `SUPABASE_DB_URL` (falls back to `DATABASE_URL`). `seed-supabase.mjs` runs `seed/dev-seed.sql` with the same comment-strip + `;`-split logic as `test/e2e/setup.ts`, then resets every identity sequence with `setval(pg_get_serial_sequence(t, 'id'), (SELECT coalesce(max(id),1) FROM t))` for all tables that have an `id` identity column.

- [ ] **Step 1:** Write failing test `test/pg/runner.test.ts` that shells out to the runner with `execFileSync('node', ['scripts/db/migrate-supabase.mjs'], { env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL } })` against a reset schema, asserts `_migrations` has one row per file, runs it a second time and asserts idempotence (no error, same rows). Then runs the seed script and asserts `SELECT count(*) FROM people` > 0 and a follow-up autogenerated insert doesn't collide (sequence reset worked).
- [ ] **Step 2:** Run — FAILS.
- [ ] **Step 3:** Implement both scripts with postgres.js (`max: 1`). Migration runner outline:

```js
#!/usr/bin/env node
// Applies migrations-supabase/*.sql in name order, once each, tracked in
// _migrations. Usage: SUPABASE_DB_URL=postgres://... node scripts/db/migrate-supabase.mjs
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
if (!url) { console.error('set SUPABASE_DB_URL (or DATABASE_URL)'); process.exit(1); }
const sql = postgres(url, { max: 1, fetch_types: false, onnotice: () => {} });
try {
  await sql.unsafe('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at text NOT NULL DEFAULT to_char(now() at time zone \'utc\', \'YYYY-MM-DD HH24:MI:SS\'))');
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
} finally {
  await sql.end();
}
```

Seed script: same skeleton; statement splitting copied from `test/e2e/setup.ts` (strip `--` lines, split on `;`); after seeding, iterate `SELECT table_name FROM information_schema.columns WHERE column_name='id' AND is_identity='YES' AND table_schema='public'` and `setval` each.

- [ ] **Step 4:** Add npm scripts: `"db:migrate:supabase": "node scripts/db/migrate-supabase.mjs"`, `"db:seed:supabase": "node scripts/db/seed-supabase.mjs"`. Run the test — PASS. Note: if any seed statement fails on Postgres, fix the seed to stay portable (the compat functions cover `datetime`/`date`; anything else genuinely SQLite-only gets rewritten portably in `seed/dev-seed.sql` itself and re-verified against D1 with `npm run test:e2e`).
- [ ] **Step 5:** Commit: `feat(db): Supabase migration runner and seed script`

---

### Task 7: Portability sweep — RETURNING id, LOWER LIKE, ON CONFLICT, unique-violation match

**Files:**
- Modify: every file `grep -rln "last_row_id" src/` lists (~13 sites), the `SELECT MAX(id)` i18n-insert sites (`grep -rn "MAX(id)" src/lib`), `src/lib/adminDb.ts` (`isUniqueViolation`), `src/lib/teamDb.ts:511`, `src/lib/giftDb.ts` (INSERT OR IGNORE), `src/lib/adminDb.ts:87-88` + `src/lib/householdDb.ts:426` (LIKE)

**Rules (apply mechanically, one commit per rule is fine, tests must pass after each):**
1. Every read of `.meta.last_row_id` → append ` RETURNING id` to the INSERT and read via `.first<{ id: number }>()`; delete the now-unused `run()` result variable. Where the INSERT participated in a `batch()`, run the parent INSERT first (RETURNING), then batch the children with the captured id.
2. Every `SELECT MAX(id)`-as-last-insert-id → same RETURNING treatment (also fixes the existing race).
3. `INSERT OR IGNORE INTO person_interests ...` (`src/lib/giftDb.ts:65`) → `INSERT INTO person_interests (person_id, category) VALUES (?, ?) ON CONFLICT (person_id, category) DO NOTHING` (check the actual UNIQUE constraint columns in `migrations/0001_init.sql` first and match them).
4. Case-insensitive search LIKEs (3 sites) → wrap both sides: `LOWER(p.display_name) LIKE LOWER(?) ESCAPE '\'` etc. Keep the ESCAPE clause.
5. `isUniqueViolation` in `adminDb.ts` and the inline check in `teamDb.ts:511`:

```ts
function isUniqueViolation(e: unknown): boolean {
  // SQLite/D1 message, or Postgres SQLSTATE 23505 (postgres.js sets .code).
  return (
    String(e).includes('UNIQUE constraint failed') ||
    (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') ||
    String(e).includes('duplicate key value violates unique constraint')
  );
}
```

- [ ] **Step 1:** For each rule: make the change, then run the covering tests (`npx vitest run --project workers`) — the existing D1 suite covers all these paths (RETURNING works on D1). Expected: PASS after each rule.
- [ ] **Step 2:** `grep -rn "last_row_id\|MAX(id)\|INSERT OR IGNORE" src/` → zero hits (MAX(id) only where it was genuinely an aggregate, not an id-fetch — inspect each).
- [ ] **Step 3:** Run `npm run check` — clean.
- [ ] **Step 4:** Commit: `refactor(db): portable SQL — RETURNING id, LOWER LIKE, ON CONFLICT DO NOTHING, dual unique-violation match`

---

### Task 8: `dbProvider` + per-request `locals.db` + type sweep

**Files:**
- Create: `src/lib/dbProvider.ts`
- Modify: `src/env.d.ts` (Locals gains `db: AppDb; dbBackend: 'd1' | 'supabase'`), `src/middleware.ts`, `src/worker.ts`
- Modify: every file from `grep -rl "D1Database" src/` (~40 files) — type annotations `D1Database` → `AppDb` (import from `./appDb` / `../lib/appDb`), and every page/endpoint that did `import { env } from 'cloudflare:workers'` + `.DB` now uses `Astro.locals.db` (pages) / `context.locals.db` (endpoints)
- Create: `test/dbProvider.test.ts` (workers project)

**Interfaces (Produces):**
```ts
// src/lib/dbProvider.ts
export type DbBackend = 'd1' | 'supabase';
export type DbEnv = {
  DB?: D1Database;
  DB_BACKEND?: string;
  HYPERDRIVE?: { connectionString: string };
};
export function getBackend(env: DbEnv): DbBackend; // 'supabase' iff DB_BACKEND === 'supabase'
/** Per-REQUEST AppDb. On supabase this opens a fresh postgres.js client —
 *  Workers sockets are request-scoped, so callers must not cache it across
 *  requests. Returns { db, end } — end() drains the client (no-op on D1). */
export function openDb(env: DbEnv): { db: AppDb; backend: DbBackend; end: () => Promise<void> };
```

Implementation notes:
- supabase branch: `postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: false, connect_timeout: 10 })`; `end = () => sql.end({ timeout: 5 }).catch(() => {})`. Throw a clear error if `HYPERDRIVE` is missing.
- d1 branch: `{ db: env.DB, end: async () => {} }`; throw if `DB` missing.
- `src/middleware.ts`: right after locale handling, `const { db, backend, end } = openDb(env as unknown as DbEnv)`; set `context.locals.db = db; context.locals.dbBackend = backend;` replace the three `vars.DB` uses (`getActiveTheme`, `getEnabledModules`, `loadSessionUser(ByEmail)`) with `db`. After `const res = await next()`, schedule cleanup without blocking streaming: `context.locals.runtime?.ctx?.waitUntil?.(end())` guarded so tests without a runtime don't crash; also call `end()` on the early-return paths (module-404, CSRF-403, signin-redirect, forbidden) — factor a tiny `finish(res)` helper inside the middleware to avoid repeating it.
- `src/worker.ts` scheduled handler: `const { db, backend, end } = openDb(env as never)`; pass `db` to `sendReminders`/`sendWeeklyDigest`; wrap each branch's promise with `.finally(end)` inside the existing `ctx.waitUntil`. The BACKUP_CRON branch: when `backend !== 'd1'`, `console.log('backup skipped: supabase backend has its own backups')` and skip `runBackup`.
- Sweep: `D1Database` → `AppDb` in every `src/lib/*.ts` signature and every page. Pages switch from `import { env } from 'cloudflare:workers'` to `Astro.locals.db` — delete the env import when the DB was its only use (keep it where pages read other vars like `APP_ORIGIN`).
- `test/dbProvider.test.ts` (workers project): `getBackend({})` → `'d1'`; `getBackend({ DB_BACKEND: 'supabase' })` → `'supabase'`; `openDb` with the test env returns the D1 binding (`db === env.DB`); `openDb({ DB_BACKEND: 'supabase' })` without HYPERDRIVE throws.

- [ ] **Step 1:** Write `test/dbProvider.test.ts` (failing), implement `dbProvider.ts`, run — PASS.
- [ ] **Step 2:** Update `src/env.d.ts`, middleware, worker. Run `npm test` — PASS (middleware paths are covered by the e2e-ish worker tests).
- [ ] **Step 3:** The sweep. Go file by file (`grep -rl "D1Database" src/`); after each batch of ~10 files run `npm run check`. Finish with `grep -rn "D1Database" src/` → remaining hits ONLY in: `appDb.ts` (the assignability check), `dbProvider.ts` (DbEnv), `worker-configuration.d.ts` (generated). `grep -rn "cloudflare:workers" src/pages` → only pages that still need non-DB vars.
- [ ] **Step 4:** `npm test` and `npm run test:e2e` — full PASS (e2e proves middleware + pages still work end-to-end on D1).
- [ ] **Step 5:** Commit: `refactor(db): per-request locals.db via dbProvider; AppDb type sweep`

---

### Task 9: Backend-gated modules — `requiresBackend` + registry entries

**Files:**
- Modify: `src/lib/modules.ts`, `src/middleware.ts` (pass backend), `src/pages/admin/settings/index.astro` (Modules panel), `src/i18n/en.ts`, `src/i18n/zh.ts`
- Modify: `test/moduleGating.test.ts` (extend)

**Produces:**
- `ModuleDef` gains `requiresBackend?: 'supabase'`.
- `MODULE_KEYS` grows to 13 with `'giving'` and `'registration'` appended:

```ts
giving: {
  publicPrefixes: ['/give/checkout', '/my/giving', '/api/giving'],
  adminPrefixes: ['/admin/giving'],
  navKeys: [],
  uses: ['people'],
  requiresBackend: 'supabase',
},
registration: {
  publicPrefixes: ['/register', '/api/register'],
  adminPrefixes: ['/admin/registration'],
  navKeys: ['nav.register'],
  uses: [],
  requiresBackend: 'supabase',
},
```

- `getEnabledModules(db: AppDb, backend: DbBackend)` — after reading settings, delete any module whose `requiresBackend` doesn't match `backend`. Cache key must include the backend (simplest: store backend alongside the cached set and miss when it differs).
- Middleware passes `context.locals.dbBackend`. `src/lib/digest.ts` + `src/pages/auth/[token].astro` call sites updated (backend from their env via `getBackend`).
- Admin Modules panel: for backend-gated modules on D1, render the row disabled (checkbox `disabled`, note text `t('admin.modules.requiresSupabase')`). i18n keys: `en: 'Requires the Supabase database'`, `zh: '需要 Supabase 数据库'`; plus `module.giving.name` ('Giving'/'奉献'), `module.registration.name` ('Registration'/'活动报名'), `nav.register` ('Register'/'活动报名') following how existing module names are rendered in that panel (inspect the panel first; reuse its existing naming mechanism if it has one).
- The admin save handler keeps writing all 13 `module.<key>` rows — writing '1' for a backend-gated module on D1 is harmless because the backend filter wins.

- [ ] **Step 1:** Extend `test/moduleGating.test.ts` (failing first): `getEnabledModules(db, 'd1')` never contains `giving`/`registration` even when their settings rows are '1'; `getEnabledModules(db, 'supabase')` contains them by default; `moduleForPath('/my/giving')` → `'giving'` (beats `serve`'s `/my`); `moduleForPath('/register')` → `'registration'`; cache distinguishes backends (call with 'd1', then 'supabase', expect different sets without waiting for TTL).
- [ ] **Step 2:** Run — FAILS. Implement. Run — PASS.
- [ ] **Step 3:** Update the settings panel + i18n keys (run `npx vitest run --project workers -t i18n` for the parity test).
- [ ] **Step 4:** `npm test` + `npm run test:e2e` — PASS. (e2e modules sweep asserts 11 toggles; update `test/e2e/modules.e2e.test.ts` expectations to 13 with the two new rows disabled on D1.)
- [ ] **Step 5:** Commit: `feat(modules): backend-gated giving + registration module registry entries`

---

### Task 10: Cross-backend parity suite

**Files:**
- Create: `test/pg/parity.test.ts`

**Produces:** Evidence that the core `*Db` modules work on Postgres. Against a migrated+seeded PG database (reuse Task 6's runner + seed via `execFileSync` in `beforeAll`), construct `new PgAdapter(pgClient())` and exercise at least one read AND one write path from each of: `settings.ts` (get/set round-trip), `auth.ts` (`createLoginToken`/`consumeLoginToken` — covers `datetime('now', ?)` modifiers), `db.ts` (`i18nJoin`-based ministries index), `householdDb.ts` (`listHouseholds` rollup + `linkPersonToHousehold`), `adminDb.ts` (people list/search — covers LOWER LIKE — and `saveEvent` — covers RETURNING + batch), `planDb.ts` (one read), `publicDb.ts` (`listActiveEvents`), `modules.ts` (`getEnabledModules` with backend 'supabase'), `notesDb.ts` (create + list). Import the real functions from `src/lib/*` — they take `db` as an argument, so they run in node unchanged.

- [ ] **Step 1:** Write the suite (failing pieces will surface real port bugs — that is the point). Read each function's signature before calling it; assert on real seeded data (e.g. `listHouseholds` returns the seeded household with `member_count` ≥ 1).
- [ ] **Step 2:** Run with DATABASE_URL — iterate until PASS. Every failure is a portability bug: fix it in the *source* (portably, per Task 7 patterns), never by special-casing the test. Re-run `npm test` after each source fix to prove D1 still passes.
- [ ] **Step 3:** Commit: `test(db): cross-backend parity suite for core data modules`

---

### Task 11: e2e suite against Postgres (stretch — timebox, fallback documented)

**Files:**
- Create: `vitest.e2e.pg.config.ts`, `test/e2e-pg/setup.ts` (or env-switch inside the existing e2e config if cleaner)
- Modify: `package.json` (`test:e2e:pg`)

**Approach:** Clone `vitest.e2e.config.ts`; in the miniflare options add `hyperdrives: { HYPERDRIVE: process.env.DATABASE_URL }` and `bindings: { DB_BACKEND: 'supabase' }`; the setup file migrates + seeds Postgres via the Task 6 scripts (`execFileSync`) instead of `applyD1Migrations`, and truncates+reseeds between files (`DROP SCHEMA public CASCADE` + rerun, or a `TRUNCATE ... RESTART IDENTITY CASCADE` of all tables + reseed — pick the faster that stays correct; note e2e-pg does NOT get D1's per-test isolated-storage rollback, so if individual tests within a file mutate state in conflicting ways, reseed per file and keep going only if the suite is order-tolerant).
- [ ] **Step 1:** Attempt the config; run `npm run test:e2e:pg` with DATABASE_URL. Timebox: if miniflare's hyperdrive binding cannot reach localhost Postgres from workerd or the isolation gap breaks >10 tests, STOP; document findings in `docs/superpowers/plans/phase1-e2e-pg-findings.md` and rely on Task 10 + manual `wrangler dev` smoke as the validation floor.
- [ ] **Step 2:** If it works: run the full e2e suite, fix genuine portability bugs it surfaces (same fix-in-source rule as Task 10).
- [ ] **Step 3:** Commit: `test(e2e): Postgres-backed e2e run (or findings doc)`

---

### Task 12: wrangler.jsonc + typegen + CI

**Files:**
- Modify: `wrangler.jsonc` (add `"DB_BACKEND": "d1"` to vars; add a commented hyperdrive block:

```jsonc
// Supabase backend (docs/supabase-setup.md): set DB_BACKEND to "supabase",
// uncomment, and paste the id from `wrangler hyperdrive create`.
// "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "YOUR_HYPERDRIVE_ID" }],
```
- Modify: `test/wrangler.test.jsonc` + `test/e2e/wrangler.e2e.jsonc` if they declare vars (keep D1 defaults), `.dev.vars.example` (document `DB_BACKEND`), `.github/workflows/ci.yml` (add a `postgres:16` service container, `DATABASE_URL` env for the test step, and a `db:migrate:supabase`+`db:seed:supabase`+`vitest --project pg` step)
- Run `npm run cf-typegen` and commit the regenerated `worker-configuration.d.ts`.

- [ ] **Step 1:** Make the edits; `npm test` + `npm run check` — PASS.
- [ ] **Step 2:** Commit: `chore(ci): DB_BACKEND var, hyperdrive stub, Postgres service in CI`

---

## Self-review checklist (run after all tasks)

- [ ] `grep -rn "D1Database" src/` → only `appDb.ts`, `dbProvider.ts`, generated types.
- [ ] `grep -rn "last_row_id\|INSERT OR IGNORE" src/` → zero.
- [ ] `npm test`, `npm run test:e2e`, `npm run check`, `npm run build` all green.
- [ ] With DATABASE_URL: `npx vitest run --project pg` green; `npm run test:e2e:pg` green or findings doc exists.
