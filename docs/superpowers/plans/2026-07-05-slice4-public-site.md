# Slice 4 — Public Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every public-facing page in both locales, driven by D1 + content collections,
styled exclusively through the token design system, with the 简→繁 toggle and the
prayer-request API.

**Architecture:** Spec §6 route map, §7 i18n, §9 design rules. References (read-only):
`/Users/leosong/Python/dcfc-website/src/{components,pages,content.config.ts}` for
component/page shapes (BulletinView, SermonMonthGrid, YouTubeEmbed facade, EventGrid,
ticker), `/Users/leosong/Python/dcfc-serve` for landing-grid patterns. Port structure,
NOT copy (design language is ours: token utilities only).

## Global Constraints

- ALL styling via token-backed Tailwind utilities (`bg-primary`, `text-ink-muted`,
  `bg-surface-raised`, `rounded-lg`, `shadow-md`, `font-display`…). `npm run tokens:check`
  must stay green — zero hex/font literals. All three themes must look right: verify
  sanctuary + harvest + midnight (light+dark) on home, sermons, bulletin pages.
- Every page: `Base.astro` layout, localized `<title>`/description via `t()`, hreflang
  alternates, all user-visible strings through dictionaries (append keys to BOTH
  `src/i18n/en.ts` and `src/i18n/zh.ts` — i18n parity test enforces).
- Public pages must render sensibly with an EMPTY database (graceful "nothing yet"
  states) AND with the seed.
- Images: original SVG placeholder art committed under `public/images/` (hero
  gradient-scene, 10 ministry covers, avatar-initials generator component); no external
  hotlinks, no binary stock photos.
- Draft/publish rule everywhere: public queries filter `status='published' AND
  (publish_at IS NULL OR publish_at <= datetime('now')) AND deleted_at IS NULL`.
- YouTube embeds: click-to-load `youtube-nocookie` facade; thumbnail `onerror` falls
  back to a token-styled placeholder `<div>` (dummy seed ids will 404 thumbnails —
  must look intentional).
- Commits per task, conventional, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Content collections + evergreen pages

**Files:** `src/content.config.ts` (collections: `pages`, `articles`, `fellowships`,
`staff` — schema per dcfc-website's config, plus `locale` derived from folder);
markdown content under `src/content/{pages,articles,fellowships,staff}/{en,zh}/…`
(fictional, spec §11: 5 evergreen pages, 6 articles, 5 fellowships, 8 staff);
`src/lib/content.ts` helper `getLocalized(coll, slug, locale)` with en-fallback +
`translated: boolean`; pages `src/pages/[locale]/{visit,about/index,about/beliefs,
privacy,give}.astro`, `src/pages/[locale]/about/staff/{index,[slug]}.astro`,
`src/pages/[locale]/{articles,fellowships}/{index,[slug]}.astro`;
components `ContentPage.astro` (page-title band + prose), `StaffCard.astro`,
`ProseBody.astro` (typography styles via tokens; `.prose` classes in base.css @layer).
Give page: settings-driven external giving link + explanation copy.
Test: `test/content.test.ts` (fallback + translated flag), e2e assertions in Task 6.

### Task 2: Home page + shared display components

**Files:** rewrite `src/pages/[locale]/index.astro` (real home: hero w/ SVG art +
scrim + heading/CTAs; announcements ticker windowed by starts/ends; service times card
from settings; next-events strip; latest sermon card; ministries preview grid;
prayer-request form w/ honeypot + consent + success/error states via query param);
components: `Hero.astro`, `Ticker.astro`, `SectionTitle.astro`, `EventGrid.astro`,
`SermonCard.astro`, `MinistryCard.astro`, `PrayerForm.astro`, `AvatarInitials.astro`;
`src/pages/api/prayer-request.ts` (port dcfc: honeypot, validation, 4000 cap, insert,
303 back with `?prayer=sent#prayer`); `src/lib/publicDb.ts`: `listActiveAnnouncements
(db, locale, today)`, `listActiveEvents(db, locale, today)`, `latestPublishedSermon(db,
locale?)`, plus queries used by later tasks. Tests: `test/publicDb.test.ts` (windowing:
starts_at future → hidden; ends_at past → hidden; i18n fallback), `test/prayer-request.test.ts`
(port dcfc's API tests).

### Task 3: Sermons + bulletins + prayer sheets + events pages

**Files:** `src/pages/[locale]/sermons/{index,[year]}.astro` (year guard `^\d{4}$`,
month grouping), `src/pages/[locale]/bulletin/{index,[date]}.astro` (latest published
per service type + tabbed service-type switcher; date param validated; archive list),
`src/pages/[locale]/prayer/{index,[date]}.astro`, `src/pages/[locale]/events/index.astro`;
components `SermonMonthGrid.astro`, `YouTubeEmbed.astro` (facade + fallback),
`BulletinView.astro` (program table, announcements, offering/attendance, memory verse,
flowers, roster block: reads roster_assignments joined via plan matching
service_type+date — renders only confirmed/unconfirmed names grouped by position),
`PrayerSheetView.astro`. Extend `src/lib/publicDb.ts`: `listSermonYears`,
`listSermonsByYear(db, year, locale)`, `latestBulletins(db)`, `getBulletin(db,
serviceTypeId, date)`, `bulletinRoster(db, serviceTypeId, date, locale)`,
`latestPrayerSheet/getPrayerSheet/listPrayerSheetDates`. Tests: extend publicDb tests
(draft invisible, publish_at future invisible, roster join correct).

### Task 4: Ministries directory (DB-driven) + serve landing

**Files:** `src/pages/[locale]/ministries/{index,[slug]}.astro` (filter groups via
`src/lib/ministryMeta.ts` — 6 UI groups mapping the 10 categories, labels via
dictionary; open-role badges from plan_positions aggregate), `src/pages/[locale]/serve/index.astro`
(volunteer landing: how-it-works 3-step, ministry grid w/ badges, published-testimonies
strip, CTA to gifts quiz + apply — port dcfc-serve landing structure); extend
`src/lib/ministryDb.ts` (create): `listMinistriesWithStats(db, locale)`,
`getMinistryBySlug(db, slug, locale)` (+teams, positions, leaders, open counts),
`listPublishedTestimonies(db, locale, limit)`. Tests `test/ministryDb.test.ts`.

### Task 5: 简→繁 toggle

**Files:** `scripts/generate-s2t.mjs` (build char/phrase table from `opencc-data` npm
devDependency — pick s2t + phrases; output `src/lib/s2t-table.json` COMMITTED),
`src/lib/s2t.ts` (`toTraditional(s)` greedy longest-match), `src/lib/zh-client.ts`
(TreeWalker DOM conversion incl. title/alt/placeholder/aria-label, skip `[data-no-convert]`,
localStorage `c4c-hant`, lazy `import()` of table only when enabled), Header button
(visible only when locale=zh, labels 繁/简). Tests `test/s2t.test.ts` (known pairs:
后→後 in 皇后 context OK to be char-level; document greedy behavior; table non-empty;
roundtrip stability).

### Task 6: Public e2e sweep

**Files:** `test/e2e/public.test.ts` (extends slice-1 e2e config target): every public
route in §6 returns 200 in en+zh with seed; `/` 302; ticker shows active announcement
title per locale; draft sermon absent from /sermons; unknown year/date 404; prayer POST
honeypot short-circuits; hreflang present; `data-theme` attribute present; zh page
lang="zh-Hans". Fix anything it catches.

## Self-review checklist

- tokens:check + full test + check + build + smoke green; screenshots (dev server) of
  home/sermons/bulletin in all 3 themes × 2 modes saved to `docs/images/` (18 files,
  small viewport ok) — these become README assets.
- Empty-DB run: delete local state, migrate only (no seed), `npm run dev` — home renders
  with graceful empties, no 500s.
