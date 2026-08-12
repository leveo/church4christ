# Adoption, Attendance, Newcomers, and v0.2 Design

**Status:** Approved for implementation

**Date:** 2026-08-11

**Baseline:** `main` at `b85ad362`

## Context

Church4Christ now has truthful production-readiness documentation, a canonical
People/Household CSV importer, atomic D1 and PostgreSQL persistence, a bilingual admin
import flow, and pre-1.0 upgrade and release runbooks. The next program should make the
project materially easier for a church or implementation partner to adopt and operate,
not simply add unrelated modules.

The remaining gaps are:

1. CI uses GitHub Actions whose embedded Node runtime is deprecated and does not cancel
   superseded pull-request runs.
2. People data can be imported but cannot be exported in the same canonical shape, and
   source spreadsheets must be manually rewritten to the exact 18-column contract.
3. Groups has per-person attendance and Children's check-in has exact child records, but
   there is no structured adult service-count history.
4. `membership_status=visitor` is a label, not a first-visit intake and follow-up
   workflow.
5. Setup and doctor expose technical readiness, but staff have no shared visible
   go-live checklist in the admin application.
6. The repository has a release process but no real tag or GitHub Release.

This program closes those gaps and ends with a rehearsed `v0.2.0-beta.1`,
followed by `v0.2.0`. After the user-facing work is complete, it also captures
real screenshots and refreshes README and feature documentation.

## Goals

1. Remove the GitHub Actions runtime warning and avoid redundant PR CI work.
2. Add safe deterministic People/Household export and create-only source-column mapping.
3. Record adult attendance as a count per service date and service type while deriving
   child counts from actual Children's check-in rows.
4. Preserve Groups as a real per-person present/absent tracker.
5. Add a bilingual, permission-scoped newcomer intake and configurable follow-up
   pipeline that never creates or merges People without staff review.
6. Use one readiness catalog across CLI setup/doctor and an admin onboarding checklist.
7. Capture real application screenshots, update documentation, and publish a rehearsed
   beta and stable pre-1.0 release.

## Non-goals

- Recording which adults attended a service.
- Replacing or weakening Groups attendance.
- Manually entering child attendance.
- Automatically updating, merging, reviving, or granting privileges to People during
  CSV mapping or import.
- Including pastoral notes in the normal People export.
- Building a general CRM automation engine or unrestricted form builder.
- Adding campuses or a multi-site hierarchy.
- Enabling Stripe live payments.
- Publishing the private package to npm.
- Building the proposed cross-church marketplace.

## Delivery model

Work proceeds as vertical slices. Each product slice owns its D1 and PostgreSQL schema,
data layer, authorization, English and Chinese UI, documentation, and
risk-proportionate tests before merge.

| Slice | Outcome | Dependency |
|---|---|---|
| 1. CI maintenance | Supported action runtime and PR concurrency cancellation | None |
| 2. Portable exports | Canonical People/Household export and separate sensitive-notes export | None |
| 3. CSV mapping | Saved source-column mappings feeding the existing create-only importer | Slice 2 round-trip fixtures |
| 4. Service attendance | Adult counts, child-check-in association, reports | None |
| 5. Newcomer foundation | Schema, permissions, statuses, validation, duplicate hints | None |
| 6. Newcomer experiences | Public/admin intake, queue, assignment, notes, People review | Slice 5 |
| 7. Shared onboarding | Shared readiness catalog, CLI adapters, admin checklist | Slices 2–6 |
| 8. Visual/documentation pass | Real screenshots, feature guides, README, upgrade notes | Slices 2–7 |
| 9. Release | `v0.2.0-beta.1` rehearsal and release, then stable `v0.2.0` | Slices 1–8 |

Dependent slices merge sequentially. Independent work may use separate worktrees, but
each PR updates to the latest `main` and passes complete repository CI. Release
tags point only at green `main` commits.

## Slice 1: CI maintenance

The workflow retains its current full D1 and PostgreSQL coverage. This slice changes
execution mechanics, not test meaning:

- replace actions whose embedded Node runtime is deprecated with supported immutable
  major versions verified from the actions' official releases;
- keep the application runtime on the repository's `.nvmrc` and
  `engines` contract;
- key workflow concurrency by workflow and pull-request ref;
- cancel superseded pull-request runs, but never cancel a push to `main`; and
- set a 30-minute job timeout, above the observed 12–15 minute full-matrix duration.

Acceptance requires the runtime-deprecation annotation to disappear and both a PR run
and its post-merge `main` run to pass.

## Slice 2: portable People and Household exports

### Standard canonical export

Admins with full People-area access can download one or more deterministic UTF-8 CSV parts
whose header is byte-for-byte the existing 18-column import header. Each part stays within
the atomic import limits and a household is never split. Together the parts contain live
People, whether active or inactive, live households, and live name-only dependents.
Soft-deleted records are excluded. A structurally invalid or individually oversized
household fails closed for repair rather than being synthesized or partially omitted.
The route is `/admin/people/export.csv`, with explicit part selection when needed.

The export never includes `role`, admin areas, session/token state, security
flags, Stripe data, pastoral notes, or internal database ids. A clean re-import creates
safe `member` accounts under the existing canonical rules.

Household keys are deterministic only within the file, such as
`household-<sequence>`. Rows sort deterministically by household grouping and
normalized person identity so D1 and PostgreSQL snapshots agree.

The response uses `csvCell` formula neutralization,
`Cache-Control: no-store`, and a dated filename. The standard export is a
read-only GET.

### Sensitive pastoral-notes export

Pastoral notes use a separate POST-only export available only to
`super_admin`. The confirmation page identifies included data and requires a
literal acknowledgement. The CSV contains a portable person reference, note author,
body, and timestamps. It is never combined with the normal export or persisted on the
server. Confirmation and POST live under `/admin/people/export-notes`.

A new generic `audit_events` table stores only safe metadata: actor person id,
action kind,
timestamp, and bounded structural counts. It never stores note bodies, email addresses,
user-supplied filenames, or raw export contents. The event means server generation
completed, not that a browser download was observed.

### Export verification

- exact header and deterministic cross-backend snapshots;
- formula neutralization and UTF-8 quoting;
- household/dependent round-trip into a clean database;
- privileged and pastoral fields absent from the standard export;
- complete anonymous/member/editor/limited-admin/full-People/super-admin matrix;
- sensitive export requires POST, CSRF, super-admin, and acknowledgement; and
- errors and logs contain no exported PII.

## Slice 3: create-only CSV mapping

### Mapping model

The mapping page accepts the same bounded UTF-8/RFC4180 envelope as canonical import:
256 KiB, at most 200 data rows, and at most 100 households. Headers must be non-empty and
unique after normalization.

Each canonical field receives one source column, no value when optional, or an allowlisted
constant for fields such as `record_type`, `language`,
`membership_status`, `active`, `household_role`, and
`household_primary`. Enum translation maps normalized source values to canonical
enums.

The first version does not split a full name, concatenate columns, run arbitrary code,
infer households from names, or guess a primary adult.

Saved profiles contain a profile name, expected normalized source headers, field
mappings, constants, and enum translations. They never contain source rows, sample
values, inferred PII, or upload bytes. Profiles are installation-local and require full
People access. They persist in a dedicated `people_import_mappings` table; the
mapping workflow lives under `/admin/people/import/map`.

### Authoritative flow

    bounded source CSV
            |
            v
    server-owned mapping configuration
            |
            v
    canonical in-memory rows
            |
            v
    existing parser, grouping, and validation
            |
            v
    existing database preflight
            |
            v
    existing atomic create-only commit

The client preview is presentation only. Commit re-reads the uploaded file, reloads the
mapping, transforms it again on the server, and invokes the existing import contract.
A client cannot submit a canonical model, override a role, or change the operation to an
update.

Conflicting emails and same-name household warnings keep their existing meaning. The
mapper may display likely matches but never updates, merges, revives, or attaches to an
existing household.

### Mapping verification

- reordered and unfamiliar source headers;
- constants and enum translations;
- missing, duplicate, unknown, and drifting headers;
- physical source record numbers retained through mapping;
- no source bytes or values in saved profiles, logs, or errors;
- commit bytes and current mapping are authoritative;
- D1/PostgreSQL create-only parity and rollback; and
- canonical export through an identity mapping re-imports cleanly.

## Slice 4: aggregate service attendance

### Data model

`service_attendance` stores one record per
`(service_type_id, service_date)`:

- an integer `adult_count` from 0 through 100,000;
- `recorded_by` and `updated_by` person ids;
- created and updated timestamps; and
- a database unique constraint on service type and date.

There is no adult person id, adult roster, anonymous identifier, or first-time-visitor
count in this table.

`service_type_checkin_events` is an append/close-only effective-dated many-to-many association
between an existing service type and existing Children's check-in events. Each link has
a start date and optional end date, so changing today's mapping cannot rewrite which
events belonged to a historical service. For a service/date, child count is
`COUNT(DISTINCT household_member_id)` across links effective on that date.
A child present in two linked rooms therefore counts once. Checkout does not erase
attendance because the existing event/child/date row remains the source of truth.
Once a link has become effective, its service, event, and start date cannot be edited or
deleted through the application; replacement closes the current link and starts a new one
today so historical counts are not rewritten.

If no Children's event is linked, the UI displays "not configured" instead of zero.
Historical child counts remain readable when Children is disabled, while association
editing follows the Children capability gate.

### Admin and reporting flow

Admins with the attendance-area grant can record or correct adult numbers from a
date/service grid. Reports show adult, derived child, and combined totals by service/date,
bounded trends, and CSV export. A service count does not require a bulletin or volunteer
plan. `adult_count` includes every adult physically present, including a
first-time adult, but no separate newcomer number or identity is stored with attendance;
newcomer reporting comes from the independent intake workflow.

The admin surface is `/admin/attendance`, owned by a dedicated attendance
admin area rather than broad console access.

Attendance is an optional D1/PostgreSQL capability. It uses existing service types and
optionally uses Children.

### Groups invariant

Groups retains its current `group_attendance` behavior: every active member has
an explicit present/absent row per tracked occurrence, authorized group admins can
correct it, and member/profile history remains available. Aggregate service attendance
does not reuse, migrate, or overwrite Group rows.

Cross-backend and built-worker regressions prove that the Group checklist still records
individual members and that aggregate-attendance permission does not grant group-tracker
access.

## Capability and preset integration

Two capabilities are added to the generated catalog:

- `attendance` works on either database, owns
  `/admin/attendance`, and softly uses Children for derived counts.
- `newcomers` works on either database, owns public
  `/new-here` and admin `/admin/newcomers` prefixes, requires People,
  and optionally uses email.

The Website preset remains the focused eight-module publishing profile. Website +
Community grows from 14 to 16 D1-compatible modules, and Full Church grows from 17 to
19 modules. Generated capability documentation, setup selection, doctor, module
navigation, route policy, seed profiles, and every hand-maintained count update together.

## Slices 5 and 6: newcomer intake and follow-up

### Capability and permissions

`newcomers` is an optional D1/PostgreSQL capability with public route
`/[locale]/new-here` and admin subtree `/admin/newcomers`. It depends
on People for reviewed link/create outcomes and optionally uses email. Community and Full
Church presets enable it; Website does not.

The `newcomers` admin area is distinct from People. A newcomer worker can view
and update newcomer submissions, assignments, custom answers, and newcomer notes, but
cannot browse the full People directory, households, pastoral notes, roles, or security
fields. Super-admin has access by definition.

### Schema

- `newcomer_statuses`: stable id, non-editable open/closed category, sort,
  active flag, and an initial-status flag.
- `newcomer_status_i18n`: editable English and Chinese labels.
- `newcomer_fields` plus i18n labels: bounded optional questions using
  allowlisted text, textarea, select, and checkbox types.
- `newcomer_submissions`: name, normalized email/phone, locale, visit date,
  optional service type, consent timestamp, source, status, assignee, optional linked
  person, and lifecycle timestamps.
- `newcomer_answers`: bounded submission/field answers.
- `newcomer_notes`: private follow-up notes with author and timestamp.
- `newcomer_activity`: append-only workflow events for status, assignment,
  link/create, and closure.

Default statuses are New, Assigned, Contacted, Connected, and Closed. Administrators may
rename, reorder, add, or deactivate them. Every status retains its open/closed category
so reminders and reports do not depend on labels. Exactly one active open status is the
initial status for new submissions; the database and validation layer prevent removing
the last valid initial status. Assignment and status are separate explicit actions:
assigning a worker does not silently select a label whose name happens to be "Assigned."
New, Assigned, and Contacted are open by default; Connected and Closed are closed.

### Intake

Public and staff-entry forms share validation. Core fields are name, at least one of email
or phone, preferred language, visit date, optional service type, and contact consent.
Administrators may add optional questions.

Public submission requires explicit contact consent. Staff entry records whether consent
was obtained and cannot trigger automated contact without it.

The public endpoint uses bounded bodies/cells, a honeypot, database-backed keyed-hash
per-contact and trusted-client-IP rate limits,
generic success responses, and no raw-input logging. It creates only a newcomer
submission. It does not create a login, magic link, household, or Person.
The hash key is a managed secret; a missing secret fails closed without persisting plaintext
identifiers or accepting an unprotected submission.

Custom questions may be marked required, but the fixed contact/consent fields cannot be
removed or redefined. This release does not send automated newcomer marketing or
multi-step follow-up sequences.

### Review and follow-up

The queue supports status, assignee, due/overdue, visit date, and service filters. Detail
supports assignment, next-follow-up date, status changes, bounded private notes, and
custom answers.

The server shows duplicate hints using normalized email/phone against live and
soft-deleted People and open newcomer submissions. Hints never auto-link.

A newcomer worker may link an existing Person only through a narrowly scoped match
result. Creating a Person requires full People access or an authorized handoff, uses safe
member/visitor defaults, and never revives a soft-deleted email.

Linking or creating a Person does not copy newcomer notes or custom answers into pastoral
notes. The newcomer record remains the audit source and keeps its narrower permission
boundary.

Multi-table changes are transactional. Conflicts force a fresh read. Client-provided
status categories, assignment authority, person fields, or duplicate decisions are not
trusted.

### Newcomer verification

- module-off 404 and navigation hiding;
- full authorization matrix including newcomer-only and People admins;
- public/staff validation parity;
- consent, body, rate-limit, honeypot, duplicate, and enumeration behavior;
- configurable bilingual statuses/fields with stable open/closed categories;
- no implicit Person creation or merge;
- explicit link and authorized safe Person creation;
- notes absent from People, leader, public, logs, and errors; and
- D1/PostgreSQL transaction and built-worker parity.

## Slice 7: shared onboarding readiness

A declarative catalog owns stable check ids, category, severity, applicable
capabilities/services, English and Chinese copy keys, CLI remediation, and admin
destination links. It contains no Node-only imports and no secrets.

Environment adapters execute checks:

- setup/doctor adapters inspect local files, generated configuration, and provider
  command results;
- Worker/admin adapters inspect safe binding presence, enabled capabilities, database
  state, and application configuration; and
- manual operational checks use explicit acknowledgements stored with actor/timestamp.

Both adapters report stable statuses: `pass`,
`action_required`, `manual`, and
`not_applicable`. A check that cannot be proven never reports pass.

All authenticated admins may read the checklist, while only super-admin may acknowledge
manual operational checks. The admin checklist covers identity/branding/locales, service times, admin grants,
migration or a deliberate no-import decision, newcomer ownership, attendance/check-in
mapping, production origin/domain/email, enabled routes/jobs, backups, and a dated
restore-drill acknowledgement.

No secret, connection URL, provider response, member contact detail, or backup content is
rendered. Setup and doctor remain authoritative for infrastructure operations; the admin
checklist is not a deploy button or unattended migration tool.

## Slice 8: screenshots, feature guides, and README

After the user-facing slices pass built-worker E2E, capture real pages from seeded
production builds. Authenticated captures use test-only signed sessions against isolated
seed data rather than the development authentication bypass.
Mockups and generated UI images do not satisfy this requirement.

The committed screenshot set covers at least:

- canonical export and source-column mapping;
- service attendance entry/report with derived child count;
- public newcomer form;
- newcomer queue and detail/follow-up;
- onboarding readiness checklist; and
- the existing Groups member checklist, proving the per-person model.

The collection includes both English and Chinese UI. Every capture uses fictional seeded
data, a declared identity/backend, a fixed viewport, an expected marker, and sign-in/404
rejection. Images receive visual review for clipping, responsive overflow, contrast,
stale copy, and accidental PII.

README updates:

- add Attendance and Newcomers to the feature matrix and capability counts;
- describe canonical export and mapped create-only migration without promising merge;
- distinguish aggregate adult service counts, derived child counts, and individual
  Groups attendance;
- show real screenshots for decisive new workflows;
- update presets, backend/module tables, roadmap, maturity, and release status; and
- retain independent positioning without naming a comparison project.

Feature, deployment, upgrade, and release guides update in the same pass. User-owned
`output/` remains untouched; only reviewed assets under
`docs/images/` are committed.

## Slice 9: beta and stable release

### Beta

After all prior PRs merge and post-merge `main` CI passes:

1. finalize the changelog;
2. set package and lockfile to `0.2.0-beta.1` while retaining
   `private: true`;
3. prove clean D1 install and data-preserving upgrade from `b85ad362`;
4. prove clean PostgreSQL install and the same data-preserving upgrade;
5. run readiness and built-worker E2E for both providers;
6. merge the release PR and tag that exact green `main` commit; and
7. create a GitHub prerelease with upgrade notes and known limitations.

No npm publication or production deployment is implied.

### Stable

`v0.2.0` follows after beta findings are resolved and the upgrade matrix passes
again. The stable tag points to green `main` whose package version and changelog
agree. Historical merged/applied migrations remain immutable; fixes use new forward
migrations.

## Cross-cutting error handling and security

- Central route policy plus inline capability/area checks run before business reads or
  request-body processing.
- Public forms and CSV uploads are bounded before parsing.
- SQL values are bound and identifiers come from fixed allowlists.
- D1 and PostgreSQL use the shared `AppDb` seam and equivalent transactions.
- Errors expose stable codes and bounded structural metadata, never cells, notes,
  contacts, secrets, stack traces, or database text.
- No workflow trusts hidden browser JSON models.
- Multi-record writes are atomic and conflicts require a fresh preview/read.
- Email is best-effort only after state commits and only when consent/readiness permit it.
- Export and newcomer responses use private/no-store caching.
- Audit events describe actions and counts, not sensitive content.

## Verification strategy

Every slice begins with failing contract tests and includes:

1. pure parser/validation/state tests;
2. live D1 integration;
3. real PostgreSQL parity for new SQL, transactions, constraints, and races;
4. authorization and capability matrices;
5. built-worker HTTP/E2E;
6. English/Chinese key parity and exhaustive error-code coverage;
7. docs/token checks where applicable;
8. full `npm test`, `npm run check`, and
   `npm run build` before completion; and
9. post-merge `main` CI before dependent work.

The visual pass additionally runs screenshot automation, validates dimensions/markers,
and visually reviews each PNG at full and README display sizes.

## Program acceptance criteria

1. Superseded PR CI cancels, `main` CI does not, and the action warning is gone.
2. A People admin can export canonical data and re-import it cleanly without privileged
   leakage.
3. Only super-admin can generate the separate audited pastoral-notes export.
4. An admin can map a bounded external CSV, save a PII-free mapping profile, preview it,
   and use the existing atomic create-only import.
5. Staff can record one adult count per date/service type; child counts derive from linked
   check-ins and cannot be manually overridden.
6. Groups still records each active member present/absent per occurrence on both databases.
7. Public/staff newcomer intake enters a permission-scoped configurable queue without
   creating a Person.
8. Authorized staff can assign, annotate, close, link, or explicitly create a safe visitor
   Person without gaining unrelated People or pastoral-note access.
9. Setup, doctor, and admin share readiness ids and never claim unproven checks passed.
10. Real English/Chinese screenshots and README/feature/upgrade documentation accurately
    cover shipped workflows.
11. `v0.2.0-beta.1` and `v0.2.0` are tagged from green
    `main` after clean-install and data-preserving D1/PostgreSQL rehearsals.
12. No release includes user-owned `output/`, live member data, secrets,
    comparison-project naming, Stripe live mode, or npm publication.
