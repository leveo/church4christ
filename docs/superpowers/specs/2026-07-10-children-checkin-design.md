# Children's Check-in — Design

Date: 2026-07-10
Status: Approved for implementation (autonomous session; owner directive recorded in session goal)

## Goal

Parents check their children in at a self-service kiosk on Sunday morning. Admins
configure which check-in events the kiosk offers, and a dedicated **Children**
admin section shows a live roster for today plus a weekly attendance chart.

Core requirements (from the owner):

1. Kiosk: search by **child name** or **parent phone number** → household →
   tap children → check in.
2. Admin can create/manage dedicated children check-in **events**.
3. Children admin section shows **weekly check-in data visualization**.
4. **Every child already in the database is checkin-able by default** — no
   per-child registration or opt-in step.

Out of scope (deliberately): label printing, classroom/room assignment,
volunteer background checks, parent mobile notifications, multi-campus
stations. These can layer on later; nothing in this design blocks them.

## Decisions and assumptions (made autonomously)

- **Child = `household_members` row with `role='child'`** (`person_id IS NULL`
  dependents). This is the codebase's only child concept
  (`migrations/0003_people.sql:31-39`); no new "children" table.
- **Kiosk auth = URL token, not a staff session.** A shared touchscreen must
  never hold a signed-in admin session (anyone could navigate to `/admin`).
  A random token in the kiosk URL (precedent: `/cal/[token].ics` calendar
  token) gates the kiosk; admin can regenerate it at any time to revoke lost
  devices.
- **Security code per household per event per day.** On check-in the kiosk
  shows a short code (one per family, shared by siblings checked in together).
  At pickup, the code must be re-entered on the kiosk to check the child out,
  and staff can see codes on the admin live roster. This is the minimum
  pickup-security story worth having; no printed labels.
- **Events are simple recurring services**, not dated occurrences: name +
  optional weekday + active flag. Weekly aggregation groups `checkins` rows by
  date; no session/occurrence table needed.
- **Dates use the existing `todayInTz()` helper** (`src/lib/dates.ts`,
  America/Chicago anchor) so a Sunday-evening check-in never lands on Monday.
- **Event names are single free-text strings** (admin can type a bilingual
  name like "主日儿童崇拜 Sunday Kids"). No `*_i18n` companion table — the
  i18n-join pattern exists for public content; a kiosk event label doesn't
  justify the extra table. Documented trade-off: per-locale event names would
  require adding `checkin_event_i18n` later.
- **Admin access is admin-only** (`ADMIN_ONLY` route class). The people module
  already enforces "children never appear on public or leader pages"
  (`docs/features/people-households.md`); the Children console shows child
  names and so must not be visible to editors/leaders. The kiosk is
  physically supervised and token-gated, which is the accepted exposure.
- **D1-compatible module** — no Supabase requirement. Works on the default
  backend; Postgres mirror kept in lockstep as usual.

## Approaches considered

**A. Token-gated kiosk + new `checkin_events`/`checkins` tables + hand-rolled
SVG chart (chosen).** Greenfield tables that reference the existing
household model; kiosk is a public-class route gated by a settings-stored
token; chart is a small server-rendered SVG using design tokens. Fits every
existing convention (AppDb portable SQL, module registry, inline form POSTs,
no client framework, no new dependencies).

**B. Staff-session kiosk (route class `console`).** Zero new auth surface, but
leaves a privileged session cookie on a shared device and lets leaders/editors
browse all children — rejected on security and privacy grounds.

**C. Reuse `reg_events` (registration module) for children events.** Rejected:
registration is Supabase-only (`requiresBackend: 'supabase'`), payment-shaped,
and tracks sign-up intent rather than attendance. The promo `events` table is
likewise wrong (homepage carousel, no people linkage).

## Data model

New migration `migrations/0006_children_checkin.sql`, mirrored as
`migrations-supabase/0005_children_checkin.sql` (Postgres identity columns per
the documented porting rules). `test/pg/schema.test.ts` `D1_FILES` must gain
`'0005_custom_pages.sql', '0006_children_checkin.sql'` so parity is enforced.

```sql
CREATE TABLE checkin_events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),  -- NULL = offered every day
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES checkin_events(id),
  household_id INTEGER NOT NULL REFERENCES households(id),
  household_member_id INTEGER NOT NULL REFERENCES household_members(id),
  child_name TEXT NOT NULL,          -- snapshot; history survives renames/removals
  security_code TEXT NOT NULL,       -- 4 chars, shared per household+event+date
  checkin_date TEXT NOT NULL,        -- YYYY-MM-DD via todayInTz()
  checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_out_at TEXT
);

CREATE UNIQUE INDEX idx_checkins_once_per_day
  ON checkins(event_id, household_member_id, checkin_date);
CREATE INDEX idx_checkins_date ON checkins(checkin_date);
```

Notes:
- The unique index is the double-check-in guard; inserts race-protect via the
  shared `isUniqueViolation()` helper.
- `child_name` is denormalized on purpose: attendance history must survive a
  household edit or dependent removal. `household_member_id` stays for joins
  while the row exists.
- Security code: 4 characters from an unambiguous alphabet (no 0/O/1/I),
  generated per household+event+date; the first sibling's insert fixes the
  code, later siblings in the same visit reuse it.

## Data access — `src/lib/checkinDb.ts`

All functions take `db: AppDb` first, portable SQL only (`?` placeholders,
`RETURNING id`, `datetime('now')`, `LOWER(...) LIKE` with escaped input).

- `searchHouseholds(db, q)` — one kiosk search over both shapes:
  - child name: `household_members` where `role='child'` and
    `LOWER(display_name) LIKE %q%`
  - parent phone: `households.phone` or adults' `people.phone`, matched on
    **digits only** (strip non-digits from both sides; `(555) 010-2000`
    matches `5550102000` — compare via `REPLACE()` chains, which run on both
    backends). Trigger digit matching when the query contains ≥ 4 digits.
  - Returns live households (`deleted_at IS NULL`) with adult names, phone,
    and their children; capped (LIMIT 10) to keep the kiosk screen sane.
- `getHouseholdForKiosk(db, householdId, date)` — children of the household
  plus today's check-in status per active event.
- `listActiveEvents(db, weekday)` — active events where `weekday IS NULL OR
  weekday = ?`.
- `checkInChildren(db, {eventId, householdId, memberIds, date})` — validates
  the members are `role='child'` rows of that household, reuses or generates
  the household's code for (event, date), inserts rows, ignores unique
  violations (already checked in), returns `{code, checkedIn: names[]}`.
- `checkOutChild(db, {checkinId, code})` — sets `checked_out_at` only when the
  code matches (case-insensitive); admin roster path can bypass the code.
- `listEventsAdmin` / `saveEvent` / `toggleEventActive` — events CRUD
  (no hard delete; deactivate keeps history intact).
- `todayRoster(db, date)` — live roster: child, household, event, code,
  in/out times.
- `weeklyStats(db, weeksBack)` — per-week totals for the chart: bucket
  `checkin_date` into weeks starting **Sunday** (computed in JS from the
  date strings — no dialect-specific date math), returns
  `[{weekStart, total, byEvent: [{eventId, name, count}]}]` for the last N
  weeks (default 12), plus headline stats (this week, 4-week average,
  distinct children this month).

## Kiosk (public, token-gated)

Routes (no locale prefix, like `/cal/[token].ics`; language via `?lang=en|zh`
toggle rendered as a big button, strings from the shared i18n dictionaries
under new `kiosk.*` keys):

- `GET /kiosk/[token]` — search screen: one large input ("child's name or
  parent's phone"), on-screen instructions. Invalid/stale token → 404.
- `POST` search (same page, redirect-after-post carrying `?q=`) — result list
  of household cards (household name, adults, masked phone) → tap through.
- `GET /kiosk/[token]/household/[id]?q=...` — children as large tap targets
  (checkbox cards), event selector (radio; preselected when only one event is
  offered today), **Check in** button. Children already checked in today show
  a checked badge and a **Check out** row instead.
- `POST` check-in → confirmation screen: big security code, children's names,
  "Back to start" link (and an `http-equiv` refresh back to search after 20s).
- `POST` check-out (from the household screen) — requires typing the security
  code; wrong code shows an inline error.

Implementation notes:
- Server-rendered forms only, zero client JS required (matches the codebase;
  the checkbox-card selection is pure CSS like the admin nav's checkbox hack).
- Kiosk pages use `Base`-less minimal layout (no site header/footer/nav):
  full-screen, `text-2xl`+ touch targets, design-token colors only.
- Module gating: new `children` module key —
  `publicPrefixes: ['/kiosk']`, `adminPrefixes: ['/admin/children']`.
  `/kiosk` added to `PUBLIC_PREFIXES` in `routePolicy.ts` (the token is the
  gate); `/admin/children` added to `ADMIN_ONLY`.
- Token: 32-hex from `crypto.getRandomValues`, stored as settings key
  `children.kiosk_token` via `src/lib/settings.ts`; created lazily when the
  admin first opens the Kiosk tab; "Regenerate" button invalidates old URL.
  Token comparison is constant-time-ish (compare hashes) — low stakes, but
  cheap to do.
- CSRF: kiosk POSTs are same-origin form posts; existing middleware check
  applies unchanged.

## Admin — `/admin/children` (admin-only)

One console page with `?tab=` switching (ministries-console pattern),
components under `src/components/admin/children/`:

- **Dashboard (default)** — stat cards (`admin/index.astro` pattern): checked
  in this week, 4-week average, distinct children this month, active events.
  Below: **weekly bar chart**, last 12 weeks — server-rendered inline SVG
  component (`WeeklyCheckinChart.astro`), token colors only
  (`fill` via CSS `var(--color-primary)` / Tailwind classes; consult the
  dataviz skill when building). X axis = week-of labels, Y = check-ins;
  per-event breakdown as a small table under the chart (event × last 4 weeks).
- **Today** — live roster table: child, household, event, security code,
  checked-in time, checked-out time, and a staff **Check out** action (no code
  needed for staff). Empty state when nobody's checked in.
- **Events** — list + inline create/edit form: name, weekday select
  (Any day/Sun..Sat), active toggle. Deactivate instead of delete.
- **Kiosk** — the kiosk URL (copyable), regenerate button with confirm,
  one-paragraph setup instructions (open this URL on the check-in device,
  add to home screen).

Nav: add a "Children" item to `rawSections` in `src/layouts/Admin.astro`,
`show: user.isAdmin`, `module: 'children'`.

## i18n

- New keys in both `src/i18n/en.ts` and `src/i18n/zh.ts`: `kiosk.*` (search
  placeholder, check in/out, security-code copy, confirmation) and
  `admin.children.*` (nav label, tabs, stats, events form, kiosk tab).
  Parity enforced by the existing `test/i18n.test.ts`.
- Kiosk renders in `en` or `zh` from the `?lang=` param (default `en`),
  with an on-screen language toggle.

## Error handling

- Bad kiosk token → 404 (no hint that the path exists).
- Search with no matches → friendly "not found — please ask a greeter" state
  (a family not yet in the database is onboarded by staff via the existing
  People admin; the kiosk is not a data-entry surface).
- Double check-in (two kiosks racing) → unique index + `isUniqueViolation`,
  treated as success.
- Check-out with wrong code → inline error, no state change.
- Zero active events today → kiosk search disabled with an "no check-in
  events right now" notice; admin dashboard prompts to create one.

## Testing

- `test/checkinDb.test.ts` (workers project, live D1): search by child name /
  phone digits / no-match; check-in creates rows + shared sibling code; double
  check-in idempotent; checkout requires matching code; weekly buckets correct
  across a Saturday/Sunday boundary; events CRUD; token setting roundtrip.
- `test/e2e/children.e2e.test.ts`: kiosk 404 on bad token; kiosk flow
  (search → household → check in → code shown) over HTTP; `/admin/children`
  redirects anonymous, 403s editor, 200s admin; module disabled → both
  surfaces 404.
- `test/pg/schema.test.ts` D1_FILES updated → parity of new tables/columns.
- i18n parity is covered by the existing dictionary test.
- Update seed (`seed/dev-seed.sql`): give the Lin household a couple of child
  dependents and phones so the kiosk demo works out of the box; one seeded
  `checkin_events` row ("Sunday Kids", weekday 0) and a few historical
  `checkins` spread over past weeks so the chart renders in dev.

## Documentation

- `docs/features/children-checkin.md` following the standard feature-doc
  template (What it does / How your team uses it / How it fits together / For
  developers), plain English, screenshots under `docs/images/admin/` +
  `docs/images/public/`. **No mention of any third-party product.**
- README "What's inside" table: one new row linking the doc.
- `docs/architecture.md` pieces table: one line for the module.

## Build order (for the implementation plan)

1. Migrations (D1 + Postgres mirror) + schema parity test update.
2. `checkinDb.ts` + unit tests (TDD: tests first).
3. Module/routePolicy/nav/i18n registration.
4. Kiosk pages.
5. Admin console page + chart component.
6. Seed data, e2e tests.
7. Screenshots + docs + README.
