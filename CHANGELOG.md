# Changelog

This file records changes that affect churches, nonprofit operators, implementers, and
maintainers. Version 1.0.0 is the initial open-source release; upgrade notes are part of the
change contract, so read the relevant entries before moving an installation forward.

Earlier development history is intentionally not reconstructed as releases. The source
package remains private because Church4Christ is distributed from this repository rather
than published to npm.

## [Unreleased]

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
