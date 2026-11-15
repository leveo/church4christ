# Changelog

This file records changes that affect churches, nonprofit operators, implementers, and
maintainers. Version 1.0.0 is the initial open-source release; upgrade notes are part of the
change contract, so read the relevant entries before moving an installation forward.

Earlier development history is intentionally not reconstructed as releases. The source
package remains private because Church4Christ is distributed from this repository rather
than published to npm.

## [Unreleased]

### Added

- Language infrastructure (no operator action required for the language settings themselves). A registry of
  supported languages, installation-wide `locale.enabled` / `locale.default` settings editable
  under **Settings → Languages**, a requested → default → English fallback chain, language
  negotiation at `/` (cookie from the switcher, `Accept-Language`, default), a switcher that
  becomes a dropdown above three languages, a reusable per-language tabbed editor in admin
  forms, and `--locales` / `--default-locale` setup flags with a multi-select in onboarding.
  Upgraded installations keep exactly English and Chinese with English as the default; nothing
  changes until an administrator saves new language settings. Disabling a language hides it and
  never deletes content. Setup manifests are `schemaVersion: 2` (version 1 still reads) and
  onboarding preferences are `schemaVersion: 2` (version 1 still reads). `--locale x` alone keeps its
  earlier meaning (English and Chinese enabled, x the default); `--locales` narrows or widens the set. See [docs/i18n.md](docs/i18n.md).

### Changed

- Locale columns now reference a `supported_locales` lookup table instead of a hard-coded
  `CHECK (locale IN ('en','zh'))`, so adding a language later is an `INSERT`, not a schema
  change. Operator impact: apply the new forward migrations before deploying. D1 gets
  `0041`-`0049` (the lookup table, then rebuilds of the translation and related tables; back up
  first, rebuild time grows with table size), and Supabase/PostgreSQL gets `0041`. No data
  changes and no behavior changes; the application still offers English and Chinese until a
  language is added. See [Unreleased: language lookup migrations](docs/upgrade.md#unreleased-language-lookup-migrations).

- New Church4Christ logo: a teal church and cross sheltering an orange figure that forms a
  "4". The browser favicon, the onboarding page, the README header, and the 1280×640
  social preview use it, and the demo seed sets it as the demo church's logo
  (`site.logo_image_key`). Source files and colors are in `docs/images/brand/`. Existing
  installations keep their own uploaded logo; only the favicon changes for them.

## [1.5.0] - 2026-11-14

Upgrade notes: [Upgrading 1.4.0 to 1.5.0](docs/upgrade.md#upgrading-140-to-150):
[Member Portal on D1](docs/upgrade.md#member-portal-on-d1),
[Production Giving](docs/upgrade.md#production-giving),
[Service Planning](docs/upgrade.md#service-planning).

### Added

- Member Portal now runs on the default Cloudflare D1 database: households, groups and
  protected group files, calendar, opportunity discovery, and church, group, and private
  prayers. New D1 migration `0039_member_portal_d1.sql` adds the `group_files` and
  `prayer_items` tables. Demo prayer items are part of the D1 demo seed.
- Production Giving on Supabase and Stripe. Stripe now has an explicit live mode
  (`STRIPE_MODE=live` plus `STRIPE_LIVE_CONFIRMED=1`) alongside the default test mode.
  Checkout offers cards, wallets, and ACH bank debits (`us_bank_account`); Stripe emails
  per-payment receipts; donors change or cancel recurring gifts in Stripe's Billing Portal;
  yearly recurring gifts are supported. ACH gifts are recorded as pending and settle or fail
  from Stripe events.
- Giving ledger accuracy: each gift records live or test mode, the Stripe payment time
  (`paid_at`), refunded amounts (partial refunds are netted out), the charge id, and
  `disputed` status. Refunds and disputes are matched to gifts by the database, including
  refunds of recurring payments. `invoice.payment_failed` marks a recurring gift past due
  without any app email, and `customer.subscription.updated` syncs amount, interval, and fund.
- Annual giving statements: a printable page at `/my/giving/statement/<year>` and an admin
  page at `/admin/giving/statements` that queues a statement email for every donor, drained
  in small batches by the existing five-minute job (no new schedule).
- Giving admin: funds gain a description, a default flag, and a tax-deductible flag; manual
  gifts use the `giving.currency` setting; totals are per currency and net of refunds; CSV
  export of gifts; audit rows for manual gifts, fund edits, statement batches, and exports.
- PostgreSQL migration `0039_giving_production.sql` (details under Operator impact).
- **Service Planning** (`planning`, 服事流程): a timed run sheet for each service or event
  (live start times, fixed starts, overrun and overlap warnings, leader-only cue notes, print
  view, copy from a previous event), rehearsal sessions with called people and call times,
  member availability windows, a "find a time" search that ranks slots by conflicts, a team
  availability calendar, rehearsals and run-sheet duties in the member calendar and calendar
  feed, and automatic email on schedule, change, cancel, and a reminder. It is a new module in
  Volunteering that works on D1 and Supabase. See
  [`docs/features/service-planning.md`](docs/features/service-planning.md).

- The Supabase setup guide opens its Stripe section with a short, no-code overview for churches
  and nonprofits, linking Stripe's official pages for account activation, the nonprofit fee
  discount, receipts, the customer portal, ACH, keys, webhooks, and test cards.

### Changed

- Children's check-in and volunteer scheduling now work at phone width (375px): Today
  check-ins are cards with a full-width Check out button, the scheduling matrix and the
  availability grid become per-date and per-member cards, kiosk inputs open the right phone
  keyboard, and buttons, inputs and the admin top bar meet touch-size targets with 16px
  inputs. The Kiosk tab shows a QR code of the kiosk link, drawn on the server with the new
  `qrcode-generator` dependency (MIT, no dependencies). Forms that carried a `data-confirm`
  message (deleting a team or service type) now actually ask before submitting. The Accept or
  Decline email shows a short button instead of the raw link. Installing the update needs
  `npm ci` only; there are no migrations or settings to change.
- `portal` no longer requires the Supabase backend; only Giving and Registration do. A
  portal-only selection now resolves to D1, and a selection that also includes Giving or
  Registration still resolves to Supabase.
- Registration-dependent portal parts (event-scope prayers, event administrators, My
  registrations) are hidden, and no Registration table is read, when the `registration`
  module is off. `/my/serving` returns 404 when Volunteer Scheduling is off.
- Stripe objects and events must now carry a `livemode` equal to the configured mode;
  the previous hard `cs_test_` / `livemode: false` checks are gone. A mismatched event gets
  `400 livemode_mismatch` and is not stored (it was `400 live_mode_disabled`). Every Stripe
  request pins `Stripe-Version: 2025-03-31.basil`. Registration shares this client, so its
  paid checkout also follows the configured mode.
- The online give form is hidden, with a clear message, when Stripe is not configured for
  the current mode. The Billing Portal return URL now comes from `APP_ORIGIN`.
- Year totals on **My giving** bucket by the Stripe payment date in the church time zone and
  are net of refunds; test-mode rows count only on test-mode installations.
- The thank-you page says Stripe emails the receipt (the app never sent one).
- `people.stripe_customer_id` is now a legacy test-mode read fallback; customers live in
  `stripe_customers`, one per person per mode.

### Fixed

- The children's Kiosk tab QR label and hint, and the "My giving" link on the giving thank-you
  page, showed raw dictionary keys. A new test fails when any literal translation key used in
  source is missing from either dictionary.

### Operator impact

- D1 installations: apply the new migration `0039_member_portal_d1.sql` with the normal D1
  migration step before deploying. The migration keeps Member Portal off on an existing
  installation by recording `module.portal = 0` unless a choice is already saved; an
  administrator turns it on in **Settings → Modules**.
- Supabase installations are unaffected by the portal change: it has no PostgreSQL migration.
- **Supabase installations with Giving:** apply PostgreSQL migration
  `0039_giving_production.sql` with the normal Supabase migration step before deploying. It
  adds gift columns (`livemode`, `paid_at`, `refunded_cents`, `stripe_charge_id`), widens the
  gift method and status and recurring interval checks, and adds `stripe_customers`,
  `giving_statement_outbox`, `giving_audit_events`, and fund description / default /
  tax-deductible columns. Existing manual gifts become live; existing Stripe gifts stay test
  (they were test-only) and their `paid_at` is backfilled from `created_at`. Existing
  installations remain in test mode: no behavior changes until you opt into live.
- New variable `STRIPE_LIVE_CONFIRMED` (set to `1` together with `STRIPE_MODE=live`) is the
  explicit live opt-in; `STRIPE_MODE` now accepts `test` or `live`. Setup still provisions test
  mode and preserves a live opt-in when rerun. The webhook endpoint must be created at Stripe
  API version `2025-03-31.basil`; the doctor warns on stored events from another version.
- Update the Stripe webhook endpoint to the twelve events in the go-live checklist
  (`invoice.payment_failed`, `charge.failed`, `charge.dispute.created`, and
  `charge.dispute.closed` are new).
- No new bindings, secrets, or cron triggers. Statement emails ride the existing
  `*/5 * * * *` Supabase schedule.
- Service Planning: apply the new migration `0040_service_planning.sql` with your normal
  migration step before deploying: `npm run db:migrate:remote` on D1 and
  `npm run db:migrate:supabase` on Supabase (numbered `0040` there as well, after Production Giving's
  `0039`). It adds seven
  `planning_*` / `availability_windows` tables with `campus_id`, four default notification
  rules, and registers the new person references with the identity merge inventory. On an
  existing installation it also records `module.planning = 0`, so the module stays off until
  an administrator turns it on in **Settings → Modules**; a fresh installation follows the
  setup choices, and no preset includes Service Planning.
- Service Planning adds the `planning` administrator area, grantable on a person's page.
  Reminder emails use the existing daily reminder cron (`0 13 * * *`).

## [1.4.0] - 2026-11-14

Upgrade notes: [Upgrading 1.3.0 to 1.4.0](docs/upgrade.md#upgrading-130-to-140).

### Added

- Three focused setup presets: `checkin` (People & Households, Children Check-in),
  `volunteer-scheduling` (Volunteer Scheduling, Spiritual Gifts, People & Households), and
  `small-groups` (Groups, Fellowships, People & Households). They run on the default D1
  database and work with the installer's `--preset` flag.
- `npm run onboard -- --preset <key>` opens the browser form with that preset's features
  pre-checked; the form's reset button returns to the same preset.
- `config/editions.json` and `node scripts/editions/render.mjs` describe and render the
  single-feature edition repositories. Each edition is a README and agent guide that installs a
  pinned release of this repository with one preset; editions contain no application code.
  See [`docs/editions.md`](docs/editions.md).

### Operator impact

None for existing installations: no migrations, bindings, secrets, module defaults, or access
rules change. Existing presets keep their module lists. A preset's module list is recorded in
each installation's setup manifest, so the new presets' lists are fixed from this release on.

## [1.3.0] - 2026-11-13

### Added

- `npm run onboard` opens a local browser form for church, nonprofit, or campus identity,
  primary and secondary colors, a PNG/JPEG/WebP logo, language, first administrator,
  initial content, and feature checkboxes. It recommends the D1-backed Website + Community
  selection; Supabase-only modules require an explicit advanced choice. Preferences and
  uploaded logos stay in Git-ignored `.church/` files and can be reopened in later sessions.
- The existing installer accepts `--preferences .church/preferences.json` for both dry-run
  plans and setup. Initial setup applies identity and logo settings and stores brand colors
  locally for design-token generation. README, AGENTS.md, CLAUDE.md, and the setup guide
  describe the browser-first workflow and preference reuse by coding agents.
- Every deployment now serves a generated `/robots.txt` and `/sitemap.xml`. The sitemap
  lists public landing pages for enabled modules and published custom pages in English and
  Chinese with hreflang alternates; robots.txt names the sitemap and disallows admin,
  signed-in, token, kiosk, and API paths. Indexable public pages add Open Graph and Twitter
  card tags, and the home page adds a schema.org `WebSite` description.
- Optional `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` Worker variables render
  search-console ownership meta tags; malformed values are ignored.

### Changed

- Canonical, hreflang, and Open Graph URLs now use the deployment's `APP_ORIGIN` (falling
  back to the request origin) instead of the build-time `site` in `astro.config.mjs`, so
  each church's pages point at its own domain.
- Refresh npm dependencies, including Astro 7.3.3, React 19.3.0, Tailwind CSS 4.3.3,
  Wrangler 4.135.0, and current compatible adapters, fonts, types, and utilities.
  Replace `@cloudflare/vitest-pool-workers` with its official successor,
  `@cloudflare/vitest-plugin` 1.1.13. Keep TypeScript 6.0.3 and Vitest 4.1.11 because
  the Astro checker and Cloudflare test plugin do not yet support their newer major
  versions. Pin the checker's language server to 2.16.16 to avoid false frontmatter
  parsing errors in 2.17.0; see the
  [dependency compatibility notes](docs/upgrade.md#1-identify-what-will-change).
- Recognize the updated workerd socket-close message in the existing narrowly scoped
  PostgreSQL end-to-end test cleanup filter. Other unhandled errors still fail the suite.

### Upgrade notes

- From 1.2.0, no database migration is added: the latest forward migration remains
  `0038_community_workflows.sql` on both backends. Run `npm ci` and rebuild after pulling
  the dependency refresh. Node.js 22.22.1 remains the minimum runtime. No reseeding,
  bindings, secrets, or deployment procedure changes are needed; follow
  [the upgrade runbook](docs/upgrade.md#upgrading-120-to-130).
- Confirm `vars.APP_ORIGIN` is the domain visitors use: canonical links, `/robots.txt`, and
  `/sitemap.xml` now come from it. Then submit `/sitemap.xml` to search consoles if wanted.
- Onboarding only saves local preferences; it does not create resources or deploy a site.
  Existing installations need no migration, reseeding, new binding, or secret for this
  workflow. Use the existing upgrade/configuration process for subsequent site changes;
  saving new preferences does not overwrite the installed brand.
- Preserve `.church/preferences.json`, its uploaded logo, and `.church/branding.json`
  when moving an organization's build to another machine. Initial setup generates brand
  tokens; `npm run tokens` and production builds regenerate them from the local brand file.
  Organization type and time zone remain preference context for further customization;
  this form does not change the application's scheduling time zone.

### Documentation

- README now leads with what the project is (open-source church management software,
  church CMS, and a self-hosted Planning Center alternative), adds project badges, a
  feature comparison with its current gaps, an FAQ, and a Chinese summary. `package.json`
  gains description, keywords, homepage, repository, and issue links; it stays private.
- Add `llms.txt` and `CITATION.cff` at the repository root, a 1280×640 social preview image
  at `docs/images/social/social-preview.png`, and a "Search engines" section in the
  deployment guide.

### Fixed

- Community workspace entry buttons now persist the selected campus through the existing
  campus switch endpoint, so navigation to fellowships, groups, and workflows keeps its
  context. Workflow save redirects also retain the selected campus, including email links.

## [1.2.0] - 2026-09-15

### Added

- Campus community workspaces can directly manage Groups and member follow-up. Optional
  Fellowships add independent membership, meeting details, a default coordinator, and child
  groups. Existing groups remain directly managed by their campus until explicitly assigned.
- Reusable campus and fellowship workflows provide manual and new-member enrollment,
  assigned steps, due dates, progress notes, completion, cancellation, and reminder controls.
  Members receive a private task workspace. All new interface and email copy is English.
- Cloudflare email reminders use the existing hourly cron and EMAIL binding, with atomic
  delivery claims, failed-send backoff, pause controls, and explicit recovery for uncertain
  delivery. Reminders are disabled unless WORKFLOW_EMAIL_ENABLED=1.

### Upgrade notes

- From 1.1.0, apply all outstanding forward migrations 0027 through 0038 for the selected
  backend before deploying 1.2.0. These include the existing campus, identity, and Planning
  Center updates as well as 0038_community_workflows.sql on D1 and Supabase/PostgreSQL.
- Preserve existing database, R2, authentication secrets, and provider configuration; use
  [the upgrade runbook](docs/upgrade.md). This release does not reseed church data.
- Review [community workflows](docs/features/community-workflows.md) before enabling email.
  Confirm the sending domain, EMAIL_FROM, and APP_ORIGIN. No new cron trigger is required.
- Community administrators need the existing Groups grant. A fellowship coordinator label
  does not grant admin privileges. Identity merges with community references require review.


### Security

- Upgrade Astro, its Cloudflare/React adapters, Wrangler, the Workers test pool,
  and affected transitive dependencies to clear the 13 npm audit findings.
  Keep Vitest on its compatible 4.x release line. Pin native install-script
  approvals for npm 12. Operator impact: run `npm ci`, rebuild, and follow the
  normal deployment process to use the patched packages. No database migration,
  reseeding, secret, or application configuration change is required.

### Changed

- Renewed all 21 core modules with Sanctuary typography, forest-green navigation,
  purpose-specific public/member/admin workspaces, responsive layouts, keyboard
  editor controls, and nine bundled decorative images. English interface and demo
  presentation stay English; Chinese pages retain bilingual support. Existing
  personal names, messages, editor inputs, and authorization boundaries remain.
  README now includes 29 refreshed application screenshots and a repeatable capture
  inventory. No image service or API key is required for the packaged design.
- First setup now describes both starting-content choices explicitly and accepts
  `--no-demo-data` alongside `--demo-data`. Both keep the bundled design; no-demo setup
  retains schema, operational defaults, modules, church settings, and the first admin
  without sample business records. Noninteractive setup still defaults to no demo data.
  New managed initialization records `site.demo_content` without overwriting an existing
  choice. Operator impact: no migration or reseeding is required; neither flag clears an
  existing installation, and existing content remains protected during reruns and feature
  selection changes. Legacy initialized databases retain their absent content marker.
- Setup preserves Wrangler's structured stdout error messages when stderr is empty,
  extracting only the bounded, redacted diagnostic field. This keeps fresh-database
  detection working with JSON command errors without dumping query results or secret
  fields. No dependency change or operator action is required.
- Fresh administrator setup now creates its trusted verified contact and audit
  records atomically, so both demo choices can sign in after member-identity
  migrations. Reruns do not reverify existing or revoked ownership. PostgreSQL
  query compatibility fixes cover child attendance, scoped team scheduling, and
  security contact labels; PostgreSQL identity sessions require UTC as documented.

## [1.1.0] - 2026-08-18

### Added

- Added the optional Learning module on D1 and PostgreSQL for Sunday school, discipleship,
  and similar ministries. Its bilingual authenticated learner pages show provider-authoritative
  course/activity metadata, click-to-load privacy-enhanced YouTube, safe provider files and
  links, due dates, and submitted/returned state; assignments and quizzes remain in the provider.
- Added official Google Classroom OAuth/API support with minimal read-only and notification
  scopes, course mapping, renewable Pub/Sub registrations, authenticated notification receipts,
  bounded scheduled/manual/notification sync, and durable disconnect cleanup.
- Added Church4Christ Learning — Canvas Edition integration through scoped Canvas OAuth/REST and
  signed Live Events. The separately operated derivative is based on Canvas LMS by
  **Instructure, Inc.**, pinned to upstream commit
  `1c9f0bb8013ed69c4f2efe11fd483025469b7e6c`, licensed under GNU AGPL v3, and is not endorsed by
  Instructure, Inc.
- Added bounded provider retry/backoff, fair scheduled scans, fail-closed reconnect state, and
  PII-free structural synchronization logs while preserving the last complete learner snapshot.
- Added an optional Activity Score module on D1 and PostgreSQL with configurable group
  attendance, confirmed serving, registration engagement, and default-disabled Learning
  engagement dimensions; explainable member calculations, coverage, trends, and summary.
- Added the fictional local Genesis 1 Sunday-school demo, bilingual learner/admin screenshots,
  and the gpt-image-2-generated Learning workflow diagram and provenance.

### Security

- Provider credentials use a versioned AES-256-GCM server-side envelope; OAuth state, callbacks,
  notification identity, allowed provider origins, URLs, response sizes, pages, items, elapsed
  time, D1 queries, and provider subrequests fail closed at bounded limits.
- Learning stores only the normalized metadata needed for the hub. Grades and answers are not
  stored; comments, assignment bodies, uploaded files, file bytes, raw provider bodies,
  continuation tokens, and provider credentials never enter learner HTML or Activity Score.
- Google Classroom and Canvas remain provider authoritative. Church4Christ launches provider
  submission UI and never acts as a second gradebook, quiz engine, or file proxy.

### Upgrade notes

- Upgrade 1.0.0 installations by backing up and rehearsing the matched Worker/database/R2 and
  provider configuration in staging, then apply forward migrations `0017_learning.sql` through
  `0026_activity_score_learning.sql` in numeric order on D1 or Supabase/PostgreSQL before
  deploying 1.1.0. Do not rewrite frozen migration history or roll code back alone after `0026`.
- Existing installations must already have `0016_activity_score.sql`; 1.1.0 preserves that
  configuration and extends it only through forward migration `0026_activity_score_learning.sql`.
- Migrations `0017`–`0019` add the provider-neutral Learning graph, bounded sync leases, and URL
  policy fingerprint; `0020`–`0022` add Google OAuth/Pub/Sub receipt lifecycle and cleanup saga;
  `0023`–`0024` add Canvas OAuth/Live Events and cleanup saga; `0025` adds fair scheduling; and
  `0026` adds default-disabled Learning engagement to Activity Score without rewriting `0016`.
- Configure `LEARNING_CREDENTIAL_KEYS` before authorizing either provider. Google and Canvas
  credentials, Pub/Sub resources, Canvas allowed origins, cron verification, retention policy,
  provider disconnect, and the separate Canvas service/source obligations require operator work;
  `npm run doctor -- --strict` does not prove a successful provider round trip.

## [1.0.0] - 2026-08-12

### Added

- Added a canonical People/Household export for admins with full People access. Downloads
  use the exact 18-column create-only importer contract, partition households atomically
  across bounded CSV parts, and fail closed when records require repair.
- Added a separate super-admin-only pastoral-notes export with explicit acknowledgement,
  bounded CSV output, and PII-free `audit_events` records containing only actor, time,
  action kind, and numeric structural counts.
- Added immutable create-only source-column mapping profiles for People CSV imports. The
  workflow detects exact header-order drift, supports explicit constants and enum
  translations, and retains configuration without source rows or samples.
- Added aggregate Service Attendance on D1 and PostgreSQL: authorized staff can record and
  correct adult service totals, derive optional distinct child totals from historical
  check-ins, and download bounded identity-free CSV reports. Groups per-person attendance
  remains separately authorized.
- Added bilingual Newcomer follow-up on D1 and PostgreSQL: a consented public intake form,
  scoped staff queue and actions, exact-match People handoff, and super-admin configuration.
- Added a shared bilingual launch-readiness catalog used by setup, doctor schema v2, and an
  always-on admin checklist. Super-admin manual acknowledgements are versioned, and restore
  drills expire after 90 days.
- Added a fail-closed `v1.0.0` upgrade rehearsal from the immutable historical baseline for
  forward D1 and isolated-schema PostgreSQL migrations.
- Added operator runbooks for reviewing, staging, backing up, applying, verifying, and
  recovering from future upgrades.
- Documented the maintainer-only process for creating v1.0.0 and future releases.

### Changed

- Staging upgrade instructions now require an explicit staging Wrangler environment or
  configuration for both D1 migrations and deployment.

### Fixed

- Corrected contributor guidance to use the project's five current rules consistently.

### Security

- Database export examples keep backups and PostgreSQL credential files outside the
  repository and keep connection URLs and passwords out of `pg_dump` arguments.
- Staging and production upgrade steps require operators to verify the exact non-secret D1 or
  Supabase/Postgres target identifiers before migration.
- Newcomer public rate limits store only keyed hashes and counters, ignore forwarded client
  headers, and fail without writing when the managed rate-limit secret is unavailable.

### Upgrade notes

- Apply forward migration `0011_people_exports.sql` before deploying the pastoral-notes
  export. It creates the `audit_events` table and actor/time index on D1 and
  Supabase/PostgreSQL; audit failures suppress the sensitive CSV.
- Apply forward migration `0012_people_import_mappings.sql` before deploying saved People
  mappings. It creates the bounded `people_import_mappings` profile table on D1 and
  Supabase/PostgreSQL; profiles store headers and mapping configuration, not uploaded rows.
- Apply forward migration `0013_service_attendance.sql` before deploying the Attendance
  admin console. It creates `service_attendance`, `service_type_checkin_events`, and
  `service_checkin_link_state` on both D1 and Supabase/PostgreSQL; no adult roster is stored.
- Apply forward migration `0014_newcomers.sql` before enabling Newcomers. It creates the
  bilingual form configuration, queue, activity, operation receipt, and hashed rate-limit
  tables on both D1 and Supabase/PostgreSQL.
- Apply forward migration `0015_onboarding.sql` before opening the launch checklist. It
  creates versioned manual acknowledgement storage on D1 and Supabase/PostgreSQL.
- Migration files `0001` through `0015` in both `migrations/` and `migrations-supabase/` are
  the frozen `main` baseline. Disposable local/CI databases do not freeze a proposed migration
  before merge, but merge to `main` or use by a persistent/shared/deployed installation does.
  Corrections after that boundary must use a new numbered forward migration.
