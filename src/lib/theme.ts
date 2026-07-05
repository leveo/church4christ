// Active visual theme. Per-church settings drive this in slice 5; until then
// every request renders THEME_DEFAULT. tokens.generated.css ships all three
// theme blocks, so flipping this one const restyles the whole site.
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
