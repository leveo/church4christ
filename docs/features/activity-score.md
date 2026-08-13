# Activity score (explainable member engagement)

## What it does

Activity Score turns existing person-linked participation records into an explainable
member score and a church-wide summary. It is a pastoral monitoring aid, not a member-facing
rating or an automated decision. Open `/admin/activity-score` to review the current rolling
window, the immediately preceding comparison window, score-band distribution, and source
coverage.

The church chooses a window of 30, 60, 90, or 180 days and one or more supported dimensions:

- **Group attendance:** present records divided by recorded attendance opportunities.
- **Confirmed serving:** confirmed roster assignments divided by a configured target count.
- **Registration engagement:** confirmed, person-linked registrations for past events divided
  by a configured target. This is engagement, not event attendance, because registration does
  not prove check-in.

Enabled weights are positive whole numbers totaling 100. The combined score is the weighted
average of the available dimension scores, rounded from 0 to 100. The same calculation runs
for the comparison window so each person and the church-wide average show a change. Native
calculation details display each numerator, denominator or target, dimension score, and weight.

Membership status is only an eligibility filter. It never adds points. Giving, prayer data,
pastoral notes, and aggregate service attendance are explicitly excluded from the model.
Scores do not send messages, change roles, create care tasks, or make any other automatic
decision.

## Access and configuration

The **Activity Score** grant lets a limited admin view `/admin/activity-score`. A super admin
can view the same report and edit its church-wide configuration. The module depends on People
and optionally reads Groups, Volunteer Scheduling, and Registration; it works on D1 and
PostgreSQL, although Registration itself remains Supabase-only.

The report contains names, membership status, bounded counts, scores, and calculation details.
It does not expose email addresses, group names, serving positions, event names, or excluded
activity sources. A disabled Activity Score module returns 404; an admin without its grant
receives 403.

Configuration saves validate every field and use a revision check. Two admins cannot silently
overwrite each other, and an invalid or stale submission leaves the previous complete model
unchanged. Only currently available source modules can be selected.

## Source availability and limits

If a configured source module is disabled later, Activity Score excludes that dimension,
renormalizes the remaining available weights, and shows a warning. It does not turn missing
source data into a misleading zero. If no configured source is available, no member scores or
church-wide average are shown until a source is enabled or the model is updated.

The calculation is bounded to 5,000 eligible people and the page displays at most 100 filtered
rows. The summary always describes the full bounded population. Results are ordered by lowest
score, then normalized display name and person id. A malformed database row, invalid model,
query failure, or population-limit breach fails closed and shows no partial member list.

## Upgrade and implementation notes

Apply `migrations/0014_activity_score.sql` for D1 or
`migrations-supabase/0014_activity_score.sql` for Supabase/PostgreSQL before enabling the
module. The migration creates a singleton `activity_score_config` row and exactly three
`activity_score_dimensions` rows. Calculated person scores are not stored; the report computes
them live from the selected model and bounded evidence queries.

The pure formula and validation live in `src/lib/activityScoreModel.ts`; portable evidence and
configuration SQL live in `src/lib/activityScoreDb.ts`; orchestration is in
`src/lib/activityScoreService.ts`; strict POST parsing is in `src/lib/activityScoreForms.ts`;
and the server-rendered interface is `src/pages/admin/activity-score/index.astro`.
