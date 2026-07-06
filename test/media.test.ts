// Media route unit tests (workers project, live R2 binding). Ports dcfc-website's
// helper-level route tests and adds the strict-key-pattern traversal guard.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { GET } from '../src/pages/media/[...key]';

const media = (env as { MEDIA: R2Bucket }).MEDIA;

function ctx(key: string) {
  return { params: { key }, request: new Request(`https://church.example/media/${key}`) } as never;
}

describe('media route', () => {
  it('404s for a missing object under a valid key', async () => {
    expect((await GET(ctx('uploads/does-not-exist.png'))).status).toBe(404);
  });

  it('serves image media inline with the stored content type and immutable cache', async () => {
    await media.put('uploads/pic.png', 'fakepng', { httpMetadata: { contentType: 'image/png' } });
    const res = await GET(ctx('uploads/pic.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('downgrades a non-media content type to an attachment download', async () => {
    await media.put('uploads/evil.html', '<script>alert(1)</script>', { httpMetadata: { contentType: 'text/html' } });
    const res = await GET(ctx('uploads/evil.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('serves a stored SVG as an attachment, never inline (SVG can carry script)', async () => {
    await media.put('uploads/evil.svg', '<svg onload="alert(1)"/>', { httpMetadata: { contentType: 'image/svg+xml' } });
    const res = await GET(ctx('uploads/evil.svg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
  });

  it('never serves a key outside uploads/, even when the object exists', async () => {
    // The nightly D1 dump lands at backups/YYYY-MM-DD.sql in this same bucket; it
    // must never be publicly downloadable through the media route.
    await media.put('backups/2026-01-01.sql', 'SECRET DB DUMP', { httpMetadata: { contentType: 'application/sql' } });
    expect((await GET(ctx('backups/2026-01-01.sql'))).status).toBe(404);
    await media.put('config.json', '{}', { httpMetadata: { contentType: 'application/json' } });
    expect((await GET(ctx('config.json'))).status).toBe(404);
  });

  it('rejects path-traversal and malformed keys with the strict pattern', async () => {
    // An encoded "../" can survive URL normalization and arrive in params.key.
    await media.put('uploads/../backups/leak.sql', 'X', { httpMetadata: { contentType: 'text/plain' } });
    expect((await GET(ctx('uploads/../backups/leak.sql'))).status).toBe(404);
    expect((await GET(ctx('../etc/passwd'))).status).toBe(404);
    expect((await GET(ctx('uploads/'))).status).toBe(404); // no filename after the prefix
    expect((await GET(ctx(''))).status).toBe(404);
    expect((await GET(ctx('uploads/UPPER.png'))).status).toBe(404); // keys are lowercase-only
  });
});
