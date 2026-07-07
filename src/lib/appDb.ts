// The structural database seam both backends satisfy. It is deliberately shaped
// like Cloudflare's D1 binding (prepare/bind/first/all/run/batch), because the
// existing D1 `DB` binding is the baseline every data-access module already codes
// against — so D1 satisfies `AppDb` as-is, with zero adapter. A second backend
// (a Postgres adapter over postgres.js, added in a later task) implements the same
// interface, letting every `db.ts`-style module take an `AppDb` and run unchanged
// against either engine. Keeping the seam D1-shaped means the migration is
// additive: nothing that already speaks to a `D1Database` has to change.
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

// Compile-time proof that the real D1 binding satisfies AppDb — if a future
// D1 type bump breaks structural compatibility, `astro check` fails here.
type _AssertD1IsAppDb = D1Database extends AppDb ? true : never;
const _d1IsAppDb: _AssertD1IsAppDb = true;
void _d1IsAppDb;
