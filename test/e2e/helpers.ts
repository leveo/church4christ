// Shared request helpers for the built-worker e2e suites. ORIGIN matches the
// wrangler.e2e.jsonc APP_ORIGIN, so a POST carrying `origin: ORIGIN` is treated
// as same-origin by the middleware's CSRF guard (which compares the Origin
// header to the request URL's origin). `redirect: 'manual'` keeps 302/303
// visible instead of being followed.
import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://church.example';

export function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { headers, redirect: 'manual' });
}

export function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      ...headers,
    },
    body,
    redirect: 'manual',
  });
}

/** First cookie name=value pair from a Set-Cookie header (drops the attributes). */
export function cookiePair(setCookie: string | null): string {
  return (setCookie ?? '').split(';')[0];
}

/**
 * The 'YYYY-MM-DD' the seed's date('now','weekday 0', ...) expressions resolve
 * to, computed in JS so date-anchored e2e assertions track the relative seed on
 * any day. `offsetWeeks` shifts by whole weeks (0 = the first upcoming Sunday,
 * +1 = next Sunday, -1 = last Sunday), mirroring the seed's '+7 days' steps.
 *
 * Sunday semantics match SQLite's 'weekday 0': advance to the next Sunday, or
 * stay put when today is already Sunday. Computed in UTC — the exact basis of
 * SQLite date('now') — so this helper and the seed always agree, with no
 * timezone-boundary drift (a Chicago-based today could disagree with the seed's
 * UTC date across the few late-evening hours the two calendars differ).
 */
export function sunday(offsetWeeks = 0): string {
  const now = new Date();
  const daysToSunday = (7 - now.getUTCDay()) % 7; // 0 when today is Sunday
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToSunday + offsetWeeks * 7),
  );
  return d.toISOString().slice(0, 10);
}

/** `sunday(offsetWeeks)` as the compact iCal date 'YYYYMMDD' (for DTSTART). */
export function icalDate(offsetWeeks = 0): string {
  return sunday(offsetWeeks).replace(/-/g, '');
}
