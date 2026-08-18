import type { Locale } from './locales';

export const LEARNING_LEARNER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  'frame-src https://www.youtube-nocookie.com',
  "connect-src 'self'",
  "media-src 'none'",
].join('; ');

export function applyLearningLearnerResponseHeaders(headers: Headers): void {
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', LEARNING_LEARNER_CONTENT_SECURITY_POLICY);
}

export function formatLearningDateTime(timestamp: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

export function formatLearningFileSize(bytes: number | null, locale: Locale): string {
  if (bytes === null) return locale === 'zh' ? '大小未知' : 'Size unavailable';
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'unit',
    unit: bytes >= 1_048_576 ? 'megabyte' : 'kilobyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(bytes >= 1_048_576 ? bytes / 1_048_576 : bytes / 1_024);
}
