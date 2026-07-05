# Slice 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A building, deployable Astro + Cloudflare Workers skeleton with the token-driven
design system live, bilingual locale routing, Base/Admin layouts with themed header/footer,
and CI — everything later slices build on.

**Architecture:** See `docs/superpowers/specs/2026-07-05-church4christ-design.md` (§3, §7, §9).
Single Astro `output:'server'` app, custom worker entry, tokens generated from
`design/*.json` into CSS custom properties consumed by Tailwind v4 `@theme inline`.

**Tech Stack:** astro ^7.0.5, @astrojs/cloudflare ^14.1.0, tailwindcss ^4.3.2 +
@tailwindcss/vite, typescript ^6, vitest ^4.1 + @cloudflare/vitest-pool-workers ^0.17,
wrangler ^4.106, jose ^6.2.3 (installed now, used slice 3), Node 22.

## Global Constraints

- **Reference repos on disk — port proven patterns, do not invent:**
  `/Users/leosong/Python/dcfc-serve` (primary: worker entry, vitest configs, middleware
  shape, Base layout skeleton), `/Users/leosong/Python/dcfc-website` (astro config,
  smoke.sh, CI workflow). Copy structure, then adapt names/strings. NEVER copy DCFC
  church names, addresses, emails, Cloudflare account/database/AUD ids, or real-person data.
- **No hardcoded design values in `src/`**: no hex/rgb/hsl colors, no font-family
  literals, no px radii/shadows. Use Tailwind utilities backed by tokens
  (`bg-primary`, `text-ink-muted`, `rounded-md`, `shadow-md`, `font-display`,
  `bg-surface-raised`, `border-border` …). `npm run tokens:check` enforces this.
- Site identity strings come from `src/i18n/{en,zh}.ts` dictionaries — never inline
  English/Chinese copy in components for chrome (header/footer/nav).
- Fictional identity only: **Church4Christ / 四方基督教会**, `church.yunfei-song.com`,
  `hello@church.yunfei-song.com`, `(555) 010-4444`, `123 Grace Avenue, Springfield, TX 75000`.
- Placeholders in `wrangler.jsonc` for ids: database_id `"YOUR_D1_DATABASE_ID"` etc.
- Commit after every task (`git add` specific paths; conventional-commit messages;
  end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).

---

### Task 1: npm scaffold + Astro/Tailwind/wrangler config

**Files:**
- Create: `package.json`, `astro.config.mjs`, `tsconfig.json`, `wrangler.jsonc`,
  `.dev.vars.example`, `src/env.d.ts`, `src/worker.ts`, `public/favicon.svg`,
  `public/robots.txt`
- Reference: `/Users/leosong/Python/dcfc-serve/{package.json,astro.config.mjs,wrangler.jsonc,src/worker.ts,src/env.d.ts}`

**Interfaces:**
- Produces: npm scripts `dev`, `build` (= `npm run tokens && astro build`), `preview`,
  `check`, `tokens` (`node scripts/build-tokens.mjs`), `tokens:check`
  (`node scripts/check-tokens.mjs`), `test`, `test:e2e` (placeholder until slice 2),
  `db:migrate:local`, `db:migrate:remote`, `db:seed:local`, `cf-typegen`, `deploy`.
- Produces: `src/worker.ts` exporting `{ fetch: handle, scheduled }` where `scheduled`
  is a stub switch on `controller.cron` (cases `0 13 * * *`, `0 14 * * 4`, `0 9 * * *`,
  each logging "not implemented"). Later slices fill the cases.

- [ ] Step 1: Port configs from dcfc-serve, adapting: name `church4christ`,
  site `https://church.yunfei-song.com`, worker name `church4christ`,
  D1 `church4christ-db` with `database_id: "YOUR_D1_DATABASE_ID"`, R2 `church4christ-media`,
  vars `APP_ORIGIN=https://church.yunfei-song.com`, `EMAIL_FROM=serve@church.yunfei-song.com`,
  `send_email` binding `EMAIL`, all three cron triggers, `nodejs_compat`,
  compatibility_date `2026-06-01`, observability on. `.dev.vars.example` with
  `SESSION_SECRET=dev-only-secret-change-me`, `EMAIL_DEV_LOG=1`,
  `AUTH_DEV_BYPASS_EMAIL=admin@example.com`, commented `D1_EXPORT_TOKEN=`.
- [ ] Step 2: `npm install` all pinned deps + `@fontsource-variable/fraunces`,
  `@fontsource-variable/inter`, `@fontsource-variable/bricolage-grotesque`,
  `@fontsource-variable/nunito`, `@fontsource-variable/space-grotesk`.
- [ ] Step 3: Verify `npx astro --version` runs; commit.

### Task 2: Token pipeline (build + lint) with contrast gate

**Files:**
- Create: `scripts/build-tokens.mjs`, `scripts/check-tokens.mjs`, `src/styles/base.css`
- Test: `test/tokens.test.ts` (plain vitest, no workers pool needed — but keep it inside
  the single vitest config's include; it must not import wrangler bindings)

**Interfaces:**
- Consumes: `design/foundation.json`, `design/themes/*.json` (already in repo — treat as
  read-only source of truth; do NOT edit values).
- Produces: `src/styles/tokens.generated.css` with, per theme: `:root[data-theme="X"]{…}`
  (its `defaultMode` palette + fonts/radius/shadow vars) and
  `:root[data-theme="X"][data-mode="dark"]{…}` / `…[data-mode="light"]{…}` for the other
  mode. Foundation vars once under `:root`. Variable naming: colors `--color-<key>`
  (e.g. `--color-primary-soft`, `--color-on-primary`), fonts `--font-display/body/mono`
  (family + fallback joined), radii `--radius-sm..full`, shadows `--shadow-sm..lg`,
  type scale `--text-xs..display-2xl`, leading `--leading-*`, tracking `--tracking-*`,
  containers `--container-*`, z `--z-*`, motion `--duration-*`, `--ease-*`.
- Produces: exported pure functions from `scripts/build-tokens.mjs`:
  `generateCss(foundation, themes) -> string` and
  `contrastViolations(themes) -> {theme,mode,pair,ratio}[]` so tests can import them.
- Contrast gate: WCAG relative-luminance ratio ≥ 4.5 required for pairs
  (ink|surface), (ink|surface-raised), (ink-muted|surface), (on-primary|primary),
  (on-accent|accent), (on-primary-soft|primary-soft), (on-accent-soft|accent-soft),
  (on-success|success), (on-warn|warn), (on-danger|danger), (on-info|info),
  (header-ink|header-bg), (footer-ink|footer-bg). Build exits 1 listing violations.
  (If a shipped theme value genuinely fails, FIX THE THEME JSON minimally — nudge the
  failing color, do not weaken the gate — and note the change in the commit message.)
- `check-tokens.mjs`: scans `src/**/*.{astro,ts,tsx,css}` excluding `tokens.generated.css`
  for `#[0-9a-fA-F]{3,8}\b` in style contexts, `rgb(`, `hsl(`, `font-family:`; exits 1
  with file:line list. Allowlist comment `/* tokens-ok */` on the same line escapes it.
- `src/styles/base.css`: `@import "tailwindcss";` + `@import "./tokens.generated.css";`
  + `@theme inline { --color-*: var(--color-*); --font-display: var(--font-display); … }`
  mapping every semantic token so utilities exist (`bg-primary`, `text-on-primary`,
  `border-border`, `rounded-sm..xl`, `shadow-sm..lg`, `font-display/body/mono`).
  Also: `:focus-visible` ring using `--color-ring`; `.skip-link`; `body:lang(zh)`
  line-height `var(--leading-cjk)`; `prefers-reduced-motion` reset; `.container-content/narrow/wide`.

- [ ] Step 1: Write failing tests: `generateCss` emits `:root[data-theme="sanctuary"]`
  containing `--color-primary: #31487A`; dark block emits `--color-primary: #93ACDD`;
  midnight default block is its dark palette; `contrastViolations` returns [] for all
  three shipped themes; a doctored theme with `on-primary:#EEE, primary:#DDD` yields a
  violation.
- [ ] Step 2: Implement `build-tokens.mjs` (pure functions + CLI main writing the file),
  run tests → pass.
- [ ] Step 3: Implement `check-tokens.mjs`; add fixture-based test (temp file with a hex
  → violation; with `/* tokens-ok */` → clean).
- [ ] Step 4: `npm run tokens` writes `src/styles/tokens.generated.css`; commit
  (generated file stays gitignored).

### Task 3: Locale core + dictionaries

**Files:**
- Create: `src/lib/locales.ts`, `src/lib/i18n.ts`, `src/i18n/en.ts`, `src/i18n/zh.ts`
- Test: `test/i18n.test.ts`, `test/locales.test.ts`

**Interfaces:**
- Produces: `LOCALES = ['en','zh'] as const`, `type Locale`, `DEFAULT_LOCALE: Locale = 'en'`,
  `parseLocale(seg: string): Locale | null`, `localePath(locale: Locale, path: string): string`
  (`localePath('zh','/sermons') === '/zh/sermons'`), `pathWithoutLocale(pathname: string):
  {locale: Locale|null, rest: string}`, `pickLocaleFromHeader(accept: string|null): Locale`.
- Produces: `t(locale, key, vars?)` — flat string dictionaries, `{var}` interpolation,
  interpolated values HTML-escaped; missing key falls back to `en` then to the key itself.
- Dictionary seed keys now (later slices append): `site.name`, `site.tagline`,
  `nav.visit/about/sermons/bulletin/events/ministries/serve/give/articles/fellowships/prayer`,
  `footer.address/contact/serviceTimes/quickLinks/rights/modeToggle`,
  `common.readMore/backTo/language/menu/signIn/signOut/mySchedule`,
  `home.*` placeholders used by the slice-1 stub homepage.
  zh values: natural Simplified Chinese (site.name = `四方基督教会`).
- Tests (port dcfc-serve `test/i18n.test.ts` semantics): identical key sets both locales,
  identical `{placeholder}` sets per key, non-empty values, interpolation escapes HTML.

- [ ] Steps: failing tests → implement → pass → commit.

### Task 4: Middleware skeleton + layouts + header/footer + stub pages

**Files:**
- Create: `src/middleware.ts`, `src/layouts/Base.astro`, `src/layouts/Admin.astro`,
  `src/components/Header.astro`, `src/components/Footer.astro`,
  `src/components/LocaleSwitch.astro`, `src/components/ModeToggle.astro`,
  `src/pages/index.astro` (root redirect), `src/pages/[locale]/index.astro` (stub home:
  hero band w/ gradient placeholder art, tagline, 3 feature cards linking nowhere yet),
  `src/pages/404.astro`, `src/pages/healthz.ts` (returns `{ok:true}` JSON)
- Reference: dcfc-serve `src/middleware.ts` (headers/no-store shape), `Base.astro`.

**Interfaces:**
- Produces: middleware that (a) redirects `/` → `/{pickLocaleFromHeader}` 302;
  (b) 404s unknown locale prefixes early; (c) sets security headers
  (nosniff, DENY, referrer-policy) on non-asset responses; (d) stubs
  `context.locals.user = null` and `context.locals.locale` (typed in `src/env.d.ts`
  `App.Locals { user: SessionUser|null; locale: Locale }` — `SessionUser` minimal
  `{id:number; email:string; isAdmin:boolean}` placeholder type in `src/lib/types.ts`
  until slice 3 replaces it).
- Produces: `Base.astro` props `{title, description?, locale}`: full head (charset,
  viewport, title template `%s · {t(site.name)}`, description, canonical + hreflang
  alternates via `alternateLinks`, favicon, fontsource imports for ALL theme fonts,
  base.css import), `<html lang={locale==='zh'?'zh-Hans':'en'} data-theme={theme}
  data-mode>` — theme read from `Astro.locals.theme ?? 'sanctuary'` (settings wiring
  comes in slice 2; hardcode default via a single `THEME_DEFAULT` const in
  `src/lib/theme.ts`), inline no-flash mode script (localStorage `c4c-mode` → data-mode),
  skip-link, `<Header/><main id="main"><slot/></main><Footer/>`.
- Header: sticky, `bg-header-bg text-header-ink`, site name (links home), nav from
  dictionary keys, LocaleSwitch (preserves path via `pathWithoutLocale`), mobile
  disclosure menu (checkbox pattern, port from dcfc-website Header), Give pill CTA.
- Footer: `bg-footer-bg text-footer-ink`, 3 columns (identity+address / service times /
  quick links) using dictionary + ModeToggle (cycles light/dark, writes localStorage,
  sets data-mode).
- Admin.astro: minimal shell (top bar "Church4Christ Admin", slot), fleshed out slice 5.

- [ ] Steps: implement; `npm run dev` renders `/en` + `/zh` stub home with sanctuary
  theme; flipping `THEME_DEFAULT` to `harvest`/`midnight` restyles everything (manually
  verify all three, then set back); `curl -I localhost:4321/` shows 302 + headers; commit.

### Task 5: Vitest workers-pool wiring + smoke + CI

**Files:**
- Create: `vitest.config.ts`, `test/wrangler.test.jsonc`, `test/setup.ts`,
  `test/security-headers.test.ts`, `scripts/smoke.sh`, `.github/workflows/ci.yml`,
  `migrations/.gitkeep`
- Reference: dcfc-serve `vitest.config.ts`, `test/wrangler.test.jsonc`, `test/setup.ts`;
  dcfc-website `scripts/smoke.sh`, `.github/workflows/deploy.yml`.

**Interfaces:**
- Produces: `npm test` runs pool-workers config (migrations dir wired via
  `readD1Migrations` even while empty) AND the pure tests from tasks 2–3 (two projects
  in one vitest config: `workers` + `node`). `test/setup.ts` applies `TEST_MIGRATIONS`.
- smoke.sh: `npm run build`, `astro preview` :4322, curl asserts: `/` 302→`/en/`,
  `/en/` 200 contains `Church4Christ`, `/zh/` 200 contains `四方基督教会`, `/healthz`
  ok, security headers present, unknown `/xx/` 404.
- CI (`ci.yml`, on push+PR): Node 22, `npm ci`, `npx wrangler types`, `npm run tokens`,
  `npm run tokens:check`, `npm test`, `npm run check`, `npm run build`, `bash scripts/smoke.sh`;
  deploy job (push to main only, `if: secrets.CLOUDFLARE_API_TOKEN`) `wrangler deploy`.

- [ ] Steps: wire configs → `npm test` green → `bash scripts/smoke.sh` green →
  `npm run check` green → commit.

## Self-review checklist (executor runs at end)

- `npm run tokens && npm run tokens:check && npm test && npm run check && npm run build
  && bash scripts/smoke.sh` all green from a clean `git status`.
- `rg -n "#[0-9a-fA-F]{6}" src/` → only tokens.generated.css (gitignored) hits.
- `rg -in "dcfc|dallas|glencliff|plano|leveosong|dcfc7294" src/ public/ *.json *.jsonc *.mjs` → zero hits.
- All three themes render (screenshot each at `/en/`), light + dark.
- Report: what was built, deviations from plan (with reasons), verification output.
