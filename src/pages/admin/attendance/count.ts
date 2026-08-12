import type { APIRoute } from 'astro';
import { hasAreaAccess } from '../../../lib/adminAreas';
import {
  ServiceAttendanceInvalidError,
  ServiceAttendancePersistenceError,
  upsertServiceAttendance,
} from '../../../lib/serviceAttendanceDb';
import { parseAdultCountForm } from '../../../lib/serviceAttendanceForms';
import { readServiceAttendanceForm } from '../../../lib/serviceAttendanceHttp';

export const prerender = false;

const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function redirect(code: 'saved' | 'error', value: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: `/admin/attendance?${code}=${encodeURIComponent(value)}` },
  });
}

function bodyError(status: 413 | 415): Response {
  return new Response('attendance_invalid', {
    status,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.modules.has('attendance')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
  const user = locals.user;
  if (!hasAreaAccess(user, 'attendance')) return new Response(null, { status: 403, headers: SAFE_HEADERS });

  const body = await readServiceAttendanceForm(request);
  if (!body.ok) {
    if (body.reason === 'unsupported_media_type') return bodyError(415);
    if (body.reason === 'too_large') return bodyError(413);
    return redirect('error', 'attendance_invalid');
  }
  const form = body.form;
  if (
    form.getAll('service_type_id').length !== 1
    || form.getAll('attendance_date').length !== 1
    || form.getAll('adult_count').length !== 1
  ) return redirect('error', 'attendance_invalid');
  const parsed = parseAdultCountForm(form);
  if (!parsed.ok) return redirect('error', 'attendance_invalid');

  try {
    await upsertServiceAttendance(locals.db, parsed.data, user!.id);
    return redirect('saved', 'count');
  } catch (error) {
    if (error instanceof ServiceAttendanceInvalidError) return redirect('error', error.code);
    if (error instanceof ServiceAttendancePersistenceError) return redirect('error', error.code);
    return redirect('error', 'attendance_failed');
  }
};

export const ALL: APIRoute = async () => new Response(null, {
  status: 405,
  headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
