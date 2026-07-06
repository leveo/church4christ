// Admin data-access layer. Admin queries apply NO publish filter (editors see
// drafts) but always exclude soft-deleted rows. This slice starts the people
// section only; content/roster writers land in later slices. People carry no
// updated_by column and no revisions (v1 simplification, per spec).
import type { PersonInput } from './validate';

type Role = PersonInput['role'];

/** Row shape for the people list table. `active` is D1's raw 0/1 integer. */
export interface PersonListRow {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  active: number;
}

/** Full row for the edit form. */
export interface AdminPersonRow extends PersonListRow {
  lang: 'en' | 'zh' | null;
}

/** savePerson input: the parsed form plus the target id (null = create). */
export interface SavePersonInput extends PersonInput {
  id: number | null;
}

export type SavePersonResult = { ok: true; id: number } | { ok: false; errors: { email: string } };

const LIST_COLS = 'id, first_name, last_name, display_name, email, phone, role, active';

/**
 * Non-deleted people ordered by display_name. With `q`, case-insensitively
 * (SQLite ASCII LIKE) matches display/first/last name or email; LIKE wildcards
 * in the query are escaped so a literal `%` or `_` searches for itself.
 */
export async function listPeople(db: D1Database, opts: { q?: string } = {}): Promise<PersonListRow[]> {
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const { results } = await db
      .prepare(
        `SELECT ${LIST_COLS} FROM people
         WHERE deleted_at IS NULL
           AND (display_name LIKE ?1 ESCAPE '\\' OR first_name LIKE ?1 ESCAPE '\\'
                OR last_name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\')
         ORDER BY display_name`,
      )
      .bind(like)
      .all<PersonListRow>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT ${LIST_COLS} FROM people WHERE deleted_at IS NULL ORDER BY display_name`)
    .all<PersonListRow>();
  return results;
}

/** Count of non-deleted people (dashboard stat). */
export async function countPeople(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM people WHERE deleted_at IS NULL`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A single non-deleted person for the edit form. */
export async function getPerson(db: D1Database, id: number): Promise<AdminPersonRow | null> {
  return db
    .prepare(`SELECT ${LIST_COLS}, lang FROM people WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<AdminPersonRow>();
}

/**
 * Create or update a person, mapping an email collision to a field error
 * instead of a raw 500.
 *  - Create (id null): if the email is held only by a SOFT-DELETED person,
 *    revive that row (clear deleted_at, overwrite fields) rather than colliding
 *    with UNIQUE(email); a LIVE holder → { email: 'errors.emailTaken' }.
 *  - Update: block moving onto another LIVE person's email; a soft-deleted
 *    occupant still holds the UNIQUE index, so we surface that as taken too.
 * `editedBy` is accepted for API symmetry with the content writers; people
 * carry no updated_by column and no revisions in v1, so nothing records it.
 */
export async function savePerson(
  db: D1Database,
  input: SavePersonInput,
  editedBy: string,
): Promise<SavePersonResult> {
  void editedBy;
  const existing = await db
    .prepare(`SELECT id, deleted_at FROM people WHERE email = ?`)
    .bind(input.email)
    .first<{ id: number; deleted_at: string | null }>();

  if (input.id === null) {
    if (existing) {
      if (existing.deleted_at === null) return { ok: false, errors: { email: 'errors.emailTaken' } };
      await writePerson(db, existing.id, input); // revive: clears deleted_at
      return { ok: true, id: existing.id };
    }
    const r = await db
      .prepare(
        `INSERT INTO people (first_name, last_name, display_name, email, phone, role, active, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.firstName,
        input.lastName,
        input.displayName,
        input.email,
        input.phone,
        input.role,
        input.active ? 1 : 0,
        input.lang,
      )
      .run();
    return { ok: true, id: r.meta.last_row_id as number };
  }

  if (existing && existing.id !== input.id && existing.deleted_at === null) {
    return { ok: false, errors: { email: 'errors.emailTaken' } };
  }
  try {
    await writePerson(db, input.id, input);
  } catch (e) {
    if (String(e).includes('UNIQUE constraint failed')) return { ok: false, errors: { email: 'errors.emailTaken' } };
    throw e;
  }
  return { ok: true, id: input.id };
}

// One UPDATE serves both a normal edit and a revive: deleted_at = NULL is a
// harmless no-op for a live row and reclaims a soft-deleted one.
function writePerson(db: D1Database, id: number, input: PersonInput): Promise<unknown> {
  return db
    .prepare(
      `UPDATE people SET first_name = ?, last_name = ?, display_name = ?, email = ?, phone = ?,
         role = ?, active = ?, lang = ?, deleted_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(
      input.firstName,
      input.lastName,
      input.displayName,
      input.email,
      input.phone,
      input.role,
      input.active ? 1 : 0,
      input.lang,
      id,
    )
    .run();
}

/**
 * Update just the role and/or active flags. Deactivation (active = 0) takes
 * effect on the person's next request — the middleware reloads the row and its
 * `active = 1` check rejects an inactive session.
 */
export async function setPersonFlags(
  db: D1Database,
  id: number,
  flags: { role?: Role; active?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (flags.role !== undefined) {
    sets.push('role = ?');
    binds.push(flags.role);
  }
  if (flags.active !== undefined) {
    sets.push('active = ?');
    binds.push(flags.active ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

/** Soft-delete: hides the person from listPeople and revokes their session
 *  (middleware rejects a deleted_at row). Assignment history is preserved. */
export async function softDeletePerson(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE people SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}
