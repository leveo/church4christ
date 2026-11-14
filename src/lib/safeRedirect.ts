/**
 * Same-origin guard for every redirect target built from request data. Collapses
 * leading slashes/backslashes (so `//host` and `/\\host` cannot become
 * protocol-relative) and re-resolves against the trusted origin; returns the
 * path+query, or null when the result would leave the origin.
 */
export function sameOriginTarget(origin: string, pathAndSearch: string): string | null {
  const target = new URL(pathAndSearch.replace(/^[\/\\]+/, '/'), origin);
  return target.origin === origin ? `${target.pathname}${target.search}` : null;
}
