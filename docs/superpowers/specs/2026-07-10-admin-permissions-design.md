# Per-Admin Module Permissions — Design Spec

Date: 2026-07-10
Author: Fable (autonomous design per Leo's /goal directive)
Branch: `feat/admin-permissions` (based on `origin/main` @ bbfa0aa, post PR #8)

## Goal (Leo's requirement, translated)

1. Admins come in different flavors: each admin sees only the admin-portal areas
   relevant to them.
2. A **super admin** (总admin) grants each module's admin access independently,
   per admin.
3. Every admin gets two things by default: the **prayer wall** admin and
   **members' basic info**.
4. A member profile's activity view only shows sections the viewing admin has
   access to — e.g. an admin without giving access must not see donation
   records on a member's profile. (Implication: an admin WITH giving access
   should see them — today no such panel exists, so it must be built.)

Out of scope (explicitly): changing what `editor`, team-leader, or
finance-flagged users can see — the permission layer narrows **role='admin'
users only**. Editors/leaders/finance keep today's behavior byte-for-byte.

## Existing landscape (from exploration)

- One admin tier only: `people.role IN ('member','editor','admin')`; no
  super-admin anywhere. `people.finance` (0/1) is the lone narrow-grant
  precedent (gates the `finance` RouteClass = /admin/giving, for non-admins).
- Two existing, distinct mechanisms that must not be conflated:
  - `src/lib/modules.ts` — **church-wide** feature toggles (14 `ModuleKey`s,
    `module.<key>` settings rows, 60s cache, middleware 404-gate that runs
    BEFORE session load).
  - `src/lib/routePolicy.ts` — pure role-based route classifier
    (`classifyRoute` → RouteClass, `canAccess(cls, user)`), enforced once in
    `src/middleware.ts` after session load; ~20 admin pages also re-check
    inline (defense-in-depth convention).
- `SessionUser` is rebuilt from D1/PG on every request (2 queries) —
  instant revocation. `PERSON_AUTH_COLS = 'id, email, display_name, role,
  finance, lang'` in `src/lib/currentUser.ts`.
- Admin sidebar: literal `rawSections` array in `src/layouts/Admin.astro`,
  filtered by role booleans + `modOn(module)`.
- Admin person page (`src/pages/admin/people/[id].astro`): panels gated by
  `hasPeople`/`hasGroups` (+nested registration); **no giving panel exists**.
  Flags form (`action=flags`) currently lets ANY admin set role/active/finance
  — a privilege-escalation hole this design closes.
- Person-scoped giving readers exist but are member-facing only:
  `listHouseholdGifts`, `householdYearTotals`, `listRecurringForPerson`
  (src/lib/givingDb.ts, used solely by /my/giving).

## Design

### 1. Vocabulary: "admin areas" (new), distinct from "modules" (existing)

New pure lib `src/lib/adminAreas.ts` defines **AdminAreaKey** — the unit of
per-admin grants. Where an area corresponds to an existing `ModuleKey` it
reuses the same string, so the church-wide toggle and the per-admin grant
compose naturally.

| Area key | Admin surfaces covered | Grantable? |
|---|---|---|
| `bulletins` | /admin/bulletins, /admin/revisions/bulletin | yes |
| `sermons` | /admin/sermons, /admin/revisions/sermon | yes |
| `prayer-sheets` | /admin/prayer-sheets, /admin/revisions/prayer_sheet | yes |
| `testimonies` | /admin/testimonies | yes |
| `pages` | /admin/pages, /admin/revisions/custom_page | yes |
| `events` | /admin/events, /admin/announcements, /admin/revisions/announcement, /admin/revisions/event | yes |
| `prayer-wall` | /admin/prayer-wall | **always on** (default, not revocable) |
| `people` | member management: edit/save, flags-panel visibility (super only, see §5), household, pastoral notes, serving apps, invite panels, add-person | yes |
| `people-basic` | /admin/people directory + person-page identity read-only view | **always on** (structural, not stored) |
| `groups` | /admin/groups | yes |
| `giving` | /admin/giving, giving-history panel on person page | yes |
| `registration` | /admin/registration, registrations in person activity | yes |
| `serve` | /admin/ministries, /admin/service-types, /admin/teams, /admin/reports (+reports.csv), /admin/availability, /admin/applications | yes |
| `settings` | /admin/settings, /admin/navigation | **super-admin only** (never grantable) |

- `GRANTABLE_AREAS` = the 11 "yes" rows. `ALWAYS_AREAS` = prayer-wall +
  people-basic. `settings` is reserved.
- `adminAreaForPath(path)` — longest-prefix classifier over admin prefixes
  (modeled on `moduleForPath`). `/admin` exact → `null` (dashboard, any admin).
  Unknown `/admin/*` → fail-closed: limited admins denied (super only), which
  mirrors routePolicy's fail-closed namespace rule.
- Note `/admin/revisions` bare (no entity segment) doesn't exist as a page;
  fail-closed is fine.

### 2. Storage: two additive columns on `people`

```sql
ALTER TABLE people ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN admin_areas TEXT NOT NULL DEFAULT '';
UPDATE people SET super_admin = 1 WHERE role = 'admin';
```

- D1 `migrations/0007_admin_permissions.sql`, PG
  `migrations-supabase/0006_admin_permissions.sql` (mirror; INTEGER booleans,
  verbatim style per convention).
- **Backfill**: every existing `role='admin'` person becomes a super admin —
  upgrade-safe (no deployed install loses access); the church owner then
  demotes/creates limited admins.
- `admin_areas` = comma-separated `AdminAreaKey`s, validated against
  `GRANTABLE_AREAS` on both write and read (unknown/reserved keys filtered).
  A column (not a join table) keeps `loadSessionUser` at 2 queries/request —
  same rationale as the `finance` column precedent. ~11 possible keys; CSV is
  proportionate.
- Follows the exact `0004_giving_people.sql` template (additive ALTERs).
- `test/pg/schema.test.ts` D1_FILES gets `0007_admin_permissions.sql`
  appended, **plus backfill of the missing `0005_custom_pages.sql` /
  `0006_groups.sql` entries** (pre-existing gap in the exact test this feature
  extends; called out in the PR).

### 3. SessionUser

`src/lib/types.ts` + `src/lib/currentUser.ts`:
- `PERSON_AUTH_COLS` += `super_admin, admin_areas`.
- New fields: `isSuperAdmin: boolean` (`super_admin === 1 && role === 'admin'`
  — the flag is inert on non-admin rows), `adminAreas: string[]` (parsed,
  validated CSV; `[]` for non-admins).
- Same instant-revocation guarantee as role/finance (row re-read per request).

### 4. Enforcement (three layers, matching existing idioms)

**a. Pure check** — `src/lib/adminAreas.ts`:
```ts
hasAreaAccess(user, area): boolean
// null user → false; !isAdmin → false (callers fall back to their own
// editor/leader/finance logic); isSuperAdmin → true; area in ALWAYS_AREAS →
// true; else adminAreas.includes(area). 'settings' → super only.
```

**b. Middleware choke point** — `src/middleware.ts`, immediately after the
existing `classifyRoute`/`canAccess` gate passes:
- Only when `rest` is under `/admin`, user is `isAdmin && !isSuperAdmin`
  (non-admins passing canAccess — editors/leaders/finance — are untouched):
  - `rest === '/admin'` → allow (dashboard).
  - `area = adminAreaForPath(rest)`; `area === null` → 403 (fail-closed);
    else `hasAreaAccess(user, area)` or 403 (`forbidden()`).
- Ordering: the church-wide module 404-gate stays where it is (pre-session);
  the area gate is per-user so it must run post-session. Module-off still
  wins (404 before we ever get here).

**c. In-page defense-in-depth** — following the ~20-page inline-recheck
convention, each area-owned admin page adds/extends its first-statement guard
with `hasAreaAccess`, e.g. `/admin/bulletins`:
`if (!user || !(user.isEditor || hasAreaAccess(user, 'bulletins'))) return 403`.
Giving keeps its finance-flag OR: `user.finance === 1 || hasAreaAccess(user,
'giving')`. Ministries keeps its leader OR. POST handlers use the same guard
(they're the same file).

### 5. Grant management UI (super admin)

Extend the existing flags panel on `/admin/people/[id]` — the same place
role/active/finance already live. Changes:
- The flags form (render AND `action=flags` POST) becomes **super-admin
  only**. This deliberately closes the existing hole where any admin could
  promote anyone to admin. Limited admins see the flags as read-only text.
- New controls inside it: a "Super admin" checkbox (only when role=admin) and,
  when role=admin && !super, a fieldset of GRANTABLE_AREAS checkboxes
  ("Module access"). Giving/registration checkboxes render disabled on a D1
  backend (mirrors the Settings→Modules panel treatment).
- Write path: `setPersonFlags(db, id, { superAdmin?, adminAreas? })` extended
  in `src/lib/adminDb.ts`; areas validated/filtered against GRANTABLE_AREAS;
  full-write semantics (all checkboxes posted each save, like the modules
  form).
- **Last-super-admin guard**: `setPersonFlags` rejects any change that would
  leave zero active, non-deleted super admins (removing the flag, demoting
  role away from admin, or deactivating — on the last one). Checked
  server-side in the same transaction/batch. `softDeletePerson` gets the same
  guard (soft-deleting the last super admin would brick grant management).
- Other person-page POST actions: `save`, `household`, `notes`, `invite`,
  `avatar`, `delete` require `hasAreaAccess(user, 'people')` (delete/flags
  additionally protected by the last-super guard); `flags` requires
  `isSuperAdmin`.

### 6. Sidebar, dashboard, and in-page surfaces

- `Admin.astro`: nav rows gain `area?: AdminAreaKey`; filter becomes
  `show && modOn(module) && areaOn(area)` where
  `areaOn(a) = !a || <non-admin> || hasAreaAccess(user, a)` — i.e. area gating
  applies only to limited admins; editor/leader/finance visibility rules stay.
  Settings + Navigation rows: `show: isSuperAdmin` (was isAdmin).
  People row: `show: isAdmin` stays (people-basic default) — link always
  visible to admins.
- `/admin/index.astro` dashboard: each stat card/section adds the matching
  `hasAreaAccess` conjunction so a limited admin's dashboard only shows cards
  they can click through (mirrors the existing "never link into a 404ing
  surface" comment).
- `/admin/people/index.astro`: directory renders for every admin
  (people-basic). Any mutating affordance (add person) requires `people`.
- `/admin/people/[id].astro`:
  - Identity form: editable with `people` grant; otherwise read-only
    presentation of the same basic fields (name, contact, status). `action=
    save` POST requires `people`.
  - Household / pastoral notes / serving applications / invite panels: now
    require module-on AND `hasAreaAccess(user,'people')` (notes privacy rule
    preserved — still never rendered elsewhere).
  - Group activity panel: requires groups module AND `hasAreaAccess(user,
    'groups')`; registrations sub-list additionally requires
    `hasAreaAccess(user, 'registration')` (module nesting preserved).
  - **NEW giving-history panel**: when giving module on (supabase backend)
    AND `hasAreaAccess(user, 'giving')`: year-to-date total +
    recent gifts for the member's household, reusing `householdYearTotals` +
    `listHouseholdGifts` (capped list, e.g. 10 rows, link to /admin/giving).
    This makes requirement 4 real in both directions.
- `/[locale]/profile/[id].astro` (the second "view another person" surface):
  in-page check `user.isAdmin || leader` becomes
  `hasAreaAccess(user,'serve') || leader` (super passes via hasAreaAccess).

### 7. What deliberately does NOT change

- Church-wide module toggles, their 404 semantics, backend force-off for
  giving/registration on D1.
- `routePolicy.ts` — untouched. canAccess('finance') still admits
  finance===1; the area layer runs after it and only narrows limited admins.
  (Keeping the pure file untouched shrinks blast radius; the area classifier
  lives in the new pure lib with its own tests.)
- Editor/leader/finance access, member-facing pages (/my, /profile own view),
  GroupActivity.astro internals (callers keep pre-filtering props), crons.
- Seed person 1 (Alex Admin) stays the demo super admin — seed sets
  `super_admin=1` explicitly (migration backfill can't reach rows inserted
  after migration). Seed also adds ONE limited admin (groups + registration
  grants) so the demo/e2e can exercise the feature evergreen.

### 8. Testing (verifiable success criteria)

- Unit (workers project): `test/adminAreas.test.ts` — table-driven
  adminAreaForPath (every admin route → expected area, incl. revisions
  entity mapping + fail-closed unknowns); hasAreaAccess matrix
  (anon/member/editor/limited-admin/granted-admin/super); CSV parse/filter
  round-trip incl. junk + reserved keys.
- Unit: `test/middlewareAuth` -style additions — loadSessionUser surfaces
  isSuperAdmin/adminAreas; epoch/active semantics unchanged.
- Unit: `test/adminDb.people.test.ts` (or existing file) — setPersonFlags
  super/areas writes, validation filtering, last-super-admin guard (reject
  demote/deactivate/unset on last; allow when another super exists).
- Schema: extend `test/schema.test.ts` (columns + defaults) and
  `test/pg/schema.test.ts` D1_FILES (+ stale-entry backfill).
- E2e (`test/e2e/admin-permissions.e2e.test.ts`): insert a limited admin +
  mint real session; matrix: 200 on /admin, /admin/prayer-wall,
  /admin/people; 403 on /admin/bulletins, /admin/settings, /admin/teams,
  unknown /admin/x; sidebar HTML omits ungranted links, shows granted;
  person page: no household/notes/flags-edit forms, POST action=flags → 403,
  POST action=save → 403; grant flow: super admin POSTs flags granting
  bulletins → limited admin now 200 on /admin/bulletins (instant, no cache).
  Existing `admin.e2e.test.ts` matrix must stay green (seeded admin is super).
- Pg-e2e: giving panel visibility (supabase backend): super admin sees
  giving panel on person page; limited admin without giving does not; with
  giving grant does.
- Gates: i18n en/zh parity (all new keys), tokens:check, astro check, smoke.

### 9. Docs & screenshots

- `docs/features/admin-permissions.md` — English, non-technical lead
  (what a super admin is, how to grant module access, what limited admins
  see), developer section quarantined at the end (schema, area keys,
  enforcement layers).
- README feature bullet + link.
- Screenshots via `scripts/screenshots.mjs`: person-page permissions
  fieldset (super admin view); if the harness's single bypass email allows, a
  limited-admin sidebar shot — otherwise skip (harness constraint, not a
  gate).

### 10. Risks / edge cases addressed

- **Last super admin lockout** → guard in setPersonFlags (§5).
- **Privilege escalation via flags form** → flags now super-only (§5).
- **Fail-open on new admin pages** → unknown /admin/* areas fail closed to
  super-only in middleware; the in-page convention documents adding an `area`
  entry when creating a new admin section.
- **Seed vs backfill ordering** → seed sets super_admin explicitly (§7).
- **Module-off vs no-grant confusion** → 404 (module) vs 403 (grant)
  preserved as distinct failure modes; grant checkboxes for backend-gated
  modules render disabled on D1.
- **Migration number collision with feat/children-checkin** (claims D1 0006 vs
  public 0006_groups) — pre-existing issue on that branch, unaffected by this
  branch's 0007/0006; noted for whoever integrates checkin later.
