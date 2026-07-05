import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import { t } from '../src/lib/i18n';

const dicts = { en, zh } as const;

describe('dictionaries (parity, ported from dcfc-serve)', () => {
  it('has a non-empty string for every key in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      for (const [key, value] of Object.entries(dicts[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('en and zh cover the identical key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('uses the same {placeholders} in en and zh for every key', () => {
    const holders = (s: string) => (s.match(/\{[a-zA-Z_]+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(holders(zh[key]), `placeholders mismatch for ${key}`).toEqual(holders(en[key]));
    }
  });

  it('carries the required seed identity strings', () => {
    expect(en['site.name']).toBe('Church4Christ');
    expect(en['site.tagline']).toBe('A church for the city');
    expect(zh['site.name']).toBe('四方基督教会');
    expect(zh['site.tagline']).toBe('城市中的教会');
  });
});

describe('t()', () => {
  it('looks up a key in the requested locale', () => {
    expect(t('en', 'site.name')).toBe('Church4Christ');
    expect(t('zh', 'site.name')).toBe('四方基督教会');
    expect(t('zh', 'nav.sermons')).toBe(zh['nav.sermons']);
  });

  it('returns literal dictionary text unchanged (trusted authored copy, not escaped)', () => {
    expect(t('en', 'nav.visit')).toBe(en['nav.visit']);
  });

  it('falls back to the key itself when the key is unknown in every locale', () => {
    expect(t('en', 'totally.unknown.key')).toBe('totally.unknown.key');
    expect(t('zh', 'totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('interpolates {var} with strings and numbers', () => {
    // No seed key carries a placeholder, so the key-as-template fallback path
    // supplies the template — this exercises the interpolation branch directly.
    expect(t('en', 'Hi {name}', { name: 'Ada' })).toBe('Hi Ada');
    expect(t('en', 'Count: {n}', { n: 5 })).toBe('Count: 5');
  });

  it('leaves unmatched placeholders intact', () => {
    expect(t('en', 'Hi {name} and {other}', { name: 'Ada' })).toBe('Hi Ada and {other}');
  });

  it('HTML-escapes interpolated VALUES but never the surrounding literal text', () => {
    // 'Q&A ' is literal template text (its & must stay a bare &); the value
    // carries all five escapable characters and must be fully escaped.
    const out = t('en', 'Q&A {v}', { v: `<a href="x">&'` });
    expect(out).toBe(`Q&A &lt;a href=&quot;x&quot;&gt;&amp;&#39;`);
  });
});
