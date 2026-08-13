# Activity Score Module Design

**Date:** 2026-08-12

## Purpose

Church4Christ will add an optional Activity Score module that turns existing,
person-linked participation records into an explainable per-person score and a
church-wide summary. The score is a pastoral monitoring aid, not an automated
judgment or a member-facing rating. An administrator chooses which supported
dimensions to monitor, their relative weights, the scoring window, and the score
bands.

The first release deliberately excludes giving, prayer requests, pastoral notes,
and aggregate service attendance. Those sources are either sensitive or cannot be
reliably attributed to an individual person. Membership status determines who is
eligible for scoring but never contributes points.

## Capability and authorization

`activity-score` is an optional community capability that works with D1 and
PostgreSQL. It owns `/admin/activity-score`, depends on People, and may use Groups,
Volunteer Scheduling, and Registration. The capability is available in the
Website + Community and Full Church presets, but not the Website preset.

A dedicated `activity-score` admin area controls report access. Super admins have
access by definition and may edit the scoring configuration. A non-super admin
must hold the activity-score area grant to view results and cannot edit the
configuration. The report exposes names, membership status, bounded activity
counts, scores, and calculation explanations. It does not expose email addresses,
group names, serving positions, registration names, prayer data, giving data, or
pastoral notes.

The middleware, route policy, admin-area classifier, admin navigation, dashboard,
and page-level checks all use the same capability and area ownership. A disabled
module returns 404 before session authorization; a signed-in but unauthorized
admin receives 403.

## Configuration model

There is one church-wide scoring model. A singleton `activity_score_config` row
stores:

- a rolling window of 30, 60, 90, or 180 days, default 90;
- included membership statuses, default `regular` and `member`;
- the lower bound for the active band, default 70;
- the lower bound for the watch band, default 40;
- a monotonically increasing revision;
- the person who last changed it and the update timestamp.

An `activity_score_dimensions` table stores one row for each supported dimension:

- `group_attendance`, default enabled with weight 50;
- `serving`, default enabled with weight 50 and target 3;
- `registration`, default disabled with weight 0 and target 2.

Enabled weights must be positive integers and total exactly 100. Disabled
dimensions have weight zero. Count-based targets are positive integers bounded to
100. The group-attendance dimension has no configurable target because its source
already has an opportunity denominator.

Configuration writes are atomic, validate every field on the server, and require
the revision the editor loaded. A stale revision produces a conflict response and
does not change either table. Changing the model immediately affects the next
report read; no score rows are rewritten because computed scores are not stored.

An enabled dimension must belong to a currently enabled source capability when a
configuration is saved. If that source capability is disabled later, the report
temporarily excludes its weight, renormalizes the remaining available enabled
weights, and displays a warning. If no configured source is available, the page
shows no score and directs a super admin to update the model.

## Eligible population and windows

The population contains live People rows whose account is active and whose
`membership_status` is included in the configuration. Soft-deleted and inactive
People are excluded. Membership status is only a filter.

The current window ends on the church-local current date and includes that date
and the preceding `window_days - 1` dates. The comparison window is the immediately
preceding equal-length period. All date bounds are passed explicitly to database
queries so tests, D1, and PostgreSQL use identical boundaries.

## Dimension calculations

Every source returns per-person evidence for both the current and comparison
windows. The scoring layer validates the returned ids and counts before combining
them.

### Group attendance

The source joins live `group_members` with `group_attendance` and tracked group
occurrences. For an eligible person:

```
group score = round(100 * present rows / recorded opportunity rows)
```

An opportunity is an explicit attendance row for that person in the window.
Because the existing tracker records every active group member as present or
absent, this denominator reflects recorded meetings rather than inferred calendar
events. A person with no recorded opportunity receives zero for this enabled
dimension. Coverage separately reports how many eligible people had at least one
recorded opportunity, so missing tracker use is not mistaken for observed absence.

### Serving

The source counts confirmed, non-deleted roster assignments whose non-deleted plan
date falls in the window:

```
serving score = round(100 * min(confirmed assignments / target, 1))
```

Unconfirmed, declined, deleted, and future assignments do not count. A person with
no confirmed assignment receives zero. Coverage is the number of eligible people
with at least one qualifying assignment.

### Registration engagement

Registration is available only when the Supabase-only Registration capability is
enabled. It counts confirmed registrations linked by `person_id` to past events
whose start date falls in the window:

```
registration score = round(100 * min(confirmed registrations / target, 1))
```

The interface calls this “registration engagement,” not attendance, because the
current registration schema does not record event check-in. Pending, cancelled,
unlinked, future, and deleted/unavailable event records do not count. A person with
no qualifying registration receives zero.

## Combined and church-wide results

For every eligible person, the current and comparison scores use the same formula:

```
combined score = round(sum(dimension score * available weight) / sum(available weight))
trend = current combined score - comparison combined score
```

The score is always an integer from 0 through 100. It is placed in one of three
configured bands:

- active: score at or above the active threshold;
- watch: score at or above the watch threshold and below active;
- limited activity: score below the watch threshold.

The church-wide score is the rounded arithmetic mean of all eligible individual
scores. The summary also reports the comparison mean and change, eligible-person
count, band counts, and per-dimension coverage. An empty eligible population
produces no average rather than zero.

No result triggers email, role changes, account changes, pastoral tasks, or other
automated actions.

## Admin interface

`/admin/activity-score` renders server-side in the existing Admin layout. It shows:

- the church-wide current average and change from the previous window;
- eligible-person and source-coverage summaries;
- the active, watch, and limited-activity distribution;
- warnings for unavailable configured sources;
- a GET filter for name, membership status, and score band;
- a bounded, deterministic per-person table containing current score, trend, and
  each available dimension score;
- a native `<details>` explanation for each visible person with raw counts,
  denominators or targets, weights, and the combined calculation.

The report calculation is bounded to 5,000 eligible people and fails closed with a
clear admin error if that limit is exceeded. The page displays at most 100 filtered
rows at once while church-wide summaries still describe the full bounded
population. Results are ordered by combined score ascending, then normalized
display name and person id so the members most likely to need review appear first.

For super admins, the same page contains a POST configuration form. Its checkboxes,
weights, targets, window, membership-status filters, thresholds, and revision are
all server-validated. A successful save redirects to a GET with a success marker;
invalid or conflicting input returns an explanatory, non-sensitive message.

All new user-facing copy is available in English and Chinese.

## Components and boundaries

- `activityScoreModel.ts` owns pure configuration validation, normalization,
  combination, bands, trends, filtering, and presentation-safe report types.
- `activityScoreDb.ts` owns configuration persistence, eligible-person reads, and
  the three source-evidence queries through `AppDb`.
- `activityScoreService.ts` orchestrates window creation, source availability,
  score calculation, coverage, warnings, summaries, and row limits.
- `activityScoreForms.ts` parses the configuration POST body into the strict model.
- `/admin/activity-score/index.astro` owns authorization re-checks, GET filtering,
  POST/redirect/get behavior, and rendering.

These boundaries keep scoring math independent from SQL, keep database reads
portable, and make every score reproducible from the displayed evidence.

## Failure behavior

Malformed database rows, invalid configuration, row-limit breaches, or failed
multi-statement writes produce typed errors. The admin page logs only a bounded
error kind and never logs names, activity evidence, form bodies, or calculated
person rows. A report failure displays no partial member list. A configuration
failure preserves the previous complete configuration.

Unknown dimensions, invalid weights, unsupported windows, empty eligibility,
invalid thresholds, out-of-range targets, duplicate source rows, and unsafe ids or
counts are rejected rather than coerced.

## Verification

The implementation will use test-driven development and cover:

- pure scoring boundaries, rounding, missing activity, unavailable-source
  renormalization, bands, trends, filters, ordering, and empty populations;
- strict configuration form parsing and validation;
- atomic configuration save, stale-revision conflict, rollback, source queries,
  date boundaries, exclusions, row validation, and limits in D1;
- equivalent configuration and activity query behavior in PostgreSQL when
  `DATABASE_URL` is available;
- capability catalog generation, preset membership, module gating, route policy,
  admin-area grants, navigation visibility, and page-level authorization;
- English and Chinese key parity;
- server-rendered dashboard, calculations, coverage warnings, filters, details,
  and super-admin-only configuration controls;
- the complete unit suite, Astro type checking, production build, and relevant
  built-worker end-to-end paths.

## Acceptance criteria

The module is complete when an authorized administrator can select supported
dimensions, weights, targets, membership statuses, thresholds, and a window; save
the model without partial-write or lost-update risk; view explainable current and
comparison scores for eligible people; and view a church-wide average,
distribution, trend, and data coverage. The behavior must be capability-gated,
privacy-bounded, bilingual, portable across the supported databases, and verified
by fresh automated test, check, and build evidence.
