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
  let largest = 0;
  let mode = 'code';
  let blockDepth = 0;
  let dollarDelimiter = '';
  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor];
    const next = sql[cursor + 1];
    if (mode === 'code') {
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '-' && next === '-') {
        mode = 'line'; out += char + next; cursor += 1; continue;
      } else if (char === '/' && next === '*') {
        mode = 'block'; blockDepth = 1; out += char + next; cursor += 1; continue;
      } else if (char === '$') {
        const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(cursor));
        if (match) {
          mode = 'dollar'; dollarDelimiter = match[0]; out += dollarDelimiter; cursor += dollarDelimiter.length - 1; continue;
        }
      } else if (char === '?') {
        let end = cursor + 1;
        while (end < sql.length && /[0-9]/.test(sql[end])) end += 1;
        let position;
        if (end > cursor + 1) {
          position = Number(sql.slice(cursor + 1, end));
          if (!Number.isSafeInteger(position) || position <= 0) throw new Error('SQL numbered bind must be a positive safe integer');
          cursor = end - 1;
        } else position = largest + 1;
        largest = Math.max(largest, position);
        if (position > params.length) throw new Error('SQL bind count is smaller than placeholder count');
        out += replacement(params[position - 1], position);
        continue;
      }
    } else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) {
      const quote = mode === 'single' ? "'" : '"';
      if (next === quote) { out += char + next; cursor += 1; continue; }
      mode = 'code';
    } else if (mode === 'line' && char === '\n') mode = 'code';
    else if (mode === 'block' && char === '/' && next === '*') {
      blockDepth += 1; out += char + next; cursor += 1; continue;
    } else if (mode === 'block' && char === '*' && next === '/') {
      blockDepth -= 1; out += char + next; cursor += 1;
      if (blockDepth === 0) mode = 'code';
      continue;
    } else if (mode === 'dollar' && sql.startsWith(dollarDelimiter, cursor)) {
      out += dollarDelimiter; cursor += dollarDelimiter.length - 1; mode = 'code'; dollarDelimiter = ''; continue;
    }
    out += char;
  }
  if (mode === 'single' || mode === 'double') throw new Error('Unterminated SQL quote');
  if (mode === 'block') throw new Error('Unterminated SQL block comment');
  if (mode === 'dollar') throw new Error('Unterminated SQL dollar quote');
  if (largest !== params.length) throw new Error('SQL bind count is larger than placeholder count');
  return out;
}
