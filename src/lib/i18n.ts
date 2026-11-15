// Tiny translation helper over the flat per-locale dictionaries in src/i18n.
// `t(locale, key, vars)` walks the fallback chain (requested -> installation
// default -> en) for the first dictionary holding the key, then falls back to the
// raw key. `{var}` placeholders are interpolated and each interpolated VALUE is
// HTML-escaped; the authored dictionary text itself is trusted.
//
// t() stays synchronous. Dictionaries live in a per-locale map: `en` and `zh` are
// bundled statically, and every other locale registers a lazy loader (a dynamic
// import, so its file ships as a separate chunk). The middleware awaits
// `loadDict(locale)` for the request locale before rendering; code that formats
// another locale (emails) awaits it too. A locale file exports the flat
// dictionary (default), per-surface design overrides (`design`) and translated
// catalog copy (`catalog`); all three are resident after loadDict.
import { fallbackChain, type SupportedLocale } from './locales';
import en from '../i18n/en';
import zh from '../i18n/zh';
import type { DesignOverrides } from '../i18n/designRegistry';

type Dict = Record<string, string>;

/** Translated catalog copy (capabilities, presets, readiness) for one language. */
export interface CatalogTranslations {
  capabilities?: Record<string, { label?: string; description?: string }>;
  presets?: Record<string, { label?: string; description?: string }>;
  readiness?: Record<string, { title?: string; description?: string; remediation?: string }>;
}

interface LocaleModule {
  default: Dict;
  design?: DesignOverrides;
  catalog?: CatalogTranslations;
}

const loaded: Partial<Record<SupportedLocale, Dict>> = { en, zh };
const designLoaded: Partial<Record<SupportedLocale, DesignOverrides>> = {};
const catalogLoaded: Partial<Record<SupportedLocale, CatalogTranslations>> = {};
let designVersion = 0;

/** Lazy dictionary loaders: each is a dynamic import so the language is its own
 *  chunk. Adding a language adds one line here (and a file in src/i18n). */
const LOADERS: Partial<Record<SupportedLocale, () => Promise<LocaleModule>>> = {
  es: () => import('../i18n/es'),
  pt: () => import('../i18n/pt'),
  fr: () => import('../i18n/fr'),
  de: () => import('../i18n/de'),
  ja: () => import('../i18n/ja'),
  ko: () => import('../i18n/ko'),
  ms: () => import('../i18n/ms'),
  id: () => import('../i18n/id'),
  vi: () => import('../i18n/vi'),
  hi: () => import('../i18n/hi'),
};

/** Ensure `locale`'s dictionary (and thus its chain) is resident for sync t(). */
export async function loadDict(locale: SupportedLocale): Promise<void> {
  for (const code of fallbackChain(locale)) {
    if (loaded[code]) continue;
    const loader = LOADERS[code];
    if (!loader) continue;
    const mod = await loader();
    loaded[code] = mod.default;
    if (mod.design) designLoaded[code] = mod.design;
    if (mod.catalog) catalogLoaded[code] = mod.catalog;
    designVersion += 1;
  }
}

/** True when t() can already resolve `locale` without awaiting loadDict. */
export function isDictLoaded(locale: SupportedLocale): boolean {
  return Boolean(loaded[locale]);
}

const designCache = new Map<string, Record<string, string>>();

/**
 * Per-surface copy for `section`: the English source overlaid, from the end of the
 * fallback chain to the front, by Chinese (supplied beside the code as `base.zh`)
 * and by each loaded language's partial override. Empty override values count as
 * missing. Results are cached per chain until another dictionary loads.
 */
export function designCopy<K extends string>(
  section: string,
  base: { en: Record<K, string>; zh: Record<K, string> },
  locale: SupportedLocale,
): Record<K, string> {
  const chain = fallbackChain(locale);
  if (chain.length === 1 && chain[0] === 'en') return base.en;
  const key = `${section}|${chain.join(',')}|${designVersion}`;
  const hit = designCache.get(key);
  if (hit) return hit as Record<K, string>;
  const out: Record<string, string> = { ...base.en };
  for (const code of [...chain].reverse()) {
    if (code === 'en') continue;
    const layer: Record<string, string | undefined> | undefined =
      code === 'zh' ? base.zh : (designLoaded[code] as Record<string, Record<string, string | undefined>> | undefined)?.[section];
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v) out[k] = v;
  }
  designCache.set(key, out);
  return out as Record<K, string>;
}

/**
 * Catalog copy (capability/preset/readiness text) in `locale` along the fallback
 * chain. en and zh live in config/*.json beside the entry (`base`); other languages
 * come from their src/i18n/catalog/<code>.json once loaded.
 */
export function catalogText(
  kind: keyof CatalogTranslations,
  id: string,
  field: string,
  base: { en: string; zh: string },
  locale: SupportedLocale,
): string {
  for (const code of fallbackChain(locale)) {
    if (code === 'en' || code === 'zh') {
      if (base[code]) return base[code];
      continue;
    }
    const entry = (catalogLoaded[code]?.[kind] as Record<string, Record<string, string | undefined>> | undefined)?.[id];
    if (entry?.[field]) return entry[field] as string;
  }
  return base.en;
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
