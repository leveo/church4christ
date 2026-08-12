import type { APIRoute } from 'astro';
import { todayInTz } from '../../../../../lib/dates';
import { transformPeopleImportMapping } from '../../../../../lib/peopleImportMapping';
import { getPeopleImportMapping } from '../../../../../lib/peopleImportMappingDb';
import { preflightPeopleImport, type PeopleImportPreflightResult } from '../../../../../lib/peopleImportDb';
import { canManagePeopleImport, peopleImportJson } from '../../../../../lib/peopleImportHttp';
import {
  mappingProfileId,
  peopleImportMappingErrorResponse,
  peopleImportMappingPreviewResponseDto,
  peopleImportMappingProfileContract,
  readPeopleImportMappingMultipart,
} from '../../../../../lib/peopleImportMappingHttp';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') return peopleImportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleImportJson(403, { ok: false, code: 'forbidden' });

  try {
    const upload = await readPeopleImportMappingMultipart(request, ['profile_id']);
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
    let preflight: PeopleImportPreflightResult = { errors: [], warnings: [] };
    if (
      transformed.issues.length === 0
      && transformed.validation !== null
      && transformed.validation.errors.length === 0
    ) {
      preflight = await preflightPeopleImport(locals.db, transformed.validation);
    }
    return peopleImportJson(
      200,
      peopleImportMappingPreviewResponseDto(profile, transformed, preflight),
    );
  } catch (error) {
    return peopleImportMappingErrorResponse(error);
  }
};

export const ALL: APIRoute = async () => peopleImportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'POST' },
);
