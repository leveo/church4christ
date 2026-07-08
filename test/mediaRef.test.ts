import { describe, expect, it } from 'vitest';
import { mediaPath, normalizeAvatarUrl } from '../src/lib/mediaRef';

describe('mediaRef', () => {
  it('turns upload keys into public media URLs', () => {
    expect(mediaPath('uploads/abc123-photo.webp')).toBe('/media/uploads/abc123-photo.webp');
    expect(mediaPath('/media/uploads/abc123-photo.webp')).toBe('/media/uploads/abc123-photo.webp');
    expect(mediaPath(null)).toBeNull();
  });

  it('keeps absolute avatar URLs but normalizes upload keys', () => {
    expect(normalizeAvatarUrl('uploads/abc123-person.webp')).toBe('/media/uploads/abc123-person.webp');
    expect(normalizeAvatarUrl('/media/uploads/abc123-person.webp')).toBe('/media/uploads/abc123-person.webp');
    expect(normalizeAvatarUrl('https://cdn.example/avatar.png')).toBe('https://cdn.example/avatar.png');
    expect(normalizeAvatarUrl('')).toBeNull();
  });
});
