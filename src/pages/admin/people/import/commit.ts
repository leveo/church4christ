import type { APIRoute } from 'astro';
import { todayInTz } from '../../../../lib/dates';
import { parsePeopleImport } from '../../../../lib/peopleImport';
import { commitPeopleImport, preflightPeopleImport } from '../../../../lib/peopleImportDb';
import {
  canManagePeopleImport,
  peopleImportCommitErrorResponse,
  peopleImportJson,
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
    if (parsed.model === null || parsed.errors.length > 0) {
      return peopleImportJson(400, { ok: false, code: 'validation_failed' });
    }

    const preflight = await preflightPeopleImport(locals.db, parsed);
    if (preflight.errors.length > 0) {
      return peopleImportJson(409, { ok: false, code: 'import_conflict' });
    }
    const hasWarnings = parsed.warnings.length > 0 || preflight.warnings.length > 0;
    if (hasWarnings && !upload.acknowledgeWarnings) {
      return peopleImportJson(409, { ok: false, code: 'warnings_not_acknowledged' });
    }

    const counts = await commitPeopleImport(locals.db, locals.dbBackend, parsed);
    return peopleImportJson(201, { ok: true, counts });
  } catch (error) {
    return peopleImportCommitErrorResponse(error);
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'POST' },
);
