import { describe, expect, it } from 'vitest';
import fields from '../src/components/admin/LocaleFields.astro?raw';
import events from '../src/pages/admin/events/index.astro?raw';
import announcements from '../src/pages/admin/announcements/index.astro?raw';
import funds from '../src/pages/admin/giving/funds.astro?raw';
import pages from '../src/pages/admin/pages/index.astro?raw';
import registration from '../src/pages/admin/registration/index.astro?raw';
import serviceTypes from '../src/pages/admin/service-types/index.astro?raw';
import planning from '../src/pages/admin/planning/index.astro?raw';
import navigation from '../src/pages/admin/navigation/index.astro?raw';

describe('LocaleFields component source', () => {
  it('renders enabled locales with the default first and posts <name>_<code>', () => {
    expect(fields).toContain('Astro.locals.locales');
    expect(fields).toContain('[defaultLocale, ...enabled.filter');
    expect(fields).toContain('name={`${name}_${code}`}');
  });

  it('preserves disabled locales as hidden inputs so saves never delete translations', () => {
    expect(fields).toMatch(/hidden\.map\(\(code\) => <input type="hidden" name=\{`\$\{name\}_\$\{code\}`\}/);
  });

  it('is mobile friendly: 44px tabs that wrap, no horizontal overflow, never submits its radios', () => {
    expect(fields).toContain('min-height: 2.75rem');
    expect(fields).toContain('flex-wrap: wrap');
    expect(fields).not.toContain('overflow-x');
    expect(fields).toContain('form="locale-fields-ui"');
    expect(fields).not.toMatch(/\brequired\b[^\n]*\/>/);
  });
});

describe('converted editors keep their field names', () => {
  const cases: [string, string, string[]][] = [
    ['events', events, ['name="title"', 'name="blurb"']],
    ['announcements', announcements, ['name="title"']],
    ['funds', funds, ['name="name"', 'name="description"']],
    ['pages', pages, ['name="title"', 'name="body"']],
    ['registration', registration, ['name="title"', 'name="description"']],
    ['service types', serviceTypes, ['name="name"']],
    ['planning', planning, ['name="title"', 'name="location"']],
    ['navigation', navigation, ['name="label"']],
  ];
  for (const [label, source, stems] of cases) {
    it(`${label} uses LocaleFields and no side-by-side *_zh input`, () => {
      expect(source).toContain('<LocaleFields');
      for (const stem of stems) expect(source).toContain(`<LocaleFields ${stem}`.replace('<LocaleFields name', '<LocaleFields name'));
      expect(source).not.toMatch(/<(input|textarea) name="\w+_zh"/);
    });
  }
});
