// Locale core: the set of supported UI locales and the URL/header helpers that
// route between them. Every page lives under a locale prefix (`/en/...`,
// `/zh/...`) per spec §6 — the bare `/` is 302-redirected by the router.
// `en` is the default only for content-negotiation fallbacks.

// ---------------------------------------------------------------------------
// Registry: the languages this codebase CAN render ("supported"). Which of them
// an installation actually serves ("enabled") and its default are runtime
// settings read per request (see ./localeSettings). Adding a language starts
// with one entry here; see docs/i18n.md.
// ---------------------------------------------------------------------------

export type LocaleScript = 'latin' | 'han' | 'kana' | 'hangul' | 'devanagari';

export interface LocaleMeta {
  /** URL segment, dictionary file name, and database `locale` value. */
  readonly code: string;
  /** BCP-47 tag for <html lang>, og/JSON-LD, and :lang() font rules. */
  readonly bcp47: string;
  /** hreflang attribute value (alternate links, sitemap). */
  readonly hreflang: string;
  /** Intl locale used for date, number, money, and list formatting. */
  readonly intl: string;
  /** Open Graph locale (underscore form). */
  readonly ogLocale: string;
  /** The language's own name, shown in the switcher and settings. */
  readonly nativeName: string;
  readonly script: LocaleScript;
  /** CJK scripts want the taller line-height utility. */
  readonly cjk: boolean;
}

export const SUPPORTED_LOCALES = ['en', 'zh', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'ms', 'id', 'vi', 'hi'] as const;
/** A language the code base ships support for (registry member). */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
/** Application-wide alias kept for the many call sites that predate the registry. */
export type Locale = SupportedLocale;
/** @deprecated Supported list, not the enabled set; use locals.locales.enabled for routing. */
export const LOCALES = SUPPORTED_LOCALES;

export const LOCALE_REGISTRY: Readonly<Record<SupportedLocale, LocaleMeta>> = {
  en: { code: 'en', bcp47: 'en', hreflang: 'en', intl: 'en-US', ogLocale: 'en_US', nativeName: 'English', script: 'latin', cjk: false },
  zh: { code: 'zh', bcp47: 'zh-Hans', hreflang: 'zh-Hans', intl: 'zh-CN', ogLocale: 'zh_CN', nativeName: '中文', script: 'han', cjk: true },
  es: { code: 'es', bcp47: 'es', hreflang: 'es', intl: 'es-ES', ogLocale: 'es_ES', nativeName: 'Español', script: 'latin', cjk: false },
  pt: { code: 'pt', bcp47: 'pt-BR', hreflang: 'pt-BR', intl: 'pt-BR', ogLocale: 'pt_BR', nativeName: 'Português (Brasil)', script: 'latin', cjk: false },
  fr: { code: 'fr', bcp47: 'fr', hreflang: 'fr', intl: 'fr-FR', ogLocale: 'fr_FR', nativeName: 'Français', script: 'latin', cjk: false },
  de: { code: 'de', bcp47: 'de', hreflang: 'de', intl: 'de-DE', ogLocale: 'de_DE', nativeName: 'Deutsch', script: 'latin', cjk: false },
  ja: { code: 'ja', bcp47: 'ja', hreflang: 'ja', intl: 'ja-JP', ogLocale: 'ja_JP', nativeName: '日本語', script: 'kana', cjk: true },
  ko: { code: 'ko', bcp47: 'ko', hreflang: 'ko', intl: 'ko-KR', ogLocale: 'ko_KR', nativeName: '한국어', script: 'hangul', cjk: true },
  ms: { code: 'ms', bcp47: 'ms', hreflang: 'ms', intl: 'ms-MY', ogLocale: 'ms_MY', nativeName: 'Bahasa Melayu', script: 'latin', cjk: false },
  id: { code: 'id', bcp47: 'id', hreflang: 'id', intl: 'id-ID', ogLocale: 'id_ID', nativeName: 'Bahasa Indonesia', script: 'latin', cjk: false },
  vi: { code: 'vi', bcp47: 'vi', hreflang: 'vi', intl: 'vi-VN', ogLocale: 'vi_VN', nativeName: 'Tiếng Việt', script: 'latin', cjk: false },
  hi: { code: 'hi', bcp47: 'hi', hreflang: 'hi', intl: 'hi-IN', ogLocale: 'hi_IN', nativeName: 'हिन्दी', script: 'devanagari', cjk: false },
};

/** The fixed final fallback: its dictionary is always loaded. */
export const FALLBACK_LOCALE: SupportedLocale = 'en';
export const DEFAULT_LOCALE: Locale = 'en';
/** Installations that never saved language settings keep exactly these. */
export const LEGACY_ENABLED_LOCALES: readonly SupportedLocale[] = ['en', 'zh'];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function localeMeta(locale: string): LocaleMeta {
  return isSupportedLocale(locale) ? LOCALE_REGISTRY[locale] : LOCALE_REGISTRY[FALLBACK_LOCALE];
}

/** True for the Chinese locale: gates the Simplified-to-Traditional toggle and
 *  other genuinely Chinese-specific behavior (not general localization). */
export function isChinese(locale: string | null | undefined): boolean {
  return locale === 'zh';
}

/** Han-script locales share CJK typography: full-width list marks and
 *  parentheses, compact calendar labels. Driven by registry metadata. */
export function isHanScript(locale: string): boolean {
  return localeMeta(locale).script === 'han';
}

/** Look up per-locale copy along the fallback chain. `en` is required so a
 *  lookup can never come back empty. */
export function pickByLocale<T>(map: { en: T } & Partial<Record<SupportedLocale, T>>, locale: string): T {
  for (const code of fallbackChain(locale)) {
    const hit = map[code];
    if (hit !== undefined) return hit;
  }
  return map.en;
}

/** Separator for an inline list of names: Han uses the enumeration comma. */
export function listSeparator(locale: string): string {
  return isHanScript(locale) ? '、' : ', ';
}

/** `Name (role)` with the locale's parenthesis style (full-width for Han). */
export function nameWithRole(locale: string, name: string, role: string | null | undefined): string {
  if (!role) return name;
  return isHanScript(locale) ? `${name}（${role}）` : `${name} (${role})`;
}

/** Coerce arbitrary input to a supported locale, else null. */
export function toSupportedLocale(value: unknown): SupportedLocale | null {
  return isSupportedLocale(value) ? value : null;
}

/** Ordered, de-duplicated lookup chain: requested -> installation default -> en.
 *  `defaultLocale` defaults to the isolate's runtime default (set by middleware). */
export function fallbackChain(locale: string, defaultLocale: string = runtimeDefaultLocale): SupportedLocale[] {
  const out: SupportedLocale[] = [];
  for (const code of [locale, defaultLocale, FALLBACK_LOCALE]) {
    if (isSupportedLocale(code) && !out.includes(code)) out.push(code);
  }
  return out.length ? out : [FALLBACK_LOCALE];
}

// The installation default for the current isolate. Language settings are
// installation-wide, so one module value is safe; the middleware refreshes it
// on every request from the memoized settings read.
let runtimeDefaultLocale: SupportedLocale = DEFAULT_LOCALE;
export function setRuntimeDefaultLocale(locale: SupportedLocale): void {
  runtimeDefaultLocale = locale;
}
export function getRuntimeDefaultLocale(): SupportedLocale {
  return runtimeDefaultLocale;
}

/** Pick one half of a legacy `*_en` / `*_zh` column pair: zh prefers zh then en,
 *  every other locale prefers en then zh. Empty/nullish values count as absent. */
export function pickPair(
  locale: string,
  enValue: string | null | undefined,
  zhValue: string | null | undefined,
): string {
  return isChinese(locale) ? zhValue || enValue || '' : enValue || zhValue || '';
}

/** Authored text keyed by locale code, e.g. `{ en: 'Home', zh: '首页' }`. */
export type LocaleText = Partial<Record<SupportedLocale, string>>;

/**
 * Validate an untrusted `{[locale]: text}` map: a plain object whose keys are all
 * SUPPORTED locales (unknown keys reject; supported-but-disabled keys are fine,
 * since disabling a language never deletes content) and whose values are strings
 * of at most `max` characters. Returns a fresh copy, or null when invalid.
 */
export function parseLocaleText(x: unknown, max: number, trim = false): LocaleText | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const out: LocaleText = {};
  for (const [key, value] of Object.entries(x)) {
    if (!isSupportedLocale(key) || typeof value !== 'string') return null;
    const text = trim ? value.trim() : value;
    if (text.length > max) return null;
    out[key] = text;
  }
  return out;
}

/** First non-empty text along the fallback chain (requested, default, en). */
export function pickLocaleText(text: LocaleText, locale: string): string {
  for (const code of fallbackChain(locale)) {
    if (text[code]) return text[code] as string;
  }
  return '';
}

/** Resolve authored locale fields without borrowing Chinese text for English
 *  pages. Chinese pages retain the English fallback. Values stay unchanged. */
export function pickLocalizedText(
  text: { en?: string | null; zh?: string | null },
  locale: Locale,
): string {
  return isChinese(locale) ? text.zh || text.en || '' : text.en || '';
}

/** Narrow a single path segment to a Locale, or null if it is not one. */
export function parseLocale(seg: string): Locale | null {
  return (LOCALES as readonly string[]).includes(seg) ? (seg as Locale) : null;
}

/**
 * Build an in-app href for `path` under `locale`. Every locale is prefixed
 * (spec §6: all pages live under `/{locale}/...`). The root path stays clean:
 * `localePath('zh', '/') === '/zh/'`, `localePath('en', '/') === '/en/'`.
 */
export function localePath(locale: Locale, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '/' ? `/${locale}/` : `/${locale}${normalized}`;
}

/**
 * Split a leading locale segment off a pathname. `/zh/sermons/2026` →
 * `{ locale: 'zh', rest: '/sermons/2026' }`. A bare locale (`/zh` or `/zh/`)
 * yields `rest: '/'`. Paths with no locale prefix yield `{ locale: null, rest }`.
 */
export function pathWithoutLocale(pathname: string): { locale: Locale | null; rest: string } {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  const locale = match ? parseLocale(match[1]) : null;
  if (!locale) return { locale: null, rest: pathname };
  return { locale, rest: match![2] || '/' };
}

/** One ranked entry of an Accept-Language header, highest preference first. */
function rankedTags(accept: string | null): string[] {
  if (!accept) return [];
  return accept
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const param of params) {
        const m = param.trim().match(/^q=([0-9.]+)$/);
        if (m) q = parseFloat(m[1]);
      }
      return { tag: tag.trim().toLowerCase(), q };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

/** Match one language tag to a supported locale by primary subtag (zh-TW -> zh). */
function matchTag(tag: string, candidates: readonly SupportedLocale[]): SupportedLocale | null {
  const primary = tag.split('-')[0];
  return candidates.find((code) => code === primary) ?? null;
}

/**
 * Choose a locale from an `Accept-Language` header, honoring q-values, over the
 * `enabled` set (default: every supported locale). Any Chinese variant (zh, zh-CN,
 * zh-Hans, zh-TW, ...) maps to `zh`. A wildcard, a missing header, or no match
 * falls back to `defaultLocale`.
 */
export function pickLocaleFromHeader(
  accept: string | null,
  enabled: readonly SupportedLocale[] = SUPPORTED_LOCALES,
  defaultLocale: SupportedLocale = DEFAULT_LOCALE,
): SupportedLocale {
  for (const tag of rankedTags(accept)) {
    const hit = matchTag(tag, enabled);
    if (hit) return hit;
  }
  return defaultLocale;
}

/** Name of the cookie remembering a visitor's explicit language choice. */
export const LOCALE_COOKIE = 'c4c_locale';

/** Bare-root negotiation: explicit cookie choice, then Accept-Language, then default. */
export function negotiateLocale(
  input: { cookie?: string | null; acceptLanguage: string | null },
  enabled: readonly SupportedLocale[],
  defaultLocale: SupportedLocale,
): SupportedLocale {
  const fromCookie = input.cookie && isSupportedLocale(input.cookie) && enabled.includes(input.cookie) ? input.cookie : null;
  return fromCookie ?? pickLocaleFromHeader(input.acceptLanguage, enabled, defaultLocale);
}
