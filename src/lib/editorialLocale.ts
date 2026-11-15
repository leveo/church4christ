// Source eligibility for legacy editorial fields that carry no language metadata
// (sermons, bulletins, plan subtitles). `isEnglishEditorialText` detects Han text, not
// language, so it is only evidence of "Chinese content" for readers of a Latin-script
// language. Never pass dedicated person names, volunteer responses, or other user
// messages through this rule.
//
// THE RULE (docs/i18n.md "Legacy editorial content"):
//   - A row is treated as Chinese by Han detection only for a LATIN-SCRIPT reader
//     (en, es, fr, ...). Those pages omit rows whose editorial fields contain Han.
//   - For zh and for every non-Latin-script language (ja, ko, hi), nothing is hidden by the
//     heuristic: Japanese and Korean text legitimately contains Han characters, so Han is no
//     proof of Chinese. Those pages show the rows that exist, following the fallback chain.
//   - Rows with an explicit locale column (prayer sheets, testimonies) never use the heuristic:
//     they are matched by that locale along the fallback chain (see publicDb).
import { localeMeta } from './locales';

/** True when this language's pages should hide Han-bearing legacy rows. */
export function hidesHanRows(locale: string): boolean {
  return localeMeta(locale).script === 'latin';
}

export function isEnglishEditorialText(...values: unknown[]): boolean {
  return values.every((value) => typeof value !== 'string' || !/\p{Script=Han}/u.test(value));
}

/** Eligible for `locale`'s pages: always true except for Latin-script readers, who skip Han text. */
export function editorialEligible(locale: string, ...values: unknown[]): boolean {
  return !hidesHanRows(locale) || isEnglishEditorialText(...values);
}
