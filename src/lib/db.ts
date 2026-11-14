// Data-access core for the public site + admin: the i18n LEFT JOIN builder that
// backs every localized list query, person lookups keyed on the login email, and
// the ministries index with its team / open-signup aggregates.
//
// i18nJoin interpolates identifiers and the locale straight into SQL, so every
// argument is validated first. Callers only ever pass trusted literals (table
// names, column names, a Locale) — the validation is defense in depth, never a
// substitute for parameterizing user input (which does not reach this layer).
import type { AppDb } from './appDb';
import { fallbackChain, isSupportedLocale, type Locale } from './locales';

export type { Locale };

// Identifier allow-list for the interpolated table/alias/column names. Lower-case
// letters, digits, and underscores only — enough to name the real tables (which
// include digits, e.g. `ministry_i18n`) while rejecting quotes, whitespace,
// semicolons, parentheses, and every other injection vector. Callers pass trusted
// literals only; this is defense in depth, not a substitute for parameterization.
const IDENT = /^[a-z0-9_]+$/;

function assertIdent(value: string, what: string): void {
  if (!IDENT.test(value)) throw new Error(`i18nJoin: invalid ${what} ${JSON.stringify(value)}`);
}

/**
 * Build the LEFT JOIN + COALESCE fragments for a locale-aware companion table.
 * The lookup order is the fallback chain (requested -> installation default -> en),
 * one join per distinct link: `<alias>_l` (first), `<alias>_d` (second) and
 * `<alias>_e` (third, only when all three differ). A one-element chain (en with
 * en as default) joins en twice, so today's SQL is unchanged. Each requested
 * column becomes `COALESCE(<alias>_l.<col>, <alias>_d.<col>[, <alias>_e.<col>])`.
 * The companion table joins its `<fkCol>` back to `<alias>.id`, so callers must
 * alias the base row `<alias>`. Pass a locale (chain derived from the runtime
 * default) or an explicit chain.
 */
export function i18nJoin(
  table: string,
  alias: string,
  fkCol: string,
  cols: string[],
  localeOrChain: Locale | readonly string[],
): { select: string; joins: string } {
  if (typeof localeOrChain === 'string' && !isSupportedLocale(localeOrChain)) {
    throw new Error(`i18nJoin: unsupported locale ${JSON.stringify(localeOrChain)}`);
  }
  const requested = typeof localeOrChain === 'string' ? fallbackChain(localeOrChain) : [...localeOrChain];
  if (requested.length === 0 || !requested.every(isSupportedLocale)) {
    throw new Error(`i18nJoin: unsupported locale ${JSON.stringify(localeOrChain)}`);
  }
  assertIdent(table, 'table');
  assertIdent(alias, 'alias');
  assertIdent(fkCol, 'fkCol');
  for (const col of cols) assertIdent(col, 'column');

  const chain = requested.length === 1 ? [requested[0], requested[0]] : requested.slice(0, 3);
  const suffixes = ['l', 'd', 'e'];
  const select = cols
    .map((col) => `COALESCE(${chain.map((_, i) => `${alias}_${suffixes[i]}.${col}`).join(', ')}) AS ${col}`)
    .join(', ');
  const joins = chain
    .map((code, i) => `LEFT JOIN ${table} ${alias}_${suffixes[i]} ON ${alias}_${suffixes[i]}.${fkCol} = ${alias}.id AND ${alias}_${suffixes[i]}.locale = '${code}'`)
    .join(' ');
  return { select, joins };
}

interface PersonRow {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  role: string;
  active: number;
  session_epoch: number;
  calendar_token: string | null;
  lang: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Person by login email (lowercased + trimmed), excluding soft-deleted rows. */
export async function getPersonByEmail(db: AppDb, email: string): Promise<PersonRow | null> {
  return db
    .prepare('SELECT * FROM people WHERE email = ? AND deleted_at IS NULL')
    .bind(email.trim().toLowerCase())
    .first<PersonRow>();
}

/** Person by id, excluding soft-deleted rows. */
export async function getPersonById(db: AppDb, id: number): Promise<PersonRow | null> {
  return db
    .prepare('SELECT * FROM people WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<PersonRow>();
}

interface MinistryListRow {
  id: number;
  slug: string;
  category: string;
  icon: string;
  coverKey: string | null;
  leaderPersonId: number | null;
  meetingTime: string | null;
  sort: number;
  name: string;
  intro: string;
  teamCount: number;
  openSignupSlots: number;
}

/**
 * Active ministries for the public index, ordered by sort then id. name/intro
 * come from ministry_i18n via i18nJoin (localized with an en fallback).
 * teamCount is the ministry's non-deleted teams. openSignupSlots counts
 * open-signup plan positions on future (plan_date >= today), non-deleted plans
 * across those teams — an upper bound on "help wanted": it does NOT subtract
 * already-filled assignments (slices 4/6 refine if a true count is needed).
 */
export async function listMinistries(db: AppDb, locale: Locale): Promise<MinistryListRow[]> {
  const { select, joins } = i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name', 'intro'], locale);
  const { results } = await db
    .prepare(
      `SELECT m.id AS id, m.slug AS slug, m.category AS category, m.icon AS icon,
              m.cover_key AS "coverKey", m.leader_person_id AS "leaderPersonId",
              m.meeting_time AS "meetingTime", m.sort AS sort,
              ${select},
              (SELECT COUNT(DISTINCT t.id) FROM teams t
                 WHERE t.ministry_id = m.id AND t.deleted_at IS NULL) AS "teamCount",
              (SELECT COUNT(*) FROM plan_positions pp
                 JOIN plans p ON p.id = pp.plan_id
                   -- 2-arg date(): Postgres parses the bare 1-arg form as a CAST to the
                   -- date type, never our compat function; 2-arg is identical on SQLite/D1.
                   AND p.deleted_at IS NULL AND p.plan_date >= date('now', 'start of day')
                 JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
                 JOIN teams t2 ON t2.id = pos.team_id
                   AND t2.deleted_at IS NULL AND t2.ministry_id = m.id
                 WHERE pp.open_signup = 1) AS "openSignupSlots"
       FROM ministries m
       ${joins}
       WHERE m.active = 1 AND m.deleted_at IS NULL
       ORDER BY m.sort, m.id`,
    )
    .all<MinistryListRow>();
  return results;
}
