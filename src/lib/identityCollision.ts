import type { AppDb, AppStatement } from './appDb';
import { normalizeEmail } from './identityNormalize';

type IdentifierRow = { id: number; identifier: string; display_value?: string };

const PAGE_SIZE = 500;

function comparisonForm(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('und');
}

async function scanRows(
  db: AppDb,
  firstSql: string,
  nextSql: string,
  remaining: Map<string, number[]>,
  collisions: boolean[],
): Promise<void> {
  let cursor: number | null = null;
  while (remaining.size > 0) {
    const statement: AppStatement = cursor === null
      ? db.prepare(firstSql)
      : db.prepare(nextSql).bind(cursor);
    const { results } = await statement.all<IdentifierRow>();
    for (const row of results) {
      // normalizeEmail is the canonical comparison. comparisonForm is a
      // conservative fallback for malformed legacy rows that are textually
      // equivalent after the same NFC/case transform but fail current syntax.
      const forms = [normalizeEmail(row.identifier), comparisonForm(row.identifier)];
      if (row.display_value !== undefined) {
        forms.push(normalizeEmail(row.display_value), comparisonForm(row.display_value));
      }
      for (const form of forms) {
        if (form === null) continue;
        const indexes = remaining.get(form);
        if (!indexes) continue;
        for (const index of indexes) collisions[index] = true;
        remaining.delete(form);
      }
    }
    if (remaining.size === 0 || results.length < PAGE_SIZE) break;
    cursor = results[results.length - 1].id;
  }
}

/**
 * Conservative application-normalized identity collision scan. SQL LOWER is
 * intentionally forbidden here because D1 and Postgres do not share Unicode
 * case/NFC semantics. Invalid candidate contacts fail closed as collisions.
 */
export async function emailIdentityCollisionMask(
  db: AppDb,
  values: readonly string[],
): Promise<boolean[]> {
  const collisions = values.map(() => false);
  const remaining = new Map<string, number[]>();
  values.forEach((value, index) => {
    const normalized = normalizeEmail(value);
    if (normalized === null) {
      collisions[index] = true;
      return;
    }
    const indexes = remaining.get(normalized) ?? [];
    indexes.push(index);
    remaining.set(normalized, indexes);
  });
  if (remaining.size === 0) return collisions;

  await scanRows(
    db,
    'SELECT id, email AS identifier FROM people ORDER BY id LIMIT 500',
    'SELECT id, email AS identifier FROM people WHERE id > ? ORDER BY id LIMIT 500',
    remaining,
    collisions,
  );
  if (remaining.size === 0) return collisions;
  await scanRows(
    db,
    "SELECT id, normalized_value AS identifier, display_value FROM contact_points WHERE kind = 'email' ORDER BY id LIMIT 500",
    "SELECT id, normalized_value AS identifier, display_value FROM contact_points WHERE kind = 'email' AND id > ? ORDER BY id LIMIT 500",
    remaining,
    collisions,
  );
  return collisions;
}

export async function hasEmailIdentityCollision(db: AppDb, value: string): Promise<boolean> {
  return (await emailIdentityCollisionMask(db, [value]))[0] ?? true;
}
