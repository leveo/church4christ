const UPLOAD_KEY = /^uploads\/[a-z0-9][a-z0-9.-]*$/;

export function mediaPath(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.startsWith('/media/uploads/')) return v;
  if (UPLOAD_KEY.test(v)) return `/media/${v}`;
  return v;
}

export function normalizeAvatarUrl(value: string | null | undefined): string | null {
  return mediaPath(value);
}
