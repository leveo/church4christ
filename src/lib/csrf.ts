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
 * allowlisted server-to-server POSTs authenticate the unmodified body in
 * their endpoint. Every other mutation remains on the browser same-origin
 * boundary above.
 */
export function hasValidMutationProvenance(request: Request): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  if (request.method === 'POST' && [
    '/api/stripe/webhook',
    '/api/learning/google/pubsub',
    '/api/learning/canvas/live-events',
  ].includes(new URL(request.url).pathname)) return true;
  if (request.method === 'POST'
    && /^\/api\/planning-center\/webhook\/[0-9]{1,32}$/u.test(new URL(request.url).pathname)) return true;
  return hasSameOriginProvenance(request);
}
