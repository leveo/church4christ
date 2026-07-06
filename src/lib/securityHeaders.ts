// Baseline security headers set on every HTML/JSON response (spec §14). Kept in
// a dependency-free module so both the middleware and a unit test can share the
// exact same source of truth for the header names and values.
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

// Set every baseline header on a response's Headers, overwriting any existing
// value. Mutates in place; safe to call on redirects and rendered pages alike.
export function applySecurityHeaders(headers: Headers): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
}
