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
