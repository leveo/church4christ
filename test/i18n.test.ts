import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import { t } from '../src/lib/i18n';

const dicts = { en, zh } as const;

describe('dictionaries (parity, ported from the reference stack)', () => {
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

  it('provides complete bilingual Stripe test-mode operations copy', () => {
    const keys = [
      'admin.stripe.title', 'admin.stripe.testMode', 'admin.stripe.events', 'admin.stripe.requests',
      'admin.stripe.filter', 'admin.stripe.status', 'admin.stripe.actions', 'admin.stripe.replay',
      'admin.stripe.dismiss', 'admin.stripe.reconcile', 'admin.stripe.attach', 'admin.stripe.cancel',
      'admin.stripe.confirmDismiss', 'admin.stripe.confirmCancel', 'admin.stripe.replayWarning',
      'admin.stripe.replayExpired', 'admin.stripe.rawHidden', 'admin.stripe.emptyEvents',
      'admin.stripe.emptyRequests', 'admin.stripe.resultSuccess', 'admin.stripe.resultError',
      'admin.stripe.status.pending', 'admin.stripe.status.processing', 'admin.stripe.status.processed',
      'admin.stripe.status.ignored', 'admin.stripe.status.failed', 'admin.stripe.status.dismissed',
      'admin.stripe.request.creating', 'admin.stripe.request.attached', 'admin.stripe.request.manual_review',
      'admin.stripe.allStatuses', 'admin.stripe.allRequestStates', 'admin.stripe.previous', 'admin.stripe.next',
      'admin.stripe.eventId', 'admin.stripe.eventType', 'admin.stripe.attempts', 'admin.stripe.updatedAt',
      'admin.stripe.outcome', 'admin.stripe.lastError', 'admin.stripe.requestId',
      'admin.stripe.registrationId', 'admin.stripe.sessionId', 'admin.stripe.confirmation',
      'admin.stripe.replayHelp',
      'admin.stripe.completedAt',
      'admin.stripe.ageDays',
    ] as const;
    for (const key of keys) {
      expect(en[key], `en:${key}`).toBeTruthy();
      expect(zh[key], `zh:${key}`).toBeTruthy();
    }
    expect(en['admin.stripe.testMode']).toContain('Stripe test mode');
    expect(zh['admin.stripe.testMode']).toContain('Stripe 测试模式');
    expect(`${en['admin.stripe.testMode']} ${zh['admin.stripe.testMode']}`).not.toMatch(/enable live|启用正式/i);
    expect(en['admin.people.finance']).toContain('Giving and paid Registration');
    expect(zh['admin.people.finance']).toContain('奉献和付费报名');
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
