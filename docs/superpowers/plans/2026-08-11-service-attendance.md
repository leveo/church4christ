# Aggregate Service Attendance Implementation Plan

> **Required execution skills:** subagent-driven-development, test-driven-development,
> workers-best-practices, and verification-before-completion.

**Goal:** Store adult service totals only, derive children from real check-ins, and keep
Groups as a separately authorized per-person tracker.

**Delivery:** One PR using migration `0013_service_attendance.sql` in both backends.

## Fixed semantics

- One `service_attendance` row per service type/date; `adult_count` is integer 0–100000.
- Adults include every physically present adult, including newcomers, but no adult id,
  roster, anonymous key, or newcomer count is stored.
- Child count is `COUNT(DISTINCT household_member_id)` across effective event links and
  ignores checkout state. No valid link means `null/not configured`; a configured link
  with no check-ins means zero.
- Links use half-open dates `[starts_on, ends_on)`. Replacing today's mapping ends the old
  link and starts the new one today. Past-date backdating is not available in v1.
- Effective links are append/close only. Once `starts_on` has become effective, service,
  event, and start date are immutable and rows are never deleted through the application.
  An open link may only be closed at today; a mistaken same-day link is closed to a
  zero-length interval before its replacement. Existing check-in rows are never deleted by
  Attendance. Historical correction outside this rule is deliberately unsupported in v1.
- For one `(service_type_id, checkin_event_id)` pair, effective date ranges may never
  overlap and at most one row may be open. D1 and PostgreSQL use the same transactional
  preflight plus a current-open uniqueness backstop; concurrent replacements resolve to
  one success and one safe conflict. Every stored interval satisfies `ends_on > starts_on`
  except the explicitly allowed same-day zero-length cancellation, which is never effective.
- Reports are driven by recorded adult rows. A child-only date does not create a service
  report row. Combined total is null when children are not configured.
- Default report window is 84 days; maximum is 366. Over-limit results fail and ask for a
  smaller range rather than truncate.
- Attendance uses existing service types but does not require Serve. An empty state asks
  a super-admin/Serve admin to configure service types; attendance-only staff cannot edit
  them.

## Files

- Create: `migrations/0013_service_attendance.sql`
- Create: `migrations-supabase/0013_service_attendance.sql`
- Create: `src/lib/serviceAttendanceForms.ts`, `serviceAttendanceDb.ts`, `serviceAttendanceCsv.ts`
- Create: `src/pages/admin/attendance/{index.astro,count.ts,checkin-links.ts,report.csv.ts}`
- Create: Workers, real PG, and built-worker D1/PG attendance test files.
- Modify: `config/capabilities.json`, `src/lib/adminAreas.ts`, `src/lib/routePolicy.ts`
- Modify: `src/lib/groupAttendance.ts`, `src/pages/attendance/o/[id].astro`
- Modify: Admin navigation/dashboard/grant UI, setup doctor, seed, en/zh i18n, docs, and
  capability count tests.

## Task 1: Schema parity

- [ ] Write D1 schema RED tests for `service_attendance` and
  `service_type_checkin_events`, their FKs, unique keys, date indexes, and adult range.
- [ ] Explicitly assert the adult table has no person roster, child count, or newcomer
  column.
- [ ] Add both migrations and run D1 GREEN.
- [ ] Repeat schema and constraint cases against real PostgreSQL.

## Task 2: Pure forms and date windows

- [ ] RED/GREEN tests for blank/non-integer/negative/100001 adult values, both legal
  boundaries, strict calendar dates, default 84-day range, and maximum 366 days.
- [ ] Implement `parseAdultCountForm`, `parseServiceCheckinLinkForm`, and
  `parseAttendanceWindow` with stable PII-free error codes and exhaustive en/zh keys.

## Task 3: Adult save and correction

- [ ] Test first insert, same-date correction, actor ownership, and unique race.
- [ ] Implement portable UPSERT so first writer remains `recorded_by`/`created_at`; each
  correction changes only count, `updated_by`, and `updated_at`.
- [ ] Use only the authenticated actor id, never form actor data.

## Task 4: Effective check-in links and child aggregation

- [ ] Test no-link null, linked/no-check-in zero, duplicate child across two rooms one,
  checked-out child one, inactive event history, and mapping replacement preserving prior
  dates.
- [ ] Aggregate directly from historical `checkins`; do not join current household member
  state or filter event active/checkout state.
- [ ] Allow link editing only when both Attendance and Children are enabled and the actor
  has Attendance access. Historical reports remain readable after Children is disabled.
- [ ] Add mutation tests proving an effective link cannot be deleted, backdated, moved to a
  different service/event, reopened, or have its start changed; close+insert today is the
  only replacement operation and prior child totals remain byte-for-byte stable.
- [ ] Test adjacent half-open ranges, overlapping-range rejection, a single current-open
  link, concurrent double replacement, and same-day zero-length cancellation on D1 and
  real PostgreSQL.

## Task 5: Reports and CSV

- [ ] Implement bounded grid/report queries and a pure `serviceAttendanceCsv` using
  `csvCell`, CRLF, deterministic date-desc/service-order sorting, UTF-8 attachment, and
  `Cache-Control: no-store`.
- [ ] Test adult, child, combined, null combined, formula service names, and `limit+1`
  rejection.

## Task 6: Capability and permission surface

- [ ] Add `attendance` to both backends, `/admin/attendance`, Community and Full presets,
  with optional Children use and no Serve dependency. Intermediate counts become 18 total,
  Website 8, Community 15, Full 18.
- [ ] Add a grantable `attendance` area and admin-only route while preserving public
  `/attendance/**` ownership for Groups.
- [ ] Add module-off 404, no-grant 403, full-grant/super 200, and Children-edit gate tests.

## Task 7: Preserve and harden Groups per-person attendance

- [ ] Change `canRecordAttendance` to accept `SessionUser`: allow a Groups-area actor,
  super-admin, or the occurrence's active group admin; remove the current any-admin bypass.
- [ ] Keep token attendance unchanged.
- [ ] Test attendance-only denial, Groups-grant allow, active group-admin allow, super allow,
  and explicit present=1/absent=0 rows for every active/name-only member.
- [ ] Add built-worker D1 and PG regressions proving aggregate access never grants the
  member checklist or personal history.

## Task 8: Admin UI, seed, docs, and delivery

- [ ] Implement the bilingual date/service grid, correction form, link editor, bounded
  report and download. All mutation handlers gate before body reads.
- [ ] Seed fictional counts and event links; update doctor table ownership and schema
  parity tests.
- [ ] Update attendance/children/groups/module/admin-permission docs and changelog.
- [ ] Run focused tests, full tests/check/build/docs/tokens, built-worker D1, real PG, and
  built-worker PG.
- [ ] Merge after green PR CI, verify exact main SHA CI, then delete branch/worktree.
