import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_KEYS } from '../src/lib/capabilityCatalog';
import { MODULE_GROUPS } from '../src/lib/modules';
import { t } from '../src/lib/i18n';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';
import settingsSource from '../src/pages/admin/settings/index.astro?raw';

const rows = CAPABILITY_KEYS.flatMap((key) => (['en', 'zh'] as const).map((locale) => ({ key, locale })));

describe('settings module presentation', () => {
  it.each(rows)('renders canonical $locale labels and descriptions for $key', ({ key, locale }) => {
    const label = t(locale, `modules.${key}.label`);
    const description = t(locale, `modules.${key}.desc`);
    expect(label).toBe(CAPABILITIES[key].labels[locale]);
    expect(description).toBe(CAPABILITIES[key].descriptions[locale]);
    expect(label.trim().length).toBeGreaterThan(0);
    expect(description.trim().length).toBeGreaterThan(0);
    expect(`${label} ${description}`).not.toMatch(/(?:admin\.)?modules\.[a-z-]+\.(?:label|desc)/);
    if (locale === 'en') expect(`${label} ${description}`).not.toMatch(/\p{Script=Han}/u);
  });

  it('provides exactly one label and description for every displayed module in both dictionaries', () => {
    expect(CAPABILITY_KEYS).toHaveLength(21);
    const displayed = MODULE_GROUPS.flatMap((group) => group.keys);
    expect([...displayed].sort()).toEqual([...CAPABILITY_KEYS].sort());
    const expected = CAPABILITY_KEYS.flatMap((key) => [`modules.${key}.label`, `modules.${key}.desc`]).sort();
    for (const dictionary of [en, zh]) {
      expect(Object.keys(dictionary).filter((key) => /^modules\..+\.(label|desc)$/.test(key)).sort()).toEqual(expected);
    }
  });

  it('uses the complete translated module namespace in the settings checkbox rows', () => {
    expect(settingsSource).toContain('t(lang, `modules.${key}.label`)');
    expect(settingsSource).toContain('t(lang, `modules.${key}.desc`)');
    expect(settingsSource).not.toContain('moduleLabelKey');
  });
});
