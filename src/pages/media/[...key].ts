import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// Serve ONLY content-addressed uploads. The same R2 bucket also holds nightly
// D1 dumps (backups/YYYY-MM-DD.sql) and other operational objects; this strict
// key pattern makes the route incapable of reaching anything outside uploads/,
// even via an encoded path-traversal key ("uploads/../backups/…") that survives
// URL normalization and arrives in params.key. Lowercase-only and the leading
// alphanumeric match exactly what uploadKey() ever emits.
const KEY_RE = /^uploads\/[a-z0-9][a-z0-9.-]*$/;

// Content types that render inline; anything else downloads as an opaque file
// (defense in depth: keys are staff-controlled, but never trust stored metadata).
// image/svg+xml is EXCLUDED — SVG can carry script — so it falls to attachment.
const SAFE_INLINE = /^(image\/(?!svg)|audio\/|video\/|application\/pdf$)/;

export const GET: APIRoute = async ({ params }) => {
  const key = params.key ?? '';
  if (!KEY_RE.test(key)) return new Response('Not found', { status: 404 });
  const object = await (env as { MEDIA: R2Bucket }).MEDIA.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = headers.get('content-type') ?? '';
  if (!SAFE_INLINE.test(contentType)) {
    headers.set('content-type', 'application/octet-stream');
    headers.set('content-disposition', 'attachment');
  }
  headers.set('x-content-type-options', 'nosniff');
  headers.set('etag', object.httpEtag);
  // This route sets its OWN long-lived cache-control; the middleware exempts
  // /media/ from its per-user no-store precisely so this survives.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
};
