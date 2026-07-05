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
  it('exposes en + zh with en as the default', () => {
    expect(LOCALES).toEqual(['en', 'zh']);
    expect(DEFAULT_LOCALE).toBe('en');
  });
});

describe('parseLocale', () => {
  it('accepts known locale segments', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('zh')).toBe('zh');
  });

  it('rejects unknown / empty segments', () => {
    expect(parseLocale('fr')).toBeNull();
    expect(parseLocale('')).toBeNull();
    expect(parseLocale('EN')).toBeNull();
    expect(parseLocale('sermons')).toBeNull();
  });
});

describe('localePath', () => {
  it('prefixes non-default locales', () => {
    expect(localePath('zh', '/sermons')).toBe('/zh/sermons');
    expect(localePath('zh', '/sermons/2026')).toBe('/zh/sermons/2026');
  });

  it('maps the root path to a clean localized root', () => {
    expect(localePath('zh', '/')).toBe('/zh/');
    expect(localePath('en', '/')).toBe('/');
  });

  it('leaves the default locale unprefixed', () => {
    expect(localePath('en', '/sermons')).toBe('/sermons');
  });
});

describe('pathWithoutLocale', () => {
  it('strips a leading locale segment', () => {
    expect(pathWithoutLocale('/zh/sermons/2026')).toEqual({ locale: 'zh', rest: '/sermons/2026' });
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
    expect(pickLocaleFromHeader('fr-FR,de;q=0.8')).toBe('en');
    expect(pickLocaleFromHeader('')).toBe('en');
    expect(pickLocaleFromHeader(null)).toBe('en');
  });
});
