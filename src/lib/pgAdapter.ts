// Postgres backend for the `AppDb` seam (src/lib/appDb.ts): the placeholder
// translation helper plus the PgStatement/PgAdapter classes built on it.
// D1/SQLite bind params as `?` / `?N`, but postgres.js (and Postgres) speak
// `$n`, so every SQL string crossing the seam is rewritten once on its way to
// the driver.
import type postgres from 'postgres';
import type { AppDb, AppDbResult, AppStatement } from './appDb';

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
    return { results: rows as unknown as T[], meta: { changes: rows.count ?? 0 }, success: true };
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
        out.push({ results: rows as unknown as T[], meta: { changes: rows.count ?? 0 }, success: true });
      }
      return out;
    }) as Promise<AppDbResult<T>[]>;
  }
}
