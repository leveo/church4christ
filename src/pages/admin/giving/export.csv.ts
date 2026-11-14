import type { APIRoute } from 'astro';
import { isValidDateStr, todayInTz } from '../../../lib/dates';
import { buildGiftsCsv } from '../../../lib/givingExport';
import { listGiftsForExport } from '../../../lib/givingDb';
import { recordGivingAudit } from '../../../lib/givingAudit';

export const prerender = false;

// CSV export of the gift ledger. routePolicy classifies /admin/giving* as the
// finance route class (admin or finance); the handler re-checks defensively. The
// request database is campus-scoped, so an export never crosses campuses.
export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user || !(user.isAdmin || user.finance === 1)) return new Response('Forbidden', { status: 403 });
  if (!locals.modules.has('giving')) return new Response('Not found', { status: 404 });
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const fund = url.searchParams.get('fund') ?? '';
  const rows = await listGiftsForExport(locals.db, {
    from: isValidDateStr(from) ? from : undefined,
    to: isValidDateStr(to) ? to : undefined,
    fundId: /^\d+$/.test(fund) ? Number(fund) : undefined,
  });
  await recordGivingAudit(locals.db, { actorPersonId: user.id, action: 'gifts_exported', refId: rows.length });
  return new Response(buildGiftsCsv(rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="church4christ-gifts-${todayInTz()}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
