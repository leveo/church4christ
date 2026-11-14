# Service Planning (run sheets, rehearsals, and availability)

## What it does

**Service Planning** is where a church plans the order of a service or event and gets the right
people to the right rehearsal. It sits next to [Volunteer Scheduling](volunteer-serve.md): the
volunteer schedule answers *who serves in which role*, and Service Planning answers *what happens
minute by minute, and when do we rehearse*. It is off for existing installations until an
administrator turns it on in **Settings → Modules**.

- **A run sheet with a live clock.** Each planning event (a Sunday service, a Christmas program, a
  retreat) has an ordered list of items: segments, songs, headings, and notes. Give every item a
  length in minutes and the sheet works out each start time from the event's start. An item can
  also have a *fixed start time* — the clock jumps to it. The page warns when a fixed start falls
  before the previous item has finished, and when the total runs past the event's target end.
- **Owners and cue notes.** An item can belong to a team, a person, or free text ("a reader from
  the congregation"). Leaders can add **cue notes** that only coordinators and the leader print
  ever show.
- **A printable sheet.** One click opens a print view with the columns time, length, item, owner,
  and notes. Coordinators can switch to the *leader print*, which adds the cue notes.
- **Copy from a previous event.** Start a new Christmas run sheet from last year's instead of from
  nothing.
- **Rehearsals and prep sessions.** Each event can have sessions with a date, a time, a place, and a
  note in English and Chinese. Call a whole team, or individual people, and give anyone a different
  call time.
- **Availability.** Members tell planners when they *can* serve — a single date or a weekly window
  over a date range — next to the blockout dates they already keep. A private note on a window
  stays private.
- **Find a time.** For a session, the page suggests slots across up to 31 days in 30-minute steps.
  Every called person is checked as **blocked** (a blockout), **busy** (another rehearsal or a timed
  volunteer assignment), **available** (inside an availability window), or **unknown**. Slots with
  the fewest conflicts, then the fewest unknowns, come first. Pick one and it fills in the session
  form.
- **A safe publish step.** Scheduling a session checks everyone again. Anyone blocked or busy stops
  it with a message naming them; unknowns need an explicit "schedule anyway" tick.
- **Calendars.** A team availability calendar (week or month; the whole team, just you, or one
  person) helps coordinators see who is free. Scheduled rehearsals and the run-sheet items a person
  or their team owns also appear in the member's own **My calendar** and in the calendar
  subscription feed. Private notes and cue notes are never exported.
- **Automatic email.** When a rehearsal is scheduled, moved, or cancelled, the people called are
  emailed in their language (both languages when they have none saved). A reminder goes out a set
  number of hours before a rehearsal. Each rule has an on/off switch on the planning admin page.

## How your team uses it

**Setting up (site admin).** Turn the module on in **Settings → Modules**, then open
**Admin → Service planning**. Create an event with a title, date, start time, and an optional
target end. Grant a colleague the **Service planning** area on their person page to let another
admin manage every event. The *Notifications* box on the same page switches each email on or off
and sets the reminder lead time.

**Planning an event (admin or coordinator).** On the event page, add run-sheet items, move them
with the Up and Down buttons, and fix any that must start at a certain time. Add **coordinators**
— ordinary members who can edit *this event only*. When it is ready, **Publish** the event so the
people involved can see it.

**Rehearsals.** Open the **Rehearsals** tab, create a session, and call people by team or one at a
time. Choose **Find a time** to see suggestions, use one, then **Schedule and notify**.

**Sharing availability (every member).** From **My schedule → Blockouts**, follow the link to
**Availability** and add a one-off date or a weekly window. Planners only ever see "available" or
"blocked", never the note or the reason.

**Who sees what.**

- Admins with the **Service planning** area, and an event's own coordinators, can open and edit it.
- People called to a non-draft rehearsal, and owners of a run-sheet item (directly or through a
  team), can read the published event. Their own items are highlighted; cue notes are hidden.
- Everyone else gets "not found", the same as an event that does not exist.

Local fixtures and the demo seed do not prove that email reaches a real inbox; check delivery on
your deployment as described in [Email automation](email-automation.md).

## How it fits together

Planning reuses what the church already keeps: people, teams, blockout dates, and the volunteer
roster. Availability and busy time feed the "find a time" check; the daily reminder job that
already sends volunteer reminders also sends rehearsal reminders; the same calendar token feeds
both volunteer and planning events into a member's calendar app. Nothing here changes the volunteer
schedule itself.

## For developers

- **Module:** `planning` in `config/capabilities.json` (group `volunteering`, soft `uses` of
  `serve`) — public prefixes `/planning` and `/my/availability`; admin prefix `/admin/planning`
  (site-admin route class plus the `planning` admin area). It works on D1 and Supabase and is in no
  preset, so an installation's recorded module list is unchanged.
- **Schema:** `migrations/0040_service_planning.sql` and `migrations-supabase/0040_service_planning.sql`:
  `planning_events` (with the `revision` optimistic lock and a nullable `plan_id`; the app treats a
  soft-deleted plan as unlinked), `planning_event_coordinators`, `planning_items`,
  `planning_sessions`, `planning_session_people` (`notified_at`, `reminded_at`),
  `availability_windows`, and `planning_notification_rules`. All carry `campus_id`. The migration
  registers the new person references for identity merges.
- **Pure logic:** `src/lib/planningModel.ts` — `computeRunSheet`, `timeStatus` (blocked > busy >
  available > unknown, half-open intervals), `findCandidates`, availability-window weekday logic.
- **Data and workflows:** `src/lib/planningDb.ts` (every event or run-sheet write passes the
  revision it loaded; `bumpRevision` is the single gate), `planningService.ts` (schedule, reschedule,
  cancel with the conflict re-check), `planningNotify.ts` (email and the reminder pass),
  `planningCalendar.ts` (member sessions and duties, ICS events, team calendar), `planningAccess.ts`.
- **Email:** kinds `planningPublish`, `planningChange`, `planningCancel`, `planningRemind` in
  `email_log`. Reminders run in the existing `0 13 * * *` reminder cron (`sendPlanningReminders`);
  there is no new cron trigger.
- **Pages:** `src/pages/admin/planning/index.astro`, `src/pages/[locale]/planning/[id]/*`
  (run sheet, `manage`, `sessions`, `calendar`, `print`), and `src/pages/[locale]/my/availability.astro`.
- **Tests:** `test/planningModel.test.ts`, `planningForms.test.ts`, `planningDb.test.ts`,
  `planningNotify.test.ts`, `planningAccess.test.ts`, `planningCalendar.test.ts` (workers project),
  `test/e2e/planning.e2e.test.ts` (built worker), and the schema checks in `test/pg/`.
  See [Modules](modules.md) for the on/off behavior.
