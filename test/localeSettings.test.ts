import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_LOCALE_SETTINGS,
  clearLocaleSettingsCache,
  getLocaleSettings,
  parseLocaleSettings,
  saveLocaleSettings,
  validateLocaleSettings,
} from '../src/lib/localeSettings';
import { getRuntimeDefaultLocale, setRuntimeDefaultLocale } from '../src/lib/locales';
import { setSetting } from '../src/lib/settings';
import { parseSettingsForm } from '../src/lib/validate';

const db = env.DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM settings WHERE key LIKE 'locale.%'").run();
  clearLocaleSettingsCache();
  setRuntimeDefaultLocale('en');
});

describe('parseLocaleSettings (upgrade safety)', () => {
  it('treats an absent locale.enabled row as legacy en+zh with default en', () => {
    expect(parseLocaleSettings({})).toEqual(LEGACY_LOCALE_SETTINGS);
    expect(LEGACY_LOCALE_SETTINGS).toEqual({ enabled: ['en', 'zh'], default: 'en' });
  });

  it('ignores a legacy locale.default row while locale.enabled is absent', () => {
    expect(parseLocaleSettings({ 'locale.default': 'zh' })).toEqual({ enabled: ['en', 'zh'], default: 'en' });
  });

  it('uses locale.default once locale.enabled exists', () => {
    expect(parseLocaleSettings({ 'locale.enabled': '["en","zh"]', 'locale.default': 'zh' })).toEqual({ enabled: ['en', 'zh'], default: 'zh' });
  });

  it('falls back safely on malformed or empty values', () => {
    expect(parseLocaleSettings({ 'locale.enabled': 'nope' })).toEqual(LEGACY_LOCALE_SETTINGS);
    expect(parseLocaleSettings({ 'locale.enabled': '{}' })).toEqual(LEGACY_LOCALE_SETTINGS);
    expect(parseLocaleSettings({ 'locale.enabled': '[]' })).toEqual(LEGACY_LOCALE_SETTINGS);
    expect(parseLocaleSettings({ 'locale.enabled': '["xx"]' })).toEqual(LEGACY_LOCALE_SETTINGS);
  });

  it('drops unknown codes, orders by registry, and repairs a default outside the enabled set', () => {
    expect(parseLocaleSettings({ 'locale.enabled': '["zh","xx"]', 'locale.default': 'en' })).toEqual({ enabled: ['zh'], default: 'zh' });
    expect(parseLocaleSettings({ 'locale.enabled': '["zh","en"]' })).toEqual({ enabled: ['en', 'zh'], default: 'en' });
  });
});

describe('validateLocaleSettings', () => {
  it('requires a non-empty supported subset containing the default', () => {
    expect(validateLocaleSettings(['zh', 'en'], 'zh')).toEqual({ ok: true, value: { enabled: ['en', 'zh'], default: 'zh' } });
    expect(validateLocaleSettings([], 'en')).toEqual({ ok: false, error: 'locale_none_enabled' });
    expect(validateLocaleSettings(['en', 'xx'], 'en')).toEqual({ ok: false, error: 'locale_unsupported' });
    expect(validateLocaleSettings(['en'], 'zh')).toEqual({ ok: false, error: 'locale_default_not_enabled' });
    expect(validateLocaleSettings(['en'], 'xx')).toEqual({ ok: false, error: 'locale_default_not_enabled' });
  });
});

describe('getLocaleSettings / saveLocaleSettings', () => {
  it('reads legacy defaults from an empty settings table', async () => {
    expect(await getLocaleSettings(db)).toEqual(LEGACY_LOCALE_SETTINGS);
  });

  it('keeps default en for an upgraded install carrying an old locale.default row', async () => {
    await setSetting(db, 'locale.default', 'zh');
    expect((await getLocaleSettings(db)).default).toBe('en');
    expect(getRuntimeDefaultLocale()).toBe('en');
  });

  it('persists both rows, clears the memo, and publishes the runtime default', async () => {
    await getLocaleSettings(db); // prime the memo
    const saved = await saveLocaleSettings(db, ['zh', 'en'], 'zh');
    expect(saved.ok).toBe(true);
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'locale.%' ORDER BY key").all<{ key: string; value: string }>();
    expect(rows.results).toEqual([
      { key: 'locale.default', value: 'zh' },
      { key: 'locale.enabled', value: '["en","zh"]' },
    ]);
    expect(await getLocaleSettings(db)).toEqual({ enabled: ['en', 'zh'], default: 'zh' });
    expect(getRuntimeDefaultLocale()).toBe('zh');
  });

  it('refuses an invalid save without writing', async () => {
    expect((await saveLocaleSettings(db, ['en'], 'zh')).ok).toBe(false);
    expect((await saveLocaleSettings(db, [], 'en')).ok).toBe(false);
    const rows = await db.prepare("SELECT key FROM settings WHERE key LIKE 'locale.%'").all();
    expect(rows.results).toEqual([]);
  });

  it('memoizes reads for 60 seconds per isolate', async () => {
    const t0 = 1_000_000;
    await saveLocaleSettings(db, ['en', 'zh'], 'en');
    expect((await getLocaleSettings(db, t0)).default).toBe('en');
    await db.prepare("UPDATE settings SET value = 'zh' WHERE key = 'locale.default'").run();
    expect((await getLocaleSettings(db, t0 + 59_000)).default).toBe('en');
    expect((await getLocaleSettings(db, t0 + 61_000)).default).toBe('zh');
  });
});

describe('parseSettingsForm language group', () => {
  const form = (entries: [string, string][]) => {
    const fd = new FormData();
    for (const [k, v] of entries) fd.append(k, v);
    return fd;
  };

  it('stores the enabled set as JSON alongside the default', () => {
    const r = parseSettingsForm(form([['locale.enabled_form', '1'], ['locale.enabled', 'en'], ['locale.enabled', 'zh'], ['locale.default', 'zh']]));
    expect(r).toEqual({ ok: true, data: { 'locale.default': 'zh', 'locale.enabled': '["en","zh"]' } });
  });

  it('rejects none enabled and a default that is not enabled', () => {
    const none = parseSettingsForm(form([['locale.enabled_form', '1'], ['locale.default', 'en']]));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors['locale.enabled']).toBe('admin.settings.localesNoneEnabled');
    const bad = parseSettingsForm(form([['locale.enabled_form', '1'], ['locale.enabled', 'en'], ['locale.default', 'zh']]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors['locale.default']).toBe('admin.settings.localeDefaultNotEnabled');
  });

  it('rejects an unsupported enabled code', () => {
    const r = parseSettingsForm(form([['locale.enabled_form', '1'], ['locale.enabled', 'en'], ['locale.enabled', 'xx'], ['locale.default', 'en']]));
    expect(r.ok).toBe(false);
  });
});
