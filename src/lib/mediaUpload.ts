import type { AppDb } from './appDb';
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, registerMedia, uploadKey } from './upload';

export interface MediaBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export interface SaveImageUploadInput {
  db: AppDb;
  media: MediaBucket;
  file: File;
  uploadedBy: string | null;
}

export async function saveImageUpload(input: SaveImageUploadInput): Promise<string> {
  const { db, media, file, uploadedBy } = input;
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) throw new Error('image_type');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image_too_large');
  const bytes = await file.arrayBuffer();
  const key = await uploadKey(bytes, file.name);
  await media.put(key, bytes, { httpMetadata: { contentType: file.type } });
  await registerMedia(db, { r2Key: key, filename: file.name, contentType: file.type, size: file.size, uploadedBy });
  return key;
}

export function uploadErrorKey(e: unknown): string {
  if (e instanceof Error && e.message === 'image_type') return 'errors.imageType';
  if (e instanceof Error && e.message === 'image_too_large') return 'errors.imageTooLarge';
  return 'admin.form.badRequest';
}
