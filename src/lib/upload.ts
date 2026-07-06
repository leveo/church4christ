// Image upload helpers, ported from the reference stack and adapted to this schema.
// SVG is deliberately NOT allowed (scriptable format); the media route
// additionally refuses to serve any stored SVG inline (defense in depth).
// Keys are content-addressed (sha256 of the bytes) so re-uploading identical
// image bytes reuses the same R2 object and the media table row.
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * SHA-256 of raw bytes as lowercase hex. auth.ts already has a sha256Hex, but it
 * hashes a STRING (token values); uploads hash an ArrayBuffer, so this is a
 * separate byte-oriented helper rather than a shared one.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sanitize an uploaded filename into a safe slug: ASCII-lowercase, `[a-z0-9.-]`
 * only, collapsed dashes, no leading/trailing separators, capped at 64 chars
 * with the extension preserved. An all-unsafe name (e.g. CJK only) → 'file'.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned =
    filename
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'file';
  if (cleaned.length <= 64) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, Math.max(1, 64 - ext.length)) + ext;
}

/** Content-addressed R2 key: `uploads/<first16 hex of sha256>-<sanitized name>`. */
export async function uploadKey(bytes: ArrayBuffer, filename: string): Promise<string> {
  const hash = await sha256Hex(bytes);
  return `uploads/${hash.slice(0, 16)}-${sanitizeFilename(filename)}`;
}

export interface MediaInput {
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string | null;
}

/**
 * Record an uploaded object in the media table. Content-addressed keys mean the
 * same bytes always produce the same key, so a re-upload is a no-op rather than
 * a UNIQUE(r2_key) throw — ON CONFLICT DO NOTHING keeps the original row.
 */
export async function registerMedia(db: D1Database, m: MediaInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO media (r2_key, filename, content_type, size, uploaded_by)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(r2_key) DO NOTHING`,
    )
    .bind(m.r2Key, m.filename, m.contentType, m.size, m.uploadedBy)
    .run();
}
