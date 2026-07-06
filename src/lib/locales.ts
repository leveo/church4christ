// Locale core: the set of supported UI locales and the URL/header helpers that
// route between them. Every page lives under a locale prefix (`/en/...`,
// `/zh/...`) per spec §6 — the bare `/` is 302-redirected by the router.
// `en` is the default only for content-negotiation fallbacks.

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

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

/**
 * Choose a locale from an `Accept-Language` header, honoring q-values. Any
 * Chinese variant (zh, zh-CN, zh-Hans, zh-TW, …) maps to `zh`; anything else,
 * a wildcard, or a missing header falls back to the default `en`.
 */
export function pickLocaleFromHeader(accept: string | null): Locale {
  if (!accept) return DEFAULT_LOCALE;

  const ranked = accept
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
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}
