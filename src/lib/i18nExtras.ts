// Companion-table translations beyond the en/zh column pair.
//
// Legacy admin lists read `name_en` / `name_zh` style columns through two joins; any other
// supported language lives only in the `*_i18n` row. These helpers let an editor load those
// rows, show them in the tabbed LocaleFields, and write them back, so enabling a language
// never drops text that was entered in it. Field names stay `<stem>_<code>`.
import type { AppDb } from './appDb';
import { SUPPORTED_LOCALES, isSupportedLocale, type SupportedLocale } from './locales';

/** Languages stored only in `*_i18n` rows (everything except the legacy en/zh pair). */
export const EXTRA_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES.filter((code) => code !== 'en' && code !== 'zh');

/** `{ locale: { column: text } }` for the extra languages of one parent row. */
export type ExtraTexts = Partial<Record<SupportedLocale, Record<string, string>>>;

/** Companion tables the helpers may touch (names are interpolated into SQL). */
export type I18nTable =
  | 'ministry_i18n' | 'team_i18n' | 'position_i18n' | 'service_type_i18n'
  | 'announcement_i18n' | 'event_i18n' | 'custom_page_i18n'
  | 'newcomer_status_i18n' | 'newcomer_field_i18n' | 'newcomer_field_option_i18n';

const IDENT = /^[a-z][a-z0-9_]*$/;
function assertIdent(...names: string[]): void {
  for (const name of names) if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
}

/** Collect `<stem>_<code>` form values for the extra languages; blank values are dropped. */
export function extraLocaleTexts(read: (field: string) => string, stem: string): Partial<Record<SupportedLocale, string>> {
  const out: Partial<Record<SupportedLocale, string>> = {};
  for (const code of EXTRA_LOCALES) {
    const value = read(`${stem}_${code}`).trim();
    if (value) out[code] = value;
  }
  return out;
}

/** Every posted `<stem>_<code>` for the extra languages, blanks included, so an editor can
 *  clear a translation. Fields that were not posted at all are omitted (left untouched). */
export function extraLocalePosted(fd: FormData, stem: string): Partial<Record<SupportedLocale, string>> {
  const out: Partial<Record<SupportedLocale, string>> = {};
  for (const code of EXTRA_LOCALES) {
    if (fd.has(`${stem}_${code}`)) out[code] = String(fd.get(`${stem}_${code}`) ?? '').trim();
  }
  return out;
}

/** Same as extraLocaleTexts, reading straight from a FormData. */
export function extraLocaleTextsFromForm(fd: FormData, stem: string): Partial<Record<SupportedLocale, string>> {
  return extraLocaleTexts((field) => String(fd.get(field) ?? ''), stem);
}

/** Load every extra-language row of `table`, keyed by the parent id. */
export async function loadExtraI18n(
  db: AppDb,
  table: I18nTable,
  fk: string,
  columns: readonly string[],
): Promise<Map<string, ExtraTexts>> {
  assertIdent(table, fk, ...columns);
  const { results } = await db
    .prepare(`SELECT ${fk} AS id, locale, ${columns.join(', ')} FROM ${table} WHERE locale NOT IN ('en', 'zh')`)
    .all<Record<string, string | number | null>>();
  const out = new Map<string, ExtraTexts>();
  for (const row of results) {
    const locale = String(row.locale);
    if (!isSupportedLocale(locale)) continue;
    const id = String(row.id);
    const entry = out.get(id) ?? {};
    entry[locale] = Object.fromEntries(columns.map((column) => [column, String(row[column] ?? '')]));
    out.set(id, entry);
  }
  return out;
}

/** Tabbed-editor values for one field: the legacy en/zh pair plus the extra languages. */
export function localeValues(
  pair: { en?: string | null; zh?: string | null },
  extras: ExtraTexts | undefined,
  column: string,
): Partial<Record<SupportedLocale, string>> {
  const out: Partial<Record<SupportedLocale, string>> = { en: pair.en ?? '', zh: pair.zh ?? '' };
  for (const code of EXTRA_LOCALES) {
    const value = extras?.[code]?.[column];
    if (value) out[code] = value;
  }
  return out;
}

/**
 * Upsert (or delete when every column is blank) the extra-language rows of one parent.
 * `required` is the column that must be non-empty for a row to exist. Languages absent
 * from `texts` are left untouched.
 */
export async function saveExtraI18n(
  db: AppDb,
  table: I18nTable,
  fk: string,
  id: number | string,
  texts: Partial<Record<SupportedLocale, Record<string, string>>>,
  required: string,
): Promise<void> {
  for (const [locale, columns] of Object.entries(texts)) {
    if (!isSupportedLocale(locale) || locale === 'en' || locale === 'zh' || !columns) continue;
    const names = Object.keys(columns);
    assertIdent(table, fk, required, ...names);
    if (!columns[required]) {
      await db.prepare(`DELETE FROM ${table} WHERE ${fk} = ?1 AND locale = ?2`).bind(id, locale).run();
      continue;
    }
    const set = names.map((name) => `${name} = excluded.${name}`).join(', ');
    const holders = names.map((_, i) => `?${i + 3}`).join(', ');
    await db
      .prepare(`INSERT INTO ${table} (${fk}, locale, ${names.join(', ')}) VALUES (?1, ?2, ${holders}) ON CONFLICT(${fk}, locale) DO UPDATE SET ${set}`)
      .bind(id, locale, ...names.map((name) => columns[name]))
      .run();
  }
}
