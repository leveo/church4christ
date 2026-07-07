// Persistence for spiritual-gifts quiz results and the "add my recommendations
// to my interests" action. Results are INSERT-only — every retake keeps its own
// history row and the latest (by created_at, id) wins on read, so a leader's
// potential-volunteer view always reflects the person's most recent test.
//
// The gift_results columns store JSON arrays of gift codes (top_gifts_json) and
// ministry categories (recommended_json). person_interests is additive here
// (ON CONFLICT DO NOTHING) — quiz recommendations augment, never replace, the set
// a person curates on their profile.

import type { AppDb } from './appDb';

export interface GiftResultRow {
  top_gifts: string[];
  recommended: string[];
  created_at: string;
}

/** Save a quiz result as a new history row (latest wins on read). */
export async function saveGiftResult(
  db: AppDb,
  personId: number,
  topGifts: string[],
  recommended: string[],
): Promise<void> {
  await db
    .prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json) VALUES (?, ?, ?)`)
    .bind(personId, JSON.stringify(topGifts), JSON.stringify(recommended))
    .run();
}

/** The person's most recent gift result, JSON columns parsed (null-safe). */
export async function getLatestGiftResult(db: AppDb, personId: number): Promise<GiftResultRow | null> {
  const row = await db
    .prepare(
      `SELECT top_gifts_json, recommended_json, created_at FROM gift_results
       WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(personId)
    .first<{ top_gifts_json: string; recommended_json: string; created_at: string }>();
  if (!row) return null;
  const parse = (json: string): string[] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return { top_gifts: parse(row.top_gifts_json), recommended: parse(row.recommended_json), created_at: row.created_at };
}

/**
 * Add the given ministry categories to the person's interests without removing
 * any existing ones (ON CONFLICT DO NOTHING dedupes against the UNIQUE constraint).
 * Blank/duplicate categories are dropped. A no-op for an empty list.
 */
export async function addRecommendedToInterests(
  db: AppDb,
  personId: number,
  categories: string[],
): Promise<void> {
  const clean = [...new Set(categories.map((c) => c.trim()).filter(Boolean))];
  if (clean.length === 0) return;
  await db.batch(
    clean.map((c) =>
      db
        .prepare(
          `INSERT INTO person_interests (person_id, category) VALUES (?, ?) ON CONFLICT (person_id, category) DO NOTHING`,
        )
        .bind(personId, c),
    ),
  );
}
