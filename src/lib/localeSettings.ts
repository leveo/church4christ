// Installation-wide language settings: which supported locales are ENABLED and
// which one is the DEFAULT. Stored in the global `settings` table as
// `locale.enabled` (JSON array) and `locale.default`, read once per request by the
// middleware through a short per-isolate memo.
//
// Upgrade safety: an installation that never saved language settings has no
// `locale.enabled` row. It stays on {en, zh} with default `en` — any legacy
// `locale.default` row was never read at runtime and is ignored until the
// installation saves the new settings (admin Settings or a fresh setup).
import type { AppDb } from './appDb';
import {
  DEFAULT_LOCALE,
  LEGACY_ENABLED_LOCALES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  setRuntimeDefaultLocale,
  type SupportedLocale,
} from './locales';
import { getSettings, setSettings } from './settings';

export const LOCALE_ENABLED_KEY = 'locale.enabled';
export const LOCALE_DEFAULT_KEY = 'locale.default';

export interface LocaleSettings {
  readonly enabled: readonly SupportedLocale[];
  readonly default: SupportedLocale;
}

export const LEGACY_LOCALE_SETTINGS: LocaleSettings = {
  enabled: LEGACY_ENABLED_LOCALES,
  default: DEFAULT_LOCALE,
};

export type LocaleSettingsError = 'locale_none_enabled' | 'locale_unsupported' | 'locale_default_not_enabled';

/** Validate a candidate save: enabled non-empty subset of supported, default among enabled. */
export function validateLocaleSettings(
  enabled: readonly string[],
  defaultLocale: string,
): { ok: true; value: LocaleSettings } | { ok: false; error: LocaleSettingsError } {
  if (enabled.length === 0) return { ok: false, error: 'locale_none_enabled' };
  if (!enabled.every(isSupportedLocale)) return { ok: false, error: 'locale_unsupported' };
  const ordered = SUPPORTED_LOCALES.filter((code) => enabled.includes(code));
  if (!isSupportedLocale(defaultLocale) || !ordered.includes(defaultLocale)) {
    return { ok: false, error: 'locale_default_not_enabled' };
  }
  return { ok: true, value: { enabled: ordered, default: defaultLocale } };
}

/** Interpret raw stored rows. Absent/invalid `locale.enabled` is the legacy state. */
export function parseLocaleSettings(rows: Record<string, string | undefined>): LocaleSettings {
  const rawEnabled = rows[LOCALE_ENABLED_KEY];
  if (rawEnabled === undefined) return LEGACY_LOCALE_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnabled);
  } catch {
    return LEGACY_LOCALE_SETTINGS;
  }
  if (!Array.isArray(parsed)) return LEGACY_LOCALE_SETTINGS;
  // Tolerate codes a newer deploy knew about and this one does not: drop them.
  const known = parsed.filter(isSupportedLocale);
  if (known.length === 0) return LEGACY_LOCALE_SETTINGS;
  const ordered = SUPPORTED_LOCALES.filter((code) => known.includes(code));
  const stored = rows[LOCALE_DEFAULT_KEY];
  const def = isSupportedLocale(stored) && ordered.includes(stored)
    ? stored
    : ordered.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : ordered[0];
  return { enabled: ordered, default: def };
}

const CACHE_TTL_MS = 60_000;
let cache: { value: LocaleSettings; expiresAt: number } | null = null;

export function clearLocaleSettingsCache(): void {
  cache = null;
}

/** Current language settings (memoized ≤60s per isolate); also refreshes the
 *  runtime fallback default used by `t()` / `i18nJoin`. Throws if the DB is down. */
export async function getLocaleSettings(db: AppDb, now: number = Date.now()): Promise<LocaleSettings> {
  if (cache && cache.expiresAt > now) {
    setRuntimeDefaultLocale(cache.value.default);
    return cache.value;
  }
  const rows = await getSettings(db, [LOCALE_ENABLED_KEY, LOCALE_DEFAULT_KEY]);
  const value = parseLocaleSettings(rows);
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  setRuntimeDefaultLocale(value.default);
  return value;
}

/** Validate and persist both rows atomically, then drop the memo. */
export async function saveLocaleSettings(
  db: AppDb,
  enabled: readonly string[],
  defaultLocale: string,
): Promise<{ ok: true; value: LocaleSettings } | { ok: false; error: LocaleSettingsError }> {
  const checked = validateLocaleSettings(enabled, defaultLocale);
  if (!checked.ok) return checked;
  await setSettings(db, {
    [LOCALE_ENABLED_KEY]: JSON.stringify(checked.value.enabled),
    [LOCALE_DEFAULT_KEY]: checked.value.default,
  });
  clearLocaleSettingsCache();
  return checked;
}
