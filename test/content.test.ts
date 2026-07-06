import { describe, expect, it } from 'vitest';
import { getLocalizedFrom, listLocalizedFrom, slugOf, splitId } from '../src/lib/contentCore';

// The pure locale-resolution core is unit-tested here with plain fixtures; the
// astro:content wrapper (src/lib/content.ts) is exercised end-to-end by the
// public pages + smoke test, since astro:content cannot be imported in plain
// vitest. Fixture ids mirror the real '<locale>/<slug>' glob-loader shape.
interface Fixture {
  id: string;
}

// visit: both locales. beliefs: en only (fallback case). give: zh only (no en →
// zh caller sees it, en caller gets nothing).
const entries: Fixture[] = [
  { id: 'en/visit' },
  { id: 'zh/visit' },
  { id: 'en/beliefs' },
  { id: 'zh/give' },
];

describe('splitId / slugOf', () => {
  it('splits a locale-prefixed id into locale + slug', () => {
    expect(splitId('zh/psalms-of-ascent')).toEqual({ locale: 'zh', slug: 'psalms-of-ascent' });
  });

  it('keeps nested slugs intact (only the first segment is the locale)', () => {
    expect(splitId('en/a/b')).toEqual({ locale: 'en', slug: 'a/b' });
  });

  it('slugOf returns the slug without the locale folder', () => {
    expect(slugOf({ id: 'en/visit' })).toBe('visit');
  });
});

describe('getLocalizedFrom', () => {
  it('returns the exact locale entry with translated=true', () => {
    const r = getLocalizedFrom(entries, 'visit', 'zh');
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('zh/visit');
    expect(r!.translated).toBe(true);
  });

  it('treats an English caller matching its own entry as translated=true', () => {
    const r = getLocalizedFrom(entries, 'visit', 'en');
    expect(r!.entry.id).toBe('en/visit');
    expect(r!.translated).toBe(true);
  });

  it('falls back to the English entry with translated=false when the locale is missing', () => {
    const r = getLocalizedFrom(entries, 'beliefs', 'zh');
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe('en/beliefs');
    expect(r!.translated).toBe(false);
  });

  it('returns null when neither the locale nor the English entry exists', () => {
    // 'give' exists only in zh, so an English caller finds nothing.
    expect(getLocalizedFrom(entries, 'give', 'en')).toBeNull();
    expect(getLocalizedFrom(entries, 'nonexistent', 'zh')).toBeNull();
  });
});

describe('listLocalizedFrom', () => {
  it('dedupes to one item per slug, preferring the locale entry over its en fallback', () => {
    const list = listLocalizedFrom(entries, 'zh');
    const bySlug = new Map(list.map((i) => [i.slug, i]));

    // visit: has a zh entry → prefer it, translated.
    expect(bySlug.get('visit')!.entry.id).toBe('zh/visit');
    expect(bySlug.get('visit')!.translated).toBe(true);

    // beliefs: en only → fallback, not translated.
    expect(bySlug.get('beliefs')!.entry.id).toBe('en/beliefs');
    expect(bySlug.get('beliefs')!.translated).toBe(false);

    // give: zh only → the zh entry, translated.
    expect(bySlug.get('give')!.entry.id).toBe('zh/give');
    expect(bySlug.get('give')!.translated).toBe(true);

    // Three distinct slugs, no duplicates even though visit has two entries.
    expect(list.length).toBe(3);
    expect([...bySlug.keys()].sort()).toEqual(['beliefs', 'give', 'visit']);
  });

  it('for the en locale returns every slug as translated (en entries + zh-only fallback absent)', () => {
    const list = listLocalizedFrom(entries, 'en');
    const bySlug = new Map(list.map((i) => [i.slug, i]));

    expect(bySlug.get('visit')!.entry.id).toBe('en/visit');
    expect(bySlug.get('visit')!.translated).toBe(true);
    expect(bySlug.get('beliefs')!.entry.id).toBe('en/beliefs');
    expect(bySlug.get('beliefs')!.translated).toBe(true);
    // 'give' is zh-only → no en fallback → the en listing omits it.
    expect(bySlug.has('give')).toBe(false);
    expect(list.length).toBe(2);
  });
});
