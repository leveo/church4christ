// Public QR image for a registration email: GET /register/qr/<eventId>/<confirmation>.png.
// It lives outside /[locale] because a mail client fetches it with no language or
// campus cookie (the link carries ?campus=<slug> instead). The QR encodes ONLY the confirmation number (no link, no token, no
// personal data), so the URL is no more revealing than the email it appears in; an
// unknown event/number pair gets the same bare 404 as a malformed one. The module
// gate in the middleware (the /register prefix) makes it 404 when registration is off.
import type { APIRoute } from 'astro';
import { CONFIRMATION_NO_RE, qrPng } from '../../../../lib/qrPng';

export const prerender = false;

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ params, locals }) => {
  const rawEvent = params.eventId ?? '';
  const confirmation = params.confirmation ?? '';
  if (!/^\d{1,9}$/.test(rawEvent) || !CONFIRMATION_NO_RE.test(confirmation)) return notFound();
  if (!locals.modules.has('registration')) return notFound();
  // The request's own campus-scoped database: the link carries ?campus=<slug> of the registration's campus.
  const found = await locals.db
    .prepare(`SELECT 1 AS found FROM registrations WHERE event_id = ?1 AND confirmation_no = ?2`)
    .bind(Number(rawEvent), confirmation)
    .first<{ found: number }>();
  if (!found) return notFound();
  const png = await qrPng(confirmation);
  return new Response(png as BodyInit, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(png.length),
    },
  });
};
