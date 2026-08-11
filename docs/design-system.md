# Design system

Church4Christ uses design tokens so components can express visual intent without knowing
a theme's exact colors or fonts. A component asks for roles such as `bg-primary`,
`text-ink-muted`, or `border-border`; each theme supplies the values for those roles in
light and dark mode. That separation keeps public and admin interfaces consistent and
allows the saved theme to change at runtime without rebuilding the application.

This document explains the architecture. For the practical checklists for changing or
creating themes, fonts, and semantic tokens, use the
[theme authoring guide](../design/README.md). For the visitor-facing behavior, see
[Public site and themes](features/public-site-and-themes.md).

## The token pipeline

```text
design/foundation.json      (theme-independent type, containers, z-index, motion)
design/themes/*.json        (per-theme metadata, fonts, radius, shadow, light + dark colors)
        │
        │  npm run tokens   (scripts/build-tokens.mjs)
        ▼
src/styles/tokens.generated.css      CSS custom properties, one block per theme and mode
src/lib/themeMeta.generated.ts       default-mode swatches and metadata for the picker
        │
        │  imported and mapped by src/styles/base.css
        ▼
components consume semantic Tailwind utilities such as bg-primary and text-ink
```

The JSON files are the source of truth. Both generated files are git-ignored and rebuilt
from those sources; direct edits to either output are temporary.

### Foundation and theme responsibilities

`design/foundation.json` contains values that do not vary by theme: the typography scale,
line heights (including CJK leading), letter spacing, container widths, z-index layers,
and motion durations/easing. It does not currently contain a spacing group, and themes
may not override its values.

Each `design/themes/*.json` file owns `version`, `name`, `label`, `defaultMode`, fonts,
radii, shadows, and complete light and dark semantic color palettes. Keeping these
responsibilities separate prevents a theme from changing shared layout or motion rules.

## Why semantic colors

Semantic tokens are grouped by purpose:

- surfaces and ink describe page layers and text hierarchy;
- primary and accent roles describe brand and action emphasis;
- success, warning, danger, and information roles describe status;
- borders, focus rings, header, footer, and scrim roles describe interface chrome.

Foreground roles are paired with their intended backgrounds. `on-primary` belongs on
`primary`, `on-primary-soft` belongs on `primary-soft`, and header/footer ink belongs on
the matching chrome background. The same role can therefore use different hues in every
theme while preserving its meaning and readable contrast.

## Generated CSS and runtime resolution

For each theme, `scripts/build-tokens.mjs` emits an unqualified
`:root[data-theme="name"]` block using that theme JSON's `defaultMode` palette, plus a
`data-mode` override for the other palette. It also emits picker metadata using swatches
from the JSON default mode. `src/styles/base.css` maps the custom properties into
Tailwind's runtime theme namespace, so utilities continue to reference variables rather
than fixed generated values.

At request time, `src/lib/theme.ts` validates the stored `theme.name` against the runtime
allowlist and resolves `theme.default_mode` from settings. Middleware makes the theme
available to layouts; `src/layouts/Base.astro` and `src/layouts/Admin.astro` stamp
`data-theme` and `data-mode` on `<html>`. Their small inline script applies a visitor's
saved `c4c-mode` choice before paint, avoiding a light/dark flash. The settings save clears
the per-isolate theme cache so the next render can use the new selection.

## Enforcement gates

### Contrast gate

`npm run tokens` checks every declared foreground/background pair in every theme and mode
against a 4.5:1 minimum before it writes outputs. A failure reports the theme, mode, pair,
and measured ratio. The pair list lives in `scripts/build-tokens.mjs` so new readable
foreground/background roles can join the same gate.

### Literal-value gate

`npm run tokens:check` scans `src/**/*.{astro,ts,tsx,css}`, excluding generated outputs,
and rejects hardcoded hex, RGB/HSL color functions, and literal `font-family` values.
Components normally consume semantic variables or utilities. The same-line
`/* tokens-ok */` marker is reserved for narrow, reviewed exceptions that cannot use the
token CSS.

Theme generation and linting run as build/CI gates, while `test/tokens.test.ts`,
`test/themeMeta.test.ts`, and `test/theme.test.ts` cover generation, picker metadata,
contrast behavior, and runtime resolution. The complete authoring and verification
commands live in [the theme authoring guide](../design/README.md#generate-and-verify).

## Key files

| Responsibility | Path |
|---|---|
| Foundation tokens | `design/foundation.json` |
| Theme sources | `design/themes/*.json` |
| Generator and contrast pairs | `scripts/build-tokens.mjs` |
| Literal-value linter | `scripts/check-tokens.mjs` |
| Tailwind mappings and shared styles | `src/styles/base.css` |
| Runtime theme resolution | `src/lib/theme.ts`, `src/lib/settings.ts` |
| Public and admin activation | `src/layouts/Base.astro`, `src/layouts/Admin.astro` |
| Authoring workflow | `design/README.md` |
