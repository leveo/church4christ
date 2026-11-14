import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { LOCALE_REGISTRY, SUPPORTED_LOCALES } from '../../../src/lib/locales';
import { SUPPORTED_LOCALE_CODES, SUPPORTED_LOCALES as SCRIPT_LOCALES, normalizeLocaleAnswers } from '../../../scripts/setup/locales.mjs';
import { parseSetupArgs } from '../../../scripts/setup/args.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';
import { buildSetupRerunCommand } from '../../../scripts/setup/failure.mjs';
import { defaultPreferences, normalizePreferences } from '../../../scripts/onboard/preferences.mjs';
import { mergePreferenceAnswers, onboardingSettings } from '../../../scripts/setup/onboarding.mjs';

const base = ['--mode', 'local', '--preset', 'website', '--site-slug', 'grace', '--church-name', 'Grace', '--admin-email', 'a@example.test', '--admin-name', 'Admin'];
const answers = (flags: string[]) => parseSetupArgs([...base, ...flags], catalog) as Record<string, any>;

describe('registry parity with setup scripts', () => {
  it('config/locales.json mirrors the runtime registry codes and native names', () => {
    expect(SUPPORTED_LOCALE_CODES).toEqual([...SUPPORTED_LOCALES]);
    for (const entry of SCRIPT_LOCALES) expect(entry.nativeName).toBe(LOCALE_REGISTRY[entry.code as 'en' | 'zh'].nativeName);
    expect(JSON.parse(readFileSync('config/locales.json', 'utf8')).defaultLocale).toBe('en');
  });
});

describe('--locales / --default-locale / --locale', () => {
  it('accepts a list; the first listed language is the default', () => {
    expect(answers(['--locales', 'zh,en'])).toMatchObject({ locale: 'zh', locales: ['en', 'zh'] });
    expect(answers(['--locales', 'en,zh', '--default-locale', 'zh'])).toMatchObject({ locale: 'zh', locales: ['en', 'zh'] });
  });

  it('keeps --locale x meaning en+zh enabled with x as the default (pre-registry behavior)', () => {
    const alias = answers(['--locale', 'zh']);
    expect(alias.locale).toBe('zh');
    expect(alias.locales).toBeUndefined();
    const plan = buildSetupPlan({ ...alias, locale: 'zh' }, catalog);
    expect(plan.site.locale).toBe('zh');
    expect(plan.site.locales).toBeUndefined(); // derived: en+zh
    expect(answers(['--default-locale', 'zh'])).toMatchObject({ locale: 'zh' });
    expect(answers(['--default-locale', 'zh']).locales).toBeUndefined();
    const explicit = buildSetupPlan(answers(['--locales', 'zh', '--default-locale', 'zh']), catalog);
    expect(explicit.site).toMatchObject({ locale: 'zh', locales: ['zh'] });
  });

  it('lets --locales win and uses --locale as the default when both are given', () => {
    expect(answers(['--locale', 'zh', '--locales', 'en,zh'])).toMatchObject({ locale: 'zh', locales: ['en', 'zh'] });
    expect(answers(['--locale', 'en', '--locales', 'en'])).toMatchObject({ locale: 'en', locales: ['en'] });
  });

  it('rejects unsupported languages, a default outside the list, and mixed forms', () => {
    expect(() => answers(['--locales', 'en,fr'])).toThrow(/unsupported languages: fr/);
    expect(() => answers(['--locale', 'fr'])).toThrow(/locale must be one of/);
    expect(() => answers(['--locales', 'en', '--default-locale', 'zh'])).toThrow(/one of the enabled/);
    expect(() => answers(['--locale', 'en', '--locales', 'zh'])).toThrow(/must be one of the enabled/);
    expect(() => answers(['--locale', 'en', '--default-locale', 'zh'])).toThrow(/different --default-locale/);
  });

  it('writes locale.enabled and locale.default for onboarding installs', () => {
    const prefs = normalizePreferences({ ...defaultPreferences(catalog), organization: { type: 'church', name: 'Grace', tagline: '', address: '', timezone: 'UTC' },
      setup: { ...defaultPreferences(catalog).setup, siteSlug: 'grace', adminName: 'A', adminEmail: 'a@example.test', locales: ['en', 'zh'], defaultLocale: 'zh' } }, catalog);
    const merged = mergePreferenceAnswers(parseSetupArgs(['--preferences', 'p.json'], catalog) as any, prefs, catalog);
    const plan: any = { ...buildSetupPlan(merged, catalog), onboarding: { organization: { tagline: '', address: '' } } };
    expect(plan.site).toMatchObject({ locale: 'zh', locales: ['en', 'zh'] });
    expect(onboardingSettings(plan)).toMatchObject({ 'locale.enabled': '["en","zh"]', 'locale.default': 'zh' });
  });

  it('prints recovery commands that repeat the language choice', () => {
    const multi = buildSetupPlan(answers(['--locales', 'en,zh', '--default-locale', 'zh']), catalog);
    expect(buildSetupRerunCommand(multi)).toContain("--locales 'en,zh' --default-locale 'zh'");
    const single = buildSetupPlan({ ...answers(['--locale', 'en']), locale: 'en' }, catalog);
    expect(buildSetupRerunCommand(single)).toContain("--locale 'en'");
  });

  it('normalizeLocaleAnswers is idempotent on its own output', () => {
    const once = normalizeLocaleAnswers({ locales: 'zh,en', defaultLocale: 'zh' });
    expect(normalizeLocaleAnswers({ locale: once.defaultLocale, locales: once.locales })).toMatchObject({ locales: ['en', 'zh'], defaultLocale: 'zh' });
  });
});

describe('onboarding preferences v1 -> v2', () => {
  const v1 = (locale: string) => ({
    schemaVersion: 1,
    organization: { type: 'church', name: 'Grace', tagline: '', address: '', timezone: 'UTC' },
    branding: { primaryColor: '#183D35', secondaryColor: '#C29A5B', logo: null },
    setup: { siteSlug: 'grace', locale, adminName: 'A', adminEmail: 'a@example.test', demoData: false, modules: ['events'] },
  });

  it('reads a v1 file as en+zh enabled with its old locale as the default and saves it as v2', () => {
    const upgraded = normalizePreferences(v1('zh'), catalog);
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.setup).toMatchObject({ locales: ['en', 'zh'], defaultLocale: 'zh' });
    expect(upgraded.setup).not.toHaveProperty('locale');
    expect(normalizePreferences(JSON.parse(JSON.stringify(upgraded)), catalog)).toEqual(upgraded);
  });

  it('validates v2 languages and defaults new preferences to the legacy pair', () => {
    expect(defaultPreferences(catalog).setup).toMatchObject({ locales: ['en', 'zh'], defaultLocale: 'en' });
    const bad = (setup: Record<string, unknown>) => () => normalizePreferences({ ...v1('en'), schemaVersion: 2, setup: { ...v1('en').setup, locale: undefined, ...setup } }, catalog);
    expect(bad({ locales: ['en'], defaultLocale: 'en' })).not.toThrow();
    expect(bad({ locales: ['en'], defaultLocale: 'zh' })).toThrow();
    expect(bad({ locales: ['en', 'xx'], defaultLocale: 'en' })).toThrow();
    expect(bad({ locales: [], defaultLocale: 'en' })).toThrow();
    expect(bad({})).toThrow(/Languages/);
  });
});

describe('onboarding web form languages', () => {
  const app = readFileSync('scripts/onboard/web/app.js', 'utf8');
  const server = readFileSync('scripts/onboard/server.mjs', 'utf8');

  it('renders a registry-driven multi-select with a default chosen among the checked languages', () => {
    expect(server).toContain('locales: SUPPORTED_LOCALES');
    expect(app).toContain("input.type = 'checkbox'");
    expect(app).toContain('state.locales');
    expect(app).toContain('draft.setup.defaultLocale');
    expect(app).not.toContain("languageEn");
  });
});
