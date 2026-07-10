# Groups (small groups with events and attendance)

## What it does

**Groups** gives your church a home for its small groups — a Bible-study circle, a young-adults
gathering, a prayer partnership. Each group has a name, a description, and one or more **group
admins** who run it day to day, so the site admin sets a group up once and then hands the keys
over.

- **A public directory, with private groups too.** A group can be **public** — listed in the
  groups directory and visible to anyone, signed in or not — or **private**, in which case it is
  hidden from everyone but its own members. A private group's page behaves exactly like a page
  that does not exist, so nobody can discover it by guessing addresses.
- **Joining is a request, not a free-for-all.** A visitor who finds a public group signs in (or
  creates an account with just a name and an email — the same magic-link sign-in the rest of the
  site uses) and taps **Request to join**. The group admin approves or declines each request.
- **Members without accounts still count.** A group admin adds members by searching the
  church's existing profiles, or by typing just a first and last name — email and phone
  optional. With an email, the person gets a real profile they can later sign in with; without
  one, they are kept as a name-only member, the same way households record children.
- **Routine events, on a schedule.** Weekly meeting? Every-other-week dinner? Monthly hike?
  Group admins create **routine events** with a recurrence, and the site materializes the
  calendar of upcoming occurrences automatically.
- **Attendance, without homework.** Turn on **attendance tracking** for a routine event and,
  when a meeting ends, every group admin gets an email with a link to a simple checklist — tick
  who came, done. The link works for three days and only opens that one meeting's sheet.
- **Special events ride on Registration.** For an event that is open to sign-ups beyond the
  group — a retreat, an outreach dinner — the group links or creates an event in the
  [Registration](registration.md) module instead of duplicating it, so sign-ups, questions,
  capacity, and payment all work exactly as they do everywhere else. (Registration needs the
  Supabase backend; on the default database this section simply does not appear.)
- **History on the profile.** A member's profile — their own view and the admin's person page —
  shows their group memberships, their attendance from tracked meetings, and their Registration
  sign-ups, so a pastor can see someone's involvement at a glance.

## How your team uses it

**Setting up a group (site admin).** Groups are created from **Admin → Groups**: a name, a
description, and public or private. From the group's page the site admin searches people and
assigns one or more **group admins**. That is the whole setup — everything after this point is
the group admin's job.

**Running a group (group admin).** A group admin opens their group and follows **Manage
group** to a single page with everything: the member roster (add by search or by typing a
name, remove, promote another admin), pending join requests with Approve/Reject buttons, the
public/private switch, and the group's routine events. No admin-area access is needed — a
group admin is an ordinary member with extra rights over their own group only.

**Joining a group (member or visitor).** The **Groups** link in the site navigation lists
every public group. Opening one shows its description, its upcoming gatherings, and who leads
it. A signed-in visitor can request to join on the spot; a signed-out one is invited to sign
in or create an account first — a name and an email is all it takes, and the confirmation
link arrives by email as usual. Members see their own groups — including private ones — at
the top of the directory.

**Tracking attendance.** When creating a routine event, the group admin ticks **Track
attendance**. After each occurrence ends, the hourly background job mails every group admin a
tracker link. The page lists every member — admins included — with a checkbox each; save, and
the record is kept. Missed the email? A signed-in group admin can open the same sheet from
the manage page's attendance history at any time. The emailed link expires after 72 hours and
can be used more than once within that window, so a mistake can be corrected.

**Special events.** On the manage page (when Registration is available), a group admin links
an existing registration event or creates a new free one — title, dates, location — and the
event appears both on the group's public page and on the site-wide `/register` list. Pricing,
custom questions, and the roster are managed by staff in the Registration admin as usual.

**Who sees what.**

- The **directory and public group pages** are open to everyone; a public group shows its
  description, schedule, leader names, and member count — the full member list is visible
  only to the group's own members.
- **Private groups** are invisible to non-members everywhere: directory, page, and search.
- The **manage page** opens only for that group's admins and site admins; anyone else sees
  "not found," the same as a page that does not exist.
- The **attendance sheet** opens only from an emailed tracker link or for a signed-in group
  admin of that group.

## How it fits together

A site admin creates the group and appoints its admins. The group admin manages the roster
and join requests, schedules routine events, and — when a tracked meeting ends — receives the
attendance email from the hourly cron, whose link opens the checklist. Special events hand
off to the Registration module, and both attendance and registrations flow back onto each
member's profile as activity history.

## For developers

- **Module:** `groups` in `src/lib/modules.ts` — public prefixes `/groups`, `/signup`,
  `/attendance`; admin prefix `/admin/groups` (site-admin route class); soft `uses` of
  `people` and `registration`. Works on both backends; only the Registration link-up is
  Supabase-gated (by the `registration` module's own backend requirement).
- **Schema:** `migrations/0006_groups.sql` and `migrations-supabase/0005_groups.sql` —
  `groups`, `group_members` (nullable `person_id` = name-only member, the household-dependents
  precedent), `group_join_requests` (partial unique index on pending), `group_events` +
  materialized `group_event_occurrences` (the `ensureWeeklyPlans` precedent, generalized to
  none/weekly/biweekly/monthly), `group_attendance`, and `group_attendance_tokens` (a
  dedicated token table because `tokens.purpose`'s CHECK cannot be altered in SQLite). The
  Supabase file also carries the Supabase-only `group_reg_events` link table.
- **Data layer:** `src/lib/groupDb.ts` (groups, membership, join requests, people search,
  profile activity), `src/lib/groupEventDb.ts` (events + occurrence generation),
  `src/lib/groupAttendance.ts` (tokens, attendance upsert, the cron pass),
  `src/lib/groupRegDb.ts` (Supabase-only Registration links). Form parsing in
  `src/lib/groupForms.ts` / `groupEventForms.ts`.
- **Attendance links:** minted by the hourly cron (`0 * * * *` in `wrangler.jsonc` →
  `sendAttendanceEmails` in `src/worker.ts`), which first tops up occurrences (+35 days), then
  atomically claims each just-ended tracked occurrence (`attendance_email_sent_at`) so a retry
  or concurrent pass can never double-send, then emails every group admin through the
  `sendEmail` choke point (kind `attendance`). Tokens are 32 random bytes, stored only as a
  SHA-256 hash, bound to (occurrence, admin), and expire after 72 hours; they are multi-use
  within that window by design (an attendance sheet needs corrections), with first use stamped
  for audit. The tracker page (`/attendance/<token>`) re-verifies the token on every POST, and
  a session variant (`/attendance/o/<id>`) accepts a signed-in group admin instead.
- **Authorization:** group admins are ordinary members; their console lives on the public-side
  `/groups/<id>/manage` page with in-page checks (site admin or `isGroupAdmin`), never the
  `console` route class — and unauthorized viewers get the same 404 a private group gives.
  Every mutating action on the manage page is scoped to the group's own rows.
- **Tests:** `test/groupDb.test.ts`, `test/groupEventDb.test.ts`, `test/groupAttendance.test.ts`,
  `test/groupForms.test.ts`, `test/groupEventForms.test.ts` (workers project),
  `test/pg/groupRegDb.test.ts` and the `groupDb`/`groupEventDb` blocks in
  `test/pg/parity.test.ts` (Postgres), and `test/e2e/groups.e2e.test.ts` (built worker).
  See [Modules](modules.md) for the on/off behavior.
