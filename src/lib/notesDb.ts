// person_notes: pastoral notes on a person (spec addendum §B). These are
// ADMIN-ONLY read/write — the privacy rule is that ministry leaders never see
// notes (their outreach tool is the logged invite email). This library performs
// NO visibility/authorization logic: every function assumes the calling page has
// already gated the request to an admin. Notes are soft-deleted (deleted_at) so
// history is retained; listNotes excludes soft-deleted rows.

export const NOTE_MAX_LEN = 4000;

export interface PersonNote {
  id: number;
  person_id: number;
  author_email: string;
  body: string;
  created_at: string;
}

/**
 * Add a note to a person. body is trimmed; empty throws 'note_empty' and a body
 * over NOTE_MAX_LEN throws 'note_too_long' (the admin page maps these to form
 * errors). Returns the new note id.
 */
export async function addNote(
  db: D1Database,
  personId: number,
  authorEmail: string,
  body: string,
): Promise<number> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('note_empty');
  if (trimmed.length > NOTE_MAX_LEN) throw new Error('note_too_long');
  const created = await db
    .prepare(`INSERT INTO person_notes (person_id, author_email, body) VALUES (?, ?, ?) RETURNING id`)
    .bind(personId, authorEmail, trimmed)
    .first<{ id: number }>();
  return created!.id;
}

/** Soft-delete a note (idempotent — already-deleted rows do not move). Returns true when a row was deleted. */
export async function softDeleteNote(db: D1Database, noteId: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE person_notes SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .bind(noteId)
    .run();
  return r.meta.changes > 0;
}

/** A person's live notes, newest first. */
export async function listNotes(db: D1Database, personId: number): Promise<PersonNote[]> {
  const { results } = await db
    .prepare(
      `SELECT id, person_id, author_email, body, created_at
       FROM person_notes
       WHERE person_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(personId)
    .all<PersonNote>();
  return results;
}
