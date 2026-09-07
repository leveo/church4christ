import { describe, expect, it } from 'vitest';
import { t } from '../../src/lib/i18n';
import { get, post } from '../e2e/helpers';

// Portal is enabled by the real PG seed. Exercise the built Worker here;
// D1 deliberately stops these requests at its unavailable-module gate.
describe('Postgres retired email-change presentation', () => {
  it.each(['en', 'zh'] as const)('keeps the retired %s email-change route expired on GET and POST', async (locale) => {
    for (const response of [
      await get('/email-change/unknown-presentation-token', { 'accept-language': locale }),
      await post('/email-change/unknown-presentation-token', '', { 'accept-language': locale }),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).toContain(t(locale, 'portal.emailChange.error.title'));
      expect(html).not.toContain(t(locale === 'en' ? 'zh' : 'en', 'portal.emailChange.error.title'));
      expect(html).not.toContain(t(locale, 'portal.emailChange.confirm.title'));
      expect(html).not.toContain('<form');
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain('property="og:url"');
      expect(html).toContain(`href="/${locale}/signin"`);
    }
  });

});
