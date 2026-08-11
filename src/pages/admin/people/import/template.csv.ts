import type { APIRoute } from 'astro';
import {
  canManagePeopleImport,
  peopleImportJson,
  peopleImportTemplate,
} from '../../../../lib/peopleImportHttp';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const access = canManagePeopleImport(locals.user, locals.modules);
  if (access === 'not_found') {
    return peopleImportJson(404, { ok: false, code: 'not_found' });
  }
  if (access === 'forbidden') {
    return peopleImportJson(403, { ok: false, code: 'forbidden' });
  }

  return new Response(peopleImportTemplate(), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="church4christ-people-import.csv"',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
