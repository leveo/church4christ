# Member Portal — Design

Date: 2026-07-10
Status: Approved for implementation (owner directive recorded in session goal; key
decisions confirmed interactively; revised after adversarial design review)

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
3. **Groups = fellowships + Sunday School** — two kinds of member groups:
   *fellowships* (团契, long-running) and *Sunday School classes* (主日学,
   seasonal — typically opened each quarter for sign-up). Fellowships are
   upgraded from content-only pages to DB entities; both kinds share one
   membership model. Members see their groups and groups open for sign-up.
   Serving teams stay serving-only.
3a. **Group file sharing** — each group has a file area backed by R2: group
   members can view/download files; group leaders (and church admins) can
   upload and delete them.
4. **Events** — see my registrations, and events open for registration.
5. **Serving** — see my assignments and open serving opportunities.
6. **Calendar** — one personal calendar combining serving, registered events,
   and group meetings; subscribable from Google/Apple Calendar; blockout
   dates editable here and visible to serving admins.
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
- **Module gating**: new module key `portal` with `requiresBackend: 'supabase'`
  (add to `MODULE_KEYS` and the admin Modules panel). Prefix gating covers the
  new pages (`/my/household`, `/my/groups`, `/my/events`, `/my/serving`,
  `/my/prayer`). The *pre-existing* `/my` basics (dashboard, schedule,
  calendar, blockouts — owned by the `serve` module) keep working on D1
  exactly as today; **their portal expansions are gated in-page** via
  `locals.modules.has('portal')` so D1 never queries Supabase-only tables.
  Giving under `/my` remains gated by the `giving` module as it already is.
  Known trade-off: if a church disables `serve`, the `/my` tree (the portal's
  entry point) 404s — documented, not solved here.
- **Member groups become DB entities** (owner decision). New `member_groups` +
  `member_group_i18n` tables in **both** backends (public content must keep
  working on D1), with `kind` ∈ `fellowship | sunday_school` and optional
  seasonal term fields (`term_label`, `term_start`, `term_end`) for Sunday
  School. The public `/[locale]/fellowships` page switches from content
  collections to DB (rows with `kind='fellowship'`) via the standard
  `i18nJoin` pattern; Sunday School classes surface in the portal only. The
  admin console gains a group editor (definitions, kind, term, meeting
  schedule, leaders). The `src/content/fellowships/` collection is retired
  (existing sample content becomes seed data). Membership (`group_members`,
  `group_applications`) is **Supabase-only** and portal-gated — on D1 the
  public page still lists fellowships, there is just no join flow.
- **Group files** live in a `group_files` table (Supabase-only) pointing at R2
  objects in the existing `MEDIA` bucket under a `group-files/{groupId}/`
  prefix. Downloads go through an authenticated route
  (`/my/groups/[id]/files/[fileId]`) that checks group membership before
  streaming from R2 — never a public URL. Uploads (leaders + church admins
  only) enforce an extension/MIME allowlist (pdf, doc/docx, xls/xlsx,
  ppt/pptx, png, jpg, webp, txt, md) and a 20 MB size cap; uploaders can
  delete (soft-delete row, best-effort R2 delete).
- **Household owner** is a new flag `household_members.is_owner` (max 2 per
  household, app-layer enforced; a concurrent-promote race could briefly yield
  3 — accepted). An owner must be an `adult` row with `person_id IS NOT NULL`
  whose person has an email (i.e. can sign in). Admin sets the first owner in
  the admin console; an owner can promote one other eligible adult in their
  household to co-owner and can demote the co-owner, never themselves — so a
  household never drops to zero owners *from the portal demote path*. A
  household can still drift to zero owners when the last owner leaves, is
  unlinked, or is soft-deleted (existing `leaveHousehold`/`unlinkPerson`
  paths); the portal then shows "ask a church admin to set an owner" and the
  admin household list flags ownerless households. Admin console can always
  override.
- **Existing `/profile` household self-service stays untouched** (create
  household, add/remove dependents, leave — `src/pages/[locale]/profile.astro`
  already does this on both backends). `/my/household` is the portal's richer
  surface (member profile editing + owner management) layered on the same
  data; the two overlap by design and the portal page links back to `/profile`
  for the create/leave actions rather than duplicating them.
- **Email is identity — owners cannot edit another member's email.** Each
  person changes their own email via a verification link sent to the *new*
  address. Everything else (name, phone, birthday, address, avatar via the
  existing `saveImageUpload`/`setPersonAvatar` plumbing, adult/child role for
  dependents) is owner-editable.
- **Email-change token flow** (hardened per design review):
  - `tokens.purpose` gains an `email_change` value. Both backends carry a
    CHECK constraint, so the migration must rebuild the table on D1 (idiom
    precedent: `migrations/0005_custom_pages.sql`) and
    `DROP CONSTRAINT`/`ADD CONSTRAINT` on Postgres (precedent:
    `migrations-supabase/0004_custom_pages.sql`). `TokenPurpose` + TTL map in
    `src/lib/auth.ts` gain the new purpose (TTL: 60 minutes).
  - The pending address lives on `people.pending_email` (one at a time).
    Issuing a new email-change token **deletes all prior `email_change`
    tokens for that person** — a stale link must never confirm a newer
    pending address.
  - Issuance is rate-limited (reuse the login-token rate-limit pattern) since
    it emails an attacker-chosen address, and rejects addresses already used
    by another account (`people.email` is UNIQUE); uniqueness is re-checked at
    consume time.
  - Confirmation is **peek-on-GET, consume-on-POST** (codebase rule — mail
    scanners prefetch GETs; see `src/pages/auth/[token].astro`). On consume:
    swap `people.email`, clear `pending_email`, bump `session_epoch`, and send
    a notification to the **old** address.
- **Prayer approval is scoped**: `church` scope → `people.role = 'admin'`;
  `group` scope → that group's `group_members.is_leader = 1`;
  `event` scope → new `event_admins` table (per-event responsible persons,
  admin-assigned); `private` → auto-approved, visible only to the author.
  Church admins can moderate every scope (superset). Approvers act inside the
  portal prayer wall (a "pending" tab filtered to their scope) — no
  admin-console duplicate.
- **Google/Apple calendar link = ICS subscription.** Extend the existing
  personal feed `/cal/[token].ics` (serving assignments today) with registered
  events and group meetings. The portal calendar page shows a `webcal://`
  link plus copy-paste instructions for Google and Apple. One feed serves
  both. Feed rules: portal sections are skipped unless the portal module is on
  (the route runs on both backends); `reg_events.starts_at` is stored UTC and
  `buildICal` emits floating local times, so event times are converted
  UTC→wall-clock with the existing `dates.ts` helpers; group-meeting
  occurrences are computed over a bounded window (past 30 days → +180 days,
  clipped to the group's term for seasonal classes) with stable per-occurrence
  UIDs (`group-{id}-{yyyy-mm-dd}`). The feed
  stays token-authenticated with `public, max-age=3600` caching — it now
  carries more personal data than before under the same threat model
  (documented trade-off).
- **Giving visibility tightens**: today every household member sees the whole
  household's gifts (`HOUSEHOLD_PERSON_IDS` scoping in `src/lib/givingDb.ts`).
  After this change the household statement is owner-only; non-owners see only
  gifts attributed to their own `person_id`. (No email-based attribution — the
  member view has never matched on `donor_email`, and this design does not add
  it.)
- **My registrations** are queried by `person_id = ? OR lower(email) = ?`
  (guest registrations carry no person_id), excluding cancelled ones. The
  same rule defines "events I'm registered for" for prayer-wall eligibility.
- **Shared-table columns land in both backends** (D1 + Postgres migrations)
  to keep schema parity: `household_members.is_owner`, `people.pending_email`,
  the `tokens` purpose-constraint rebuild, and the `member_groups` /
  `member_group_i18n` tables. Portal-only tables (`event_admins`,
  `prayer_items`, `group_members`, `group_applications`, `group_files`) are
  Supabase-only, following the giving/registration precedent.

## Approaches considered

**A. Expand `/my` into the portal; supabase-only module; member groups
(fellowships + Sunday School) as DB entities with R2 file areas;
scoped-approval prayer wall (chosen).** Maximum reuse: route policy (`authed`
class + fail-closed `/my` gate), magic-link auth, ICS feed, month-calendar
component, household / plan / giving data layers, R2 media bucket all exist.
New code concentrates on group membership/files, household ownership, prayer
items, and read-model pages.

**B. Treat serving teams as "groups".** Cheapest option (teams already have
membership + applications), but conflates 服事队 with 小组/团契 and leaves the
public fellowships page disconnected from portal groups. Rejected by owner.

**C. Standalone `/portal` namespace with its own layout.** Cleaner "new module"
story but duplicates the member shell, requires migrating/redirecting the four
existing `/my` pages, and delivers no user-visible benefit. Rejected.

**D. Password-based portal accounts (original idea).** Rejected with the owner:
the codebase is deliberately passwordless; adding password storage, strength
rules, and reset flows is pure liability when magic-link already works.

## Data model

New migrations: `migrations/0007_member_portal.sql` (D1: shared columns,
tokens rebuild, member groups) and `migrations-supabase/0006_member_portal.sql`
(Postgres: the same shared changes + portal-only tables).
`test/pg/schema.test.ts` `D1_FILES` gains `0007_member_portal.sql`; the
tokens rebuild reuses the rename-fold idiom already handled there.

Naming note: the group entity is `member_groups` (not `groups` — a window-frame
keyword in both engines) with child tables `group_members`,
`group_applications`, `group_files`.

Shared changes (both backends):

```sql
ALTER TABLE household_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN pending_email TEXT;

-- tokens: widen purpose CHECK to include 'email_change'
--   D1: table-rebuild idiom (create tokens_new → copy → drop → rename)
--   PG: ALTER TABLE tokens DROP CONSTRAINT ... ; ADD CONSTRAINT ... CHECK
--       (purpose IN ('login','respond','email_change'))

CREATE TABLE member_groups (
  id         INTEGER PRIMARY KEY,             -- identity in PG
  slug       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'fellowship', -- fellowship|sunday_school
  term_label TEXT,                            -- seasonal classes, e.g. '2026 Fall'
  term_start TEXT,                            -- YYYY-MM-DD; NULL for long-running
  term_end   TEXT,
  meeting_weekday   INTEGER,                  -- 0=Sun..6=Sat
  meeting_time      TEXT,                     -- 'HH:MM'
  meeting_frequency TEXT,                     -- weekly|biweekly|monthly
  meeting_location  TEXT,
  open_signup INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

CREATE TABLE member_group_i18n (
  group_id      INTEGER NOT NULL REFERENCES member_groups(id),
  locale        TEXT NOT NULL,                -- en|zh
  name          TEXT NOT NULL,
  description   TEXT,
  PRIMARY KEY (group_id, locale)
);
```

Portal-only tables (Supabase migration only; Postgres identity columns per the
documented porting rules; timestamp defaults follow sibling tables):

```sql
CREATE TABLE group_members (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES member_groups(id),
  person_id     INTEGER NOT NULL REFERENCES people(id),
  is_leader     INTEGER NOT NULL DEFAULT 0,
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, person_id)
);

CREATE TABLE group_applications (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES member_groups(id),
  person_id     INTEGER NOT NULL REFERENCES people(id),
  status        TEXT NOT NULL DEFAULT 'P',    -- P|A|R (pattern: team_applications)
  note          TEXT,
  decided_by    INTEGER REFERENCES people(id),
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE group_files (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES member_groups(id),
  uploaded_by   INTEGER NOT NULL REFERENCES people(id),
  file_name     TEXT NOT NULL,                -- original name, sanitized
  r2_key        TEXT NOT NULL UNIQUE,         -- group-files/{group_id}/{random}
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE INDEX idx_group_files_group ON group_files(group_id, deleted_at);

CREATE TABLE event_admins (
  id           INTEGER PRIMARY KEY,
  reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
  person_id    INTEGER NOT NULL REFERENCES people(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reg_event_id, person_id)
);

CREATE TABLE prayer_items (
  id            INTEGER PRIMARY KEY,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  scope         TEXT NOT NULL,                -- church|group|event|private
  group_id      INTEGER REFERENCES member_groups(id),  -- required iff scope=group
  reg_event_id  INTEGER REFERENCES reg_events(id),     -- required iff scope=event
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',       -- pending|approved|rejected
  approved_by   INTEGER REFERENCES people(id),
  approved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);
CREATE INDEX idx_prayer_items_scope ON prayer_items(scope, status, deleted_at);
CREATE INDEX idx_prayer_items_group ON prayer_items(group_id);
CREATE INDEX idx_prayer_items_event ON prayer_items(reg_event_id);
```

Notes:

- `prayer_items.scope='private'` rows are created with `status='approved'`.
- `body` is single free-text (author writes bilingual if they wish); user
  content gets no i18n treatment.
- The existing `prayer_requests` table (public prayer-request form) and the
  `prayer-wall` public module are unrelated and untouched; portal nav and
  admin naming must disambiguate ("Prayer wall (portal)" vs the public one).
- Shared-table queries stay in the SQLite dialect (PG side has `datetime()` /
  `date()` compat functions); portal-only queries may use PG idioms.

## Permission model

| Action | Who |
|---|---|
| View portal | any signed-in person (`authed`), portal module on |
| Edit own profile (incl. email w/ verification) | self |
| Edit household members' profiles (not email) | household owner |
| Promote/demote co-owner | owner (not self-demote); admin console always |
| View household giving | owner; others see own gifts only |
| Post prayer item | member: church scope + own groups + events they're registered for + private |
| Approve church prayer | `role='admin'` |
| Approve group prayer | that group's leader (`is_leader=1`); church admin |
| Approve event prayer | that event's `event_admins`; church admin |
| See group-scoped prayers | members of that group |
| See event-scoped prayers | registered persons of that event + its event admins |
| Apply to join a group | any member, when `open_signup=1` |
| Approve group applications | that group's leader; church admin |
| View/download group files | members of that group; church admin |
| Upload/delete group files | that group's leader; church admin |
| Set own blockout dates | self (existing) |

Enforcement lives in the data layer (`portalDb`/`prayerDb`/`groupDb`
functions take the viewer's person id and scope every query), not in
templates. `SessionUser` already carries `isAdmin`; group membership /
leadership is loaded per-request where needed.

## Pages and routes (all `/[locale]/my/*`, bilingual, Base layout + portal sub-nav)

| Route | Content |
|---|---|
| `/my` (expand) | Dashboard cards: my household, next serving, upcoming registered events, pending approvals (if approver), quick links. Portal cards gated in-page (`serve`-owned page, runs on D1) |
| `/my/household` | Member list; profile edit forms (owner sees edit on all, member on self); owner management panel; links to `/profile` for create/leave household |
| `/my/giving` (tighten) | Owner: household statement (existing view); non-owner: own gifts only |
| `/my/groups` | My groups — fellowships and Sunday School classes, with meeting schedule/term — + open-signup groups with apply button; leaders see pending applications |
| `/my/groups/[id]` | Group detail: members, meeting/term info, **file area** (list/download for members; upload/delete for leaders + admins) |
| `/my/groups/[id]/files/[fileId]` | Authenticated download route — checks membership, streams from R2 (no public URL) |
| `/my/events` | My registrations (person_id or email match, non-cancelled) + open `reg_events` linking to the existing public register flow |
| `/my/serving` | My assignments (links to existing respond flow) + open opportunities (existing `opportunityDb` open_signup; replaces/absorbs the dashboard's current open-slots strip) |
| `/my/calendar` (expand) | Month grid gains registered events + group meetings alongside serving + blockouts (portal-gated in-page); blockout editing as today; "Subscribe in Google/Apple Calendar" panel with the `webcal://` feed link + regenerate token |
| `/my/prayer` | Tabs: Church / My groups / My events / Private; post form with scope picker; approvers get a Pending tab scoped to their authority; authors see their own pending/rejected items |

Public site: `/[locale]/fellowships` switches to DB-driven rendering
(`i18nJoin`, rows with `kind='fellowship'`), gains meeting time/location
display; visual design unchanged. Sunday School classes are portal-only.

Header (`Header.astro`): the header currently has **no** signed-in state.
When `Astro.locals.user` exists and the portal module is on, render a
"My Portal" element *outside* the settings-driven nav list (`nav.items`
whitelist can't express user-conditional entries) — visible in both desktop
nav and the mobile disclosure menu.

API/form endpoints follow the existing convention: progressive-enhancement
POST-to-self with 303 redirects; CSRF via existing middleware origin check.

## Email flows

- **Email change**: POST new address (validated against `people.email`
  uniqueness, rate-limited) → store `pending_email`, delete prior
  `email_change` tokens, send link to the new address → GET peeks and shows a
  confirm button → POST consumes: re-check uniqueness, swap `people.email`,
  clear `pending_email`, bump `session_epoch`, notify the old address.
- **Prayer approval notice** (nice-to-have, final-phase stretch): notify author
  on approve/reject via existing `email.ts`. Not required for v1.

## Admin console (minimal additions)

1. Household editor: owner checkbox per eligible adult member (max-2
   validation); household list flags ownerless households.
2. Registration event editor: manage `event_admins` (person picker).
3. **Group editor (new, `/admin/fellowships`)**: CRUD for member groups + i18n
   names/descriptions, kind (fellowship / Sunday School), term label/start/end,
   meeting weekday/time/frequency/location, open_signup toggle; member +
   leader management (portal-module-gated, Supabase-only data). File areas are
   managed in the portal by leaders, not here.

No admin prayer-moderation page; church admins moderate in the portal.

## i18n

All new UI strings added to `src/i18n/en.ts` + `zh.ts` under the `portal.*`
prefix (including `portal.prayer.*` — the bare `prayer.*` prefix is already
taken by prayer-sheet strings). Group content localized via
`member_group_i18n` joins. User-generated content (prayer bodies, file names)
is not localized.

## Testing

- Unit (Vitest): owner promotion/demotion rules (max 2, no self-demote, no
  zero-owner via portal), giving visibility scoping, prayer scope/approval
  matrix, email change token lifecycle (re-issue invalidation, uniqueness
  collision, peek-vs-consume), ICS feed contents (events + meetings + serving,
  UTC→wall-clock, D1 skips portal sections), meeting occurrence computation
  (window + term clipping + stable UIDs), group application flow, group-file
  ACL matrix (member download / non-member 404 / leader upload / size + type
  rejection).
- E2E (`test:e2e:pg`, since portal is Supabase-only): sign-in → edit household
  member → apply to group → leader approves → post group prayer → leader
  approves → appears in group tab; leader uploads file → member downloads,
  non-member gets 404; event admin approves event prayer; non-owner cannot
  see household giving.
- Schema parity tests updated (`D1_FILES` + tokens rebuild fold).
- Seed data (`seed/dev-seed.sql` + supabase seed): member groups (fellowships
  ported from the retired content collection + one Sunday School class with a
  term), owners on seeded households, group members/leaders, a few prayer
  items in each scope/status, an event_admin.

## Implementation phasing

1. **Foundations**: module key, migrations (incl. tokens rebuild), seed,
   `is_owner` + admin console toggles, `/my/household` with profile editing +
   owner management, email change flow.
2. **Member groups**: admin group editor (kind/term/meeting), public
   fellowships page switch to DB, content-collection retirement, `/my/groups`
   + group detail with application flow and R2 file areas.
3. **Events / serving / giving / dashboard**: `/my/events`, `/my/serving`,
   giving visibility tightening, dashboard expansion.
4. **Calendar**: month-grid expansion, ICS feed expansion, subscribe panel.
5. **Prayer wall**: tables, posting, scoped tabs, approval queues, (stretch)
   author notifications.

Each phase lands with tests green (`npm test` + pg e2e where applicable);
screenshots and a bilingual feature doc (`docs/features/member-portal.md`)
accompany the final PR, following the children check-in delivery pattern.
