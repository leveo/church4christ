import { readdirSync } from 'node:fs';

export type D1Column = {
  name: string;
  type: 'integer' | 'text' | 'real' | 'blob';
  nullable: boolean;
  defaultValue: string | null;
  identity: boolean;
};

export type D1Constraint = {
  kind: 'primary' | 'unique' | 'foreign';
  columns: string[];
  foreignTable?: string;
  foreignColumns?: string[];
};

export type D1Index = {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  predicate: string | null;
};

export type D1Schema = {
  tables: Map<string, { columns: Map<string, D1Column>; constraints: D1Constraint[] }>;
  indexes: Map<string, D1Index>;
};

export function discoverD1MigrationFiles(directory = 'migrations'): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

function mapOutsideSqlQuotes(
  value: string,
  transform: (segment: string) => string,
  transformQuoted: (segment: string) => string = (segment) => segment,
): string {
  let result = '';
  let outsideStart = 0;
  for (let i = 0; i < value.length; i += 1) {
    const quote = value[i];
    if (quote !== "'" && quote !== '"') continue;
    result += transform(value.slice(outsideStart, i));
    const quotedStart = i;
    let closed = false;
    for (i += 1; i < value.length; i += 1) {
      if (value[i] !== quote) continue;
      if (value[i + 1] === quote) {
        i += 1;
        continue;
      }
      closed = true;
      break;
    }
    if (!closed) throw new Error('unterminated quoted value in index predicate');
    result += transformQuoted(value.slice(quotedStart, i + 1));
    outsideStart = i + 1;
  }
  return result + transform(value.slice(outsideStart));
}

function hasSingleOuterPair(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i + 1] === quote) i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && i < value.length - 1) return false;
    if (depth < 0) return false;
  }
  return !quote && depth === 0;
}

function redundantAtomPair(value: string): [number, number] | null {
  const stack: number[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i + 1] === quote) i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') {
      stack.push(i);
      continue;
    }
    if (char !== ')') continue;
    const start = stack.pop();
    if (start === undefined) throw new Error('unbalanced index predicate parentheses');
    const before = value[start - 1] ?? '';
    const syntax = mapOutsideSqlQuotes(value.slice(start + 1, i), (segment) => segment, () => '');
    if (!/[A-Za-z0-9_\"]/.test(before) && !/\b(?:and|or)\b/i.test(syntax)) return [start, i];
  }
  if (quote) throw new Error('unterminated quoted value in index predicate');
  if (stack.length) throw new Error('unbalanced index predicate parentheses');
  return null;
}

/** Canonicalize equivalent SQLite/Postgres partial-index predicates. */
export function normalizeIndexPredicate(value: string | null): string | null {
  if (value === null) return null;
  let normalized = mapOutsideSqlQuotes(
    value.trim(),
    (segment) => segment
      .replaceAll(/::(?:text|character varying)/gi, '')
      .replace(/\s+/g, ' ')
      .toLowerCase(),
  );
  while (hasSingleOuterPair(normalized)) normalized = normalized.slice(1, -1).trim();
  // pg_get_expr parenthesizes each simple boolean atom. Remove only those
  // redundant atom wrappers; retain function calls and grouped AND/OR terms.
  let pair = redundantAtomPair(normalized);
  while (pair) {
    normalized = `${normalized.slice(0, pair[0])}${normalized.slice(pair[0] + 1, pair[1])}${normalized.slice(pair[1] + 1)}`;
    while (hasSingleOuterPair(normalized)) normalized = normalized.slice(1, -1).trim();
    pair = redundantAtomPair(normalized);
  }
  return normalized;
}

function identifier(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed).toLowerCase();
}

function stripLineComments(sql: string): string {
  let result = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (quote) {
      result += char;
      if (char === quote) {
        if (next === quote) {
          result += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += char;
      continue;
    }
    if (char === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      result += '\n';
      continue;
    }
    result += char;
  }
  return result;
}

function splitSql(sql: string, delimiter: ',' | ';'): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === '(') {
      depth += 1;
      current += char;
    } else if (char === ')') {
      depth -= 1;
      current += char;
    } else if (char === delimiter && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (quote || depth !== 0) throw new Error('unbalanced SQL while parsing D1 migrations');
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function identifiers(value: string): string[] {
  return splitSql(value, ',').map(identifier);
}

function normalizeDefault(raw: string | null): string | null {
  if (raw === null) return null;
  let value = raw.trim();
  while (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
  if (/^datetime\s*\(\s*'now'\s*\)$/i.test(value)) return 'utc-now';
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.toLowerCase();
}

function defaultExpression(tail: string): string | null {
  const match = /\bDEFAULT\b/i.exec(tail);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (/\s/.test(tail[i] ?? '')) i += 1;
  const start = i;
  if (tail[i] === '(') {
    let depth = 0;
    let quote = false;
    for (; i < tail.length; i += 1) {
      const char = tail[i];
      if (char === "'") {
        if (quote && tail[i + 1] === "'") i += 1;
        else quote = !quote;
      } else if (!quote && char === '(') depth += 1;
      else if (!quote && char === ')' && --depth === 0) return tail.slice(start, i + 1);
    }
    throw new Error(`unbalanced DEFAULT expression: ${tail}`);
  }
  if (tail[i] === "'") {
    i += 1;
    while (i < tail.length) {
      if (tail[i] === "'" && tail[i + 1] === "'") i += 2;
      else if (tail[i] === "'") return tail.slice(start, i + 1);
      else i += 1;
    }
    throw new Error(`unterminated DEFAULT string: ${tail}`);
  }
  while (i < tail.length && !/\s|,/.test(tail[i])) i += 1;
  return tail.slice(start, i);
}

function parseColumn(entry: string): { column: D1Column; constraints: D1Constraint[] } | null {
  const match = entry.match(/^((?:"(?:[^"]|"")+")|[A-Za-z_]\w*)\s+(INTEGER|TEXT|REAL|BLOB)\b([\s\S]*)$/i);
  if (!match) return null;
  const name = identifier(match[1]);
  const type = match[2].toLowerCase() as D1Column['type'];
  const tail = match[3];
  const primary = /\bPRIMARY\s+KEY\b/i.test(tail);
  const constraints: D1Constraint[] = [];
  if (primary) constraints.push({ kind: 'primary', columns: [name] });
  if (/\bUNIQUE\b/i.test(tail)) constraints.push({ kind: 'unique', columns: [name] });
  const foreign = tail.match(/\bREFERENCES\s+((?:"(?:[^"]|"")+")|[A-Za-z_]\w*)\s*\(([^)]+)\)/i);
  if (foreign) {
    constraints.push({
      kind: 'foreign',
      columns: [name],
      foreignTable: identifier(foreign[1]),
      foreignColumns: identifiers(foreign[2]),
    });
  }
  return {
    column: {
      name,
      type,
      nullable: !primary && !/\bNOT\s+NULL\b/i.test(tail),
      defaultValue: normalizeDefault(defaultExpression(tail)),
      identity: type === 'integer' && primary,
    },
    constraints,
  };
}

function parseTableConstraint(entry: string): D1Constraint | null {
  const primary = entry.match(/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  if (primary) return { kind: 'primary', columns: identifiers(primary[1]) };
  const unique = entry.match(/^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*\(([^)]+)\)/i);
  if (unique) return { kind: 'unique', columns: identifiers(unique[1]) };
  const foreign = entry.match(/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(\S+)\s*\(([^)]+)\)/i);
  if (foreign) {
    return {
      kind: 'foreign',
      columns: identifiers(foreign[1]),
      foreignTable: identifier(foreign[2]),
      foreignColumns: identifiers(foreign[3]),
    };
  }
  return null;
}

export function parseFinalD1Schema(sources: string[]): D1Schema {
  const schema: D1Schema = { tables: new Map(), indexes: new Map() };
  const statements = sources.flatMap((source) => splitSql(stripLineComments(source), ';'));

  for (const statement of statements) {
    const createTable = statement.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\S+)\s*\(([\s\S]*)\)$/i);
    if (createTable) {
      const name = identifier(createTable[1]);
      const table = { columns: new Map<string, D1Column>(), constraints: [] as D1Constraint[] };
      for (const entry of splitSql(createTable[2], ',')) {
        const parsed = parseColumn(entry);
        if (parsed) {
          table.columns.set(parsed.column.name, parsed.column);
          table.constraints.push(...parsed.constraints);
          continue;
        }
        const constraint = parseTableConstraint(entry);
        if (constraint) table.constraints.push(constraint);
        else if (!/^(?:CONSTRAINT\s+\S+\s+)?CHECK\b/i.test(entry)) {
          throw new Error(`unsupported table entry in ${name}: ${entry}`);
        }
      }
      schema.tables.set(name, table);
      continue;
    }

    const addColumn = statement.match(/^ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN\s+([\s\S]+)$/i);
    if (addColumn) {
      const tableName = identifier(addColumn[1]);
      const table = schema.tables.get(tableName);
      const parsed = parseColumn(addColumn[2]);
      if (!table || !parsed) throw new Error(`cannot apply ADD COLUMN to ${tableName}: ${statement}`);
      table.columns.set(parsed.column.name, parsed.column);
      table.constraints.push(...parsed.constraints);
      continue;
    }

    const dropTable = statement.match(/^DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(\S+)$/i);
    if (dropTable) {
      const tableName = identifier(dropTable[1]);
      schema.tables.delete(tableName);
      for (const [name, index] of schema.indexes) {
        if (index.table === tableName) schema.indexes.delete(name);
      }
      continue;
    }

    const renameTable = statement.match(/^ALTER\s+TABLE\s+(\S+)\s+RENAME\s+TO\s+(\S+)$/i);
    if (renameTable) {
      const from = identifier(renameTable[1]);
      const to = identifier(renameTable[2]);
      const table = schema.tables.get(from);
      if (!table) throw new Error(`cannot rename missing table ${from}`);
      schema.tables.delete(from);
      schema.tables.set(to, table);
      for (const index of schema.indexes.values()) {
        if (index.table === from) index.table = to;
      }
      continue;
    }

    const createIndex = statement.match(
      /^CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\S+)\s+ON\s+(\S+)\s*\(([^)]+)\)(?:\s+WHERE\s+([\s\S]+))?$/i,
    );
    if (createIndex) {
      const name = identifier(createIndex[2]);
      schema.indexes.set(name, {
        name,
        table: identifier(createIndex[3]),
        columns: identifiers(createIndex[4]),
        unique: Boolean(createIndex[1]),
        predicate: createIndex[5]?.replace(/\s+/g, ' ').trim() ?? null,
      });
      continue;
    }

    const dropIndex = statement.match(/^DROP\s+INDEX(\s+IF\s+EXISTS)?\s+(\S+)$/i);
    if (dropIndex) {
      const name = identifier(dropIndex[2]);
      if (!dropIndex[1] && !schema.indexes.has(name)) {
        throw new Error(`cannot drop missing index ${name}`);
      }
      schema.indexes.delete(name);
      continue;
    }

    // Data-copy statements used by SQLite table rebuilds are intentionally
    // ignored. Any unrecognized schema-affecting statement must stop parity
    // analysis so a future migration cannot silently disappear from the model.
    if (/^(?:CREATE|ALTER|DROP)\b/i.test(statement)) {
      throw new Error(`unsupported schema DDL: ${statement}`);
    }
  }
  return schema;
}
