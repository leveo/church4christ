// Testimonies with a light review workflow. Status: P pending → A approved
// (public) / R returned. A visitor submits in the current page locale (single
// localized title/body + the row's `locale`); a reviewer approves (which stamps
// published_at, gating public visibility) or returns it. Approve/return are
// guarded on status = 'P', which makes them idempotent — a second approve of an
// already-approved row is a no-op and never re-stamps published_at.
//
// Public reads (locale-first ordering for the serve strip + page) live in
// ministryDb.listPublishedTestimonies; this module owns writes + the review queue.

export interface TestimonyInput {
  person_id: number | null;
  author_name: string;
  locale: 'en' | 'zh';
  title: string;
  body: string;
  category: string | null;
}

/** Insert a testimony as pending (status defaults to 'P'). Returns its id. */
export async function submitTestimony(db: D1Database, input: TestimonyInput): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO testimonies (person_id, author_name, locale, title, body, category)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(input.person_id, input.author_name, input.locale, input.title, input.body, input.category)
    .run();
  return r.meta.last_row_id;
}

export interface PendingTestimonyRow {
  id: number;
  person_id: number | null;
  author_name: string;
  locale: 'en' | 'zh';
  title: string;
  body: string;
  category: string | null;
  created_at: string;
}

const PENDING_COLS = 'id, person_id, author_name, locale, title, body, category, created_at';

/** Pending (status='P'), non-deleted testimonies for the review queue, oldest first. */
export async function listPendingTestimonies(db: D1Database): Promise<PendingTestimonyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PENDING_COLS} FROM testimonies
       WHERE status = 'P' AND deleted_at IS NULL
       ORDER BY created_at, id`,
    )
    .all<PendingTestimonyRow>();
  return results;
}

/** How many testimonies await review (dashboard card). */
export async function countPendingTestimonies(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM testimonies WHERE status = 'P' AND deleted_at IS NULL`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Approve a pending testimony: status → 'A' and published_at → now. Guarded on
 * status = 'P', so calling it again on an already-approved row changes nothing
 * (idempotent — published_at is stamped exactly once). Returns whether a row moved.
 */
export async function approveTestimony(db: D1Database, id: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE testimonies SET status = 'A', published_at = datetime('now')
       WHERE id = ? AND status = 'P' AND deleted_at IS NULL`,
    )
    .bind(id)
    .run();
  return r.meta.changes > 0;
}

/** Return a pending testimony (status → 'R'). Guarded on 'P' like approve. */
export async function returnTestimony(db: D1Database, id: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE testimonies SET status = 'R' WHERE id = ? AND status = 'P' AND deleted_at IS NULL`)
    .bind(id)
    .run();
  return r.meta.changes > 0;
}
