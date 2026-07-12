export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite SQL number');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value !== 'string') throw new TypeError(`unsupported SQL bind type: ${typeof value}`);
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * @param {string} sql
 * @param {unknown[]} params
 * @param {(value: unknown, position: number) => string} [replacement]
 */
export function renderAnonymousBinds(sql, params, replacement = sqlLiteral) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
  if (!Array.isArray(params)) throw new TypeError('SQL params must be an array');
  if (typeof replacement !== 'function') throw new TypeError('SQL replacement must be a function');
  let out = '';
  let index = 0;
  let mode = 'code';
  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor];
    const next = sql[cursor + 1];
    if (mode === 'code') {
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '-' && next === '-') {
        mode = 'line'; out += char + next; cursor += 1; continue;
      } else if (char === '/' && next === '*') {
        mode = 'block'; out += char + next; cursor += 1; continue;
      } else if (char === '?') {
        if (index >= params.length) throw new Error('SQL bind count is smaller than placeholder count');
        out += replacement(params[index], index + 1);
        index += 1;
        continue;
      }
    } else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) {
      const quote = mode === 'single' ? "'" : '"';
      if (next === quote) { out += char + next; cursor += 1; continue; }
      mode = 'code';
    } else if (mode === 'line' && char === '\n') mode = 'code';
    else if (mode === 'block' && char === '*' && next === '/') {
      out += char + next; cursor += 1; mode = 'code'; continue;
    }
    out += char;
  }
  if (mode === 'single' || mode === 'double') throw new Error('Unterminated SQL quote');
  if (mode === 'block') throw new Error('Unterminated SQL block comment');
  if (index !== params.length) throw new Error('SQL bind count is larger than placeholder count');
  return out;
}
