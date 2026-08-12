import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import {
  discoverD1MigrationFiles,
  normalizeIndexPredicate,
  parseFinalD1Schema,
  type D1Constraint,
} from './schemaParity';

const D1_FILES = discoverD1MigrationFiles();

// These feature tables intentionally have no D1 equivalent. Keeping this list
// explicit makes a new Postgres-only table a reviewed schema decision.
const SUPABASE_ONLY_TABLES = new Set([
  // Giving
  'funds',
  'fund_i18n',
  'gifts',
  'recurring_gifts',
  // Registration
  'reg_events',
  'reg_event_i18n',
  'reg_questions',
  'reg_question_i18n',
  'registrations',
  'reg_answers',
  // Member portal
  'group_files',
  'event_admins',
  'prayer_items',
  // Groups bridge available only on the Supabase schema
  'group_reg_events',
]);

// Private relations are qualified and deliberately separate from the public
// Supabase-only allowlist so D1/public parity cannot absorb them accidentally.
const SUPABASE_ONLY_PRIVATE_RELATIONS = new Set([
  'church_private.stripe_checkout_requests',
  'church_private.stripe_webhook_events',
]);

const INFRASTRUCTURE_TABLES = new Set(['_migrations']);

function normalizePgDefault(value: string | null): string | null {
  if (value === null) return null;
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (/^datetime\s*\(\s*'now'::text(?:\s*,[\s\S]*)?\)$/i.test(normalized)) return 'utc-now';
  const text = normalized.match(/^'((?:[^']|'')*)'::text$/i);
  if (text) return text[1].replaceAll("''", "'");
  return normalized.toLowerCase();
}

function expectedPgType(table: string, column: string, d1Type: string): string {
  // SQLite's INTEGER affinity stores custom-page UUIDs in revisions.entity_id;
  // Postgres must widen that shared column to text to preserve the same values.
  if (table === 'revisions' && column === 'entity_id') return 'text';
  if (d1Type === 'blob') return 'bytea';
  return d1Type;
}

function pgIdentifierArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1);
    return body ? body.split(',').map((item) => item.replace(/^"|"$/g, '')) : [];
  }
  throw new Error(`unexpected Postgres identifier array: ${JSON.stringify(value)}`);
}

function constraintSignature(table: string, constraint: D1Constraint): string {
  const target =
    constraint.kind === 'foreign'
      ? `->${constraint.foreignTable}(${constraint.foreignColumns?.join(',') ?? ''})` +
        `[delete=${constraint.onDelete ?? 'no action'},update=${constraint.onUpdate ?? 'no action'}]`
      : '';
  return `${table}:${constraint.kind}(${constraint.columns.join(',')})${target}`;
}

function pgReferentialAction(value: unknown): NonNullable<D1Constraint['onDelete']> {
  const actions: Record<string, NonNullable<D1Constraint['onDelete']>> = {
    a: 'no action',
    r: 'restrict',
    c: 'cascade',
    n: 'set null',
    d: 'set default',
  };
  const action = actions[String(value)];
  if (!action) throw new Error(`unsupported Postgres referential action: ${String(value)}`);
  return action;
}

describe('foreign-key action signature', () => {
  const base = {
    kind: 'foreign',
    columns: ['parent_id'],
    foreignTable: 'parents',
    foreignColumns: ['id'],
    onDelete: 'cascade',
    onUpdate: 'no action',
  };

  it('detects CASCADE changing to RESTRICT or NO ACTION', () => {
    expect(constraintSignature('children', base as D1Constraint)).not.toBe(constraintSignature('children', {
      ...base,
      onDelete: 'restrict',
    } as D1Constraint));
    expect(constraintSignature('children', base as D1Constraint)).not.toBe(constraintSignature('children', {
      ...base,
      onDelete: 'no action',
    } as D1Constraint));
  });

  it('does not let quoted or commented text disguise D1 NO ACTION as PostgreSQL CASCADE', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE parents (id INTEGER PRIMARY KEY);
       CREATE TABLE children (
         parent_id INTEGER REFERENCES parents(id)
           CHECK (parent_id <> 'ON DELETE CASCADE')
           /* ON DELETE CASCADE */
       );`,
    ]);
    const d1Foreign = schema.tables.get('children')?.constraints.find((constraint) => constraint.kind === 'foreign');
    expect(d1Foreign?.onDelete).toBe('no action');
    expect(constraintSignature('children', d1Foreign as D1Constraint)).not.toBe(
      constraintSignature('children', base as D1Constraint),
    );
  });
});

function sqlTokens(value: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '-' && value[index + 1] === '-') {
      while (index < value.length && value[index] !== '\n') index += 1;
      continue;
    }
    if (char === "'") {
      const start = index;
      for (index += 1; index < value.length;) {
        if (value[index] === "'" && value[index + 1] === "'") index += 2;
        else if (value[index] === "'") { index += 1; break; }
        else index += 1;
      }
      if (value[index - 1] !== "'") throw new Error('unterminated trigger string literal');
      tokens.push(value.slice(start, index));
      continue;
    }
    const word = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0];
    if (word) { tokens.push(word.toLowerCase()); index += word.length; continue; }
    const number = value.slice(index).match(/^\d+(?:\.\d+)?/)?.[0];
    if (number) { tokens.push(number); index += number.length; continue; }
    const operator = ['<>', '>=', '<=', '::'].find((candidate) => value.startsWith(candidate, index));
    if (operator) { tokens.push(operator); index += operator.length; continue; }
    if ('().,;=<>+-'.includes(char)) { tokens.push(char); index += 1; continue; }
    throw new Error(`unsupported trigger token at: ${value.slice(index)}`);
  }
  const canonical: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens.slice(index, index + 4).join(' ') === 'is not distinct from') {
      canonical.push('is');
      index += 3;
    } else if (tokens[index] === '::' && tokens[index + 1] === 'text') {
      index += 1;
    } else {
      canonical.push(tokens[index]);
    }
  }
  return canonical;
}

function pgTriggerEffect(
  source: string,
  event: 'insert' | 'update' | 'delete',
): { guard: string; abortMessage: string } {
  const tokens = sqlTokens(source);
  let index = 0;
  const word = (value: string | undefined) => value !== undefined && /^[a-z_][a-z0-9_$]*$/.test(value);
  if (tokens[index] === 'declare') {
    index += 1;
    while (tokens[index] !== 'begin') {
      if (!word(tokens[index]) || !['boolean', 'integer', 'bigint', 'text'].includes(tokens[index + 1] ?? '')) {
        throw new Error('unsupported Postgres trigger function declaration');
      }
      index += 2;
      if (tokens[index] !== ';') throw new Error('unsupported Postgres trigger function declaration');
      index += 1;
    }
  }
  if (tokens[index] !== 'begin') throw new Error('unsupported Postgres trigger function: expected BEGIN');
  index += 1;

  const effects: Array<{ guard: string; abortMessage: string }> = [];
  const topLevelStatements: Array<'if' | 'perform' | 'raise' | 'return'> = [];

  const parseBlock = (conditions: string[][], terminator: 'end' | 'end if'): void => {
    const statementKinds = conditions.length === 0 ? topLevelStatements : [];
    while (index < tokens.length) {
      if (tokens[index] === 'else' || (tokens[index] === 'elsif')) {
        throw new Error('unsupported Postgres trigger function: ELSE/ELSIF');
      }
      if (tokens[index] === 'end') {
        if (terminator === 'end if') {
          if (tokens[index + 1] !== 'if' || tokens[index + 2] !== ';') {
            throw new Error('unsupported Postgres trigger function: expected END IF');
          }
          index += 3;
          return;
        }
        if (tokens[index + 1] !== ';') throw new Error('unsupported Postgres trigger function: expected END');
        index += 2;
        return;
      }

      if (tokens[index] === 'if') {
        statementKinds.push('if');
        index += 1;
        const condition: string[] = [];
        let depth = 0;
        while (index < tokens.length && !(tokens[index] === 'then' && depth === 0)) {
          if (tokens[index] === '(') depth += 1;
          if (tokens[index] === ')') depth -= 1;
          if (depth < 0) throw new Error('unsupported Postgres trigger function: unbalanced IF guard');
          condition.push(tokens[index]);
          index += 1;
        }
        if (tokens[index] !== 'then' || condition.length === 0 || depth !== 0) {
          throw new Error('unsupported Postgres trigger function: malformed IF');
        }
        index += 1;
        parseBlock([...conditions, condition], 'end if');
        continue;
      }

      if (tokens[index] === 'perform') {
        statementKinds.push('perform');
        const perform = tokens.slice(index, index + 3).join(' ');
        if (perform !== 'perform pg_advisory_xact_lock (' || conditions.length === 0) {
          throw new Error('unsupported Postgres trigger function: PERFORM');
        }
        index += 3;
        let depth = 1;
        while (index < tokens.length && depth > 0) {
          if (tokens[index] === '(') depth += 1;
          if (tokens[index] === ')') depth -= 1;
          index += 1;
        }
        if (depth !== 0 || tokens[index] !== ';') {
          throw new Error('unsupported Postgres trigger function: advisory lock');
        }
        index += 1;
        continue;
      }

      if (tokens[index] === 'raise') {
        statementKinds.push('raise');
        if (tokens[index + 1] !== 'exception' || !tokens[index + 2]?.startsWith("'")) {
          throw new Error('unsupported Postgres trigger function: RAISE');
        }
        const message = tokens[index + 2];
        index += 3;
        if (tokens[index] === 'using') {
          if (tokens[index + 1] !== 'errcode' || tokens[index + 2] !== '=' || !tokens[index + 3]?.startsWith("'")) {
            throw new Error('unsupported Postgres trigger function: RAISE USING');
          }
          index += 4;
        }
        if (tokens[index] !== ';') throw new Error('unsupported Postgres trigger function: RAISE terminator');
        index += 1;
        effects.push({
          guard: conditions.length === 0
            ? 'true'
            : conditions.length === 1
              ? conditions[0].join(' ')
              : conditions.map((condition) => `( ${condition.join(' ')} )`).join(' and '),
          abortMessage: message.slice(1, -1).replaceAll("''", "'"),
        });
        continue;
      }

      if (tokens[index] === 'return') {
        if (conditions.length > 0) {
          throw new Error('unsupported Postgres trigger function: conditional RETURN');
        }
        statementKinds.push('return');
        if (!['new', 'old'].includes(tokens[index + 1] ?? '') || tokens[index + 2] !== ';') {
          throw new Error('unsupported Postgres trigger function: RETURN');
        }
        index += 3;
        continue;
      }

      throw new Error(`unsupported Postgres trigger function statement: ${tokens[index]}`);
    }
    throw new Error(`unsupported Postgres trigger function: missing ${terminator.toUpperCase()}`);
  };

  parseBlock([], 'end');
  if (index !== tokens.length) throw new Error('unsupported Postgres trigger function: trailing tokens');
  if (effects.length !== 1) throw new Error(`Postgres trigger must have exactly one abort effect, received ${effects.length}`);
  const terminalRow = event === 'delete' ? 'old' : 'new';
  if (effects[0].guard === 'true') {
    if (topLevelStatements.join(',') !== 'raise') {
      throw new Error('unsupported Postgres trigger function: unconditional abort must be the only statement');
    }
  } else if (
    topLevelStatements.at(-1) !== 'return' ||
    topLevelStatements.filter((kind) => kind === 'return').length !== 1 ||
    tokens.slice(-5, -2).join(' ') !== `return ${terminalRow} ;`
  ) {
    throw new Error(`unsupported Postgres trigger function: expected terminal RETURN ${terminalRow.toUpperCase()}`);
  }
  return effects[0];
}

function pgTriggerSignature(row: Record<string, unknown>): string {
  const definition = String(row.definition).replace(/\s+/g, ' ').trim();
  if (/\bFOR EACH ROW WHEN\s*\(/i.test(definition)) {
    throw new Error('unsupported Postgres trigger-level WHEN');
  }
  const parsed = definition.match(
    /^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON public\.(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$/i,
  );
  if (!parsed) throw new Error(`unsupported Postgres trigger definition: ${definition}`);
  const event = parsed[3].toLowerCase() as 'insert' | 'update' | 'delete';
  const effect = pgTriggerEffect(String(row.function_source), event);
  return [
    parsed[1].toLowerCase(), parsed[4].toLowerCase(), parsed[2].toLowerCase(), parsed[3].toLowerCase(),
    effect.guard, effect.abortMessage,
  ].join(':');
}

function syntheticPgTrigger(
  functionSource: string,
  overrides: Partial<{ definition: string }> = {},
): Record<string, unknown> {
  return {
    definition: 'CREATE TRIGGER protected_insert BEFORE INSERT ON public.protected_rows FOR EACH ROW EXECUTE FUNCTION protected_guard()',
    function_source: functionSource,
    ...overrides,
  };
}

describe('Postgres trigger semantic parser', () => {
  it('rejects trigger-level WHEN because its predicate is not represented by the parity signature', () => {
    expect(() => pgTriggerSignature(syntheticPgTrigger(`
      BEGIN
        IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF;
        RETURN NEW;
      END;
    `, {
      definition: 'CREATE TRIGGER protected_insert BEFORE INSERT ON public.protected_rows FOR EACH ROW WHEN (false) EXECUTE FUNCTION protected_guard()',
    }))).toThrow(/trigger-level WHEN/i);
  });

  it.each([
    ['early RETURN', `BEGIN RETURN NEW; IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF; RETURN NEW; END;`],
    ['conditional early RETURN', `BEGIN IF NEW.active = 0 THEN RETURN NEW; END IF; IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF; RETURN NEW; END;`],
    ['ELSE branch', `BEGIN IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; ELSE RETURN NEW; END IF; RETURN NEW; END;`],
    ['extra DML', `BEGIN UPDATE protected_rows SET fixed=0; IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF; RETURN NEW; END;`],
    ['unmodeled LOOP', `BEGIN LOOP RAISE EXCEPTION 'protected'; END LOOP; RETURN NEW; END;`],
    ['missing terminal RETURN', `BEGIN IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF; END;`],
    ['wrong terminal row', `BEGIN IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF; RETURN OLD; END;`],
  ])('fails closed on %s in a trigger function', (_label, source) => {
    expect(() => pgTriggerSignature(syntheticPgTrigger(source))).toThrow(/unsupported Postgres trigger function/i);
  });

  it('accepts declarations, nested guards, the known advisory lock, and one terminal RETURN', () => {
    expect(pgTriggerSignature(syntheticPgTrigger(`
      DECLARE marker boolean;
      BEGIN
        IF NEW.fixed = 1 THEN
          PERFORM pg_advisory_xact_lock(NEW.id, NEW.id);
          IF NEW.active = 0 THEN
            RAISE EXCEPTION 'protected' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
    `))).toBe(
      "protected_insert:protected_rows:before:insert:( new . fixed = 1 ) and ( new . active = 0 ):protected",
    );
  });

  it.each([
    ['newcomer_fields_boundary_insert', 'INSERT', 'newcomer_fields', "NOT (NEW.id > 7 AND NEW.fixed = 0)", "NOT (NEW.id > 7 AND NEW.fixed = 1)"],
    ['newcomer_fields_boundary_update', 'UPDATE', 'newcomer_fields', "NOT (NEW.id > 7 AND NEW.fixed = 0)", "NOT (NEW.id > 7 AND NEW.fixed = 1)"],
    ['newcomer_fields_core_delete', 'DELETE', 'newcomer_fields', 'OLD.fixed = 1', 'OLD.fixed = 0'],
    ['newcomer_field_options_custom_insert', 'INSERT', 'newcomer_field_options', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1)', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 0)'],
    ['newcomer_field_options_custom_update', 'UPDATE', 'newcomer_field_options', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1)', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 0)'],
    ['newcomer_answers_custom_insert', 'INSERT', 'newcomer_answers', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1)', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 0)'],
    ['newcomer_answers_custom_update', 'UPDATE', 'newcomer_answers', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1)', 'EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 0)'],
  ])('detects a guard mutation in %s', (name, event, table, guard, mutation) => {
    const definition = `CREATE TRIGGER ${name} BEFORE ${event} ON public.${table} FOR EACH ROW EXECUTE FUNCTION guard()`;
    const returnedRow = event === 'DELETE' ? 'OLD' : 'NEW';
    const source = (condition: string) => `BEGIN IF ${condition} THEN RAISE EXCEPTION 'protected'; END IF; RETURN ${returnedRow}; END;`;
    expect(pgTriggerSignature({ definition, function_source: source(mutation) }))
      .not.toBe(pgTriggerSignature({ definition, function_source: source(guard) }));
  });
});

describe.skipIf(!hasPg)('Postgres schema port', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const d1 = parseFinalD1Schema(
    D1_FILES.map((file) => readFileSync(`migrations/${file}`, 'utf8')),
  );

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('has exactly the shared, explicitly Supabase-only, and migration tables', async () => {
    const rows = await sql.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actual = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
    const expected = new Set([
      ...d1.tables.keys(),
      ...SUPABASE_ONLY_TABLES,
      ...INFRASTRUCTURE_TABLES,
    ]);

    const missing = [...expected].filter((table) => !actual.has(table)).sort();
    const unexpectedSharedDrift = [...actual].filter((table) => !expected.has(table)).sort();
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('has exactly the explicitly qualified Supabase-only private relations', async () => {
    const rows = await sql.unsafe(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'church_private' AND table_type = 'BASE TABLE'
    `);
    const actual = new Set(rows.map((row) => `${row.table_schema}.${row.table_name}`));
    const missing = [...SUPABASE_ONLY_PRIVATE_RELATIONS].filter((relation) => !actual.has(relation)).sort();
    const unexpectedPrivateDrift = [...actual].filter((relation) => !SUPABASE_ONLY_PRIVATE_RELATIONS.has(relation)).sort();
    expect({ missing, unexpectedPrivateDrift }).toEqual({ missing: [], unexpectedPrivateDrift: [] });
  });

  it('matches shared columns, types, nullability, defaults, and identity metadata bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `);
    const actual = new Map(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)))
        .map((row) => [
          `${row.table_name}.${row.column_name}`,
          {
            type: String(row.data_type).toLowerCase(),
            nullable: row.is_nullable === 'YES',
            defaultValue: normalizePgDefault(row.column_default as string | null),
            identity: row.is_identity === 'YES',
          },
        ]),
    );
    const expected = new Map<string, (typeof actual extends Map<string, infer T> ? T : never)>();
    for (const [tableName, table] of d1.tables) {
      for (const [columnName, column] of table.columns) {
        expected.set(`${tableName}.${columnName}`, {
          type: expectedPgType(tableName, columnName, column.type),
          nullable: column.nullable,
          defaultValue: column.defaultValue,
          identity: column.identity,
        });
      }
    }

    const missing = [...expected].flatMap(([key, value]) =>
      JSON.stringify(actual.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual.get(key))}`],
    );
    const unexpectedSharedDrift = [...actual].flatMap(([key, value]) =>
      JSON.stringify(expected.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: received ${JSON.stringify(value)}, expected ${JSON.stringify(expected.get(key))}`],
    );
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches shared primary, unique, and foreign-key constraints bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT rel.relname AS table_name, con.contype, con.confdeltype, con.confupdtype,
        ARRAY(
          SELECT att.attname
          FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
          ORDER BY key.ord
        ) AS columns,
        frel.relname AS foreign_table,
        CASE WHEN con.confkey IS NULL THEN NULL ELSE ARRAY(
          SELECT att.attname
          FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
          JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = key.attnum
          ORDER BY key.ord
        ) END AS foreign_columns
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      LEFT JOIN pg_class frel ON frel.oid = con.confrelid
      WHERE namespace.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
    `);
    const kinds = { p: 'primary', u: 'unique', f: 'foreign' } as const;
    const actual = new Set(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)))
        .map((row) => {
          const kind = kinds[row.contype as keyof typeof kinds];
          const constraint: D1Constraint = {
            kind,
            columns: pgIdentifierArray(row.columns),
            foreignTable: row.foreign_table ? String(row.foreign_table) : undefined,
            foreignColumns:
              row.foreign_columns === null ? undefined : pgIdentifierArray(row.foreign_columns),
          };
          if (kind === 'foreign') {
            constraint.onDelete = pgReferentialAction(row.confdeltype);
            constraint.onUpdate = pgReferentialAction(row.confupdtype);
          }
          return constraintSignature(String(row.table_name), constraint);
        }),
    );
    const expected = new Set(
      [...d1.tables].flatMap(([tableName, table]) =>
        table.constraints.map((constraint) => constraintSignature(tableName, constraint)),
      ),
    );
    const missing = [...expected].filter((value) => !actual.has(value)).sort();
    const unexpectedSharedDrift = [...actual].filter((value) => !expected.has(value)).sort();
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches every application-significant shared index bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT tbl.relname AS table_name, idx.relname AS index_name,
        indexes.indisunique,
        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = indexes.indexrelid) AS is_constraint,
        ARRAY(
          SELECT pg_get_indexdef(indexes.indexrelid, position, true)
          FROM generate_series(1, indexes.indnkeyatts) position
          ORDER BY position
        ) AS columns,
        pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate
      FROM pg_index indexes
      JOIN pg_class idx ON idx.oid = indexes.indexrelid
      JOIN pg_class tbl ON tbl.oid = indexes.indrelid
      JOIN pg_namespace namespace ON namespace.oid = tbl.relnamespace
      WHERE namespace.nspname = 'public'
    `);
    const actual = new Map(
      rows
        .filter((row) => d1.tables.has(String(row.table_name)) && !row.is_constraint)
        .map((row) => [
          String(row.index_name),
          {
            table: String(row.table_name),
            columns: pgIdentifierArray(row.columns),
            unique: Boolean(row.indisunique),
            predicate: normalizeIndexPredicate(row.predicate as string | null),
          },
        ]),
    );
    const expected = new Map(
      [...d1.indexes].map(([name, index]) => [
        name,
        {
          table: index.table,
          columns: index.columns,
          unique: index.unique,
          predicate: normalizeIndexPredicate(index.predicate),
        },
      ]),
    );
    const missing = [...expected].flatMap(([key, value]) =>
      JSON.stringify(actual.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actual.get(key))}`],
    );
    const unexpectedSharedDrift = [...actual].flatMap(([key, value]) =>
      JSON.stringify(expected.get(key)) === JSON.stringify(value)
        ? []
        : [`${key}: received ${JSON.stringify(value)}, expected ${JSON.stringify(expected.get(key))}`],
    );
    expect({ missing, unexpectedSharedDrift }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('matches shared trigger identity, target, timing, event, and abort semantics bidirectionally', async () => {
    const rows = await sql.unsafe(`
      SELECT trigger.tgname, pg_get_triggerdef(trigger.oid) AS definition,
        procedure.prosrc AS function_source
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
      WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname
    `);
    const actual = new Set(rows.map((row) => pgTriggerSignature(row)));
    const expected = new Set([...d1.triggers.values()].map((trigger) => [
      trigger.name, trigger.table, trigger.timing, trigger.event, trigger.semanticGuard, trigger.abortMessage,
    ].join(':')));
    expect({
      missing: [...expected].filter((signature) => !actual.has(signature)).sort(),
      unexpectedSharedDrift: [...actual].filter((signature) => !expected.has(signature)).sort(),
    }).toEqual({ missing: [], unexpectedSharedDrift: [] });
  });

  it('accepts explicit identity ids and still autogenerates afterwards', async () => {
    await sql.unsafe("INSERT INTO settings (key, value) VALUES ('probe', '1')");
    await sql.unsafe(
      "INSERT INTO people (id, first_name, last_name, display_name, email) VALUES (9000, 'A', 'B', 'A B', 'probe@example.com')",
    );
    await sql.unsafe("SELECT setval(pg_get_serial_sequence('people', 'id'), (SELECT max(id) FROM people))");
    const rows = await sql.unsafe(
      "INSERT INTO people (first_name, last_name, display_name, email) VALUES ('C', 'D', 'C D', 'probe2@example.com') RETURNING id",
    );
    expect(Number(rows[0].id)).toBeGreaterThan(9000);
  });
});
