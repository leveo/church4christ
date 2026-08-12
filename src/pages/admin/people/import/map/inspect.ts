import type { APIRoute } from 'astro';
import { canManagePeopleImport, peopleImportJson } from '../../../../../lib/peopleImportHttp';
import {
  peopleImportMappingInspectDto,
  readPeopleImportMappingMultipart,
} from '../../../../../lib/peopleImportMappingHttp';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const upload = await readPeopleImportMappingMultipart(request, []);
    if (!upload.ok) return peopleImportJson(upload.status, { ok: false, code: upload.code });
    return peopleImportJson(200, peopleImportMappingInspectDto(upload.bytes));
  } catch {
    return peopleImportJson(500, { ok: false, code: 'generic_error' });
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'POST' },
);
