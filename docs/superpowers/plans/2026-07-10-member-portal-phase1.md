# Member Portal — Phase 1 (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portal module skeleton + all portal schema, household ownership (max 2 owners), `/my/household` with owner-managed profile editing, and the hardened email-change flow.

**Architecture:** New `portal` module (`requiresBackend: 'supabase'`) whose pages live under the existing `/[locale]/my/*` member area. One migration pair carries ALL portal DDL (later phases add no migrations). Data-layer authorization in new `src/lib/portalDb.ts` + `src/lib/emailChange.ts` against the `AppDb` seam. Spec: `docs/superpowers/specs/2026-07-10-member-portal-design.md`.

**Tech Stack:** Astro 7 SSR on Cloudflare Workers, D1/Postgres via AppDb adapter, Tailwind v4 + design tokens, Vitest (workers pool + pg e2e), jose sessions, magic-link tokens.

## Global Constraints

- Portable SQL only in shared-table queries: `?` placeholders, `INSERT ... RETURNING id`, `datetime('now')`; race detection via `isUniqueViolation()` from `src/lib/adminDb.ts`. Portal-only tables (Supabase-only) may use PG idioms when needed.
- Every D1 migration change must be mirrored in `migrations-supabase/` (Postgres identity columns, porting rules documented in `migrations-supabase/0001_init.sql:1-88`).
- No hardcoded colors/fonts in `src/` — design-token classes only; `npm run tokens:check` must pass.
- Every UI string goes in BOTH `src/i18n/en.ts` and `src/i18n/zh.ts` with identical keys (enforced by `test/i18n.test.ts`). Portal strings use the `portal.*` prefix (NOT bare `prayer.*` — taken).
- Forms are progressive-enhancement POST-to-self with 303 redirects; CSRF is the middleware origin check (nothing per-form). Follow the `action` hidden-field pattern from `src/pages/[locale]/profile.astro`.
- Member/admin UI class constants come from `src/lib/adminUi.ts` (`tin`, `lab`, `card`, `btn`, `btnSecondary`, `th`, `td`, `noticeOk`, `noticeErr`, `badge`).
- Comments/commits in English.
- After each task: run the named tests, then commit with the message given.
- All commits on branch `feat/member-portal`, message suffix:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01LXG31UsdHggtkv9S8KYNBY`.

---

### Task 1: Migrations (all portal DDL) + schema parity

**Files:**
- Create: `migrations/0007_member_portal.sql`
- Create: `migrations-supabase/0006_member_portal.sql`
- Modify: `test/pg/schema.test.ts` (`D1_FILES` array)
- Test: `npm run test:pg-schema` (or the vitest file directly)

**Interfaces:**
- Produces: `household_members.is_owner`, `people.pending_email`, widened `tokens.purpose` CHECK (`'email_change'`), tables `member_groups`, `member_group_i18n` (both backends); `group_members`, `group_applications`, `group_files`, `event_admins`, `prayer_items` (Postgres only). Later phases add NO migrations.

- [ ] **Step 1: Write the D1 migration**

`migrations/0007_member_portal.sql`:

```sql
-- Member portal (spec: docs/superpowers/specs/2026-07-10-member-portal-design.md).
-- Shared-backend DDL only; portal-only tables (group_members,
-- group_applications, group_files, event_admins, prayer_items) are
-- Supabase-only — see migrations-supabase/0006_member_portal.sql.

-- Household ownership: max 2 owners per household (app-layer enforced);
-- an owner must be an adult member with a linked person (portalDb checks).
ALTER TABLE household_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

-- Pending email-change target (one at a time; see src/lib/emailChange.ts).
ALTER TABLE people ADD COLUMN pending_email TEXT;

-- Widen tokens.purpose CHECK to allow 'email_change'. SQLite cannot alter a
-- CHECK, so rebuild (idiom precedent: revisions rebuild in 0005_custom_pages.sql).
CREATE TABLE tokens_new (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login','respond','email_change')),
  assignment_id INTEGER REFERENCES roster_assignments(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tokens_new (id, token_hash, person_id, purpose, assignment_id, expires_at, used_at, created_at)
  SELECT id, token_hash, person_id, purpose, assignment_id, expires_at, used_at, created_at FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
CREATE INDEX idx_tokens_person ON tokens(person_id, purpose);

-- Member groups: fellowships (long-running) + Sunday School classes (seasonal).
-- Graduated from content collections to DB entities (owner decision).
-- Definitions live in BOTH backends (public /fellowships page must work on D1);
-- membership + files are Supabase-only. Table is member_groups, not "groups"
-- (window-frame keyword in both engines).
CREATE TABLE member_groups (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'fellowship' CHECK (kind IN ('fellowship','sunday_school')),
  term_label TEXT,                 -- seasonal classes, e.g. '2026 Fall'
  term_start TEXT,                 -- YYYY-MM-DD; NULL for long-running
  term_end TEXT,
  meeting_weekday INTEGER CHECK (meeting_weekday BETWEEN 0 AND 6), -- 0=Sunday
  meeting_time TEXT,               -- 'HH:MM' church-local
  meeting_frequency TEXT CHECK (meeting_frequency IN ('weekly','biweekly','monthly')),
  meeting_location TEXT,
  open_signup INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE member_group_i18n (
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (group_id, locale)
);
```

- [ ] **Step 2: Write the Postgres mirror + portal-only tables**

`migrations-supabase/0006_member_portal.sql` — same shared DDL with PG idioms
(identity ids, `DROP/ADD CONSTRAINT` instead of rebuild), plus the four
portal-only tables:

```sql
-- Member portal: mirror of migrations/0007_member_portal.sql plus the
-- Supabase-only portal tables (giving/registration precedent).

ALTER TABLE household_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN pending_email TEXT;

-- Inline CHECK from 0001_init.sql auto-named tokens_purpose_check.
ALTER TABLE tokens DROP CONSTRAINT tokens_purpose_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_purpose_check
  CHECK (purpose IN ('login','respond','email_change'));

CREATE TABLE member_groups (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'fellowship' CHECK (kind IN ('fellowship','sunday_school')),
  term_label TEXT,
  term_start TEXT,
  term_end TEXT,
  meeting_weekday INTEGER CHECK (meeting_weekday BETWEEN 0 AND 6),
  meeting_time TEXT,
  meeting_frequency TEXT CHECK (meeting_frequency IN ('weekly','biweekly','monthly')),
  meeting_location TEXT,
  open_signup INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE member_group_i18n (
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (group_id, locale)
);

-- ---- Portal-only (no D1 counterpart) ----

CREATE TABLE group_members (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  is_leader INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, person_id)
);

CREATE TABLE group_applications (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  note TEXT,
  decided_by INTEGER REFERENCES people(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_group_applications_pending
  ON group_applications(group_id, status);

CREATE TABLE group_files (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  uploaded_by INTEGER NOT NULL REFERENCES people(id),
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,      -- group-files/{group_id}/{random}
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX idx_group_files_group ON group_files(group_id, deleted_at);

CREATE TABLE event_admins (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reg_event_id, person_id)
);

CREATE TABLE prayer_items (
  id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  scope TEXT NOT NULL CHECK (scope IN ('church','group','event','private')),
  group_id INTEGER REFERENCES member_groups(id),
  reg_event_id INTEGER REFERENCES reg_events(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by INTEGER REFERENCES people(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX idx_prayer_items_scope ON prayer_items(scope, status, deleted_at);
CREATE INDEX idx_prayer_items_group ON prayer_items(group_id);
CREATE INDEX idx_prayer_items_event ON prayer_items(reg_event_id);
```

NOTE: before committing, verify against `migrations-supabase/0001_init.sql` that
`datetime('now')` defaults are legal in this tree (they are — sqlite-compat shim
functions are defined there; copy the exact default style used by existing
mirrored tables). Verify the tokens CHECK constraint name with
`\d tokens` semantics: if 0001 named it explicitly, use that name.

- [ ] **Step 3: Update the parity test**

In `test/pg/schema.test.ts`, append `'0007_member_portal.sql'` to `D1_FILES`.
The tokens rebuild uses the rename-fold idiom the test already understands
(commit e077ce0); if the fold list is explicit, add `tokens_new → tokens`.

- [ ] **Step 4: Apply migrations locally and run parity tests**

Run: `npm run db:migrate:local` (check `package.json` for the exact script name), then `npx vitest run test/pg/schema.test.ts` (needs the local PG harness — see `vitest.e2e.pg.config.ts`; if PG isn't running, `npm run test:e2e:pg` docs in README tell you how to start it).
Expected: parity test PASS with the new file included.

- [ ] **Step 5: Commit**

```bash
git add migrations/0007_member_portal.sql migrations-supabase/0006_member_portal.sql test/pg/schema.test.ts
git commit -m "feat(portal): migrations for member portal schema"
```

---

### Task 2: `portal` module key + route ownership

**Files:**
- Modify: `src/lib/modules.ts` (MODULE_KEYS + MODULES)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts` (module label/desc)
- Test: `test/modules.test.ts` (extend existing patterns), `npx vitest run test/modules.test.ts test/i18n.test.ts`

**Interfaces:**
- Produces: `ModuleKey` gains `'portal'`; `moduleForPath('/my/household')==='portal'` etc.; `locals.modules.has('portal')` available everywhere.

- [ ] **Step 1: Write failing tests** in `test/modules.test.ts` (match the file's existing style):

```ts
it('portal owns its /my sub-prefixes but not /my itself', () => {
  expect(moduleForPath('/my')).toBe('serve');
  expect(moduleForPath('/my/household')).toBe('portal');
  expect(moduleForPath('/my/groups')).toBe('portal');
  expect(moduleForPath('/my/events')).toBe('portal');
  expect(moduleForPath('/my/serving')).toBe('portal');
  expect(moduleForPath('/my/prayer')).toBe('portal');
  expect(moduleForPath('/my/giving')).toBe('giving');
  expect(moduleForPath('/my/calendar')).toBe('serve');
  expect(moduleForPath('/email-change')).toBe('portal');
});

it('portal is supabase-only', () => {
  expect(filterByBackend(['portal'], 'd1').has('portal')).toBe(false);
  expect(filterByBackend(['portal'], 'supabase').has('portal')).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/modules.test.ts` → FAIL (unknown key).

- [ ] **Step 3: Implement.** In `src/lib/modules.ts`: add `'portal'` to `MODULE_KEYS` (before `giving`, keeping backend-gated keys last is nice-to-have; placement only affects display order — update the "The 14 module keys" comment to 15). Add:

```ts
portal: {
  publicPrefixes: ['/my/household', '/my/groups', '/my/events', '/my/serving', '/my/prayer', '/email-change'],
  adminPrefixes: ['/admin/fellowships'],
  navKeys: [],
  uses: ['serve', 'fellowships'],
  requiresBackend: 'supabase',
},
```

Add i18n keys in both dictionaries following the `modules.<key>.label/.desc` pattern, e.g. EN label `Member Portal`, desc `Member self-service: household profiles, groups, events, serving, calendar, prayer wall. Requires Supabase.`; ZH label `会友门户`, desc matching in Simplified Chinese.

- [ ] **Step 4: Run tests** — `npx vitest run test/modules.test.ts test/i18n.test.ts` → PASS. Check the admin Modules panel renders the new row (it iterates MODULE_KEYS; verify by reading `src/pages/admin/settings` module panel source — no code change expected).

- [ ] **Step 5: Commit** — `git commit -m "feat(portal): register portal module (supabase-only)"`

---

### Task 3: Household ownership in the data layer

**Files:**
- Modify: `src/lib/householdDb.ts` (`MEMBER_COL_NAMES` + `HouseholdMember`)
- Create: `src/lib/portalDb.ts`
- Test: `test/portalDb.test.ts` (new; copy DB harness setup from an existing db-layer test such as `test/householdDb.test.ts` if present, else the closest `*Db` test)

**Interfaces:**
- Consumes: `household_members.is_owner` from Task 1.
- Produces (exact signatures later phases rely on):

```ts
// householdDb.ts: HouseholdMember gains `is_owner: number` (0|1), selected by all queries.

// portalDb.ts
export interface PortalHousehold extends HouseholdWithMembers {
  viewerIsOwner: boolean;
}
/** Household for the signed-in viewer with ownership flag; null when none. */
export async function getPortalHousehold(db: AppDb, viewerPersonId: number): Promise<PortalHousehold | null>;
/** Promote/demote a co-owner. Rules: actor must be owner of the household (or isAdmin);
 *  target must be role='adult' AND person_id IS NOT NULL and its person must have an email;
 *  max 2 owners; an owner cannot demote themselves. Throws: 'not_authorized' |
 *  'owner_limit' | 'not_eligible' | 'cannot_demote_self' | 'not_found'. */
export async function setOwner(db: AppDb, args: {
  householdId: number; memberId: number; isOwner: boolean;
  actorPersonId: number; isAdmin: boolean;
}): Promise<void>;
/** Fields an owner may edit on a linked member's people row (never email). */
export interface MemberProfilePatch {
  first_name?: string; last_name?: string; display_name?: string;
  phone?: string | null; birthday?: string | null; address?: string | null;
}
/** Owner (or self, or admin) edits a household member's profile. Dependent rows
 *  (person_id IS NULL) accept only display_name + role. Throws 'not_authorized' | 'not_found'. */
export async function updateMemberProfile(db: AppDb, args: {
  actorPersonId: number; isAdmin: boolean; memberId: number;
  patch: MemberProfilePatch; dependentRole?: 'adult' | 'child';
}): Promise<void>;
```

- [ ] **Step 1: Add `is_owner` to householdDb** — extend `MEMBER_COL_NAMES` (`'is_owner'`) and `HouseholdMember` (`is_owner: number`). Run the whole unit suite once (`npx vitest run`) to catch any `SELECT *`-shape assertions.

- [ ] **Step 2: Write failing tests** in `test/portalDb.test.ts` covering the rule matrix:
  - promote second adult (owner actor) → both owners, is_owner=1
  - promote a third → throws `owner_limit`
  - promote a dependent (person_id NULL) or a child → `not_eligible`
  - non-owner actor promotes → `not_authorized`; admin actor → allowed
  - owner demotes co-owner → ok; owner demotes self → `cannot_demote_self`
  - `updateMemberProfile`: owner edits linked member's phone → people row updated; email is not a patchable field (type-level) and a raw attempt is ignored; non-owner edits someone else → `not_authorized`; self-edit without ownership → allowed; dependent row: only display_name/role apply.

Include real test code in the file using the harness's `people`/`households` fixtures (mirror how existing db tests seed rows — check `test/` for a households/checkin test to copy setup from).

- [ ] **Step 3: Run to verify failures**, **Step 4: implement `portalDb.ts`** (portable SQL; owner-count check with `SELECT COUNT(*) ... is_owner=1`; eligibility via join to `people.email IS NOT NULL`), **Step 5: tests green**.

- [ ] **Step 6: Commit** — `git commit -m "feat(portal): household ownership data layer"`

---

### Task 4: Admin console — owner checkbox + ownerless flag

**Files:**
- Modify: `src/pages/admin/people/[id].astro` (household panel: owner toggle per eligible adult; reuse `setOwner` with `isAdmin: true`)
- Modify: the admin household list surface (in `src/pages/admin/people/index.astro` — find where households are listed; add an "No owner" `badge` when a household has zero owners; extend `listHouseholds` in `householdDb.ts` with an `owner_count` subselect)
- Modify: `src/i18n/en.ts` / `zh.ts` (keys like `portal.owner`, `portal.ownerNone`, `portal.ownerLimit` — reuse for portal pages later)
- Test: extend the page's existing test if one exists; otherwise `npx vitest run` + manual check

**Interfaces:**
- Consumes: `setOwner` from Task 3.
- Produces: `HouseholdSummary` gains `owner_count: number`.

Steps: add `action === 'setOwner'` branch next to the existing `setPrimary` branch (same form pattern: hidden `memberId`, `householdId`); render an Owner badge/toggle beside the Primary one at `src/pages/admin/people/[id].astro:432-447`; surface `owner_limit`/`not_eligible` errors with `noticeErr`. i18n both locales. Run `npx vitest run test/i18n.test.ts` + full unit suite. Commit `feat(portal): admin household owner management`.

---

### Task 5: Email-change flow (lib + routes)

**Files:**
- Modify: `src/lib/auth.ts` (TokenPurpose + TTL)
- Create: `src/lib/emailChange.ts`
- Create: `src/pages/email-change/[token].astro`
- Modify: `src/lib/routePolicy.ts` (mirror how `/auth` + `/respond` are classified public)
- Modify: `src/lib/notify.ts` (two senders)
- Test: `test/emailChange.test.ts`

**Interfaces:**
- Consumes: widened tokens CHECK (Task 1).
- Produces:

```ts
// auth.ts
export type TokenPurpose = 'login' | 'respond' | 'email_change';
export const EMAIL_CHANGE_TTL_MIN = 60;           // TTL_SQL entry '+60 minutes'
export const EMAIL_CHANGE_RATE_LIMIT = 3;         // per person per hour

// emailChange.ts
/** Validates + normalizes (lowercase) the new address, rejects addresses already on
 *  another people row, rate-limits (3/hour), deletes prior email_change tokens for
 *  this person, stores people.pending_email, returns the raw token to email.
 *  Returns {error:'invalid'|'taken'|'rate_limited'} instead of throwing. */
export async function requestEmailChange(db: AppDb, personId: number, newEmail: string):
  Promise<{ raw: string; newEmail: string } | { error: 'invalid' | 'taken' | 'rate_limited' }>;
/** peek (GET confirm page): returns { personId, newEmail } or null. */
export async function peekEmailChange(db: AppDb, rawToken: string):
  Promise<{ personId: number; newEmail: string } | null>;
/** consume (POST): atomically consumes the token, re-checks uniqueness, swaps
 *  people.email, clears pending_email, bumps session_epoch, returns old+new email
 *  for notification. Returns {error:'taken'|'invalid'} on failure. */
export async function consumeEmailChange(db: AppDb, rawToken: string):
  Promise<{ personId: number; oldEmail: string; newEmail: string } | { error: 'taken' | 'invalid' }>;
```

- [ ] **Step 1: Failing tests** in `test/emailChange.test.ts`: happy path (request → peek → consume swaps email + clears pending + bumps epoch); re-issue deletes the earlier token (old raw no longer peeks); rate limit at 4th request in the window; `taken` at request time and at consume time (create the collision between request and consume); expired token (insert with past `expires_at`) fails peek/consume; GET-peek does not consume (peek twice OK, consume still works).
- [ ] **Step 2: verify failures.** **Step 3: implement** `auth.ts` additions + `emailChange.ts` (token insert can reuse a small exported helper from auth.ts or duplicate the 6-line insert — prefer exporting `insertToken` as `createEmailChangeToken(db, personId)` from auth.ts next to its siblings). **Step 4: tests green.**
- [ ] **Step 5: Confirm page** `src/pages/email-change/[token].astro` — copy the structure of `src/pages/auth/[token].astro`: GET → `peekEmailChange` → render confirm button (shows the new address, `Base` layout, i18n keys `portal.emailChange.*`); POST → `consumeEmailChange` → send notification to OLD address via a new `sendEmailChangedNotice` in `notify.ts` (pattern: `sendDeclineNotice`), then 303 to `/{locale}/signin?changed=1` (session was revoked by the epoch bump — the page copy must say "sign in again with your new address"). Add the `/email-change` prefix to `routePolicy.ts` exactly the way `/auth` and `/respond` are declared public.
- [ ] **Step 6: The request form** lives in `/my/household` (Task 6) — this task only exposes the lib + confirm page. Senders: `sendEmailChangeLink(env, db, person, raw, newEmail, locale)` in `notify.ts` (pattern: `sendMagicLink`, link `${APP_ORIGIN}/email-change/${raw}`).
- [ ] **Step 7: Full unit suite + i18n test green; commit** `feat(portal): email change flow with peek/consume confirm`.

---

### Task 6: `/my/household` page

**Files:**
- Create: `src/pages/[locale]/my/household.astro`
- Create: `src/components/PortalNav.astro`
- Modify: `src/components/Header.astro` (signed-in "My Portal" link)
- Modify: `src/i18n/en.ts` / `zh.ts`
- Test: `test/i18n.test.ts` + `npx vitest run`; visual check via dev server

**Interfaces:**
- Consumes: `getPortalHousehold`, `setOwner`, `updateMemberProfile` (Task 3), `requestEmailChange` + `sendEmailChangeLink` (Task 5), avatar plumbing `saveImageUpload`/`setPersonAvatar` (existing, see `src/pages/[locale]/profile.astro:146-169`).
- Produces: `PortalNav.astro` — props `{ locale, active }` where `active` ∈ `'dashboard'|'household'|'giving'|'groups'|'events'|'serving'|'calendar'|'prayer'`; renders links only for enabled modules (`Astro.locals.modules`). Later phases add their tabs here.

- [ ] **Step 1: PortalNav component** — horizontal tab strip under the page title (token classes; mirror how existing member pages render section headers). Tabs: Dashboard `/my`, Household `/my/household`, Giving `/my/giving` (only if `giving` module on), Groups/Events/Serving/Prayer (render only if `portal` on — always true on these pages, but the component is shared with `/my` which runs without portal), Calendar `/my/calendar`.
- [ ] **Step 2: Page frontmatter** — signed-in user from `Astro.locals.user` (pattern: `src/pages/[locale]/my/index.astro`); `getPortalHousehold(db, user.id)`; POST handling with `action` switch: `updateProfile` (self or owner; fields first/last/display name, phone, birthday, address), `setOwner` / `unsetOwner`, `requestEmailChange` (self only → send link, `noticeOk` "check your new inbox"), `avatar` upload (copy profile.astro's `saveImageUpload` handling). 303 redirect to self with `?ok=...` / `?err=...` query params rendered as notices.
- [ ] **Step 3: Markup** — household card (name/address/phone read-only + link to `/{locale}/profile` for create/leave/add-dependent actions, per spec overlap decision); member list with per-member edit form (collapsed `<details>` per member is fine, no client JS); owner badge + promote/demote buttons for eligible adults when viewer is owner; "ask a church admin to set an owner" `noticeErr` when `owner_count === 0`; self card additionally shows email + pending_email state + change-email form.
- [ ] **Step 4: No-household state** — friendly empty card linking to `/{locale}/profile` (household creation stays there).
- [ ] **Step 5: Header** — in `Header.astro`, when `Astro.locals.user` exists AND `Astro.locals.modules.has('portal')`, render a "My Portal" link (`localePath(locale, '/my')`) in the desktop nav area (after the settings-driven items, before the Give CTA) and inside the mobile disclosure menu. i18n key `portal.nav.myPortal`. NOTE: Header currently never reads `locals` user — confirm `Astro.locals` is reachable there (it is in .astro components via `Astro.locals`); pass locale the way the component already does.
- [ ] **Step 6: i18n keys both locales** (`portal.household.*`, `portal.nav.*`, `portal.emailChange.*` UI strings). Run `npx vitest run` (i18n + tokens checks). `npm run build` must succeed.
- [ ] **Step 7: Commit** — `feat(portal): /my/household page, portal nav, header entry`.

---

### Task 7: Seed data + pg e2e + phase gate

**Files:**
- Modify: `seed/dev-seed.sql` (+ the supabase seed path if separate — check `scripts/db/` seed scripts)
- Create: `test/e2e-pg/portal-household.test.ts` (copy harness from an existing e2e-pg test, e.g. the giving or children one)
- Test: `npm test` AND `npm run test:e2e:pg`

Steps:
- [ ] Seed: give the seeded demo household an owner (`UPDATE household_members SET is_owner=1 WHERE ...` on the seeded primary adult); add one fellowship-kind and one sunday_school-kind `member_groups` row + i18n (en+zh) so Phase 2 has data; keep D1/PG seeds in step.
- [ ] E2E (pg backend): sign in as seeded owner (the e2e harness has a session helper — find how existing e2e tests authenticate) → GET `/en/my/household` 200, shows members → POST promote second adult → both owners → POST demote → one owner → non-owner member GET sees no edit forms for others → email-change request → consume → old session 401/redirects (epoch bump) . Also: with `DB_BACKEND=d1` (unit-level), `moduleForPath('/my/household')` gating means the route 404s — assert via the modules unit test already written (no e2e needed).
- [ ] Run FULL suites: `npm test` and `npm run test:e2e:pg` → green. Fix fallout (e.g. any test asserting 14 modules).
- [ ] Commit — `feat(portal): seed + e2e for household foundations`.

---

## Phase-gate checklist (reviewer runs)

- `npm test`, `npm run test:e2e:pg`, `npm run build`, `npm run tokens:check` all green.
- `git log` shows one commit per task on `feat/member-portal`.
- Manual smoke (dev server, supabase backend): `/en/my/household` renders; owner promote/demote; email-change email logged with `EMAIL_DEV_LOG=1`; D1 backend: `/en/my/household` 404s, `/en/my` untouched.
