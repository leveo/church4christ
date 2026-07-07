import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import type { MediaBucket } from '../src/lib/mediaUpload';
import { saveImageUpload, uploadErrorKey } from '../src/lib/mediaUpload';
import { uploadKey } from '../src/lib/upload';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

interface StoredMediaObject {
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

type TestMediaBucket = MediaBucket & {
  get(key: string): Promise<StoredMediaObject | null>;
};

const testEnv = env as unknown as { DB: AppDb; MEDIA: TestMediaBucket };
const media = testEnv.MEDIA;

describe('saveImageUpload', () => {
  it('stores a valid image in R2 and registers media metadata', async () => {
    const file = new File([pngBytes], 'Tiny Hero.PNG', { type: 'image/png' });
    const key = await saveImageUpload({
      db: testEnv.DB,
      media,
      file,
      uploadedBy: 'admin@example.com',
    });

    expect(key).toBe(await uploadKey(pngBytes.buffer as ArrayBuffer, 'Tiny Hero.PNG'));
    const object = await media.get(key);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pngBytes);
    const row = await testEnv.DB.prepare('SELECT filename, content_type, size, uploaded_by FROM media WHERE r2_key = ?')
      .bind(key)
      .first<{ filename: string; content_type: string; size: number; uploaded_by: string }>();
    expect(row).toEqual({ filename: 'Tiny Hero.PNG', content_type: 'image/png', size: pngBytes.length, uploaded_by: 'admin@example.com' });
  });

  it('rejects unsupported image types', async () => {
    await expect(saveImageUpload({
      db: testEnv.DB,
      media,
      file: new File(['x'], 'x.svg', { type: 'image/svg+xml' }),
      uploadedBy: 'admin@example.com',
    })).rejects.toThrow('image_type');
  });
});

describe('uploadErrorKey', () => {
  it('maps image type errors to the localized image type key', () => {
    expect(uploadErrorKey(new Error('image_type'))).toBe('errors.imageType');
  });

  it('maps image size errors to the localized size key', () => {
    expect(uploadErrorKey(new Error('image_too_large'))).toBe('errors.imageTooLarge');
  });

  it('falls back to the generic bad request key for unknown errors', () => {
    expect(uploadErrorKey(new Error('weird'))).toBe('admin.form.badRequest');
  });
});
