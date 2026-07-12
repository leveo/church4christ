import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { contentDispositionAttachment, getGroupFileForDownload } from '../../../../../lib/groupFiles';
import { hasAreaAccess } from '../../../../../lib/adminAreas';

export const prerender = false;

// Auth-gated R2 download for a group file (every /media/ object is public; this
// is the codebase's ONE exception). /groups is groups-module-owned and runs on
// D1 too, but group_files is Supabase-only — so the FIRST gate is the portal
// module: with it off the table does not exist and the route must 404 before any
// query. Then we fail closed on a missing user, validate the ids, and defer the
// ACL (member ∪ site-admin-with-groups-grant) to getGroupFileForDownload.
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.modules.has('portal')) return new Response('Not found', { status: 404 });

  const user = locals.user;
  if (!user) return new Response('Not found', { status: 404 });

  const rawGroupId = params.id ?? '';
  const rawFileId = params.fileId ?? '';
  if (!/^\d+$/.test(rawGroupId) || !/^\d+$/.test(rawFileId)) return new Response('Not found', { status: 404 });
  const groupId = Number(rawGroupId);
  const fileId = Number(rawFileId);

  const isAdmin = hasAreaAccess(user, 'groups');
  const row = await getGroupFileForDownload(locals.db, { fileId, groupId, personId: user.id, isAdmin });
  if (!row) return new Response('Not found', { status: 404 });

  const object = await (env as { MEDIA: R2Bucket }).MEDIA.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  // Headers are set EXPLICITLY from the DB row, never from R2's stored metadata,
  // and the content is always served as an attachment with nosniff — a stored
  // object can never be coerced into inline rendering in the member's browser.
  const headers = new Headers();
  headers.set('content-type', row.content_type);
  headers.set('content-disposition', contentDispositionAttachment(row.file_name));
  headers.set('cache-control', 'no-store, private');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
};
