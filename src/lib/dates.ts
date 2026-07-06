// Date helpers. Church scheduling is anchored to a fixed timezone
// (America/Chicago by default); day-of-week arithmetic runs on the DATE STRING
// re-parsed as UTC midnight, so it is immune to DST because no zoned instants
// are ever added or subtracted. datetime-local <-> UTC conversion is DST-aware
// and returns SQL-comparable strings (space separator, no 'Z') matching D1's
// datetime('now').
import type { Locale } from './locales';

const DAY_MS = 86_400_000;
const DEFAULT_TZ = 'America/Chicago';

/** Strict YYYY-MM-DD that is also a real calendar date. */
export function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 'YYYY-MM-DD' for the given instant (default: now) as seen in `tz`. */
export function todayInTz(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shift a 'YYYY-MM-DD' by `n` days (UTC-anchored → DST-immune). */
export function addDays(dateStr: string, n: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * From `fromDateStr`, the next date whose day-of-week is `weekday` (0=Sunday …
 * 6=Saturday). Returns `fromDateStr` itself when it already falls on `weekday`.
 */
export function nextWeekday(fromDateStr: string, weekday: number): string {
  const cur = new Date(`${fromDateStr}T00:00:00Z`).getUTCDay();
  return addDays(fromDateStr, (((weekday - cur) % 7) + 7) % 7);
}

/** Human-readable date: en → 'July 5, 2026', zh → '2026年7月5日'. */
export function formatDate(dateStr: string, locale: Locale): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (locale === 'zh') return `${y}年${m}月${d}日`;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Inclusive date-string bounds for a 'YYYY-MM' month. The end is the '-31'
 *  sentinel: string comparison against real 'YYYY-MM-DD' rows is safe for
 *  shorter months (ported from the reference stack). */
export function monthRange(ym: string): { start: string; end: string } {
  return { start: `${ym}-01`, end: `${ym}-31` };
}

/** Month heading from a 'YYYY-MM' key: en → 'July 2026', zh → '2026年7月'. */
export function formatMonth(yearMonth: string, locale: Locale): string {
  const [y, m] = yearMonth.split('-').map(Number);
  if (locale === 'zh') return `${y}年${m}月`;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function wallClock(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Convert an admin <input type="datetime-local"> value ('YYYY-MM-DDTHH:MM'),
 * interpreted in `tz` (DST-aware), to a UTC 'YYYY-MM-DD HH:MM:SS' string
 * comparable with D1's datetime('now'). Returns null on invalid input.
 * Nonexistent local times inside the spring-forward hole resolve to a nearby
 * instant; ambiguous fall-back times pick one of the two possible instants —
 * both are fine for publish scheduling.
 */
export function datetimeLocalToUtc(local: string, tz: string = DEFAULT_TZ): string | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
  const fields = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(fields);
  // Date.UTC silently normalizes rollover (2026-02-30 → Mar 2); reject it.
  if (
    check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
    check.getUTCHours() !== h || check.getUTCMinutes() !== mi
  ) return null;
  // Start from the instant whose UTC wall clock matches the input, then correct
  // by the observed `tz` offset; converges in <=2 passes outside the
  // spring-forward hole (loop is capped either way).
  let guess = fields;
  for (let i = 0; i < 3; i++) {
    const diff = fields - Date.parse(`${wallClock(new Date(guess), tz)}:00Z`);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString().slice(0, 19).replace('T', ' ');
}

/** UTC 'YYYY-MM-DD HH:MM:SS' → `tz` 'YYYY-MM-DDTHH:MM' for datetime-local inputs ('' if null/invalid). */
export function utcToDatetimeLocal(utcSql: string | null, tz: string = DEFAULT_TZ): string {
  if (!utcSql) return '';
  const d = new Date(utcSql.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return wallClock(d, tz);
}
