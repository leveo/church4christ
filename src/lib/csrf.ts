/**
 * A state-changing request must carry browser-controlled proof that it came
 * from this exact origin. Origin is authoritative when present; Fetch Metadata
 * is accepted only when it explicitly says same-origin.
 */
export function hasSameOriginProvenance(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(request.url).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Central mutation-auth classification for the Worker middleware. The exact
 * Stripe POST is server-to-server and authenticates the unmodified body with
 * Stripe's signature inside its endpoint. Every other mutation, including any
 * future webhook, remains on the browser same-origin boundary above.
 */
export function hasValidMutationProvenance(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  if (request.method === 'POST' && new URL(request.url).pathname === '/api/stripe/webhook') return true;
  return hasSameOriginProvenance(request);
}
