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
  if (/^current_timestamp$/i.test(normalized)) return 'utc-now';
  if (/^datetime\s*\(\s*'now'::text(?:\s*,[\s\S]*)?\)$/i.test(normalized)) return 'utc-now';
  const text = normalized.match(/^'((?:[^']|'')*)'::text$/i);
  if (text) return text[1].replaceAll("''", "'");
  return normalized.toLowerCase();
}

describe('Postgres default normalization', () => {
  it('treats native CURRENT_TIMESTAMP as the D1 UTC-now default', () => {
    expect(normalizePgDefault('CURRENT_TIMESTAMP')).toBe('utc-now');
  });
});

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
    const operator = ['#>>', '<>', '>=', '<=', '::', '||'].find((candidate) => value.startsWith(candidate, index));
    if (operator) { tokens.push(operator); index += operator.length; continue; }
    if ('().,;=<>+-*'.includes(char)) { tokens.push(char); index += 1; continue; }
    throw new Error(`unsupported trigger token at: ${value.slice(index)}`);
  }
  const canonical: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens.slice(index, index + 4).join(' ') === 'is not distinct from') {
      canonical.push('is');
      index += 3;
    } else if (tokens.slice(index, index + 3).join(' ') === 'is distinct from') {
      canonical.push('is', 'not');
      index += 2;
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
        const performEnd = tokens.indexOf(';', index);
        const orderedContactLocks = tokens.slice(index, performEnd + 1).join(' ');
        const expectedOrderedContactLocks = [
          'perform pg_advisory_xact_lock ( hashtextextended ( lock_key , 0 ) ) from (',
          "select 'email:' || o . normalized_email as lock_key from identity_source_records s",
          'join identity_observations o on o . id = s . observation_id',
          'where s . id = new . source_record_id and o . normalized_email is not null union all',
          "select 'phone:' || o . normalized_phone as lock_key from identity_source_records s",
          'join identity_observations o on o . id = s . observation_id',
          'where s . id = new . source_record_id and o . normalized_phone is not null',
          ') contact_locks order by lock_key ;',
        ].join(' ');
        if (orderedContactLocks.includes('hashtextextended')) {
          if (conditions.length !== 0 || orderedContactLocks !== expectedOrderedContactLocks) {
            throw new Error('unsupported Postgres trigger function: ordered provisional contact locks');
          }
          index = performEnd + 1;
          continue;
        }
        if (orderedContactLocks === 'perform person_merge_lock_operation_people_fn ( new . operation_id , new . approver_person_id ) ;') {
          if (conditions.length > 1 || (conditions.length === 1 && conditions[0].join(' ') !== 'found')) {
            throw new Error('unsupported Postgres trigger function: merge approval lock precondition');
          }
          index = performEnd + 1;
          continue;
        }
        if (orderedContactLocks === 'perform person_merge_lock_operation_people_fn ( new . operation_id , new . decided_by_person_id ) ;') {
          if (conditions.length !== 0) {
            throw new Error('unsupported Postgres trigger function: merge decision lock precondition');
          }
          index = performEnd + 1;
          continue;
        }
        if (tokens[index + 1] === '1') {
          const end = performEnd;
          const rowLock = orderedContactLocks;
          const conditionalCaseLock = rowLock === 'perform 1 from identity_resolution_cases c where c . id = old . resolution_case_id for update ;'
            && conditions.length === 1
            && conditions[0].join(' ') === "new . state in ( 'awaiting_approval' , 'approved' , 'executing' )";
          if (!conditionalCaseLock && (conditions.length !== 0 || ![
            'perform 1 from identity_source_records where id = new . source_record_id for update ;',
            'perform 1 from identity_observations where id = ( select observation_id from identity_source_records where id = new . source_record_id ) for update ;',
            'perform 1 from people where id = new . person_id for update ;',
            'perform 1 from campus_memberships where person_id = new . person_id and campus_id = new . campus_id for update ;',
            'perform 1 from person_merge_operations op where op . operation_id = new . operation_id for update ;',
            'perform 1 from identity_resolution_cases c where c . id = new . resolution_case_id for update ;',
          ].includes(rowLock))) {
            throw new Error('unsupported Postgres trigger function: source row lock or eligibility row lock');
          }
          index = end + 1;
          continue;
        }
        const perform = tokens.slice(index, index + 3).join(' ');
        if (perform !== 'perform pg_advisory_xact_lock (') {
          throw new Error('unsupported Postgres trigger function: PERFORM');
        }
        index += 3;
        const argumentStart = index;
        let depth = 1;
        while (index < tokens.length && depth > 0) {
          if (tokens[index] === '(') depth += 1;
          if (tokens[index] === ')') depth -= 1;
          index += 1;
        }
        if (depth !== 0 || tokens[index] !== ';') {
          throw new Error('unsupported Postgres trigger function: advisory lock');
        }
        const argumentsText = tokens.slice(argumentStart, index - 1).join(' ');
        // Existing guarded locks can protect a compound application invariant.
        // A top-level lock is accepted only for the contact ownership race and
        // must be keyed exactly by the row's contact point.
        if (conditions.length === 0 && ![
          'new . challenge_id',
          'new . contact_point_id',
          'new . person_id',
          'old . contact_point_id',
          'least ( new . loser_person_id , new . canonical_person_id )',
          'greatest ( new . loser_person_id , new . canonical_person_id )',
          "hashtext ( old . campus_id || ':' || old . requester_bucket_hash )",
          "hashtext ( new . campus_id || ':' || new . bucket_hash )",
          'hashtext ( new . operation_id )',
          'hashtext ( new . rollback_id )',
          'new . case_id :: bigint',
          '732 , new . contact_point_id',
          '732 , old . contact_point_id',
          '732 , coalesce ( ( select contact_point_id from identity_recovery_cases where id = new . case_id ) , 0 )',
        ].includes(argumentsText)) {
          throw new Error(`unsupported Postgres trigger function: advisory lock key ${argumentsText}`);
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
    /^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE(?: OF [a-z_, ]+)?|DELETE) ON public\.(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$/i,
  );
  if (!parsed) throw new Error(`unsupported Postgres trigger definition: ${definition}`);
  const event = parsed[3].toLowerCase().split(/\s+/)[0] as 'insert' | 'update' | 'delete';
  const effect = pgTriggerEffect(String(row.function_source), event);
  return [
    parsed[1].toLowerCase(), parsed[4].toLowerCase(), parsed[2].toLowerCase(), event,
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
  it('accepts an exact JSONB text-path comparison used by rollback approval binding guards', () => {
    expect(pgTriggerSignature(syntheticPgTrigger(`BEGIN
      IF NEW.context_json::jsonb #>> '{person_merge_rollback_approval,rollback_id}' = OLD.rollback_id THEN
        RAISE EXCEPTION 'protected';
      END IF;
      RETURN NEW;
    END;`))).toContain(
      "new . context_json :: jsonb #>> '{person_merge_rollback_approval,rollback_id}' = old . rollback_id",
    );
  });

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

  it('permits only contact/person-keyed transaction advisory locks before identity guards', () => {
    const source = `BEGIN
      PERFORM pg_advisory_xact_lock(NEW.contact_point_id);
      IF NOT EXISTS (SELECT 1 FROM person_contact_links WHERE person_id=NEW.person_id) THEN
        RAISE EXCEPTION 'verified_contact_owner_requires_active_link';
      END IF;
      RETURN NEW;
    END;`;
    expect(pgTriggerSignature(syntheticPgTrigger(source, {
      definition: 'CREATE TRIGGER verified_contact_owner_requires_active_link_insert BEFORE INSERT ON public.verified_contact_owners FOR EACH ROW EXECUTE FUNCTION verified_contact_owner_requires_active_link_insert()',
    }))).toBe(
      'verified_contact_owner_requires_active_link_insert:verified_contact_owners:before:insert:not exists ( select 1 from person_contact_links where person_id = new . person_id ):verified_contact_owner_requires_active_link',
    );
    expect(() => pgTriggerSignature(syntheticPgTrigger(source.replace('NEW.contact_point_id', 'NEW.source_record_id')))).toThrow(/advisory lock/i);
  });

  it('permits only the exact source-row FOR UPDATE lock before a receipt guard', () => {
    const source = `BEGIN
      PERFORM 1 FROM identity_source_records WHERE id=NEW.source_record_id FOR UPDATE;
      PERFORM pg_advisory_xact_lock(NEW.contact_point_id);
      IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF;
      RETURN NEW;
    END;`;
    expect(pgTriggerSignature(syntheticPgTrigger(source))).toBe(
      'protected_insert:protected_rows:before:insert:new . fixed = 1:protected',
    );
    expect(() => pgTriggerSignature(syntheticPgTrigger(source.replace('identity_source_records', 'people'))))
      .toThrow(/source row lock/i);
    expect(() => pgTriggerSignature(syntheticPgTrigger(source.replace('NEW.source_record_id', 'NEW.person_id'))))
      .toThrow(/source row lock/i);
  });

  it('permits only exact observation and eligibility row locks with the receipt person advisory key', () => {
    const source = `BEGIN
      PERFORM 1 FROM identity_source_records WHERE id=NEW.source_record_id FOR UPDATE;
      PERFORM 1 FROM identity_observations WHERE id=(SELECT observation_id FROM identity_source_records WHERE id=NEW.source_record_id) FOR UPDATE;
      PERFORM pg_advisory_xact_lock(NEW.person_id);
      PERFORM 1 FROM people WHERE id=NEW.person_id FOR UPDATE;
      PERFORM 1 FROM campus_memberships WHERE person_id=NEW.person_id AND campus_id=NEW.campus_id FOR UPDATE;
      PERFORM pg_advisory_xact_lock(NEW.contact_point_id);
      IF NEW.fixed = 1 THEN RAISE EXCEPTION 'protected'; END IF;
      RETURN NEW;
    END;`;
    expect(pgTriggerSignature(syntheticPgTrigger(source))).toContain('new . fixed = 1:protected');
    for (const unsafe of [
      source.replace('identity_observations', 'identity_challenges'),
      source.replace('FROM people WHERE id=NEW.person_id', 'FROM people WHERE id=NEW.source_record_id'),
      source.replace('campus_id=NEW.campus_id', 'campus_id=1'),
      source.replace('pg_advisory_xact_lock(NEW.person_id)', 'pg_advisory_xact_lock(NEW.source_record_id)'),
    ]) expect(() => pgTriggerSignature(syntheticPgTrigger(unsafe))).toThrow();
  });

  it('normalizes PostgreSQL NULL-safe distinctness to the D1 IS NOT predicate', () => {
    expect(pgTriggerSignature(syntheticPgTrigger(`BEGIN
      IF OLD.person_id IS NOT NULL AND NEW.person_id IS DISTINCT FROM OLD.person_id THEN
        RAISE EXCEPTION 'protected';
      END IF;
      RETURN NEW;
    END;`))).toContain('old . person_id is not null and new . person_id is not old . person_id');
  });

  it('uses the base UPDATE event, not UPDATE OF columns, in parity signatures', () => {
    expect(pgTriggerSignature(syntheticPgTrigger(`BEGIN
      IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
        RAISE EXCEPTION 'verified_contact_owner_requires_active_link';
      END IF;
      RETURN NEW;
    END;`, {
      definition: 'CREATE TRIGGER person_contact_link_owner_cannot_end BEFORE UPDATE OF ended_at ON public.person_contact_links FOR EACH ROW EXECUTE FUNCTION person_contact_link_owner_cannot_end()',
    }))).toBe(
      'person_contact_link_owner_cannot_end:person_contact_links:before:update:old . ended_at is null and new . ended_at is not null:verified_contact_owner_requires_active_link',
    );
  });

  it('accepts only deterministically ordered advisory locks for one-hop redirects', () => {
    const source = `BEGIN
      PERFORM pg_advisory_xact_lock(LEAST(NEW.loser_person_id, NEW.canonical_person_id));
      PERFORM pg_advisory_xact_lock(GREATEST(NEW.loser_person_id, NEW.canonical_person_id));
      IF EXISTS (SELECT 1 FROM person_merge_redirects WHERE loser_person_id = NEW.canonical_person_id)
        OR EXISTS (SELECT 1 FROM person_merge_redirects WHERE canonical_person_id = NEW.loser_person_id) THEN
        RAISE EXCEPTION 'person_merge_redirect_one_hop_required';
      END IF;
      RETURN NEW;
    END;`;
    expect(pgTriggerSignature(syntheticPgTrigger(source, {
      definition: 'CREATE TRIGGER person_merge_redirects_one_hop_insert BEFORE INSERT ON public.person_merge_redirects FOR EACH ROW EXECUTE FUNCTION person_merge_redirects_one_hop_insert()',
    }))).toContain(':before:insert:exists ( select 1 from person_merge_redirects where loser_person_id = new . canonical_person_id ) or exists ( select 1 from person_merge_redirects where canonical_person_id = new . loser_person_id ):');
  });

  it.each([
    ['newcomer_statuses_boundary_insert', 'INSERT', 'newcomer_statuses', "NOT ((NEW.id = 1 AND NEW.key = 'new') OR (NEW.id > 5 AND NEW.key <> 'new'))", "NOT ((NEW.id = 1 AND NEW.key = 'renamed') OR (NEW.id > 5 AND NEW.key <> 'new'))"],
    ['newcomer_statuses_boundary_update', 'UPDATE', 'newcomer_statuses', 'NOT (NEW.id = OLD.id AND NEW.key = OLD.key AND NEW.category = OLD.category)', 'NOT (NEW.id = OLD.id AND NEW.key = OLD.key)'],
    ['newcomer_statuses_core_delete', 'DELETE', 'newcomer_statuses', 'OLD.id <= 5', 'OLD.id < 5'],
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
        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = indexes.indexrelid AND con.contype IN ('p','u','x')) AS is_constraint,
        ARRAY(
          SELECT regexp_replace(
            pg_get_indexdef(indexes.indexrelid, position, true),
            '\\s+(ASC|DESC)(\\s+NULLS\\s+(FIRST|LAST))?\\s*$', '', 'i'
          ) || CASE WHEN pg_index_column_has_property(indexes.indexrelid, position, 'desc')
            THEN ' desc' ELSE '' END
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
    const triggerNames = new Set(rows.map((row) => String(row.tgname).toLowerCase()));
    expect([...triggerNames].filter((name) => name.startsWith('person_merge_operations_risk_set_')
      || name.startsWith('person_merge_risk_set_')).sort()).toEqual([
      'person_merge_operations_risk_set_guard',
      'person_merge_operations_risk_set_snapshot',
      'person_merge_risk_set_facts_append_only_delete',
      'person_merge_risk_set_facts_append_only_update',
      'person_merge_risk_set_facts_insert_guard',
      'person_merge_risk_set_seals_append_only_delete',
      'person_merge_risk_set_seals_append_only_update',
    ]);
    expect([...d1.triggers.keys()].filter((name) => name.startsWith('person_merge_operations_risk_set_')
      || name.startsWith('person_merge_risk_set_'))).toHaveLength(27);
    const semanticBindingLifecycleTriggers = new Set([
      'person_merge_semantic_binding_people_stripe_bump',
      'person_merge_semantic_binding_people_calendar_bump',
      'person_merge_semantic_binding_external_identity_bump',
      'person_merge_semantic_binding_learning_identity_bump',
      'person_merge_semantic_binding_canonical_key_bump',
      // Recurring gifts are a PostgreSQL-only module table.
      'person_merge_semantic_binding_recurring_gift_guard',
      'person_merge_semantic_binding_recurring_gift_bump',
    ]);
    const mergeExecutionLifecycleTriggers = new Set([
      // PostgreSQL combines each group into one transaction-locked trigger;
      // D1 uses one trigger per abort condition under SQLite's single writer.
      'person_merge_rollback_operations_update_guard',
      'person_merge_rollback_operations_immutable_guard',
      'person_merge_rollback_operations_state_cas_guard',
      'person_merge_rollback_operations_transition_guard',
      'person_merge_rollback_operations_expiry_guard',
      'person_merge_rollback_state_approval_guard',
      'person_merge_rollback_approval_gate_guard',
      'person_merge_rollback_approval_live_guard',
      'person_merge_rollback_approval_veto_guard',
      // Migration 0036 adds rollback-aware reverse-mutation branches using
      // native JSON/set expressions in PostgreSQL and decomposed queries in
      // D1. Their exact inventories and behavior are covered by the dedicated
      // 0036 parser plus D1/PG merge execution suites.
      'identity_newcomer_submission_binding_update_guard',
      'identity_source_observation_attachment_guard',
      'identity_source_observation_link_immutable',
      'identity_source_records_link_immutable',
      'person_merge_core_receipt_precondition_guard',
      'person_merge_execution_seals_append_only_delete',
      'person_merge_execution_seals_append_only_update',
      'person_merge_journal_row_details_append_only_delete',
      'person_merge_journal_row_details_append_only_update',
      'person_merge_operations_completion_seal_guard',
      'person_merge_reference_facts_append_only_delete',
      'person_merge_reference_facts_append_only_update',
      'person_merge_rollback_approvals_append_only_delete',
      'person_merge_rollback_approvals_append_only_update',
      'person_merge_rollback_approvals_binding_guard',
      'person_merge_rollback_completion_guard',
      'person_merge_rollback_operations_delete_guard',
      'person_merge_rollback_operations_insert_guard',
      'person_merge_rollback_receipt_precondition_guard',
      'person_merge_rollback_step_up_binding_immutable',
      'person_merge_rollback_step_up_direct_consumed_guard',
    ]);
    const lifecycleTrigger = (name: unknown) => {
      const normalized = String(name).toLowerCase();
      return normalized === 'campus_membership_after_person_insert'
        || normalized.startsWith('identity_person_canonical_keys_')
        || semanticBindingLifecycleTriggers.has(normalized)
        || normalized === 'identity_recovery_notification_outbox_insert_receipt'
        || normalized === 'identity_recovery_notification_outbox_transition_receipt'
        || normalized === 'planning_center_merge_mapping_snapshot'
        // The recent-step-up guards use native PostgreSQL timestamp/JSON
        // operators and SQLite julianday/json_extract spellings. Dedicated
        // D1/PG suites assert their exact binding, expiry, revocation, campus,
        // and concurrency behavior; the generic token signature cannot safely
        // erase those engine-specific expressions into apparent equivalence.
        || normalized === 'person_merge_approvals_step_up_guard'
        || normalized === 'person_merge_operations_approval_eligibility_guard'
        || normalized === 'person_merge_step_up_direct_consumed_guard'
        || normalized === 'person_merge_step_up_binding_immutable'
        // These two large transition guards are implemented as decomposed
        // SQLite queries and native PostgreSQL set operations. Their complete
        // live-set/race behavior is covered by the dedicated C1/PCO suites.
        || normalized === 'person_merge_operations_risk_source_guard'
        || normalized === 'planning_center_merge_mapping_stale_guard'
        || mergeExecutionLifecycleTriggers.has(normalized)
        // PostgreSQL needs transaction-scoped advisory locks around all live
        // risk writers and merge transitions; D1 obtains the same ordering from
        // its single-writer transaction model, so these are engine lifecycle
        // controls rather than cross-engine abort semantics.
        || normalized === 'person_merge_operations_a_global_lock_guard'
        || normalized.startsWith('person_merge_risk_writer_')
        // D1 decomposes exact live-set equality into small per-domain guards
        // to stay below the Workers SQLite compound-select limit; PostgreSQL
        // can enforce the same bidirectional set equality in one trigger.
        // Their inventories are asserted immediately above and their behavior
        // is exercised against both engines in the C1 substitution suites.
        || normalized.startsWith('person_merge_operations_risk_set_')
        || normalized.startsWith('person_merge_risk_set_');
    };
    const actual = new Set(rows
      .filter((row) => !lifecycleTrigger(row.tgname))
      .map((row) => {
        try {
          return pgTriggerSignature(row);
        } catch (error) {
          throw new Error(`failed to parse PostgreSQL trigger ${String(row.tgname)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    const expected = new Set([...d1.triggers.values()]
      .filter((trigger) => !lifecycleTrigger(trigger.name))
      .map((trigger) => [
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
