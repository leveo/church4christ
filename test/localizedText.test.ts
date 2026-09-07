import { describe, expect, it } from 'vitest';
import { pickLocalizedText as pick } from '../src/lib/locales';

describe('localized authored text', () => {
  it('uses only the English field on English pages', () => {
    expect(pick({ en: 'Gatherings', zh: '聚会' }, 'en')).toBe('Gatherings');
    expect(pick({ en: '', zh: '仅中文' }, 'en')).toBe('');
    expect(pick({ en: null, zh: '仅中文' }, 'en')).toBe('');
  });

  it('preserves Chinese text and its English fallback on Chinese pages', () => {
    expect(pick({ en: 'Gatherings', zh: '聚会' }, 'zh')).toBe('聚会');
    expect(pick({ en: 'Gatherings', zh: '' }, 'zh')).toBe('Gatherings');
    expect(pick({}, 'zh')).toBe('');
  });

  it('returns authored values unchanged rather than removing characters from names', () => {
    const name = 'David Chen 陈大卫';
    expect(pick({ en: name, zh: '陈大卫' }, 'en')).toBe(name);
  });
});
