import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLoginToken, peekToken } from '../../src/lib/auth';
import { t } from '../../src/lib/i18n';
import { get, post } from './helpers';

describe('single-language emailed token pages', () => {
  it.each(['en', 'zh'] as const)('renders a %s sign-in confirmation without consuming the token', async (locale) => {
    const token = await createLoginToken(env.DB, 3);
    if ('rateLimited' in token) throw new Error('expected a fresh login token');
    if ('notEligible' in token) throw new Error('seed member 3 must be eligible for a login token');
    const page = await get(`/auth/${token.raw}`, { 'accept-language': locale });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(t(locale, 'auth.confirm.title'));
    expect(html).not.toContain(t(locale === 'en' ? 'zh' : 'en', 'auth.confirm.title'));
    expect(html).toContain(locale === 'en' ? 'lang="en"' : 'lang="zh-Hans"');
    expect(await peekToken(env.DB, token.raw, 'login')).not.toBeNull();
  });

  it.each(['en', 'zh'] as const)('keeps invalid %s auth GET and POST responses in one language', async (locale) => {
    for (const response of [
      await get('/auth/unknown-presentation-token', { 'accept-language': locale }),
      await post('/auth/unknown-presentation-token', '', { 'accept-language': locale }),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).toContain(t(locale, 'auth.error.title'));
      expect(html).not.toContain(t(locale === 'en' ? 'zh' : 'en', 'auth.error.title'));
      expect(html).toContain(`href="/${locale}/signin"`);
    }
  });

  it.each(['en', 'zh'] as const)('keeps retired %s email-change requests behind the D1 portal module gate', async (locale) => {
    // Portal is unavailable on D1. The public module gate must run before the
    // retired route renderer, including on POST; locale rendering lives in PG.
    for (const response of [
      await get('/email-change/unknown-presentation-token', { 'accept-language': locale }),
      await post('/email-change/unknown-presentation-token', '', { 'accept-language': locale }),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).not.toContain(t(locale, 'portal.emailChange.confirm.title'));
      expect(html).not.toContain('<form');
    }
  });

  it.each(['en', 'zh'] as const)('localizes an invalid %s attendance token without revealing event details', async (locale) => {
    const response = await get('/attendance/unknown-presentation-token', { 'accept-language': locale });
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain(t(locale, 'attendance.invalid.title'));
    expect(html).not.toContain(t(locale === 'en' ? 'zh' : 'en', 'attendance.invalid.title'));
    expect(html).not.toContain('name="member"');
    expect(html).not.toContain('name="token"');
  });
});
