// The settings key/value store: a flat `settings(key, value)` table read by the
// public site (identity, theme) and written by admin. Keys are dotted strings;
// localized settings carry a `.<locale>` suffix (e.g. `site.name.zh`) and fall
// back to the `.en` value, while operational settings are locale-free.
import type { AppDb } from './appDb';
import type { Locale } from './locales';

/** Fetch several settings at once; missing keys are simply absent from the map. */
export async function getSettings(db: AppDb, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const placeholders = keys.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of results) out[row.key] = row.value;
  return out;
}

/** A single setting's value, or `fallback` (default '') when the key is unset. */
export async function getSetting(db: AppDb, key: string, fallback = ''): Promise<string> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

/** Insert or replace a setting by key. */
export async function setSetting(db: AppDb, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** Upsert several settings in ONE atomic batch — the admin settings form save,
 *  so a partial write can never leave identity/theme half-applied. */
export async function setSettings(db: AppDb, values: Record<string, string>): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  await db.batch(
    keys.map((key) =>
      db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, values[key]),
    ),
  );
}

interface SiteIdentity {
  name: string;
  tagline: string;
  address: string;
  email: string;
  phone: string;
  serviceTimes: string;
  givingUrl: string;
  youtubeUrl: string;
  mapUrl: string;
}

/**
 * The church's public identity. name/tagline/serviceTimes are localized
 * (`site.<x>.<locale>` with an `.en` fallback); address/email/phone and the
 * giving/youtube/map URLs are locale-free (`site.<x>`). Unset keys read as ''.
 */
export async function getSiteIdentity(db: AppDb, locale: Locale): Promise<SiteIdentity> {
  const s = await getSettings(db, [
    `site.name.${locale}`,
    'site.name.en',
    `site.tagline.${locale}`,
    'site.tagline.en',
    `site.service_times.${locale}`,
    'site.service_times.en',
    'site.address',
    'site.email',
    'site.phone',
    'site.giving_url',
    'site.youtube_url',
    'site.map_url',
  ]);
  const localized = (base: string) => s[`${base}.${locale}`] ?? s[`${base}.en`] ?? '';
  return {
    name: localized('site.name'),
    tagline: localized('site.tagline'),
    address: s['site.address'] ?? '',
    email: s['site.email'] ?? '',
    phone: s['site.phone'] ?? '',
    serviceTimes: localized('site.service_times'),
    givingUrl: s['site.giving_url'] ?? '',
    youtubeUrl: s['site.youtube_url'] ?? '',
    mapUrl: s['site.map_url'] ?? '',
  };
}

/** Active theme + its default color mode, defaulting to sanctuary/light. */
export async function getTheme(db: AppDb): Promise<{ theme: string; defaultMode: string }> {
  const s = await getSettings(db, ['theme.name', 'theme.default_mode']);
  return {
    theme: s['theme.name'] ?? 'sanctuary',
    defaultMode: s['theme.default_mode'] ?? 'light',
  };
}
