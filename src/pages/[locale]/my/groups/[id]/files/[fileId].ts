import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { contentDispositionAttachment, getGroupFileForDownload } from '../../../../../../lib/groupFiles';

export const prerender = false;

// The codebase's FIRST auth-gated R2 download route (every /media/ object is
// public). Route policy already classes /my/* as `authed` and /my/groups as
// portal-module-owned (routePolicy.ts + modules gating), so an anonymous or
// module-off request never reaches here; we still fail closed on a missing user.
//
// Permission: this is a READ-ONLY route. The spec's §Permission model grants
// church admins view/download of group files, so we pass the real `isAdmin` flag
// to the ACL. That deliberately diverges from the portal's "admin authority never
// flows through /my" rule — which governs MUTATIONS (create/delete). Nothing here
// writes; a church admin downloading a group file is exactly the intended grant.
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Not found', { status: 404 });

  const rawGroupId = params.id ?? '';
  const rawFileId = params.fileId ?? '';
  if (!/^\d+$/.test(rawGroupId) || !/^\d+$/.test(rawFileId)) return new Response('Not found', { status: 404 });
  const groupId = Number(rawGroupId);
  const fileId = Number(rawFileId);

  const row = await getGroupFileForDownload(locals.db, { fileId, groupId, personId: user.id, isAdmin: user.isAdmin });
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
