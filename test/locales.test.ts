import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  localePath,
  parseLocale,
  pathWithoutLocale,
  pickLocaleFromHeader,
} from '../src/lib/locales';

describe('locale constants', () => {
  it('exposes the 12 supported languages with en as the default', () => {
    expect(LOCALES).toEqual(['en', 'zh', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'ms', 'id', 'vi', 'hi']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
});

describe('parseLocale', () => {
  it('accepts known locale segments', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('zh')).toBe('zh');
  });

  it('rejects unknown / empty segments', () => {
    expect(parseLocale('xx')).toBeNull();
    expect(parseLocale('')).toBeNull();
    expect(parseLocale('EN')).toBeNull();
    expect(parseLocale('sermons')).toBeNull();
  });
});

describe('localePath', () => {
  it('prefixes every locale — all pages live under /{locale}/ (spec §6)', () => {
    expect(localePath('zh', '/sermons')).toBe('/zh/sermons');
    expect(localePath('zh', '/sermons/2026')).toBe('/zh/sermons/2026');
    expect(localePath('en', '/sermons')).toBe('/en/sermons');
    expect(localePath('en', '/about')).toBe('/en/about');
  });

  it('maps the root path to a clean localized root', () => {
    expect(localePath('zh', '/')).toBe('/zh/');
    expect(localePath('en', '/')).toBe('/en/');
  });
});

describe('pathWithoutLocale', () => {
  it('strips a leading locale segment', () => {
    expect(pathWithoutLocale('/zh/sermons/2026')).toEqual({ locale: 'zh', rest: '/sermons/2026' });
    expect(pathWithoutLocale('/en/sermons')).toEqual({ locale: 'en', rest: '/sermons' });
    expect(pathWithoutLocale('/en/about')).toEqual({ locale: 'en', rest: '/about' });
  });

  it('treats a bare locale segment as the localized root', () => {
    expect(pathWithoutLocale('/zh')).toEqual({ locale: 'zh', rest: '/' });
    expect(pathWithoutLocale('/zh/')).toEqual({ locale: 'zh', rest: '/' });
  });

  it('returns locale:null when there is no locale prefix', () => {
    expect(pathWithoutLocale('/media/x')).toEqual({ locale: null, rest: '/media/x' });
    expect(pathWithoutLocale('/')).toEqual({ locale: null, rest: '/' });
    expect(pathWithoutLocale('/sermons')).toEqual({ locale: null, rest: '/sermons' });
  });
});

describe('pickLocaleFromHeader', () => {
  it('picks the highest-q language that maps to a known locale', () => {
    expect(pickLocaleFromHeader('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(pickLocaleFromHeader('en-US,en;q=0.9')).toBe('en');
    expect(pickLocaleFromHeader('en;q=0.8,zh;q=0.9')).toBe('zh');
  });

  it('maps every Chinese variant to zh', () => {
    expect(pickLocaleFromHeader('zh')).toBe('zh');
    expect(pickLocaleFromHeader('zh-CN')).toBe('zh');
    expect(pickLocaleFromHeader('zh-Hans')).toBe('zh');
    expect(pickLocaleFromHeader('zh-TW')).toBe('zh');
  });

  it('defaults to en for wildcard, unknown, or missing headers', () => {
    expect(pickLocaleFromHeader('*')).toBe('en');
    expect(pickLocaleFromHeader('sw-KE,th;q=0.8')).toBe('en');
    expect(pickLocaleFromHeader('')).toBe('en');
    expect(pickLocaleFromHeader(null)).toBe('en');
  });
});

import {
  FALLBACK_LOCALE,
  LOCALE_COOKIE,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALES,
  fallbackChain,
  isChinese,
  isSupportedLocale,
  localeMeta,
  negotiateLocale,
  pickPair,
} from '../src/lib/locales';

describe('locale registry', () => {
  it('describes every language with BCP-47, hreflang, Intl and script metadata', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'zh', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'ms', 'id', 'vi', 'hi']);
    expect(LOCALE_REGISTRY.pt).toMatchObject({ bcp47: 'pt-BR', hreflang: 'pt-BR', intl: 'pt-BR', ogLocale: 'pt_BR', script: 'latin' });
    expect(LOCALE_REGISTRY.ja).toMatchObject({ script: 'kana', cjk: true });
    expect(LOCALE_REGISTRY.ko).toMatchObject({ script: 'hangul', cjk: true });
    expect(LOCALE_REGISTRY.hi).toMatchObject({ script: 'devanagari', cjk: false });
    expect(LOCALE_REGISTRY.en).toMatchObject({ bcp47: 'en', hreflang: 'en', intl: 'en-US', script: 'latin', cjk: false });
    expect(LOCALE_REGISTRY.zh).toMatchObject({ bcp47: 'zh-Hans', hreflang: 'zh-Hans', intl: 'zh-CN', script: 'han', cjk: true });
    for (const code of SUPPORTED_LOCALES) {
      expect(LOCALE_REGISTRY[code].code).toBe(code);
      expect(LOCALE_REGISTRY[code].nativeName.length).toBeGreaterThan(0);
    }
  });

  it('narrows unknown codes without throwing', () => {
    expect(isSupportedLocale('zh')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(true);
    expect(isSupportedLocale('xx')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(localeMeta('xx').code).toBe(FALLBACK_LOCALE);
    expect(isChinese('zh')).toBe(true);
    expect(isChinese('en')).toBe(false);
  });
});

describe('fallbackChain', () => {
  it('walks requested, then default, then en without duplicates', () => {
    expect(fallbackChain('zh', 'en')).toEqual(['zh', 'en']);
    expect(fallbackChain('en', 'en')).toEqual(['en']);
    expect(fallbackChain('en', 'zh')).toEqual(['en', 'zh']);
    expect(fallbackChain('zh', 'zh')).toEqual(['zh', 'en']);
  });

  it('drops unsupported codes and always ends in en', () => {
    expect(fallbackChain('xx', 'zh')).toEqual(['zh', 'en']);
    expect(fallbackChain('xx', 'yy')).toEqual(['en']);
    expect(fallbackChain('fr', 'zh')).toEqual(['fr', 'zh', 'en']);
  });
});

describe('pickPair', () => {
  it('prefers zh for zh readers and en for everyone else, each falling back to the other', () => {
    expect(pickPair('zh', 'Hello', '你好')).toBe('你好');
    expect(pickPair('zh', 'Hello', '')).toBe('Hello');
    expect(pickPair('en', 'Hello', '你好')).toBe('Hello');
    expect(pickPair('en', '', '你好')).toBe('你好');
    expect(pickPair('en', null, undefined)).toBe('');
    expect(pickPair('xx', 'Hello', '你好')).toBe('Hello');
  });
});

describe('negotiateLocale', () => {
  const both = ['en', 'zh'] as const;
  it('prefers a valid cookie over Accept-Language', () => {
    expect(negotiateLocale({ cookie: 'zh', acceptLanguage: 'en-US' }, both, 'en')).toBe('zh');
    expect(LOCALE_COOKIE).toBe('c4c_locale');
  });
  it('ignores a cookie for a disabled or unknown locale', () => {
    expect(negotiateLocale({ cookie: 'zh', acceptLanguage: 'zh-CN' }, ['en'], 'en')).toBe('en');
    expect(negotiateLocale({ cookie: 'xx', acceptLanguage: 'zh-CN' }, both, 'en')).toBe('zh');
  });
  it('matches Accept-Language over the enabled set only, else the default', () => {
    expect(negotiateLocale({ acceptLanguage: 'zh-TW,zh;q=0.9' }, both, 'en')).toBe('zh');
    expect(negotiateLocale({ acceptLanguage: 'zh-TW' }, ['en'], 'en')).toBe('en');
    expect(negotiateLocale({ acceptLanguage: 'fr' }, both, 'zh')).toBe('zh');
    expect(negotiateLocale({ acceptLanguage: null }, both, 'zh')).toBe('zh');
  });
});
