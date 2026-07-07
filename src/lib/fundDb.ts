// Funds are the giving destinations an admin configures (General, Missions,
// Building, …). Each fund carries a unique human-facing `fund_number` and a
// localized name in both locales via the fund_i18n companion table, read back
// through the i18nJoin en-fallback helper. This is a Supabase-only module (the
// giving schema lives in migrations-supabase/0002_giving.sql); its tests run
// against real Postgres in test/pg/. Every function assumes the calling page has
// already gated the request to a finance-authorized admin.
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';
import { isUniqueViolation } from './adminDb';

export interface Fund {
  id: number;
  fund_number: string;
  name: string;
  active: number; // 0 | 1
  sort: number;
}

/** Active-and-inactive funds (or active only), localized name with en fallback,
 *  ordered by sort then id. */
export async function listFunds(db: AppDb, locale: Locale, opts: { activeOnly?: boolean } = {}): Promise<Fund[]> {
  const { select, joins } = i18nJoin('fund_i18n', 'f', 'fund_id', ['name'], locale);
  const where = opts.activeOnly ? 'WHERE f.active = 1' : '';
  const { results } = await db
    .prepare(
      `SELECT f.id AS id, f.fund_number AS fund_number, ${select}, f.active AS active, f.sort AS sort
       FROM funds f
       ${joins}
       ${where}
       ORDER BY f.sort, f.id`,
    )
    .all<Fund>();
  return results;
}

/** A single fund with its localized name (en fallback), or null when unknown. */
export async function getFund(db: AppDb, locale: Locale, id: number): Promise<Fund | null> {
  const { select, joins } = i18nJoin('fund_i18n', 'f', 'fund_id', ['name'], locale);
  return db
    .prepare(
      `SELECT f.id AS id, f.fund_number AS fund_number, ${select}, f.active AS active, f.sort AS sort
       FROM funds f
       ${joins}
       WHERE f.id = ?1`,
    )
    .bind(id)
    .first<Fund>();
}

/**
 * Insert (id absent) or update (id present) a fund plus BOTH locale names in one
 * pass. The i18n rows are upserted on their (fund_id, locale) primary key so a
 * rename overwrites in place. A duplicate `fund_number` — on the INSERT, or on an
 * UPDATE that moves onto another fund's number — trips the UNIQUE(fund_number)
 * index and is mapped to a clean 'fund_number_taken' throw (never a raw 500),
 * mirroring the pre-check-free race mapping the people/household writers use.
 * Returns the fund id.
 */
export async function saveFund(
  db: AppDb,
  input: { id?: number; fund_number: string; name_en: string; name_zh: string; active: number; sort: number },
): Promise<number> {
  try {
    let fundId: number;
    if (input.id != null) {
      await db
        .prepare(`UPDATE funds SET fund_number = ?1, active = ?2, sort = ?3, updated_at = datetime('now') WHERE id = ?4`)
        .bind(input.fund_number, input.active, input.sort, input.id)
        .run();
      fundId = input.id;
    } else {
      const created = await db
        .prepare(`INSERT INTO funds (fund_number, active, sort) VALUES (?1, ?2, ?3) RETURNING id`)
        .bind(input.fund_number, input.active, input.sort)
        .first<{ id: number }>();
      fundId = created!.id;
    }
    await db.batch([
      db
        .prepare(`INSERT INTO fund_i18n (fund_id, locale, name) VALUES (?1, 'en', ?2) ON CONFLICT (fund_id, locale) DO UPDATE SET name = excluded.name`)
        .bind(fundId, input.name_en),
      db
        .prepare(`INSERT INTO fund_i18n (fund_id, locale, name) VALUES (?1, 'zh', ?2) ON CONFLICT (fund_id, locale) DO UPDATE SET name = excluded.name`)
        .bind(fundId, input.name_zh),
    ]);
    return fundId;
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error('fund_number_taken');
    throw e;
  }
}

/** Flip a fund's active flag (quick list action). */
export async function toggleFundActive(db: AppDb, id: number): Promise<void> {
  await db.prepare(`UPDATE funds SET active = 1 - active, updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
}
