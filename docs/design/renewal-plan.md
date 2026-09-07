# Church4Christ design renewal

User-approved direction: the seven generated concept boards from September 5, 2026.
Scope: redesign every enabled core module, including public, member, leader, admin,
and kiosk experiences. Preserve real workflows, authorization and provider boundaries.
English routes must render English UI and English demo content; Chinese routes may
include bilingual copy. Bundle all visual assets so a fresh setup reproduces the design.
No runtime image-generation service, external stock-image host or API key is required.

## Visual direction

Warm ivory, white work surfaces, forest green primary/navigation, restrained borders,
8–12px radii, serif public/editorial headings and clean application typography.
Purpose-specific layouts: editorial homepage, media library, bulletin editor with preview,
people/household master-detail, care board, newcomer queue, serving matrix, touch kiosk,
course player and operational ledgers. Module accent colors supplement text/icon states.
Accessible navigation, visible keyboard focus, responsive layouts and reduced motion.
Retain selectable Harvest/Midnight themes; renew default Sanctuary with light/dark parity.

## Delivery batches and acceptance evidence

- [x] 1. Foundation: Sanctuary tokens, public/admin/member shells, grouped contextual menus,
  reusable icons/page anatomy, module accents; token contrast and navigation authorization tests.
- [x] 2. Public front door: home, visit/newcomer card, beliefs/staff, sermons, articles,
  testimonies, ministries/fellowships/groups discovery; packaged image assets and locale-safe demo data.
- [x] 3. Content: actionable Sunday workspace, bulletin editor/reader, prayer sheets,
  sermon editor/library, announcements/events, custom page builder and revisions.
- [x] 4. Care: searchable people directory/household details, import/export wizard,
  newcomer queue/detail, scoped prayer board; retain create-only imports and consent checks.
- [x] 5. Ministry: serving matrix, plans, teams, applications, availability, gifts,
  groups attendance/files/join requests and scoped leader panels.
- [x] 6. Gatherings: date-led event discovery, free registration and roster,
  children kiosk/check-out and dashboard, aggregate attendance chart/history correction.
- [x] 7. Member/learning: personal dashboard, opportunity discovery, household,
  calendar, serving, giving history, scoped prayer, course catalog/player, provider admin.
- [x] 8. Operations: offline giving ledger/funds/reconciliation, explainable activity
  score, campuses, resource grants, modules/settings/navigation, email and launch readiness.
- [ ] 9. Release validation: all 21 modules explicitly checked against this inventory;
  English/Chinese desktop/mobile screenshots, keyboard checks, fresh setup/media verification,
  Node/Workers/Postgres tests as appropriate, Astro check, token lint, production build,
  smoke and E2E. Review diff and publish/merge verified batches to main as appropriate.

## Required boundaries

No changes to frozen migrations. No exposure of private member/prayer data through public
pages. Menus retain module and area/role gates. No local homework submission or grading:
learning submission remains provider-authoritative. Stripe remains preview/test-only.
Giving/prayers/pastoral notes stay excluded from activity scoring. Aggregate attendance
reports remain identity-free. Generated mockup numbers/copy are not product specifications.

## Evidence log

- Locale audit: English dictionaries and one-way text fallback fixed; public English sermons,
  prayer sheets, and testimonies now select eligible source content. Shared bilingual demo
  fields use English defaults without rewriting user records or frozen migrations.
- Bulletin source selection: `src/lib/publicDb.ts` now uses the same editorial eligibility
  rule for English latest, archive, service tabs, and dated reads, including announcements.
  Latest scans older candidates; archive limits follow eligibility. Chinese fixtures and
  dedicated person/roster names remain intact. The no-metadata heuristic can omit bilingual
  editorial prose; its exact scope and limitations are documented in `docs/i18n.md`.
- Serving-plan source: the title/series source is `src/lib/planDb.ts`, used by plan readers
  and the team matrix. Optional English display subtitles are separate from raw content;
  IDs, assignments, names and messages are unchanged. `myDb` serving/calendar queries do
  not select plan title/series, so they require no language-driven scheduling changes.
- Bulletin/plan regression evidence: 17 failing cases observed before implementation;
  117 tests then pass across public, scheduling, team, member, admin-content and campus-scope
  suites. Coverage includes 105 newer announcement-ineligible bulletins, older English
  fallback, Chinese access, archive limits, and unchanged names/assignments/messages.
  Built-renderer regressions are ready in public and volunteer-sweep E2E suites; their run
  remains part of the shared build validation.
- Fresh demo prayer requests use English names and messages because those shared records
  have no locale field. This is seed authoring only: existing user-entered names and messages
  are preserved, and Chinese bulletin, sermon, and prayer-sheet examples remain localized.

- Baseline source: main 0b0737a (PR #35).
- Worktree: .worktrees/design-renewal; branch: codex/design-renewal.
- Existing untracked output/ and .pnpm-store/ in the main checkout are left untouched.
- Baseline full suite: 223 files passed / 38 skipped; 3,411 tests passed / 371 skipped (270.32s).
- Foundation implemented: Sanctuary light/dark palette, contextual admin sidebar, mobile account actions, header mega menus, editorial homepage, sermon feature, actionable Sunday dashboard. Member shell, personal dashboard, opportunity cards, household, prayer, giving history, calendar and course catalog/player now implemented; remaining admin/ministry/gathering module bodies continue below.
- Nine optimized same-origin decorative WebP assets bundled (<1 MB total), independent of demo selection.
- Foundation focused checks: 23 tests across navigation/theme/assets; token lint passes.
- Visual check: actual desktop homepage/admin and 390px admin disclosure/profile/account controls inspected in Codex browser.
- Demo setup: explicit choices/flags and setting; actual clean D1 no-demo initialization and safe rerun pass, including legacy fingerprint-change preservation.
- Demo collections: 37 marked samples, list/detail gating, generic evergreen prose. Three built-renderer cases pass.
- Locale: English dictionaries, navigation/builder fallbacks, sermon/bulletin/prayer/testimony source selection, serving display subtitles and shared seed defaults implemented.

- Public reading batch: media sermon library, editorial article list/detail, printable bulletin/prayer readers and contextual archives; desktop and 390px reader/media layouts inspected.
- Care batch: people directory/detail, import/map progression, newcomer queue/detail and six-stage prayer care board. 299 focused care/import tests; built form/permission regressions pass.
- Member batch: one module-aware navigation, dashboard response priority, opportunity photography, household/contact columns, prayer composer/feed, dated event tickets, giving ledgers, semantic calendar/agenda and course contents/player. Compact footer retains theme switching; readonly independent review found no remaining regressions.
- Integrated checkpoint: production build and all 324 D1 E2E tests across 26 files pass; Astro check has 0 errors / 0 warnings; token lint passes. Full Node/Workers suite: 231 files passed / 38 skipped, 3,495 tests passed / 371 skipped (329.50s).
- PostgreSQL integration: isolated loopback-only PostgreSQL 18 test cluster; 539 tests across 45 suites pass. Built PostgreSQL E2E: 43 tests across 11 files pass (24.81s).
- Preview-only setup config, secrets, dependency symlink, database/media state and screenshots stay uncommitted. Tracked wrangler configuration restored to the repository default.

## Second implementation checkpoint and release review

All 21 principal module bodies now have dedicated layouts; see [module-coverage.md](module-coverage.md) for routes and boundaries. The second batch includes the publishing editors and live local previews, page-builder keyboard controls, serving matrix/teams/leader tools, public discovery and welcome forms, gatherings/kiosk, ledgers, provider administration, settings, and utility pages.

- Combined Node/Workers checkpoint: 3,517 passed / 371 skipped, 235 files passed / 38 skipped (325.72s). Astro: 721 files, 0 errors / 0 warnings. Production build and token lint passed.
- Combined built-worker checkpoint: D1 330/330 across 27 files; PostgreSQL 43/43 across 11 files. This includes six new locale-aware token presentation cases.
- Actual browser review covers 1280px desktop, 1024px settings, 641px groups and 390px mobile. Verified bulletin preview/repeat rows, page-builder keyboard select/move/undo, gift progress, team search/no-results/reset, ministry wizard focus/review, Chinese navigation, and Sanctuary dark mode. The newcomers scroll container now contains its visually hidden table heading; 390px document width returned from 627px to 375px.
- Giving summaries show counts instead of combining different currencies. Ledger rows preserve explicit currency; reconciliation amounts are labeled minor units where no currency is supplied. The current-month label uses the existing localized month formatter, not the SQL '-31' query sentinel.
- Date-dependent attendance E2E fixtures are isolated from demo check-ins during the UTC-Monday/Chicago-Sunday overlap; production count and provenance behavior is unchanged.
- Actual PostgreSQL children rendering exposed unquoted camelCase aliases. Three query aliases now retain their field names in both providers. Three real PostgreSQL regressions, 26 D1 tests, and one built-child-dashboard regression pass after the minimal query correction.
- Kiosk browser review found missing theme attributes in its standalone shell. The shell now uses the configured theme/default mode; the existing search → household → pickup-code E2E was observed red and then all six children E2E cases passed. Desktop and 390px household selection now render the packaged illustration, colors, rounded cards and touch controls.
- PostgreSQL team-detail review found SQLite-only JSON expansion in volunteer suggestions. The query now uses provider-specific JSON expansion with the same exact matching and source/exclusion semantics. Two real PostgreSQL regressions and 14 existing D1 tests pass; actual mobile team detail renders successfully.
- Release review found that origin/main advanced to 21a01ac (member identity, PR #36). Integrate that upstream change, preserve its identity/security contracts, rerun the combined checks, finish the remaining browser sweep, and publish/merge the verified branch. No release completion is claimed at this checkpoint.
