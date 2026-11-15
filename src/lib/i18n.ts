// Tiny translation helper over the flat per-locale dictionaries in src/i18n.
// `t(locale, key, vars)` walks the fallback chain (requested -> installation
// default -> en) for the first dictionary holding the key, then falls back to the
// raw key. `{var}` placeholders are interpolated and each interpolated VALUE is
// HTML-escaped; the authored dictionary text itself is trusted.
//
// t() stays synchronous. Dictionaries live in a per-locale map: `en` is always
// bundled (the final fallback), and any locale may register a lazy loader so its
// file ships as a separate chunk. The middleware awaits `loadDict(locale)` for the
// request locale before rendering; code that formats another locale (emails)
// awaits it too. en and zh are bundled statically today, so loading them is a no-op.
import { fallbackChain, type SupportedLocale } from './locales';
import en from '../i18n/en';
import zh from '../i18n/zh';

type Dict = Record<string, string>;

const loaded: Partial<Record<SupportedLocale, Dict>> = { en, zh };

/** Lazy dictionary loaders. A locale listed here is fetched on first use; add
 *  `es: () => import('../i18n/es')` style entries for chunked languages. */
const LOADERS: Partial<Record<SupportedLocale, () => Promise<{ default: Dict }>>> = {};

/** Ensure `locale`'s dictionary (and thus its chain) is resident for sync t(). */
export async function loadDict(locale: SupportedLocale): Promise<void> {
  for (const code of fallbackChain(locale)) {
    if (loaded[code]) continue;
    const loader = LOADERS[code];
    if (loader) loaded[code] = (await loader()).default;
  }
}

/** True when t() can already resolve `locale` without awaiting loadDict. */
export function isDictLoaded(locale: SupportedLocale): boolean {
  return Boolean(loaded[locale]);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string {
  let template: string | undefined;
  for (const code of fallbackChain(locale)) {
    template = loaded[code]?.[key];
    if (template !== undefined) break;
  }
  template ??= key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? escapeHtml(String(vars[name])) : match,
  );
}
