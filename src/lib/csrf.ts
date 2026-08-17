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
