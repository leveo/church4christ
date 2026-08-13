# Changelog

This file records changes that affect churches, nonprofit operators, implementers, and
maintainers. Church4Christ is pre-1.0, so upgrade notes are part of the change contract:
read the relevant entries before moving an installation forward.

The `Unreleased` section starts after baseline commit
[`20b67f3`](https://github.com/leveo/church4christ/commit/20b67f3). Earlier development
history is intentionally not reconstructed as releases. The `0.1.0` value in the private
package metadata identifies the current source tree; it does not claim that a `0.1.0` tag
or GitHub Release exists.

## [Unreleased]

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
- Added an optional Activity Score module on D1 and PostgreSQL with configurable group
  attendance, confirmed serving, and registration-engagement dimensions; explainable member
  calculations; source coverage; comparison trends; and a church-wide summary.
- Added operator runbooks for reviewing, staging, backing up, applying, verifying, and
  recovering from future upgrades.
- Documented the maintainer-only process for creating future pre-1.0 release checkpoints.

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
- Apply forward migration `0015_activity_score.sql` before enabling Activity Score. It creates
  the singleton scoring configuration and dimension rows on both D1 and
  Supabase/PostgreSQL; calculated member scores are not stored.
- Migration files `0001` through `0015` in both `migrations/` and `migrations-supabase/` are
  the frozen `main` baseline. Disposable local/CI databases do not freeze a proposed migration
  before merge, but merge to `main` or use by a persistent/shared/deployed installation does.
  Corrections after that boundary must use a new numbered forward migration.
