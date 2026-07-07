import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { saveImageUpload } from '../src/lib/mediaUpload';
import { uploadKey } from '../src/lib/upload';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

describe('saveImageUpload', () => {
  it('stores a valid image in R2 and registers media metadata', async () => {
    const file = new File([pngBytes], 'Tiny Hero.PNG', { type: 'image/png' });
    const key = await saveImageUpload({
      db: env.DB,
      media: (env as { MEDIA: R2Bucket }).MEDIA,
      file,
      uploadedBy: 'admin@example.com',
    });

    expect(key).toBe(await uploadKey(pngBytes.buffer as ArrayBuffer, 'Tiny Hero.PNG'));
    expect(await (env as { MEDIA: R2Bucket }).MEDIA.get(key)).not.toBeNull();
    const row = await env.DB.prepare('SELECT filename, content_type, size, uploaded_by FROM media WHERE r2_key = ?')
      .bind(key)
      .first<{ filename: string; content_type: string; size: number; uploaded_by: string }>();
    expect(row).toEqual({ filename: 'Tiny Hero.PNG', content_type: 'image/png', size: pngBytes.length, uploaded_by: 'admin@example.com' });
  });

  it('rejects unsupported image types', async () => {
    await expect(saveImageUpload({
      db: env.DB,
      media: (env as { MEDIA: R2Bucket }).MEDIA,
      file: new File(['x'], 'x.svg', { type: 'image/svg+xml' }),
      uploadedBy: 'admin@example.com',
    })).rejects.toThrow('image_type');
  });
});
