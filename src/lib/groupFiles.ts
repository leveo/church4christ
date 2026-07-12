// Group file storage (Member Portal Phase 2, Task 4) — the codebase's FIRST
// auth-gated R2 route lives on top of this lib (every other media route is
// public). A sibling of upload.ts/mediaUpload.ts, but deliberately different:
//   - NOT content-addressed. Keys are random (crypto), so re-uploading the same
//     bytes never reuses an object across groups — that would both dedupe and
//     LEAK "this exact file already exists in some group" to any uploader.
//   - Writes group_files (Supabase-only, migrations-supabase/0009), not media.
//   - Allows document types (pdf/office/txt/md), not just images.
// The download route enforces the ACL via getGroupFileForDownload; this lib holds
// the validation, storage, ACL query, soft-delete, and listing.
import type { AppDb } from './appDb';
import { isGroupMember } from './groupDb';

/**
 * The R2 seam this lib needs: `put` (store bytes with a content-type) and
 * `delete` (best-effort cleanup on soft-delete). A real R2Bucket satisfies it
 * structurally; the download route reads via `MEDIA.get` directly.
 */
export interface GroupFileBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

// Extension → the exact MIME(s) that extension is allowed to carry. Validation
// requires BOTH the extension AND file.type to appear here together, so a
// mislabelled upload (a .pdf claiming text/html, an .exe claiming application/pdf,
// or ANY application/octet-stream — even with an allowed extension) is rejected.
// txt/md accept only text/* variants a browser realistically sends; octet-stream
// is never accepted. SVG is intentionally absent (scriptable).
const EXT_MIME: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
};

export const ALLOWED_GROUP_FILE_EXTS: string[] = Object.keys(EXT_MIME);
export const MAX_GROUP_FILE_BYTES = 20 * 1024 * 1024;

export interface GroupFileRow {
  id: number;
  group_id: number;
  uploaded_by: number;
  file_name: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

/**
 * The lowercased final extension of a filename, alphanumerics only (so a stray
 * "pdf " or "p.df" never sneaks past the allowlist). Derived from the ORIGINAL
 * name, NOT upload.ts's sanitizeFilename: that sanitizer strips the dot on an
 * all-unicode basename (e.g. "夏令營.pdf" → "pdf" with no dot), which would
 * misclassify a legitimate file as extension-less. The double-extension case
 * (invoice.pdf.exe) is caught correctly here — the FINAL segment ("exe") is what
 * gets validated.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Random, group-scoped R2 key: `group-files/<groupId>/<32 hex>` (16 random
 *  bytes). Never derived from file content or name — see the module header. */
function groupFileKey(groupId: number): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `group-files/${groupId}/${hex}`;
}

/**
 * Validate (ext + MIME allowlist → 'file_type'; 0 bytes → 'file_empty'; over cap
 * → 'file_too_large'), store the raw bytes in R2 under a random key, insert the
 * group_files row (original filename kept verbatim so the download route's RFC
 * 5987 header can present a unicode name), and return the new row id.
 */
export async function saveGroupFile(
  db: AppDb,
  media: GroupFileBucket,
  args: { groupId: number; uploadedBy: number; file: File },
): Promise<number> {
  const { groupId, uploadedBy, file } = args;
  const ext = extensionOf(file.name);
  const allowedMimes = EXT_MIME[ext];
  if (!allowedMimes || !allowedMimes.includes(file.type)) throw new Error('file_type');
  if (file.size === 0) throw new Error('file_empty');
  if (file.size > MAX_GROUP_FILE_BYTES) throw new Error('file_too_large');

  const key = groupFileKey(groupId);
  const bytes = await file.arrayBuffer();
  await media.put(key, bytes, { httpMetadata: { contentType: file.type } });
  const row = await db
    .prepare(
      `INSERT INTO group_files (group_id, uploaded_by, file_name, r2_key, content_type, size_bytes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
    )
    .bind(groupId, uploadedBy, file.name, key, file.type, file.size)
    .first<{ id: number }>();
  return row!.id;
}

/** A group's files (non-deleted), newest first, with the uploader's display name. */
export async function listGroupFiles(db: AppDb, groupId: number): Promise<(GroupFileRow & { uploader_name: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT gf.id AS id, gf.group_id AS group_id, gf.uploaded_by AS uploaded_by, gf.file_name AS file_name,
              gf.r2_key AS r2_key, gf.content_type AS content_type, gf.size_bytes AS size_bytes, gf.created_at AS created_at,
              COALESCE(people.display_name, people.first_name || ' ' || people.last_name) AS uploader_name
       FROM group_files gf
       JOIN people ON people.id = gf.uploaded_by
       WHERE gf.group_id = ? AND gf.deleted_at IS NULL
       ORDER BY gf.created_at DESC, gf.id DESC`,
    )
    .bind(groupId)
    .all<GroupFileRow & { uploader_name: string }>();
  return results;
}

/**
 * Soft-delete a file (row scoped to id AND group_id, only if not already
 * deleted), then best-effort delete the R2 object — an R2 failure is logged, not
 * thrown, so the row still ends up soft-deleted. Returns whether a row was
 * deleted. Permission (group leader ∪ church admin) is the CALLER's contract
 * (Task 5's mutation handler), not enforced here.
 */
export async function deleteGroupFile(db: AppDb, media: GroupFileBucket, fileId: number, groupId: number): Promise<boolean> {
  const existing = await db
    .prepare(`SELECT r2_key FROM group_files WHERE id = ? AND group_id = ? AND deleted_at IS NULL`)
    .bind(fileId, groupId)
    .first<{ r2_key: string }>();
  if (!existing) return false;
  await db.prepare(`UPDATE group_files SET deleted_at = datetime('now') WHERE id = ? AND group_id = ?`).bind(fileId, groupId).run();
  try {
    await media.delete(existing.r2_key);
  } catch (e) {
    console.error('group file R2 delete failed', existing.r2_key, e);
  }
  return true;
}

/**
 * The download route's ACL gate: return the file row ONLY when it is in the
 * group named by the URL (group_id match), is not soft-deleted, AND the requester
 * is a member of that group OR a church admin. Any other case → null (a 404 at
 * the route). A mismatched groupId can never reach a file that lives in another
 * group, since the row lookup itself is scoped by group_id.
 */
export async function getGroupFileForDownload(
  db: AppDb,
  args: { fileId: number; groupId: number; personId: number; isAdmin: boolean },
): Promise<GroupFileRow | null> {
  const row = await db
    .prepare(
      `SELECT id, group_id, uploaded_by, file_name, r2_key, content_type, size_bytes, created_at
       FROM group_files WHERE id = ? AND group_id = ? AND deleted_at IS NULL`,
    )
    .bind(args.fileId, args.groupId)
    .first<GroupFileRow>();
  if (!row) return null;
  if (args.isAdmin) return row;
  return (await isGroupMember(db, args.groupId, args.personId)) ? row : null;
}

/**
 * Build a `content-disposition` header value that always forces a download
 * (never inline) and safely carries a possibly-unicode filename:
 *   - `filename*=UTF-8''<pct-encoded>` (RFC 5987) is the real name for modern UAs;
 *   - a plain `filename="<ascii>"` fallback strips every non-printable-ASCII byte
 *     plus `"`/`\`, so a crafted name can never inject a quote, backslash, CR, or
 *     LF into the header. encodeURIComponent likewise pct-encodes CR/LF/quotes in
 *     the RFC 5987 part.
 */
export function contentDispositionAttachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
