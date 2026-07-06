# Design system

Every color, font, radius, and shadow on the site comes from **design tokens** — a small
set of values in `design/` that compile into CSS variables. Components never hardcode a
color or a font; they use semantic utilities (`bg-primary`, `text-ink-muted`) that resolve
to those variables. This is what keeps the whole site visually consistent and lets an admin
switch the entire look by choosing a different theme, with no rebuild.

## The token pipeline

```
design/foundation.json      (theme-independent: type scale, spacing, z, motion)
design/themes/*.json         (per-theme: fonts, radius, shadow, light + dark colors)
        │
        │  npm run tokens   (scripts/build-tokens.mjs)
        ▼
src/styles/tokens.generated.css      →  CSS custom properties, one block per theme × mode
src/lib/themeMeta.generated.ts       →  swatches + labels for the admin theme picker
        │
        │  imported by src/styles/base.css, consumed via Tailwind utilities
        ▼
Components use  bg-primary · text-ink · border-subtle · font-display  (never raw hex)
```

Both generated files are **git-ignored** and rebuilt from the JSON source of truth. Run
`npm run tokens` after editing anything in `design/`. (The full build, `npm run build`,
runs it for you.)

### Foundation vs. themes

- **`design/foundation.json`** holds values that do *not* change between themes: the type
  scale (`--text-*`), line heights (`--leading-*`, including a CJK-tuned value), letter
  spacing, container widths, z-index layers, and motion durations. Themes may not override
  these.
- **`design/themes/{sanctuary,harvest,midnight}.json`** each hold that theme's fonts,
  border radii, shadows, and — the heart of it — a full **light** palette and **dark**
  palette of semantic colors.

### Semantic colors, not raw colors

Palettes are named by *role*, not by hue. A theme defines `primary`, `on-primary`,
`surface`, `surface-raised`, `ink`, `ink-muted`, `accent`, `success`, `warn`, `danger`,
`info`, and their `-soft` / `-hover` variants, plus header and footer colors. Because
components reference the role (`bg-primary`), the same component looks right in all three
themes and both modes without change.

### How a mode is emitted

`scripts/build-tokens.mjs` writes, for each theme:

- `:root[data-theme="sanctuary"] { … }` — the theme's fonts, radius, shadow, and its
  **default-mode** colors.
- `:root[data-theme="sanctuary"][data-mode="dark"] { … }` — the **other mode's** color
  overrides.

`src/layouts/Base.astro` stamps `data-theme` and `data-mode` on `<html>` (with a tiny
inline script that avoids a dark-mode flash), so switching either attribute reskins the
page instantly.

## Two enforcement gates

The design system is not a convention you have to remember — two build steps enforce it,
and both run in CI.

### 1. Contrast gate (in `npm run tokens`)

Before writing any CSS, the token builder checks **every theme, every mode, every
foreground/background pair** (ink on surface, on-primary on primary, header ink on header
background, and so on) against **WCAG 4.5:1** contrast. If any pair falls short, the build
**fails** and prints the offending `theme/mode pair ratio`. You cannot ship a theme whose
text is hard to read.

### 2. Token gate (`npm run tokens:check`)

`scripts/check-tokens.mjs` scans `src/**/*.{astro,ts,tsx,css}` (excluding the generated
CSS) and **fails the build** on any hardcoded style value:

- hex colors (`#31487A`, `#FFF`, `#RRGGBBAA`)
- `rgb()` / `rgba()` / `hsl()` / `hsla()` literals
- a `font-family` with anything other than `var(--font-*)` values

If you genuinely need a literal (for example, a system-font fallback in a bare error page
that renders without the token CSS), append `/* tokens-ok */` on that line to allow it
deliberately. Everything else must come from a token.

## Editing or adding a theme

### Tweak an existing theme

1. Open `design/themes/sanctuary.json` (or `harvest` / `midnight`).
2. Change the values you want — a `primary` color, a font family, a radius. Edit both the
   `light` and `dark` palettes so both modes stay balanced.
3. Run `npm run tokens`. If the contrast gate complains, adjust the pair it names until it
   passes 4.5:1.
4. Run `npm run dev` and check the pages in both light and dark mode.

### Add a brand-new theme

1. Copy an existing theme file to `design/themes/<yourtheme>.json` and change its `name`
   (must match the filename stem), `label` (shown in the admin picker), and `defaultMode`.
2. Fill in `fonts`, `radius`, `shadow`, and the full `light` + `dark` color palettes. Keep
   every semantic key the existing themes have.
3. If you introduce a new font family, add its `@fontsource-variable/*` package and import
   it where the others are imported.
4. Run `npm run tokens`. The new theme is now compiled into `tokens.generated.css`, and its
   swatches appear automatically in the admin **Settings → theme picker** (from
   `themeMeta.generated.ts`) — no other wiring needed.
5. Run `npm run tokens:check` and the test suite (`test/tokens.test.ts`,
   `test/themeMeta.test.ts`) to confirm everything is green.

## Where it lives

| Thing | Path |
|---|---|
| Foundation tokens | `design/foundation.json` |
| Theme tokens | `design/themes/*.json` |
| Token builder (+ contrast gate, theme meta) | `scripts/build-tokens.mjs` |
| Token linter | `scripts/check-tokens.mjs` |
| Generated CSS (git-ignored) | `src/styles/tokens.generated.css` |
| Generated theme meta (git-ignored) | `src/lib/themeMeta.generated.ts` |
| Base styles / utilities | `src/styles/base.css` |
| Theme resolution at runtime | `src/lib/theme.ts`, `src/lib/settings.ts` |
| Tests | `test/tokens.test.ts`, `test/themeMeta.test.ts`, `test/theme.test.ts` |
