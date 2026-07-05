# Slice 6 — Volunteer Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Full volunteer management: plans/scheduling, matrix, assignments with conflict
detection, open-slot claims, blockouts, my-schedule + calendar + iCal, applications,
gifts quiz, testimonies, admin console tabs (ministries, wizard, applications, email,
availability), reports.

**Architecture:** Direct feature port of `/Users/leosong/Python/dcfc-serve` (lib:
planDb, ministryDb, adminOverviewDb, emailSettingsDb, digest, notify, ical, giftQuiz,
giftDb, testimonyDb + pages + components + tests), adapted to: i18n companion tables
(team/position/ministry names via i18nJoin from `src/lib/db.ts`), no congregation
column, locale-prefixed routes `/{locale}/serve/...` + `/{locale}/my...`, unified
locals.user, dictionaries for ALL copy, token-only styling, `src/lib/planDb.ts` already
holds `respondToAssignment` (slice 3) — extend, don't duplicate.

## Global Constraints

- Authorization invariant (port verbatim): every position-touching write re-derives the
  team from position_id server-side (`canEditPosition`: admin or leader of that team).
  Volunteers can only mutate their own assignments/blockouts (verified by person_id).
- Conflicts are warnings: `getConflicts` (blockout overlap incl. partial-day time-range
  auto-resolve vs service start/end; same-day double-booking) → `'conflicts'` result
  unless `force`; claims NEVER force. `respondToAssignment` refuses past services
  (`plan_date >= date('now','-1 day')`).
- Plan generation: idempotent weekly generation through clamped +370d; new empty plans
  copy needs from nearest earlier plan of same service type having needs.
- Open-slot claim: team member only, slot open + not full (needed minus non-declined),
  not already assigned, conflict-free → status 'C', is_signup=1.
- Emails via lib/email.ts only; all best-effort; bilingual per person.lang (or both
  stacked when unset) — port `bilingualEmail` helper into `src/lib/notify.ts`; vars
  HTML-escaped. Touchpoints: scheduling request (+notified_at), decline notice → team
  leaders, application received → leaders, application result → applicant.
- Crons in worker.ts: `0 13 * * *` → `sendReminders(env)` honoring email_rules
  remind7/remind3 (re-send to still-U at exactly 7/3 days out); `0 14 * * 4` →
  `sendWeeklyDigest(env)` gated by digestAM (non-declined next-7d per person).
  `0 9 * * *` backup remains slice 7.
- Gifts quiz: `src/data/gift-questions.json` — 40 questions, 9 gifts, each question
  `{id, tags:[gift], text:{en,zh}}`; gift definitions `{code, label:{en,zh},
  definition:{en,zh}, ministries:[category]}`; scoring normalized count/max, top-3 →
  recommended categories; signed-in saves gift_results; "add to my interests" bulk
  insert person_interests; leaders see potential volunteers (interest ∪ latest-gift
  recommendation, badged) on team page. Write original bilingual question copy
  (spiritual gifts: teaching, service, mercy, giving, leadership, hospitality,
  evangelism, encouragement, administration).
- Reports: per-person confirmed/upcoming/declines/last-served over `?months=` window
  (default 12), CSV export with formula-injection neutralization (prefix `'` on
  `=+-@` starts).
- iCal: RFC 5545, CRLF, escaped text, timed via service start/end else all-day,
  UID stable per assignment, `/cal/[token].ics` by calendar_token.
- Commits per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Tasks

### Task 1: planDb core (generation, conflicts, assign, claim, respond, remove) + tests
Extend `src/lib/planDb.ts`; port dcfc-serve planDb + its full test file (adapt names).
Also `listOpenSlotsForPerson`, `getTeamAvailability` (availability matrix data),
`ensureWeeklyPlans`. This is the module's engine — port faithfully.

### Task 2: serve pages: plans, plan detail, matrix, teams, team detail
`/{locale}/serve/plans/{index,[id]}.astro`, `/{locale}/serve/matrix/{index,
[serviceTypeId]}.astro`, `/{locale}/serve/teams/{index,[id]}.astro` + components
(StatusBadge, needs editor, assign picker w/ conflict redirect confirm, potential
volunteers list). Port page logic; all copy via dictionaries.

### Task 3: my-schedule, calendar, blockouts, profile, apply, respond completion
`/{locale}/my/{index,calendar,blockouts}.astro`, `/{locale}/profile.astro`,
`/{locale}/profile/[id].astro`, `/{locale}/serve/apply.astro` (works signed-out via
magic-link issuance), MonthCalendar + ServingHistory components, `src/lib/ical.ts` +
`/cal/[token].ics.ts`. Blockouts: ranges, optional times (reject half-filled), recurring
weekly/biweekly 2–26 materialized w/ recurrence_group, series delete. Tests: ical
format, blockout validation, mySchedule filtering.

### Task 4: gifts quiz + testimonies + applications review
`/{locale}/serve/gifts.astro` (quiz form → results cards → save/interests),
`/{locale}/serve/testimonies.astro` (list published by locale + submit form honeypot),
gift-questions.json + `src/lib/{giftQuiz,giftDb,testimonyDb}.ts` + tests (port
giftQuiz tests incl. all-gifts-mapped, dedupe; testimony publish/return idempotence).

### Task 5: admin console tabs + email settings + reports + crons
`/admin/ministries` tabs (overview/applications/ministries/new-wizard/email/availability
— port the 6 tab components), `/admin/service-types`, `/admin/teams`, `/admin/reports`
(+`.csv.ts`), `src/lib/{adminOverviewDb,emailSettingsDb,digest}.ts`, notify.ts
completion, worker.ts cron wiring. Wizard: 4-step progressive form; weekly+autoGenerate
→ service type + 8 weeks plans batch. Tests: overview stats admin vs leader,
needs-attention, email rules/templates/fillTemplate/log, digest window, reminders
rule-gating, wizard creates ministry+team+positions+plans, CSV neutralization.

### Task 6: volunteer e2e sweep
Magic-link → claim open slot → appears in /my + ics; leader assign w/ conflict → force;
decline → leaders emailed (email_log devlog rows); apply → application P + leader email;
gifts quiz POST → results render; role matrix on serve/admin console routes. Fix findings.

## Self-review checklist
Full suite green (incl. all ported tests), tokens:check, check, build, smoke; manual:
wizard creates ministry end-to-end; matrix assign; blockout warning honored; digest
dry-run via test. `rg -n "congregation" src/` → 0 hits.
