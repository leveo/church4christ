import { describe, it, expect } from 'vitest';
import { extractYouTubeId } from '../src/lib/youtube';

describe('extractYouTubeId', () => {
  it('extracts from watch URL (with extra params)', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe('dQw4w9WgXcQ');
  });
  it('extracts from a http (non-https) watch URL', () => {
    expect(extractYouTubeId('http://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('extracts from short youtu.be URL with timestamp', () => {
    expect(extractYouTubeId('https://youtu.be/M7lc1UVf-VE?t=42')).toBe('M7lc1UVf-VE');
  });
  it('extracts from embed URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/embed/ScMzIvxBSi4?rel=0')).toBe('ScMzIvxBSi4');
  });
  it('extracts from live URL', () => {
    expect(extractYouTubeId('https://youtube.com/live/x0xA4dhN8gE')).toBe('x0xA4dhN8gE');
  });
  it('extracts from shorts URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/shorts/M7lc1UVf-VE')).toBe('M7lc1UVf-VE');
  });
  it('accepts a bare 11-char id', () => {
    expect(extractYouTubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('rejects other domains and garbage', () => {
    expect(extractYouTubeId('https://example.com/notyoutube')).toBeNull();
    expect(extractYouTubeId('https://vimeo.com/12345')).toBeNull();
    expect(extractYouTubeId('short')).toBeNull();
    expect(extractYouTubeId('')).toBeNull();
  });
});
