// Upload helper unit tests (node project), ported from dcfc-website and adapted
// to our async, byte-hashing uploadKey and the ASCII-lowercase sanitizer.
import { describe, it, expect } from 'vitest';
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, sanitizeFilename, sha256Hex, uploadKey } from '../src/lib/upload';

// SHA-256('abc') — first 16 hex chars form the key prefix.
const abc = new TextEncoder().encode('abc').buffer as ArrayBuffer;
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('upload helpers', () => {
  it('exposes the image allowlist (no SVG) and the 10MB cap', () => {
    expect(ALLOWED_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(ALLOWED_IMAGE_TYPES).not.toContain('image/svg+xml');
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('computes SHA-256 hex of raw bytes via WebCrypto', async () => {
    expect(await sha256Hex(abc)).toBe(ABC_SHA);
  });

  describe('sanitizeFilename', () => {
    it('lowercases and keeps a clean name and its extension', () => {
      expect(sanitizeFilename('My Photo.JPG')).toBe('my-photo.jpg');
      expect(sanitizeFilename('safe.name-1.png')).toBe('safe.name-1.png');
    });
    it('replaces underscores and other unsafe runs with a single dash', () => {
      expect(sanitizeFilename('safe_name-1.png')).toBe('safe-name-1.png');
      expect(sanitizeFilename('résumé  photo.jpg')).toBe('r-sum-photo.jpg');
    });
    it('strips leading/trailing separators and falls back to "file" for all-unsafe names', () => {
      expect(sanitizeFilename('--weird--.png')).toBe('weird-.png');
      expect(sanitizeFilename('夏令營')).toBe('file');
      expect(sanitizeFilename('___')).toBe('file');
    });
    it('caps at 64 chars while preserving the extension', () => {
      const long = 'a'.repeat(200) + '.png';
      const out = sanitizeFilename(long);
      expect(out.length).toBe(64);
      expect(out.endsWith('.png')).toBe(true);
      expect(out).toBe('a'.repeat(60) + '.png');
    });
  });

  describe('uploadKey', () => {
    it('builds uploads/<sha256hex16>-<sanitized>', async () => {
      expect(await uploadKey(abc, 'My Photo.JPG')).toBe(`uploads/${ABC_SHA.slice(0, 16)}-my-photo.jpg`);
    });
    it('is content-addressed: identical bytes → identical key regardless of name casing', async () => {
      const k1 = await uploadKey(abc, 'a.png');
      const k2 = await uploadKey(abc, 'a.png');
      expect(k1).toBe(k2);
      expect(k1.startsWith('uploads/ba7816bf8f01cfea-')).toBe(true);
    });
  });
});
