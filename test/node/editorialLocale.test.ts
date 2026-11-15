import { describe, expect, it } from 'vitest';
import { editorialEligible, hidesHanRows } from '../../src/lib/editorialLocale';

describe('legacy editorial eligibility', () => {
  it('hides Han-bearing rows only for Latin-script languages', () => {
    for (const code of ['en', 'es', 'pt', 'fr', 'de', 'ms', 'id', 'vi']) {
      expect(hidesHanRows(code), code).toBe(true);
      expect(editorialEligible(code, '主日崇拜'), code).toBe(false);
      expect(editorialEligible(code, 'Sunday service'), code).toBe(true);
    }
    for (const code of ['zh', 'ja', 'ko', 'hi']) {
      expect(hidesHanRows(code), code).toBe(false);
      expect(editorialEligible(code, '主日崇拜', '日曜礼拝'), code).toBe(true);
    }
  });

  it('ignores non-string values and unknown languages fall back to the English rule', () => {
    expect(editorialEligible('en', null, undefined, 3)).toBe(true);
    expect(hidesHanRows('xx')).toBe(true);
  });
});
