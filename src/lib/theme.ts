// Active visual theme. Per-church settings drive this (see getActiveTheme
// below); tokens.generated.css ships all three theme blocks, so flipping the
// stored theme.name restyles the whole site.
import type { AppDb } from './appDb';
import { getTheme } from './settings';

export const THEMES = ['sanctuary', 'harvest', 'midnight'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_DEFAULT: Theme = 'sanctuary';

// Each theme's default color mode, used when the visitor has not chosen one.
// The token CSS bakes these as the base block (sanctuary/harvest = light with a
// [data-mode="dark"] override, midnight = dark with a [data-mode="light"] one).
// Keep in sync with the inline no-flash map in Base.astro / Admin.astro.
export const THEME_DEFAULT_MODE: Record<Theme, 'light' | 'dark'> = {
  sanctuary: 'light',
  harvest: 'light',
  midnight: 'dark',
};

export interface ActiveTheme {
  theme: Theme;
  defaultMode: 'light' | 'dark';
}

/** True when a stored string is one of the shipped theme names. */
function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

// Per-isolate cache: reading settings on every request would hammer D1, and the
// active theme changes at most a few times a year. A settings save clears this
// (task 4 calls clearThemeCache) so a switch takes effect on the next render in
// the writing isolate; other isolates catch up within the TTL.
const CACHE_TTL_MS = 60_000;
let cache: { value: ActiveTheme; expiresAt: number } | null = null;

/** Drop the cached active theme (tests + settings save after a theme change). */
export function clearThemeCache(): void {
  cache = null;
}

/**
 * The active theme + default color mode, from the `theme.name` / `theme.default_mode`
 * settings, cached per-isolate for {@link CACHE_TTL_MS}. An unknown/absent stored
 * theme name falls back to THEME_DEFAULT (no logging); an invalid default_mode falls
 * back to the chosen theme's intrinsic default. May throw if the DB is unavailable —
 * callers that render before auth (middleware, layouts) guard it to THEME_DEFAULT.
 */
export async function getActiveTheme(db: AppDb): Promise<ActiveTheme> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const stored = await getTheme(db);
  const theme = isTheme(stored.theme) ? stored.theme : THEME_DEFAULT;
  const defaultMode =
    stored.defaultMode === 'light' || stored.defaultMode === 'dark'
      ? stored.defaultMode
      : THEME_DEFAULT_MODE[theme];
  const value: ActiveTheme = { theme, defaultMode };
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}
