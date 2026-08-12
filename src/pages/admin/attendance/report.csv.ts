import type { APIRoute } from 'astro';
import { hasAreaAccess } from '../../../lib/adminAreas';
import { todayInTz } from '../../../lib/dates';
import {
  ServiceAttendanceInvalidError,
  ServiceAttendancePersistenceError,
  ServiceAttendanceReportLimitError,
  listServiceAttendanceReport,
} from '../../../lib/serviceAttendanceDb';
import { ServiceAttendanceCsvInvalidError, serializeServiceAttendanceCsv } from '../../../lib/serviceAttendanceCsv';
import { parseAttendanceWindow } from '../../../lib/serviceAttendanceForms';

export const prerender = false;

const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function errorResponse(status: number, code: string): Response {
  return new Response(code, {
    status,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.modules.has('attendance')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
  const user = locals.user;
  if (!hasAreaAccess(user, 'attendance')) return new Response(null, { status: 403, headers: SAFE_HEADERS });

  const today = todayInTz();
  const parsed = parseAttendanceWindow(url.searchParams, today);
  if (!parsed.ok) {
    const code = parsed.errors.from
      ?? parsed.errors.to
      ?? parsed.errors.window
      ?? 'attendance_window_invalid';
    return errorResponse(400, code);
  }

  try {
    const rows = await listServiceAttendanceReport(locals.db, user!.lang === 'zh' ? 'zh' : 'en', parsed.data);
    const csv = serializeServiceAttendanceCsv(rows);
    const bytes = new TextEncoder().encode(csv);
    return new Response(bytes, {
      headers: {
        ...SAFE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="church4christ-service-attendance-${today}.csv"`,
        'Content-Length': String(bytes.byteLength),
      },
    });
  } catch (error) {
    if (error instanceof ServiceAttendanceInvalidError) return errorResponse(400, error.code);
    if (error instanceof ServiceAttendanceReportLimitError) return errorResponse(400, error.code);
    if (error instanceof ServiceAttendanceCsvInvalidError) return errorResponse(500, error.code);
    if (error instanceof ServiceAttendancePersistenceError) return errorResponse(500, error.code);
    return errorResponse(500, 'attendance_failed');
  }
};

export const ALL: APIRoute = async () => new Response(null, {
  status: 405,
  headers: { ...SAFE_HEADERS, Allow: 'GET' },
});
