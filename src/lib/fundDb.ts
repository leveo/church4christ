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
import { recordGivingAudit } from './givingAudit';

export interface Fund {
  id: number;
  fund_number: string;
  name: string;
  /** Localized description (en fallback), '' when none was written. */
  description: string;
  active: number; // 0 | 1
  sort: number;
  /** The fund preselected on the give form. At most one per campus. */
  is_default: boolean;
  /** Only tax-deductible funds appear on annual giving statements. */
  tax_deductible: boolean;
}

// Fund columns plus a localized name/description. A zh row written without a
// description must fall back to English, so the description coalesces over NULLIF.
function fundSelect(locale: Locale): { select: string; joins: string } {
  const { select, joins } = i18nJoin('fund_i18n', 'f', 'fund_id', ['name'], locale);
  return {
    select: `f.id AS id, f.fund_number AS fund_number, ${select},
      COALESCE(NULLIF(f_l.description, ''), f_d.description, '') AS description,
      f.active AS active, f.sort AS sort, f.is_default AS is_default, f.tax_deductible AS tax_deductible`,
    joins,
  };
}

/** Active-and-inactive funds (or active only), localized name with en fallback,
 *  ordered by sort then id. */
export async function listFunds(db: AppDb, locale: Locale, opts: { activeOnly?: boolean } = {}): Promise<Fund[]> {
  const { select, joins } = fundSelect(locale);
  const where = opts.activeOnly ? 'WHERE f.active = 1' : '';
  const { results } = await db
    .prepare(
      `SELECT ${select}
       FROM funds f
       ${joins}
       ${where}
       ORDER BY f.is_default DESC, f.sort, f.id`,
    )
    .all<Fund>();
  return results;
}

/** A single fund with its localized name (en fallback), or null when unknown. */
export async function getFund(db: AppDb, locale: Locale, id: number): Promise<Fund | null> {
  const { select, joins } = fundSelect(locale);
  return db
    .prepare(
      `SELECT ${select}
       FROM funds f
       ${joins}
       WHERE f.id = ?1`,
    )
    .bind(id)
    .first<Fund>();
}

/**
 * Insert (id absent) or update (id present) a fund plus its locale names in one
 * pass. The i18n rows are upserted on their (fund_id, locale) primary key so a
 * rename overwrites in place. The en row is always written; a blank/whitespace
 * zh name DELETES the zh row instead of storing '' — the i18nJoin en-fallback
 * COALESCE only fires on NULL (a missing row), never on an empty string, so a
 * stored '' would render a blank fund option to zh donors. Blanking the zh name
 * on an edit therefore also removes a previously saved zh row. A duplicate
 * `fund_number` — on the INSERT, or on an UPDATE that moves onto another fund's
 * number — trips the UNIQUE(fund_number) index and is mapped to a clean
 * 'fund_number_taken' throw (never a raw 500), mirroring the pre-check-free
 * race mapping the people/household writers use. Returns the fund id.
 */
export async function saveFund(
  db: AppDb,
  input: {
    id?: number;
    fund_number: string;
    name_en: string;
    name_zh: string;
    description_en?: string;
    description_zh?: string;
    active: number;
    sort: number;
    is_default?: boolean;
    tax_deductible?: boolean;
    /** When set, an audit row records who saved the fund. */
    actorPersonId?: number;
  },
): Promise<number> {
  try {
    let fundId: number;
    if (input.id != null) {
      await db
        .prepare(
          `UPDATE funds SET fund_number = ?1, active = ?2, sort = ?3, tax_deductible = COALESCE(?4, tax_deductible),
                  updated_at = datetime('now') WHERE id = ?5`,
        )
        .bind(input.fund_number, input.active, input.sort, input.tax_deductible ?? null, input.id)
        .run();
      fundId = input.id;
    } else {
      // Inserted non-default; the default flag moves in the batch below so the
      // one-default-per-campus index never sees two defaults.
      const created = await db
        .prepare(`INSERT INTO funds (fund_number, active, sort, tax_deductible) VALUES (?1, ?2, ?3, COALESCE(?4, true)) RETURNING id`)
        .bind(input.fund_number, input.active, input.sort, input.tax_deductible ?? null)
        .first<{ id: number }>();
      fundId = created!.id;
    }
    const nameZh = input.name_zh.trim();
    const descEn = (input.description_en ?? '').trim();
    const descZh = (input.description_zh ?? '').trim();
    const statements = [
      db
        .prepare(`INSERT INTO fund_i18n (fund_id, locale, name, description) VALUES (?1, 'en', ?2, ?3) ON CONFLICT (fund_id, locale) DO UPDATE SET name = excluded.name, description = excluded.description`)
        .bind(fundId, input.name_en, descEn),
      nameZh
        ? db
            .prepare(`INSERT INTO fund_i18n (fund_id, locale, name, description) VALUES (?1, 'zh', ?2, ?3) ON CONFLICT (fund_id, locale) DO UPDATE SET name = excluded.name, description = excluded.description`)
            .bind(fundId, nameZh, descZh)
        : db.prepare(`DELETE FROM fund_i18n WHERE fund_id = ?1 AND locale = 'zh'`).bind(fundId),
    ];
    if (input.is_default === true) {
      statements.push(
        db.prepare(`UPDATE funds SET is_default = false WHERE is_default = true AND id <> ?1`).bind(fundId),
        db.prepare(`UPDATE funds SET is_default = true WHERE id = ?1`).bind(fundId),
      );
    } else if (input.is_default === false) {
      statements.push(db.prepare(`UPDATE funds SET is_default = false WHERE id = ?1`).bind(fundId));
    }
    await db.batch(statements);
    if (input.actorPersonId) {
      await recordGivingAudit(db, { actorPersonId: input.actorPersonId, action: 'fund_saved', refId: fundId });
    }
    return fundId;
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error('fund_number_taken');
    throw e;
  }
}

/** Flip a fund's active flag (quick list action). */
export async function toggleFundActive(db: AppDb, id: number, actorPersonId?: number): Promise<void> {
  await db.prepare(`UPDATE funds SET active = 1 - active, updated_at = datetime('now') WHERE id = ?1`).bind(id).run();
  if (actorPersonId) await recordGivingAudit(db, { actorPersonId, action: 'fund_saved', refId: id });
}

export interface FundAdminRow {
  id: number;
  fund_number: string;
  name_en: string;
  name_zh: string;
  description_en: string;
  description_zh: string;
  active: number; // 0 | 1
  sort: number;
  is_default: boolean;
  tax_deductible: boolean;
}

/**
 * Every fund (active AND inactive) with BOTH locale names, for the admin funds
 * table. listFunds returns only one locale's name (with en fallback) — the admin
 * table shows en + zh side by side, so this reads both fund_i18n rows directly
 * (mirrors listAnnouncements/listEvents). Ordered by sort then id.
 */
export async function listFundsAdmin(db: AppDb): Promise<FundAdminRow[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id AS id, f.fund_number AS fund_number,
              COALESCE(en.name, '') AS name_en, COALESCE(zh.name, '') AS name_zh,
              COALESCE(en.description, '') AS description_en, COALESCE(zh.description, '') AS description_zh,
              f.active AS active, f.sort AS sort, f.is_default AS is_default, f.tax_deductible AS tax_deductible
       FROM funds f
       LEFT JOIN fund_i18n en ON en.fund_id = f.id AND en.locale = 'en'
       LEFT JOIN fund_i18n zh ON zh.fund_id = f.id AND zh.locale = 'zh'
       ORDER BY f.sort, f.id`,
    )
    .all<FundAdminRow>();
  return results;
}
