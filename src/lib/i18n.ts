// Tiny translation helper over the flat per-locale dictionaries in src/i18n.
// `t(locale, key, vars)` looks the key up in that locale, falls back to the en
// dictionary, then to the raw key. `{var}` placeholders are interpolated and
// each interpolated VALUE is HTML-escaped; the authored dictionary text itself
// is trusted and passes through untouched.
import { DEFAULT_LOCALE, type Locale } from './locales';
import en from '../i18n/en';
import zh from '../i18n/zh';

const dicts: Record<Locale, Record<string, string>> = { en, zh };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const template = dicts[locale]?.[key] ?? dicts[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? escapeHtml(String(vars[name])) : match,
  );
}
