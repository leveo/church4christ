import type { APIRoute } from 'astro';
import { requireRegRole } from '../../../../lib/regAccess';
import { CSV_BOM, registrationPeopleCsv } from '../../../../lib/regExport';
import type { Locale } from '../../../../lib/locales';

export const prerender = false;

// Roster CSV with one row per person (see registrationPeopleCsv). Same gate as export.csv: the event's roster
// capability ('view') is checked before any read.
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const rawId = params.id ?? '';
  if (!user || !/^\d+$/.test(rawId)) return new Response(null, { status: user ? 404 : 403 });
  const eventId = Number(rawId);
  const role = await requireRegRole(locals.db, user, eventId, 'view');
  if (!role.ok) return new Response(null, { status: role.status });

  const csv = await registrationPeopleCsv(locals.db, (user.lang ?? 'en') as Locale, eventId);
  return new Response(CSV_BOM + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="church4christ-people-${eventId}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
