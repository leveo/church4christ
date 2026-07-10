# Member Portal — Design

Date: 2026-07-10
Status: Approved for implementation (owner directive recorded in session goal; key
decisions confirmed interactively)

## Goal

Expand the existing member area (`/[locale]/my/*`) into a full **member portal**:
a member-facing module completely separate from the admin console, sharing only
the underlying data. The portal keeps the public site's look — same header, nav,
and design tokens — and simply reveals more once a member signs in.

Core requirements (from the owner):

1. **Household profiles** — members edit their own profile; household *owners*
   (max two per household) edit every member's profile in their household.
2. **Giving history** — owners see the whole household's gifts; other members
   see only their own.
3. **Groups** — see my groups, and groups open for sign-up.
4. **Events** — see my registrations, and events open for registration.
5. **Serving** — see my assignments and open serving opportunities.
6. **Calendar** — one personal calendar combining serving, registered events,
   and group meetings; subscribable from Google/Apple Calendar; blockout dates
   editable here and visible to serving admins.
7. **Prayer wall** — church-public, group-scoped, event-scoped, and private
   prayer items, with scoped approval (church admin / group leader / event
   admin respectively; private items need no approval).
8. **Supabase-only module** — like giving/registration, the portal requires the
   Supabase backend (owner wants the higher data-security posture); on default
   D1 the portal is off.

Out of scope (deliberately): passwords or OAuth (magic-link stays), member
self-registration (admin adds people), push/mobile notifications, prayer-item
comments or "I prayed" reactions, two-way Google/Apple calendar sync (one-way
ICS subscription only), admin-console prayer moderation UI (approval lives in
the portal). None of these are blocked by this design.

## Decisions and assumptions (confirmed with owner)

- **Auth stays passwordless magic-link.** Admin entering a member's email in
  the people module *is* the invitation; the member signs in via the existing
  `/[locale]/signin` flow. Zero new auth surface.
- **Portal = expansion of `/[locale]/my/*`.** The existing member pages
  (schedule, calendar, blockouts, giving) are the seed; new pages join them.
  No `/portal` namespace, no migration/redirects.
- **Module gating**: new module key `portal` with `requiresBackend: 'supabase'`.
  The *pre-existing* `/my` basics (schedule, calendar, blockouts) keep working
  on D1 exactly as today — only the new portal surface (household, groups,
  events, prayer, opportunities dashboard) is gated by the module. Giving under
  `/my` remains gated by the `giving` module as it already is.
- **Household owner** is a new flag `household_members.is_owner` (max 2 per
  household, app-layer enforced). An owner must be an `adult` row linked to a
  `person_id` whose person has an email (i.e. can sign in). Admin sets the
  first owner in the admin console; an owner can promote one other eligible
  adult in their household to co-owner and can demote the co-owner, never
  themselves — so a household never drops to zero owners from the portal.
  Admin console can always override.
- **Email is identity — owners cannot edit another member's email.** Each
  person changes their own email via a verification link sent to the *new*
  address (`people.pending_email` + a new `email_change` token kind reusing the
  existing hashed-token infrastructure). Everything else (name, phone,
  birthday, address, avatar, adult/child role for dependents) is owner-editable.
- **Prayer approval is scoped**: `church` scope → `people.role = 'admin'`;
  `group` scope → that team's `team_members.is_leader = 1`; `event` scope → new
  `event_admins` table (per-event responsible persons, admin-assigned);
  `private` → auto-approved, visible only to the author. Church admins can
  moderate every scope (superset). Approvers act inside the portal prayer wall
  (a "pending" tab filtered to their scope) — no admin-console duplicate.
- **Group meetings become calendar-able** via simple recurrence columns on
  `teams` (`meeting_weekday`, `meeting_time`, `meeting_frequency`
  weekly/biweekly/monthly, `meeting_location`), maintained in the admin team
  editor. No occurrence table; occurrences are computed.
- **Google/Apple calendar link = ICS subscription.** Extend the existing
  personal feed `/cal/[token].ics` (serving assignments today) with registered
  events and group meetings. The portal calendar page shows a `webcal://` link
  plus copy-paste instructions for Google and Apple. One feed serves both.
- **Giving visibility tightens**: the current `/my/giving` household view
  becomes owner-only; non-owners see only gifts attributed to their own
  `person_id` (or their email for guest-attributed gifts, matching existing
  attribution logic).
- **Shared-table columns land in both backends** (D1 + Postgres migrations)
  to keep schema parity: `household_members.is_owner`, `teams.meeting_*`,
  `people.pending_email`. Portal-only tables (`event_admins`, `prayer_items`)
  are Supabase-only, following the giving/registration precedent (they also
  reference `reg_events`, which exists only there).

## Approaches considered

**A. Expand `/my` into the portal; supabase-only module; scoped-approval prayer
wall (chosen).** Maximum reuse: route policy (`authed` class + fail-closed
`/my` gate), magic-link auth, ICS feed, month-calendar component, household /
team / plan / giving data layers all exist. New code concentrates on household
ownership, prayer items, and read-model pages.

**B. Standalone `/portal` namespace with its own layout.** Cleaner "new module"
story but duplicates the member shell, requires migrating/redirecting the four
existing `/my` pages, and delivers no user-visible benefit. Rejected.

**C. Password-based portal accounts (original idea).** Rejected with the owner:
the codebase is deliberately passwordless; adding password storage, strength
rules, and reset flows is pure liability when magic-link already works.

## Data model

New migrations: `migrations/0007_member_portal.sql` (D1, shared columns only)
and `migrations-supabase/0006_member_portal.sql` (Postgres, shared columns +
portal-only tables). `test/pg/schema.test.ts` parity lists updated accordingly.

Shared columns (both backends):

```sql
ALTER TABLE household_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN meeting_weekday INTEGER;          -- 0=Sun..6=Sat
ALTER TABLE teams ADD COLUMN meeting_time TEXT;                -- 'HH:MM'
ALTER TABLE teams ADD COLUMN meeting_frequency TEXT;           -- weekly|biweekly|monthly
ALTER TABLE teams ADD COLUMN meeting_location TEXT;
ALTER TABLE people ADD COLUMN pending_email TEXT;
```

Portal-only tables (Supabase migration only; Postgres identity columns per the
documented porting rules):

```sql
CREATE TABLE event_admins (
  id          INTEGER PRIMARY KEY,           -- identity in PG
  reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
  person_id   INTEGER NOT NULL REFERENCES people(id),
  created_at  TEXT NOT NULL,
  UNIQUE (reg_event_id, person_id)
);

CREATE TABLE prayer_items (
  id            INTEGER PRIMARY KEY,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  scope         TEXT NOT NULL,               -- church|group|event|private
  team_id       INTEGER REFERENCES teams(id),        -- required iff scope=group
  reg_event_id  INTEGER REFERENCES reg_events(id),   -- required iff scope=event
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',     -- pending|approved|rejected
  approved_by   INTEGER REFERENCES people(id),
  approved_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX idx_prayer_items_scope ON prayer_items(scope, status, deleted_at);
CREATE INDEX idx_prayer_items_team ON prayer_items(team_id);
CREATE INDEX idx_prayer_items_event ON prayer_items(reg_event_id);
```

Notes:

- `prayer_items.scope='private'` rows are created with `status='approved'`.
- `body` is single free-text (author writes bilingual if they wish); user
  content gets no `*_i18n` table.
- No new token table: `email_change` reuses `tokens` with the pending address
  kept on `people.pending_email` (one pending change at a time; issuing a new
  token replaces it).
- The existing `prayer_requests` table (public prayer-request form) is
  unrelated and untouched.

## Permission model

| Action | Who |
|---|---|
| View portal | any signed-in person (`authed`), portal module on |
| Edit own profile (incl. email w/ verification) | self |
| Edit household members' profiles (not email) | household owner |
| Promote/demote co-owner | owner (not self-demote); admin console always |
| View household giving | owner; others see own gifts only |
| Post prayer item (any scope they belong to) | member: church + own groups + events they're registered for + private |
| Approve church prayer | `role='admin'` |
| Approve group prayer | that team's leader (`is_leader=1`); church admin |
| Approve event prayer | that event's `event_admins`; church admin |
| See group-scoped prayers | members of that team (leaders included) |
| See event-scoped prayers | registered persons of that event + its event admins |
| Set own blockout dates | self (existing) |

Enforcement lives in the data layer (`portalDb`/`prayerDb` functions take the
viewer's person id and scope every query), not in templates.

## Pages and routes (all `/[locale]/my/*`, bilingual, Base layout + portal sub-nav)

| Route | Content |
|---|---|
| `/my` (expand) | Dashboard cards: my household, next serving, upcoming registered events, pending approvals (if approver), quick links |
| `/my/household` | Member list; profile edit forms (owner sees edit on all, member on self); owner management panel |
| `/my/giving` (tighten) | Owner: household statement (existing view); non-owner: own gifts only |
| `/my/groups` | My groups (with meeting schedule) + open groups with join/apply button (existing `team_applications` flow) |
| `/my/events` | My registrations (status, date) + open `reg_events` linking to the existing public register flow |
| `/my/serving` | My assignments (links to existing respond flow) + open opportunities with sign-up (existing `opportunityDb` open_signup) |
| `/my/calendar` (expand) | Month grid gains registered events + group meetings alongside serving + blockouts; blockout editing as today; "Subscribe in Google/Apple Calendar" panel with the `webcal://` feed link + regenerate token |
| `/my/prayer` | Tabs: Church / My groups / My events / Private; post form with scope picker; approvers get a Pending tab scoped to their authority; authors see their own pending/rejected items |

Header (`Header.astro`): when `Astro.locals.user` exists and the portal module
is on, show a "My Portal" nav entry (replacing/augmenting the current signed-in
affordance). Portal pages render a shared `PortalNav.astro` sub-navigation.

API/form endpoints follow the existing convention: progressive-enhancement
POST-to-self with 303 redirects; CSRF via existing middleware.

## Email flows

- **Email change**: POST new address → store `pending_email`, send
  `email_change` token link to the new address → GET consume → swap
  `people.email`, clear pending, bump `session_epoch` (re-login with new email).
- **Prayer approval notice** (nice-to-have, phase 4 stretch): notify author on
  approve/reject via existing `email.ts`. Not required for v1.

## Admin console (minimal additions)

1. Household editor: owner checkbox per adult member (max-2 validation).
2. Registration event editor: manage `event_admins` (person picker).
3. Team editor: meeting weekday/time/frequency/location fields.

No admin prayer-moderation page; church admins moderate in the portal.

## i18n

All new UI strings added to `src/i18n/en.ts` + `zh.ts` under a `portal.*` /
`prayer.*` prefix. DB-driven content reuses existing `*_i18n` joins (teams,
reg_events already have them). User-generated content (prayer bodies) is not
localized.

## Testing

- Unit (Vitest): owner promotion/demotion rules (max 2, no self-demote, no
  zero-owner), giving visibility scoping, prayer scope/approval matrix, email
  change token lifecycle, ICS feed contents (events + meetings + serving),
  meeting occurrence computation.
- E2E (`test:e2e:pg`, since portal is Supabase-only): sign-in → edit household
  member → post group prayer → leader approves → appears in group tab; event
  admin approves event prayer; non-owner cannot see household giving.
- Schema parity tests updated for the new migration files.
- Seed data (`seed/dev-seed.sql` + supabase seed): owners on seeded households,
  team meeting schedules, a few prayer items in each scope/status, an
  event_admin.

## Implementation phasing

1. **Foundations**: module key, migrations, seed, `is_owner` + admin console
   toggles, household page with profile editing + owner management, email
   change flow.
2. **Read models + signups**: groups / events / serving pages, dashboard
   expansion, giving visibility tightening.
3. **Calendar**: month-grid expansion, ICS feed expansion, subscribe panel.
4. **Prayer wall**: tables, posting, scoped tabs, approval queues, (stretch)
   author notifications.

Each phase lands with tests green (`npm test` + pg e2e where applicable);
screenshots and a bilingual feature doc (`docs/features/member-portal.md`)
accompany the final PR, following the children check-in delivery pattern.
