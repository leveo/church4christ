import type { APIRoute } from 'astro';
import { hasAreaAccess } from '../../../lib/adminAreas';
import { todayInTz } from '../../../lib/dates';
import {
  ServiceAttendanceConflictError,
  ServiceAttendanceInvalidError,
  ServiceAttendancePersistenceError,
  replaceServiceCheckinLinksToday,
} from '../../../lib/serviceAttendanceDb';
import { parseServiceCheckinLinkForm } from '../../../lib/serviceAttendanceForms';

export const prerender = false;

const SAFE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function redirect(code: 'saved' | 'error', value: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: `/admin/attendance?${code}=${encodeURIComponent(value)}` },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.modules.has('attendance')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
  const user = locals.user;
  if (!hasAreaAccess(user, 'attendance')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
  if (!locals.modules.has('children')) return new Response(null, { status: 404, headers: SAFE_HEADERS });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect('error', 'attendance_invalid');
  }
  if (form.getAll('service_type_id').length !== 1) return redirect('error', 'attendance_invalid');
  const parsed = parseServiceCheckinLinkForm(form);
  if (!parsed.ok) return redirect('error', 'attendance_invalid');

  try {
    await replaceServiceCheckinLinksToday(
      locals.db,
      parsed.data.serviceTypeId,
      parsed.data.eventIds,
      todayInTz(),
      user!.id,
    );
    return redirect('saved', 'links');
  } catch (error) {
    if (
      error instanceof ServiceAttendanceInvalidError
      || error instanceof ServiceAttendanceConflictError
      || error instanceof ServiceAttendancePersistenceError
    ) return redirect('error', error.code);
    return redirect('error', 'attendance_failed');
  }
};

export const ALL: APIRoute = async () => new Response(null, {
  status: 405,
  headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
