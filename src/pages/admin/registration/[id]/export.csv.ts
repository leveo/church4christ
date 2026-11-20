import type { APIRoute } from 'astro';
import { requireRegRole } from '../../../../lib/regAccess';
import { registrationsCsv } from '../../../../lib/regDb';
import { CSV_BOM } from '../../../../lib/regExport';
import type { Locale } from '../../../../lib/locales';

export const prerender = false;

// Roster CSV export for one event (one row per registration). The route class is `regEventStaff` (a per-event
// viewer or registrar may export their own event; the middleware checks the role before this runs) and this
// endpoint checks it again, BEFORE any read, so a registrar of another event, a desk-only volunteer or a
// signed-in member without a role never reaches the data. Streams registrationsCsv (RFC4180, one column per
// question) behind a UTF-8 byte-order mark, as a downloadable file named by event id, in the signed-in
// person's language (en fallback). The columns are unchanged; only the BOM is new.
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const rawId = params.id ?? '';
  if (!user || !/^\d+$/.test(rawId)) return new Response(null, { status: user ? 404 : 403 });
  const eventId = Number(rawId);
  const role = await requireRegRole(locals.db, user, eventId, 'view');
  if (!role.ok) return new Response(null, { status: role.status });

  const lang: Locale = user.lang ?? 'en';
  const csv = await registrationsCsv(locals.db, lang, eventId);

  return new Response(CSV_BOM + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="church4christ-registrations-${eventId}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
