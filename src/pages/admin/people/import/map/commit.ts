import type { APIRoute } from 'astro';
import { todayInTz } from '../../../../../lib/dates';
import { transformPeopleImportMapping } from '../../../../../lib/peopleImportMapping';
import { getPeopleImportMapping } from '../../../../../lib/peopleImportMappingDb';
import { commitPeopleImport, preflightPeopleImport } from '../../../../../lib/peopleImportDb';
import { canManagePeopleImport, peopleImportJson } from '../../../../../lib/peopleImportHttp';
import {
  mappingAcknowledgesWarnings,
  mappingProfileId,
  peopleImportMappingErrorResponse,
  peopleImportMappingProfileContract,
  readPeopleImportMappingMultipart,
} from '../../../../../lib/peopleImportMappingHttp';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const upload = await readPeopleImportMappingMultipart(
      request,
      ['profile_id', 'acknowledge_warnings'],
    );
    if (!upload.ok) return peopleImportJson(upload.status, { ok: false, code: upload.code });
    const id = mappingProfileId(upload.fields.profile_id);
    if (id === null) return peopleImportJson(400, { ok: false, code: 'profile_id_invalid' });
    const profile = await getPeopleImportMapping(locals.db, id);
    if (profile === null) {
      return peopleImportJson(404, { ok: false, code: 'mapping_profile_not_found' });
    }

    const transformed = transformPeopleImportMapping(
      upload.bytes,
      peopleImportMappingProfileContract(profile),
      { today: todayInTz() },
    );
    const validation = transformed.validation;
    if (transformed.issues.length > 0 || validation === null || validation.errors.length > 0) {
      return peopleImportJson(400, { ok: false, code: 'validation_failed' });
    }

    const preflight = await preflightPeopleImport(locals.db, validation);
    if (preflight.errors.length > 0) {
      return peopleImportJson(409, { ok: false, code: 'import_conflict' });
    }
    const hasWarnings = validation.warnings.length > 0 || preflight.warnings.length > 0;
    if (hasWarnings && !mappingAcknowledgesWarnings(upload.fields.acknowledge_warnings)) {
      return peopleImportJson(409, { ok: false, code: 'warnings_not_acknowledged' });
    }

    const counts = await commitPeopleImport(locals.db, locals.dbBackend, validation);
    return peopleImportJson(201, { ok: true, counts });
  } catch (error) {
    return peopleImportMappingErrorResponse(error);
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'POST' },
);
