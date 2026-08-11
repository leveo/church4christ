import type { APIRoute } from 'astro';
import { todayInTz } from '../../../../lib/dates';
import { parsePeopleImport } from '../../../../lib/peopleImport';
import { preflightPeopleImport, type PeopleImportPreflightResult } from '../../../../lib/peopleImportDb';
import {
  canManagePeopleImport,
  peopleImportJson,
  peopleImportPreviewDto,
  readPeopleImportFile,
} from '../../../../lib/peopleImportHttp';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const upload = await readPeopleImportFile(request);
    if (!upload.ok) return peopleImportJson(upload.status, { ok: false, code: upload.code });

    const parsed = parsePeopleImport(upload.bytes, { today: todayInTz() });
    let preflight: PeopleImportPreflightResult = { errors: [], warnings: [] };
    if (parsed.model !== null && parsed.errors.length === 0) {
      preflight = await preflightPeopleImport(locals.db, parsed);
    }
    return peopleImportJson(200, peopleImportPreviewDto(parsed, preflight));
  } catch {
    return peopleImportJson(500, { ok: false, code: 'generic_error' });
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'POST' },
);
