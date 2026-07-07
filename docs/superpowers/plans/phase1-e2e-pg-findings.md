# Phase 1 · Task 11 — e2e suite against Postgres (findings)

Status: **partial success.** The Postgres-backed worker runs end-to-end through
miniflare's Hyperdrive binding, and the exploration surfaced (and fixed, in source,
portably) seven genuine SQLite→Postgres portability bugs. The full `test/e2e/**`
suite (150 tests) can NOT be reused as-is against Postgres — not because of any
runtime limitation, but because those tests are architected on the D1 `env.DB`
binding as the shared source of truth. `npm run test:e2e:pg` therefore runs a
focused, green PG **smoke** (`test/e2e-pg/smoke.test.ts`), and the D1 `npm run
test:e2e` remains the full-coverage suite.

## What works — miniflare Hyperdrive → local Postgres

`@cloudflare/vitest-pool-workers@0.17.0` (miniflare 4.2026063x) accepts a per-worker
`hyperdrives` option and the pool passes it through (`hyperdrives` is part of
`WorkerOptions`, merged into the runner worker). Given a plain `postgres://…` URL:

- miniflare's `HYPERDRIVE_PLUGIN.getServices` parses `sslmode` from the URL. With no
  `sslmode` param it defaults to **`disable`**, and miniflare wires workerd straight
  to `host:port` via an `external` service with `tcp: {}` — **no proxy, no TLS.**
  (For `sslmode=require`/`verify-*` it instead spins up a local TLS proxy.)
- So `hyperdrives: { HYPERDRIVE: 'postgres://postgres:postgres@localhost:5434/postgres' }`
  lets workerd reach local Postgres over plain TCP. The worker's request-scoped
  `postgres.js` client (`src/lib/dbProvider.ts`, `prepare:false`) connects with no
  changes.

Config: `vitest.e2e.pg.config.ts` reuses `test/e2e/wrangler.e2e.jsonc` (the built
worker + its bindings; the unused D1 binding is harmless) and adds
`miniflare.hyperdrives` + `miniflare.bindings.DB_BACKEND='supabase'`.

### Migrate + seed split (the pool can't run child_process)

The e2e `setupFiles` run **inside** workerd, so `execFileSync` / `node:child_process`
are unavailable there. Split accordingly:

- `test/e2e-pg/global-setup.ts` (Node, once): `DROP SCHEMA public CASCADE` + the Task 6
  `migrate-supabase.mjs` via `execFileSync`.
- `test/e2e-pg/setup.ts` (in-pool, per file): opens a `postgres.js` client over
  `env.HYPERDRIVE`, `TRUNCATE … RESTART IDENTITY CASCADE`s every table, reloads the
  demo seed, and bumps the identity sequences — the D1 path's per-test isolated-storage
  rollback does not exist here, so each file re-baselines the whole DB. Files run
  serially (`fileParallelism: false`) since they share one database.

## The blocker — the e2e suite is coupled to the D1 `env.DB` binding

When the full `test/e2e/**` suite is pointed at the PG config, **51 of 150 tests fail**
— and after the source fixes below, **every remaining failure is `D1_ERROR: no such
table`** (or an assertion that follows from it). Zero `PostgresError` /
`CONNECTION_ENDED` remain. Root cause:

- The e2e suite uses `env.DB` (the D1 binding) directly **98 times across 9 files** to
  seed rows, verify writes, and mint auth tokens — on the assumption that the test
  harness and the worker share ONE database.
- With `DB_BACKEND=supabase`, the worker reads/writes **Postgres** (over HYPERDRIVE),
  while `env.DB` is a **separate, unmigrated D1**. The two diverge: a row seeded via
  `env.DB` is invisible to the worker; a mutation the worker makes (into PG) is
  invisible to an `env.DB` verification; a login token created via `env.DB` can't be
  found by the PG-backed worker (so all 8 `auth.e2e` tests fail).

This is wholesale harness coupling (≫10 tests), which the task brief designates a STOP
condition. Making the full suite pass would require a **suite fork**: give the tests a
backend-agnostic DB handle that, in PG mode, is a `PgAdapter` over the same Hyperdrive
connection the worker uses, and rewrite the raw SQLite-dialect test SQL
(`datetime('now', …)`, `?` binds, `.batch()`, integer-boolean `active = 0/1`) to run
through it. That is out of scope for this timeboxed task and touches the shared D1 e2e
files.

## Portability bugs found and fixed (in source, portable to both backends)

The exploration drove the real request path (middleware + routes + streamed render)
against Postgres and surfaced bugs the module-level parity suite (Task 10) did not.
All fixes keep the app SQL identical on D1/SQLite and Postgres, verified by
`npm run test:e2e` (D1, 150 green) staying green.

1. **`IS NOT ?` → `IS DISTINCT FROM ?`** (`src/lib/adminDb.ts`, 2 sites:
   `resolveDateSlot`, `movePrayerRequest`). SQLite's null-safe `x IS NOT <expr>` is a
   Postgres syntax error (`IS NOT` only accepts NULL/TRUE/FALSE/DISTINCT FROM). The
   SQL-standard `IS DISTINCT FROM` has identical semantics and both backends accept it.
   Symptom: bulletin/sermon/prayer-sheet save → `syntax error at or near "$3"` → 500.

2. **Scalar 2-arg `MAX`/`MIN` → compat functions** (`migrations-supabase/0001_init.sql`).
   SQLite's `MAX(a,b)`/`MIN(a,b)` are scalar greatest/least; Postgres has only 1-arg
   aggregates. Added 2-arg scalar overloads under the same names (Postgres resolves by
   arity — the aggregate is untouched) so `SUM(MAX(0, needed - filled))` staffing math
   runs unchanged. Symptom: `function max(integer, bigint) does not exist` on
   `/admin/ministries`, `/admin` reports, ministry/team pages.

3. **Mixed numbered/anonymous placeholder collision** (`src/lib/pgAdapter.ts`,
   `translatePlaceholders`). A numbered head query (`?1, ?2`) splicing an anonymous
   IN-list (`?`, from `leaderTeamFilter`) numbered the bare `?` from its own counter →
   `$1`, colliding with `?1`. SQLite numbers a bare `?` as *(largest assigned so far) +
   1*; the translator now does the same. Symptom: `operator does not exist: integer =
   text` (the team id bound to a date string) in the leader-scope shortfall query.

4. **`CONNECTION_ENDED` during streamed render** (`src/middleware.ts`) — the carry-forward
   from Task 8. The middleware scheduled the postgres.js `end()` via
   `cfContext.waitUntil` at middleware-return, but a rendered body streams lazily and
   component queries (e.g. the settings load) run *as the client consumes the stream* —
   racing `end()`. Fix (the sanctioned contingency): on the supabase backend, when the
   response has a body, pipe it through a pass-through `TransformStream` whose `flush()`
   (fired after the last byte) drains the client; null-body exits (redirects) still
   drain via `waitUntil`. D1's `end()` is a no-op, so the D1 path is unchanged.

5. **`HAVING <select-alias>` → subquery** (`src/lib/adminOverviewDb.ts`,
   `getNeedsAttention`). SQLite lets `HAVING gap > 0` reference a SELECT alias; Postgres
   rejects it (`column "gap" does not exist`). Rewrote to filter the alias in an outer
   `WHERE` over the grouped subquery — portable to both.

6. **`GROUP BY` functional dependency** (same query). SQLite allows selecting bare
   non-grouped columns; Postgres requires `st_l.name`/`st_d.name` (from a joined table)
   in `GROUP BY`. Listed them explicitly. (Masked by #5 until fixed — Postgres reports
   the HAVING-alias error at parse time, before the grouping check.)

7. **`WHERE 1` / `WHERE 0` → `WHERE TRUE` / `WHERE FALSE`** (`src/lib/adminOverviewDb.ts`,
   the scope `clause`). Postgres's `WHERE` demands a boolean; SQLite treats integers as
   truthy. The `TRUE`/`FALSE` keywords are accepted by both D1/SQLite (≥3.23) and
   Postgres. Symptom: `argument of WHERE must be type boolean, not type integer`.

Unit coverage added for the two source-level fixes: `test/pg/translate.test.ts` (mixed
placeholder) and `test/pg/compatFunctions.test.ts` (2-arg max/min + aggregate
coexistence).

## Residual (benign) noise

`postgres.js`'s Cloudflare socket read loop surfaces `Error: Stream was cancelled` as an
unhandled rejection when `end()` closes a socket mid-`read()`. It is cosmetic — the
query has already completed and the drain is intentional — and is swallowed by the
config's `dangerouslyIgnoreUnhandledErrors` (the same knob the D1 e2e uses for the
benign es-module-lexer WASM-compile rejection). It is distinct from `CONNECTION_ENDED`
(a real mid-render failure, fixed by #4 above).

## What `test:e2e:pg` validates now, and the validation floor

`npm run test:e2e:pg` (requires `DATABASE_URL`) runs `test/e2e-pg/smoke.test.ts` — 7
tests driving the built worker over Postgres: the public render path (theme/settings/
modules/announcements read over Hyperdrive while the body streams) and the
authenticated admin + team-leader `/admin/ministries` console (the fixed shortfall
query, both all-scope and leader-scope). Green.

Combined validation floor for the Supabase backend:

- `test/pg/**` — module-level cross-backend parity (Task 10), every `*Db` module against
  real Postgres.
- `test/e2e-pg/smoke.test.ts` — the full middleware→route→postgres.js stack against
  Postgres.
- `npm run test:e2e` — the complete 150-test behavioural suite on D1 (the production-parity
  backend for behaviour), unchanged.
- Manual `wrangler dev` smoke against a real Hyperdrive/Supabase, as needed.

## Gates

- `npm run test:e2e:pg` — 7 passed (with `DATABASE_URL`).
- `npm run test:e2e` (D1) — 150 passed (no regression from the source fixes).
- `npm test` — 694 passed (unit + `test/pg` parity, with `DATABASE_URL`).
- `npm run check` — 0 errors.
