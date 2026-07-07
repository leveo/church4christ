import type { APIRoute } from 'astro';
import { listServeReport } from '../../lib/adminOverviewDb';
import { csvCell } from '../../lib/csv';
import { addDays, todayInTz } from '../../lib/dates';

export const prerender = false;

// CSV export of the serving report (admin only — routePolicy gates /admin/reports*).
export const GET: APIRoute = async ({ url, locals }) => {
  const db = locals.db;
  const months = Math.min(60, Math.max(1, Number(url.searchParams.get('months')) || 12));
  const today = todayInTz();
  const rows = await listServeReport(db, addDays(today, -months * 30), today);

  const header = ['Name', 'Email', 'Confirmed', 'Upcoming', 'Declines', 'LastServed'];
  const body = rows.map((r) => [r.name, r.email, r.confirmed, r.upcoming, r.declines, r.last_served].map(csvCell).join(','));
  const csv = [header.join(','), ...body].join('\r\n') + '\r\n';

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="church4christ-serving-report-${today}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
