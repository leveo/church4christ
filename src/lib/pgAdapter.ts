// Postgres backend for the `AppDb` seam (src/lib/appDb.ts). The full PgAdapter
// class lands in a later task; this task ships only the placeholder translation
// helper it will depend on. D1/SQLite bind params as `?` / `?N`, but postgres.js
// (and Postgres) speak `$n`, so every SQL string crossing the seam is rewritten
// once on its way to the driver.

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
