const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the 11-char YouTube video id from any common URL form, or from a bare id. */
export function extractYouTubeId(input: string): string | null {
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'm.youtube.com') {
    const v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = url.pathname.match(/^\/(?:embed|live|shorts|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}
