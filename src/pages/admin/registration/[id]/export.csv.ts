import type { APIRoute } from 'astro';
import { getEventAdmin, registrationsCsv } from '../../../../lib/regDb';
import type { Locale } from '../../../../lib/locales';

export const prerender = false;

// Roster CSV export for one event (console class — routePolicy gates
// /admin/registration; the module gate 404s it when registration is off). Streams
// registrationsCsv (RFC4180, one column per question) as a downloadable file named
// by event id. Localized to the signed-in admin's language, en fallback.
export const GET: APIRoute = async ({ params, locals }) => {
  // The route class is 'console' (admits bare team leaders), but this roster is
  // names/emails/answers (PII), so re-tighten to editor∪admin exactly like the two
  // registration pages do — BEFORE any DB read. Without this a leader 403'd off the
  // roster page could still download the CSV.
  const user = locals.user;
  if (!user || !(user.isEditor || user.isAdmin)) return new Response(null, { status: 403 });

  const db = locals.db;
  const rawId = params.id ?? '';
  if (!/^\d+$/.test(rawId)) return new Response(null, { status: 404 });
  const eventId = Number(rawId);
  if (!(await getEventAdmin(db, eventId))) return new Response(null, { status: 404 });

  const lang: Locale = user.lang ?? 'en';
  const csv = await registrationsCsv(db, lang, eventId);

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="church4christ-registrations-${eventId}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
