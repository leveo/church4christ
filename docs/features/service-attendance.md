# Service attendance (aggregate worship counts)

## What it does

**Service Attendance** gives authorized staff a bilingual grid at `/admin/attendance` for
recording the number of adults at each service and reviewing adult, child, and combined
totals over time. Adults are stored only as an **aggregate total** from 0–100,000. The
feature stores no adult identity, name, roster, anonymous identifier, or newcomer count.

Child totals are not typed into a second box. When the optional
[Children's check-in](children-checkin.md) module is enabled, an Attendance admin can link
each service type to one or more check-in events. Reports then derive the child total from
the real historical check-ins. [Groups](groups.md) attendance remains a separate,
per-person checklist with its own authorization; the Attendance grant does not open it.

## How your team uses it

**Record or correct a service.** Pick an existing service type, choose the service date,
enter the adult aggregate total, and save. Entering the same service and date again corrects
the count. The first recorder is retained for audit, while the authenticated person making
the correction becomes the latest updater. The page and CSV never display those internal
actor ids or any adult identities.

Attendance reuses the service types configured by Volunteer Scheduling, but the Attendance
module does not depend on Serve. If no service types exist, the page asks a super-admin or
Serve admin to configure service types. An attendance-only admin cannot edit service types.

**Review or export a bounded report.** The grid is driven by dates with a recorded adult
row; a child-only date does not create a service row. The default window is 84 days and the
maximum is 366 days. A larger window is rejected instead of truncated. The query fails
closed above 5,000 rows, and CSV generation is capped at 2 MiB. CSV downloads use the same
date-descending, service-order results as the grid and contain only the date, numeric service
id, service name, adult count, child count, and combined count.

**Link Children's check-in events.** With both Attendance and Children enabled, use the link
editor to select up to 100 check-in events for each service. Saving replaces today's open
mapping by closing old rows and appending new rows; effective date ranges are half-open
`[starts_on, ends_on)`. There is no past-date backdating or destructive history editor.

For a recorded service date, the child calculation is
`COUNT(DISTINCT household_member_id)` across every check-in event effectively linked on
that date. A child checked into two linked rooms counts once. Checked-out children still
count, and check-ins from an event that is now inactive still count in history. **Not
configured is different from zero**: no effective link produces “Not configured” and a
null combined total, while an effective link with no check-ins produces child count zero.

Turning Children off hides the link editor and makes its mutation endpoint return 404.
When Children is off, historical reports remain readable, including their previously
derived child totals, because reporting reads stored links and check-ins without requiring
the current Children module toggle.

## Who can use it

- Turning the Attendance module off makes the entire `/admin/attendance/**` subtree return
  404, even for a super-admin and before a request body is read.
- An admin without the Attendance grant gets 403. A limited admin with the Attendance grant
  and every super-admin can view the grid, record corrections, manage links while Children
  is on, and download CSV reports.
- The Attendance grant is aggregate-only. It does not grant a Groups member checklist or a
  person's Groups attendance history. Those require the separate Groups authority described
  in [Groups](groups.md); emailed Groups tracker tokens continue to work as before.

## How it fits together

Service types label the rows, `service_attendance` stores one adult aggregate per service
and date, and date-effective links connect a service to historical Children check-ins.
Corrections change the aggregate, not the first-recorder audit field. Turning modules off
does not delete any of these records, so restoring Attendance restores its grid and turning
Children back on restores the link editor.

## For developers

- **Schema:** `migrations/0013_service_attendance.sql` and
  `migrations-supabase/0013_service_attendance.sql` create the same three capability-owned
  tables on D1 and PostgreSQL: `service_attendance`, `service_type_checkin_events`, and
  `service_checkin_link_state`. Adult rows contain counts plus recorder/updater audit ids,
  never an adult person or roster relationship.
- **Data and validation:** `src/lib/serviceAttendanceForms.ts` owns strict dates, integer
  counts, the 84/366-day windows, and stable bilingual-safe error codes.
  `src/lib/serviceAttendanceDb.ts` owns correction UPSERTs, append/close link replacement,
  and bounded aggregate reports. `src/lib/serviceAttendanceCsv.ts` owns deterministic,
  formula-safe UTF-8 CSV output.
- **Routes:** `src/pages/admin/attendance/index.astro` is GET-only;
  `count.ts` and `checkin-links.ts` are POST-only; `report.csv.ts` is GET-only. Each handler
  checks module and area authorization before reading a body or querying attendance data.
  CSV and error responses are `no-store` and `nosniff`, and unsupported methods return 405
  with an `Allow` header.
- **Tests:** focused D1 and PostgreSQL data/form/CSV suites cover the shared semantics.
  `test/e2e/attendance.e2e.test.ts` and `test/e2e-pg/attendance.e2e.test.ts` exercise the
  built Worker, including module/grant ordering, CSRF and method handling, correction audit,
  child aggregation, Children-off history, Groups isolation, and identity-free CSV.
