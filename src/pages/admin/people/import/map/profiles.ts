import type { APIRoute } from 'astro';
import { inspectPeopleImportMappingSource } from '../../../../../lib/peopleImportMapping';
import {
  createPeopleImportMapping,
  getPeopleImportMapping,
  listPeopleImportMappings,
} from '../../../../../lib/peopleImportMappingDb';
import { canManagePeopleImport, peopleImportJson } from '../../../../../lib/peopleImportHttp';
import {
  mappingConfigFromUpload,
  mappingProfileId,
  peopleImportMappingErrorResponse,
  peopleImportMappingProfileDto,
  peopleImportMappingSummaryDto,
  readPeopleImportMappingMultipart,
} from '../../../../../lib/peopleImportMappingHttp';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const suppliedIds = new URL(request.url).searchParams.getAll('id');
    if (suppliedIds.length === 0) {
      const profiles = await listPeopleImportMappings(locals.db);
      return peopleImportJson(200, {
        ok: true,
        profiles: profiles.map(peopleImportMappingSummaryDto),
      });
    }
    if (suppliedIds.length !== 1) {
      return peopleImportJson(400, { ok: false, code: 'profile_id_invalid' });
    }
    const id = mappingProfileId(suppliedIds[0]);
    if (id === null) return peopleImportJson(400, { ok: false, code: 'profile_id_invalid' });
    const profile = await getPeopleImportMapping(locals.db, id);
    if (profile === null) {
      return peopleImportJson(404, { ok: false, code: 'mapping_profile_not_found' });
    }
    return peopleImportJson(200, { ok: true, profile: peopleImportMappingProfileDto(profile) });
  } catch (error) {
    return peopleImportMappingErrorResponse(error);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const upload = await readPeopleImportMappingMultipart(request, ['profile_name', 'mapping_config']);
    if (!upload.ok) return peopleImportJson(upload.status, { ok: false, code: upload.code });
    const profileName = upload.fields.profile_name;
    if (profileName === undefined || profileName.trim() === '') {
      return peopleImportJson(400, { ok: false, code: 'profile_name_invalid' });
    }

    const inspection = inspectPeopleImportMappingSource(upload.bytes);
    if (inspection.headers === null) {
      return peopleImportJson(400, {
        ok: false,
        code: 'mapping_source_invalid',
        issues: inspection.issues.map((issue) => ({
          code: issue.code,
          row: issue.row,
          column: issue.column,
          field: issue.field,
        })),
      });
    }
    const captured = mappingConfigFromUpload(upload.fields.mapping_config, inspection.headers);
    if (captured.contract === null) {
      return peopleImportJson(400, {
        ok: false,
        code: 'mapping_config_invalid',
        issues: captured.issues,
      });
    }

    const created = await createPeopleImportMapping(locals.db, {
      name: profileName,
      expectedHeaders: captured.contract.expectedHeaders,
      fieldMappings: captured.contract.fieldMappings,
      constants: captured.contract.constants,
      enumTranslations: captured.contract.enumTranslations,
      createdByPersonId: locals.user!.id,
    });
    return peopleImportJson(201, { ok: true, profile: peopleImportMappingProfileDto(created) });
  } catch (error) {
    return peopleImportMappingErrorResponse(error);
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'GET, POST' },
);
