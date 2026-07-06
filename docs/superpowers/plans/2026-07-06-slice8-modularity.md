# Slice 8 — Modular Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Authoritative design: docs/superpowers/specs/2026-07-06-people-and-modules-addendum.md §A.

**Goal:** Every capability becomes a toggleable module (11 keys, default ON) with one
middleware choke point, soft-degrade cross-links, an admin Modules panel, cron gating,
and docs — so onboarding = "switch off what you don't need."

## Global Constraints
- Module keys exactly: bulletins, sermons, prayer-sheets, prayer-wall, events, serve,
  gifts, testimonies, articles, fellowships, people (people is registered now; its
  routes arrive in slice 9 — registry entry exists with empty-so-far admin panels noted).
- Settings rows `module.<key>` = '1'|'0'; ABSENT = enabled. All-on by default; seed adds
  no module rows.
- Disabled → 404 via middleware BEFORE route policy (public + admin + API routes of that
  module). Everything token-styled, dictionary-driven (both locales), tests per task.
- Commits conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Module registry + cache + middleware gating

**Files:** Create src/lib/modules.ts; modify src/lib/theme.ts-adjacent new cache in
modules.ts; modify src/middleware.ts, src/env.d.ts (locals.modules), test/modules.test.ts
(node: registry purity) + test/moduleGating.test.ts (workers: cache + settings).

**Interfaces:**
- `MODULE_KEYS` const array (11, order = display order);
  `MODULES: Record<key, {publicPrefixes: string[], adminPrefixes: string[],
  navKeys: string[], uses: key[]}>` — locale-stripped prefixes:
  bulletins: ['/bulletin'] + admin ['/admin/bulletins']; sermons: ['/sermons'] +
  ['/admin/sermons']; prayer-sheets: ['/prayer'] + ['/admin/prayer-sheets'];
  prayer-wall: ['/api/prayer-request'] + ['/admin/prayer-wall'] (home form section
  soft-degrades in T2); events: ['/events'] + ['/admin/events','/admin/announcements'];
  serve: ['/serve','/my','/cal'] + ['/admin/ministries','/admin/service-types',
  '/admin/teams','/admin/reports'] — NOTE /profile stays core (auth surface);
  gifts: ['/serve/gifts'] (longest-prefix wins over serve) — registry must support
  overlap: match the LONGEST matching prefix's module; testimonies:
  ['/serve/testimonies'] + ['/admin/testimonies']; articles: ['/articles'];
  fellowships: ['/fellowships']; people: [] now (slice 9 fills).
- `moduleForPath(strippedPath) -> key|null` (longest-prefix; pure; exhaustive tests
  incl. /serve/gifts→gifts while /serve/plans→serve).
- `getEnabledModules(db) -> Promise<Set<key>>` 60s cache + `clearModuleCache()`;
  absent-row=enabled; junk value treated as enabled ('0' is the only disable).
- Middleware: after locale, before policy: `const m = moduleForPath(rest); if (m &&
  !locals.modules.has(m)) return 404` (rewrite to /404 with status, same pattern as
  unknown-locale guard; security headers applied).
- Steps: TDD registry (node) → cache/gating (workers: set module.sermons='0' → helper
  excludes; clear → included) → wire middleware → npm test green; e2e untouched (all-on
  default keeps 130 green) → commit.

### Task 2: Surface gating — nav, home sections, dashboard, crons, Settings panel

**Files:** Modify Header.astro, Footer.astro (quick links), src/pages/[locale]/index.astro
(per-section module checks), Admin.astro (nav), admin/index.astro (cards), worker.ts
(cron gating), admin/settings/index.astro (+Modules panel), validate.ts
(parseSettingsForm accepts module.* keys — extend allowlist dynamically from
MODULE_KEYS, values '1'|'0' via checkbox presence), i18n dictionaries
(modules.<key>.label/desc + settings.modules.* both locales), e2e new file
test/e2e/modules.e2e.test.ts.

**Behavior (binding):**
- Header nav item per module hidden when off (nav.sermons ↔ sermons etc.; give/visit/
  about untouched). Home: ticker+events strip (events), latest sermon (sermons),
  ministries preview (serve), prayer form section (prayer-wall) — each wrapped.
  Serve landing hides gifts CTA when gifts off; quiz hides ministry recommendations
  when serve off (soft-degrade per spec).
- Admin nav groups/cards per module; settings Modules panel: grouped checkboxes
  (Content: bulletins/sermons/prayer-sheets/articles/fellowships · Community:
  events/prayer-wall/testimonies/people · Volunteering: serve/gifts), save →
  setSettings module.* + clearModuleCache → 303 saved.
- worker.ts: reminders+digest crons early-return (log skip) when serve disabled
  (read via getEnabledModules with fresh clear? crons run in new isolates — direct
  read fine).
- e2e (all DB-toggled via SQL + clearModuleCache is per-isolate so e2e must toggle via
  the settings POST as admin OR insert row + new request against fresh... NOTE for
  implementer: the built-worker e2e hits a long-lived isolate — toggling via SQL then
  waiting out a 60s TTL is not viable; toggle via the admin settings POST (which busts
  the cache in-process) — assert: sermons off → /en/sermons 404 + nav link gone +
  /admin/sermons 404 + home latest-sermon section gone; toggle back on → 200 again;
  people key present in panel; serve off → /en/my 404 + reminders skip (unit covers
  cron, e2e covers route).
- Steps: TDD-ish (e2e cases first where practical) → implement → all gates + commit.

### Task 3: Docs + screenshots

**Files:** docs/features/modules.md (+ docs/images/diagrams/modules.svg, palette rules
as before), README (onboarding paragraph in "What's inside" or new "Pick your modules"
subsection + feature row), docs/features/cms-admin.md cross-link, screenshot
docs/images/admin/settings-modules.png (1280×800), settings.png refresh if layout moved.

- Content: plain-English "switch off what you don't need" story, module table (what
  each includes), how disabling behaves (pages hidden, nothing deleted — flipping back
  restores), soft-degrade examples. Gates unchanged (docs-only) + commit.

## Self-review checklist
All gates green; with everything default-on the public site is byte-equivalent except
nav markup ordering (no regressions); toggling each module off in dev shows no 500s
anywhere (spot 3 modules manually); dictionary parity green.
