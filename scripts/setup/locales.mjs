// Supported languages for setup and onboarding. The runtime registry lives in
// src/lib/locales.ts; config/locales.json mirrors its codes and native names for
// these plain-Node scripts, and test/node/setup/locales-parity.test.ts keeps the
// two in lockstep. Adding a language means adding it to both.
import config from '../../config/locales.json' with { type: 'json' };

export const SUPPORTED_LOCALE_CODES = Object.freeze(config.supported.map((entry) => entry.code));
export const SUPPORTED_LOCALES = Object.freeze(config.supported.map((entry) => Object.freeze({ ...entry })));
export const FALLBACK_DEFAULT_LOCALE = config.defaultLocale;

/** Settings an upgraded installation without saved language settings behaves as. */
export const LEGACY_ENABLED_LOCALES = Object.freeze(['en', 'zh']);

/**
 * Normalize language answers to { locales, defaultLocale } (or both undefined when
 * nothing was supplied). `locale` is the legacy single-language alias:
 * `--locale x` means `--locales x --default-locale x`. Without an explicit default,
 * the first listed language is the default.
 */
/**
 * @param {{ locale?: string | null, locales?: string | string[], defaultLocale?: string | null }} input
 * @param {string} [label]
 */
export function normalizeLocaleAnswers({ locale, locales, defaultLocale }, label = '--locales') {
  const list = typeof locales === 'string' ? locales.split(',') : locales;
  const given = Array.isArray(list)
    ? list.map((value) => (typeof value === 'string' ? value.trim() : value)).filter(Boolean)
    : undefined;
  const hasLocale = locale !== undefined && locale !== null && locale !== '';
  if (hasLocale && (given !== undefined || defaultLocale)) {
    // Already-normalized answers carry all three consistently; anything else is a conflict.
    const consistent = (defaultLocale === undefined || defaultLocale === locale) && (given === undefined || given.includes(locale));
    if (!consistent) throw new Error('--locale cannot be combined with --locales or --default-locale');
    return normalizeLocaleAnswers({ locales: given, defaultLocale: locale }, label);
  }
  if (hasLocale) {
    if (!SUPPORTED_LOCALE_CODES.includes(locale)) throw new Error(`--locale must be one of: ${SUPPORTED_LOCALE_CODES.join(', ')}`);
    return { locales: [locale], defaultLocale: locale, alias: true };
  }
  if (given === undefined && !defaultLocale) return { locales: undefined, defaultLocale: undefined, alias: false };
  const unique = [...new Set(given ?? [defaultLocale])];
  if (unique.length === 0) throw new Error(`${label} must list at least one language`);
  const unknown = unique.filter((code) => !SUPPORTED_LOCALE_CODES.includes(code));
  if (unknown.length) throw new Error(`${label} contains unsupported languages: ${unknown.join(', ')} (supported: ${SUPPORTED_LOCALE_CODES.join(', ')})`);
  const chosen = defaultLocale ?? unique[0];
  if (!unique.includes(chosen)) throw new Error('--default-locale must be one of the enabled --locales');
  // Registry order keeps stored settings stable regardless of flag order.
  return { locales: SUPPORTED_LOCALE_CODES.filter((code) => unique.includes(code)), defaultLocale: chosen, alias: false };
}
