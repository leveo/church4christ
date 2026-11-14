// The single money-display seam. Every gift/total in the giving module is stored
// as integer cents (no floats ever cross the DB seam — see givingDb.ts), so the
// UI needs exactly one place that turns cents into human money. USD renders the
// familiar '$1,234.56' (grouped, always 2 decimals, '-$' for a refund shown
// negative); any other ISO code falls back to an uppercase prefix like
// 'CAD 12.34'. USD is the only currency the app emits today, so the fallback is a
// forward-compat courtesy, not a localized formatter. Integer arithmetic
// throughout — no cents/100 float that could round a large gift wrong.

import { localeMeta, type Locale } from './locales';

/** Format integer `cents` as display money. USD → `$1,234.56` / `-$1,234.56`;
 *  any other currency → `CAD 12.34` (uppercase code prefix). `locale` (optional)
 *  selects digit grouping and the decimal mark through Intl; omitted, or for en
 *  and zh, the output is the classic `1,234.56`. */
export function formatCents(cents: number, currency = 'usd', locale?: Locale): string {
  const abs = Math.abs(cents);
  const intl = locale ? localeMeta(locale).intl : 'en-US';
  const major = Math.floor(abs / 100).toLocaleString(intl); // grouping per locale
  const decimal = intl !== 'en-US' && intl !== 'zh-CN'
    ? (new Intl.NumberFormat(intl).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.')
    : '.';
  const minor = String(abs % 100).padStart(2, '0');
  const sign = cents < 0 ? '-' : '';
  const body = `${major}${decimal}${minor}`;
  return currency.toLowerCase() === 'usd' ? `${sign}$${body}` : `${sign}${currency.toUpperCase()} ${body}`;
}
