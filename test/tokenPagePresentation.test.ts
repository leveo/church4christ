import { describe, expect, it } from 'vitest';
import { tokenPagePresentation } from '../src/lib/tokenPagePresentation';
import authSource from '../src/pages/auth/[token].astro?raw';
import emailSource from '../src/pages/email-change/[token].astro?raw';
import attendanceSource from '../src/pages/attendance/[token].astro?raw';

const request = (language?: string) => new Request('https://church.example/auth/example', {
  headers: language ? { 'accept-language': language } : {},
});

describe('locale-free token page presentation', () => {
  it.each(['auth', 'emailChange', 'attendance'] as const)('keeps English %s copy and retry links in English', (kind) => {
    for (const state of ['confirm', 'error'] as const) {
      const page = tokenPagePresentation(request('en-US,en;q=0.9,zh;q=0.2'), kind, state, 'member@example.com');
      expect(page.locale).toBe('en');
      expect(page.title.length).toBeGreaterThan(0);
      expect(page.body.length).toBeGreaterThan(0);
      expect(`${page.title} ${page.body} ${page.action}`).not.toMatch(/\p{Script=Han}/u);
      expect(page.retryHref).toBe('/en/signin');
    }
  });

  it.each(['auth', 'emailChange', 'attendance'] as const)('uses the existing Chinese header negotiation for %s', (kind) => {
    for (const state of ['confirm', 'error'] as const) {
      const page = tokenPagePresentation(request('en;q=0.4,zh-Hant;q=0.9'), kind, state, 'member@example.com');
      expect(page.locale).toBe('zh');
      expect(page.title).toMatch(/\p{Script=Han}/u);
      expect(page.body).toMatch(/\p{Script=Han}/u);
      expect(page.retryHref).toBe('/zh/signin');
    }
  });

  it('uses the site default for missing or unsupported language preferences', () => {
    for (const language of [undefined, 'fr-FR,de;q=0.8', '*']) {
      expect(tokenPagePresentation(request(language), 'auth', 'error').locale).toBe('en');
    }
  });

  it('preserves the address displayed during email confirmation', () => {
    const address = 'member+family@example.com';
    expect(tokenPagePresentation(request('en'), 'emailChange', 'confirm', address).body).toContain(address);
    expect(tokenPagePresentation(request('zh'), 'emailChange', 'confirm', address).body).toContain(address);
  });

  it('wires each token surface to one presentation locale without stacking languages', () => {
    for (const source of [authSource, emailSource, attendanceSource]) {
      expect(source).toContain('tokenPagePresentation(Astro.request');
      expect(source).not.toContain('LOCALES.map');
      expect(source).toContain('locale={presentation.locale}');
    }
    // The valid attendance sheet continues using the verified token owner's language.
    expect(attendanceSource).toContain('locale = langOf(person?.lang)');
    expect(attendanceSource).toContain('locale={locale}');
  });
});
