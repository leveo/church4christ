import type { APIRoute } from 'astro';
import { todayInTz } from '../../../lib/dates';
import { buildCanonicalExportParts } from '../../../lib/peopleExport';
import { loadCanonicalPeopleExport } from '../../../lib/peopleExportDb';
import {
  handlePeopleExport,
  peopleExportJson,
  type StandardPeopleExportRuntime,
} from '../../../lib/peopleExportHttp';

export const prerender = false;

const runtime: StandardPeopleExportRuntime = {
  loadCanonical: loadCanonicalPeopleExport,
  buildCanonical: buildCanonicalExportParts,
};

export const GET: APIRoute = async ({ request, locals }) => handlePeopleExport({
  request,
  user: locals.user,
  modules: locals.modules,
  db: locals.db,
  backend: locals.dbBackend,
  today: todayInTz(),
}, runtime);

export const ALL: APIRoute = async () => peopleExportJson(
  405,
  { ok: false, code: 'method_not_allowed' },
  { Allow: 'GET' },
);
