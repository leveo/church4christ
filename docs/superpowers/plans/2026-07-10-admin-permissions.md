# Per-Admin Module Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A super admin grants each admin per-module access; every admin gets prayer-wall + member-directory basics by default; all admin surfaces (routes, sidebar, dashboard, member-profile activity panels incl. a NEW giving-history panel) respect the grants.

**Architecture:** Two additive `people` columns (`super_admin`, `admin_areas` CSV) loaded into `SessionUser` each request (instant revocation, no cache). A new pure lib `src/lib/adminAreas.ts` (modeled on `modules.ts`/`routePolicy.ts`) classifies admin paths to "area" keys and answers `hasAreaAccess(user, area)`. Enforcement: middleware choke point (403) + the codebase's in-page defense-in-depth convention + nav/dashboard/panel filtering. Spec: `docs/superpowers/specs/2026-07-10-admin-permissions-design.md`.

**Tech Stack:** Astro SSR on Cloudflare Workers, D1 + Postgres dual backend (AppDb), Vitest (workers pool + e2e vs built worker), no client framework.

## Global Constraints

- Working dir: `/Users/leosong/Python/church-cms-perms` (branch `feat/admin-permissions`, based on origin/main). NEVER commit `docs/superpowers/**` (internal; this branch becomes a public PR).
- Editors / team leaders / finance-flagged members keep today's behavior EXACTLY. The permission layer narrows only `role='admin'` users who are not super admins.
- Every new i18n key goes to BOTH `src/i18n/en.ts` and `src/i18n/zh.ts` (parity test enforces; identical `{placeholder}` names).
- No hardcoded colors/fonts (CI `tokens:check`); reuse `src/lib/adminUi.ts` class constants and `var(--color-*)` tokens.
- Migrations are append-only, mirrored in `migrations/` (D1) and `migrations-supabase/` (PG); booleans are INTEGER 0/1 in both.
- `seed/dev-seed.sql` is `;`-split by 4 consumers — no semicolons except as statement terminators.
- Comments are load-bearing in this codebase: new gating logic gets a short WHY comment matching existing density/style. Commit messages in English, conventional (`feat:`/`fix:`/`test:`/`docs:`).
- After EVERY task: `npm test` green before commit. (`npm run test:e2e` where the task says so.)
- Failure modes stay distinct: module off = 404 (existing, pre-session); missing per-admin grant = 403. On D1, giving/registration modules are force-off → those routes 404 for everyone regardless of grants (use `groups` to test no-grant 403 on D1).

---

### Task 1: Schema migrations + seed + schema tests

**Files:**
- Create: `migrations/0007_admin_permissions.sql`
- Create: `migrations-supabase/0006_admin_permissions.sql`
- Modify: `seed/dev-seed.sql` (people section, ~line 28-40)
- Modify: `test/schema.test.ts` (add column assertions)
- Modify: `test/pg/schema.test.ts` (D1_FILES array)

**Interfaces:**
- Produces: `people.super_admin INTEGER NOT NULL DEFAULT 0`, `people.admin_areas TEXT NOT NULL DEFAULT ''`; seeded person 1 (admin@example.com) is super admin; seeded person 11 `lydia.kwan@example.com` is a limited admin with `admin_areas='groups,events'`.

- [ ] **Step 1: Write failing schema test.** In `test/schema.test.ts`, find the existing people-table tests and add (mirror the file's existing style for reading `PRAGMA`/inserting rows):

```ts
it('people carries admin-permission columns with safe defaults', async () => {
  await env.DB.prepare(
    `INSERT INTO people (first_name, last_name, display_name, email) VALUES ('P', 'Q', 'P Q', 'pq@example.com')`,
  ).run();
  const row = await env.DB.prepare(
    `SELECT super_admin, admin_areas FROM people WHERE email = 'pq@example.com'`,
  ).first<{ super_admin: number; admin_areas: string }>();
  expect(row).toEqual({ super_admin: 0, admin_areas: '' });
});
```

- [ ] **Step 2: Run** `npx vitest run test/schema.test.ts` → the new test FAILS (`no such column: super_admin`).

- [ ] **Step 3: Create `migrations/0007_admin_permissions.sql`:**

```sql
-- Per-admin module permissions (design spec 2026-07-10): `super_admin` marks the
-- admins who see everything and manage other admins' access; `admin_areas` is a
-- comma-separated list of granted area keys (validated against the allow-list in
-- src/lib/adminAreas.ts — prayer-wall and the member directory are always-on
-- defaults and never stored). Existing role='admin' rows are backfilled as super
-- admins so no already-deployed install loses access on upgrade.
ALTER TABLE people ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN admin_areas TEXT NOT NULL DEFAULT '';
UPDATE people SET super_admin = 1 WHERE role = 'admin';
```

- [ ] **Step 4: Create `migrations-supabase/0006_admin_permissions.sql`** with the IDENTICAL statements (same comment header; INTEGER booleans are the cross-backend convention — do not use `boolean`).

- [ ] **Step 5: Seed.** In `seed/dev-seed.sql`, directly after the people INSERT block (ends near line 40), add:

```sql
-- Alex Admin is the demo super admin. The migration's role='admin' backfill runs
-- BEFORE seeding, so seeded rows must set the flag explicitly. Lydia Kwan is the
-- demo LIMITED admin: she sees only prayer wall + member directory (defaults)
-- plus her granted groups + news/events areas.
UPDATE people SET super_admin = 1 WHERE id = 1;
INSERT INTO people (id, first_name, last_name, display_name, email, phone, role, lang, super_admin, admin_areas) VALUES
  (11, 'Lydia', 'Kwan', 'Lydia Kwan 关莉迪', 'lydia.kwan@example.com', NULL, 'admin', 'zh', 0, 'groups,events');
```

First confirm id 11 is unused: `grep -n "^  (11," seed/dev-seed.sql` (people ids run 1–10 today). If a later seed section (e.g. team_members) assumes contiguous people ids, it doesn't — verify by running the e2e suite in Step 7.

- [ ] **Step 6: PG parity test.** In `test/pg/schema.test.ts`, the `D1_FILES` array currently lists only `0001…0004` — it is stale (missing 0005/0006, a pre-existing gap). Replace with the full list:

```ts
const D1_FILES = [
  '0001_init.sql',
  '0002_email.sql',
  '0003_people.sql',
  '0004_giving_people.sql',
  '0005_custom_pages.sql',
  '0006_groups.sql',
  '0007_admin_permissions.sql',
];
```

- [ ] **Step 7: Verify.** `npx vitest run test/schema.test.ts` → PASS. Then `npm test` (pg project self-skips without DATABASE_URL — fine). Then `npm run test:e2e` (seed must still parse: 4 consumers split on `;`).

- [ ] **Step 8: Commit** `feat: admin permission columns (super_admin, admin_areas) + seed demo admins`

---

### Task 2: Pure area registry — `src/lib/adminAreas.ts`

**Files:**
- Create: `src/lib/adminAreas.ts`
- Create: `test/adminAreas.test.ts`

**Interfaces:**
- Consumes: `SessionUser` type from `src/lib/types.ts` — NOTE: uses the two fields Task 3 adds (`isSuperAdmin: boolean`, `adminAreas: string[]`). **Do Task 3's types.ts change here if Task 3 hasn't run yet** — add the fields to the type only (loading comes in Task 3); TypeScript object literals in existing tests won't break if tests build users via spread of a full fixture. If `npm run check` complains about missing fields in existing test fixtures, prefer adding the two fields to those fixtures.
- Produces (exact API for Tasks 4/6/7/8/9):

```ts
export const GRANTABLE_AREAS = ['bulletins','sermons','prayer-sheets','testimonies','pages','events','people','groups','giving','registration','serve'] as const;
export type GrantableArea = (typeof GRANTABLE_AREAS)[number];
export type AdminAreaKey = GrantableArea | 'prayer-wall' | 'people-basic' | 'settings';
export const ALWAYS_AREAS: readonly AdminAreaKey[];            // ['prayer-wall','people-basic']
export function parseAdminAreas(csv: string | null | undefined): GrantableArea[]; // trim, split ',', filter to GRANTABLE_AREAS, dedupe
export function adminAreaForPath(path: string): AdminAreaKey | null; // locale-stripped path; null = not an area-owned admin path
export function hasAreaAccess(user: SessionUser | null, area: AdminAreaKey): boolean;
```

- [ ] **Step 1: Write failing tests** in `test/adminAreas.test.ts`, table-driven in the style of `test/routePolicy.test.ts` (copy its `makeUser` helper shape, extended with the two new fields):

```ts
import { describe, expect, it } from 'vitest';
import { adminAreaForPath, hasAreaAccess, parseAdminAreas, GRANTABLE_AREAS } from '../src/lib/adminAreas';
import type { SessionUser } from '../src/lib/types';

const makeUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1, email: 'x@example.com', displayName: 'X', role: 'member',
  isAdmin: false, isEditor: false, isSuperAdmin: false, adminAreas: [],
  finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: 'en', ...over,
});

describe('adminAreaForPath', () => {
  const cases: Array<[string, string | null]> = [
    ['/admin', null],
    ['/admin/bulletins', 'bulletins'],
    ['/admin/bulletins/new', 'bulletins'],
    ['/admin/revisions/bulletin/1', 'bulletins'],
    ['/admin/sermons', 'sermons'],
    ['/admin/revisions/sermon/2', 'sermons'],
    ['/admin/prayer-sheets', 'prayer-sheets'],
    ['/admin/revisions/prayer_sheet/3', 'prayer-sheets'],
    ['/admin/testimonies', 'testimonies'],
    ['/admin/pages', 'pages'],
    ['/admin/revisions/custom_page/4', 'pages'],
    ['/admin/announcements', 'events'],
    ['/admin/events', 'events'],
    ['/admin/revisions/announcement/5', 'events'],
    ['/admin/revisions/event/6', 'events'],
    ['/admin/prayer-wall', 'prayer-wall'],
    ['/admin/people', 'people-basic'],
    ['/admin/people/3', 'people-basic'],
    ['/admin/groups', 'groups'],
    ['/admin/groups/2', 'groups'],
    ['/admin/giving', 'giving'],
    ['/admin/giving/reconcile', 'giving'],
    ['/admin/registration', 'registration'],
    ['/admin/ministries', 'serve'],
    ['/admin/service-types', 'serve'],
    ['/admin/teams', 'serve'],
    ['/admin/reports', 'serve'],
    ['/admin/reports.csv', 'serve'],
    ['/admin/availability', 'serve'],
    ['/admin/applications', 'serve'],
    ['/admin/settings', 'settings'],
    ['/admin/navigation', 'settings'],
    ['/admin/revisions', null],          // bare revisions: fail closed via null
    ['/admin/nonexistent', null],        // unknown: fail closed via null
    ['/adminx', null],                   // segment-aware: not under /admin
    ['/bulletin', null],                 // public path, no area
  ];
  for (const [path, expected] of cases) {
    it(`${path} -> ${expected}`, () => expect(adminAreaForPath(path)).toBe(expected));
  }
});

describe('hasAreaAccess', () => {
  const limited = makeUser({ role: 'admin', isAdmin: true, adminAreas: ['groups'] });
  const superA = makeUser({ role: 'admin', isAdmin: true, isSuperAdmin: true });
  it('anon / member / editor / leader never pass (callers keep their own role logic)', () => {
    expect(hasAreaAccess(null, 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser(), 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser({ role: 'editor', isEditor: true }), 'bulletins')).toBe(false);
    expect(hasAreaAccess(makeUser({ leaderTeamIds: [1] }), 'serve')).toBe(false);
  });
  it('super admin passes every area including settings', () => {
    expect(hasAreaAccess(superA, 'settings')).toBe(true);
    expect(hasAreaAccess(superA, 'giving')).toBe(true);
  });
  it('limited admin: granted + always-on areas only; settings never grantable', () => {
    expect(hasAreaAccess(limited, 'groups')).toBe(true);
    expect(hasAreaAccess(limited, 'bulletins')).toBe(false);
    expect(hasAreaAccess(limited, 'prayer-wall')).toBe(true);
    expect(hasAreaAccess(limited, 'people-basic')).toBe(true);
    expect(hasAreaAccess(limited, 'settings')).toBe(false);
  });
});

describe('parseAdminAreas', () => {
  it('filters junk, reserved keys, and dupes; handles empty/null', () => {
    expect(parseAdminAreas('groups, events ,junk,settings,prayer-wall,groups')).toEqual(['groups', 'events']);
    expect(parseAdminAreas('')).toEqual([]);
    expect(parseAdminAreas(null)).toEqual([]);
    expect(parseAdminAreas(undefined)).toEqual([]);
  });
  it('accepts every grantable key', () => {
    expect(parseAdminAreas(GRANTABLE_AREAS.join(','))).toEqual([...GRANTABLE_AREAS]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/adminAreas.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/adminAreas.ts`** (pure, no DB imports — mirrors the tone of `modules.ts`/`routePolicy.ts` header comments):

```ts
// Per-ADMIN area grants (design spec 2026-07-10) — the third authorization axis,
// distinct from the church-wide module toggles (src/lib/modules.ts) and the role
// classes (src/lib/routePolicy.ts). An "area" is the unit a super admin grants to
// an individual admin. Where an area matches a ModuleKey it reuses the same string
// so the church-wide toggle (404, pre-session) and the per-admin grant (403,
// post-session) compose without translation. Pure and unit-tested; the middleware
// is the enforcement choke point, pages re-check inline per house convention.
import type { SessionUser } from './types';

// Areas a super admin can grant. prayer-wall and people-basic are NOT here: they
// are always-on for every admin (Leo's default: prayer wall + member basics).
// settings (which also covers /admin/navigation) is never grantable — super only.
export const GRANTABLE_AREAS = [
  'bulletins',
  'sermons',
  'prayer-sheets',
  'testimonies',
  'pages',
  'events',
  'people',
  'groups',
  'giving',
  'registration',
  'serve',
] as const;
export type GrantableArea = (typeof GRANTABLE_AREAS)[number];
export type AdminAreaKey = GrantableArea | 'prayer-wall' | 'people-basic' | 'settings';

export const ALWAYS_AREAS: readonly AdminAreaKey[] = ['prayer-wall', 'people-basic'];

// Admin route prefix -> owning area. Longest prefix wins (so the per-entity
// revision editors map to their content area, not a generic revisions bucket).
// A bare/unknown /admin path maps to NO area — the middleware fails closed and
// only super admins pass, mirroring routePolicy's unknown-/admin -> adminOnly.
const AREA_PREFIXES: Array<[string, AdminAreaKey]> = [
  ['/admin/bulletins', 'bulletins'],
  ['/admin/revisions/bulletin', 'bulletins'],
  ['/admin/sermons', 'sermons'],
  ['/admin/revisions/sermon', 'sermons'],
  ['/admin/prayer-sheets', 'prayer-sheets'],
  ['/admin/revisions/prayer_sheet', 'prayer-sheets'],
  ['/admin/testimonies', 'testimonies'],
  ['/admin/pages', 'pages'],
  ['/admin/revisions/custom_page', 'pages'],
  ['/admin/announcements', 'events'],
  ['/admin/events', 'events'],
  ['/admin/revisions/announcement', 'events'],
  ['/admin/revisions/event', 'events'],
  ['/admin/prayer-wall', 'prayer-wall'],
  ['/admin/people', 'people-basic'],
  ['/admin/groups', 'groups'],
  ['/admin/giving', 'giving'],
  ['/admin/registration', 'registration'],
  ['/admin/ministries', 'serve'],
  ['/admin/service-types', 'serve'],
  ['/admin/teams', 'serve'],
  ['/admin/reports', 'serve'],
  ['/admin/reports.csv', 'serve'],
  ['/admin/availability', 'serve'],
  ['/admin/applications', 'serve'],
  ['/admin/settings', 'settings'],
  ['/admin/navigation', 'settings'],
];

/** Segment-aware prefix match (same shape as modules.ts): exact or `prefix/…`. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** The area owning a locale-stripped admin path, or null (dashboard / unknown). */
export function adminAreaForPath(path: string): AdminAreaKey | null {
  let best: [string, AdminAreaKey] | null = null;
  for (const entry of AREA_PREFIXES) {
    if (under(path, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** Comma-separated grant list -> validated, deduped GrantableArea[]. */
export function parseAdminAreas(csv: string | null | undefined): GrantableArea[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: GrantableArea[] = [];
  for (const raw of csv.split(',')) {
    const key = raw.trim();
    if ((GRANTABLE_AREAS as readonly string[]).includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key as GrantableArea);
    }
  }
  return out;
}

/**
 * Whether this user's ADMIN grant covers `area`. Only ever true for admins:
 * editors / leaders / finance-flagged members return false and their callers
 * keep their existing role logic (this layer only narrows admins). Super admins
 * pass everything; limited admins pass the always-on defaults plus their grants;
 * `settings` is reserved for super admins.
 */
export function hasAreaAccess(user: SessionUser | null, area: AdminAreaKey): boolean {
  if (!user || !user.isAdmin) return false;
  if (user.isSuperAdmin) return true;
  if (area === 'settings') return false;
  if (ALWAYS_AREAS.includes(area)) return true;
  return (user.adminAreas as readonly string[]).includes(area);
}
```

- [ ] **Step 4:** If `src/lib/types.ts` doesn't yet have the two fields, add them to `SessionUser` now (see Task 3 Step 3 for the exact block) so this compiles.

- [ ] **Step 5: Run** `npx vitest run test/adminAreas.test.ts` → PASS. Run `npm run check` (fix any SessionUser fixture fallout in existing tests by adding `isSuperAdmin: false, adminAreas: []`).

- [ ] **Step 6: Commit** `feat: pure admin-area registry (adminAreaForPath, hasAreaAccess)`

---

### Task 3: SessionUser plumbing (types + currentUser)

**Files:**
- Modify: `src/lib/types.ts` (SessionUser)
- Modify: `src/lib/currentUser.ts` (PERSON_AUTH_COLS, PersonAuthRow, toSessionUser)
- Modify: `test/middlewareAuth.test.ts` (new cases)

**Interfaces:**
- Consumes: `parseAdminAreas` from Task 2.
- Produces: `SessionUser.isSuperAdmin: boolean` (true iff `role==='admin' && super_admin===1`), `SessionUser.adminAreas: string[]` (validated grants; `[]` for non-admins). Every page sees these via `Astro.locals.user`.

- [ ] **Step 1: Write failing tests.** In `test/middlewareAuth.test.ts`, mirror its beforeEach-seeded style and add:

```ts
it('loads super_admin and validated admin_areas onto the session user', async () => {
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (60, 'S', 'A', 'S A', 'sup@example.com', 'admin', 1, ''),
            (61, 'L', 'A', 'L A', 'lim@example.com', 'admin', 0, 'groups,junk,settings,events'),
            (62, 'E', 'D', 'E D', 'ed@example.com', 'editor', 1, 'groups')`,
  ).run();
  const sup = await loadSessionUser(env.DB, 60, 0);
  expect(sup?.isSuperAdmin).toBe(true);
  const lim = await loadSessionUser(env.DB, 61, 0);
  expect(lim?.isSuperAdmin).toBe(false);
  expect(lim?.adminAreas).toEqual(['groups', 'events']); // junk + reserved filtered
  // the flags are inert on a non-admin row
  const ed = await loadSessionUser(env.DB, 62, 0);
  expect(ed?.isSuperAdmin).toBe(false);
  expect(ed?.adminAreas).toEqual([]);
});
```

- [ ] **Step 2: Run** `npx vitest run test/middlewareAuth.test.ts` → new test FAILS.

- [ ] **Step 3: Implement.** `src/lib/types.ts` — after the `finance` field:

```ts
  // Per-admin module permissions (spec 2026-07-10): super admins see every admin
  // area and manage other admins' grants; adminAreas holds a limited admin's
  // granted area keys (validated against src/lib/adminAreas.ts, [] for
  // non-admins). Loaded fresh each request, so revocation is immediate.
  isSuperAdmin: boolean;
  adminAreas: string[];
```

`src/lib/currentUser.ts`:
- `PERSON_AUTH_COLS` → `'id, email, display_name, role, finance, lang, super_admin, admin_areas'`
- `PersonAuthRow` += `super_admin: number; admin_areas: string;`
- `toSessionUser` += (import `parseAdminAreas` from `./adminAreas`):

```ts
    isSuperAdmin: person.role === 'admin' && person.super_admin === 1,
    adminAreas: person.role === 'admin' ? parseAdminAreas(person.admin_areas) : [],
```

- [ ] **Step 4: Run** `npx vitest run test/middlewareAuth.test.ts` → PASS; `npm test` + `npm run check` green (fix any SessionUser literal fixtures missing the new fields).

- [ ] **Step 5: Commit** `feat: load per-admin area grants onto SessionUser`

---

### Task 4: Middleware area gate + core e2e matrix

**Files:**
- Modify: `src/middleware.ts` (immediately after the classifyRoute/canAccess block, ~line 197)
- Create: `test/e2e/admin-permissions.e2e.test.ts`

**Interfaces:**
- Consumes: `adminAreaForPath`, `hasAreaAccess` (Task 2); `SessionUser.isSuperAdmin` (Task 3).
- Produces: limited admins get 403 on ungranted admin areas and on unknown /admin paths; dashboard `/admin` stays open to every admin.

- [ ] **Step 1: Write failing e2e test** `test/e2e/admin-permissions.e2e.test.ts` (copy the helper style from `test/e2e/admin.e2e.test.ts` — `get`, `mintSession`, `SESSION_COOKIE`; insert test people via `env.DB` so the file is self-contained):

```ts
// Per-admin area-grant matrix against the BUILT worker. A LIMITED admin (role
// 'admin', super_admin=0) sees only the always-on defaults (prayer wall, member
// directory) plus explicit grants; a super admin sees everything. On the D1 e2e
// backend the giving/registration modules are force-off (404 pre-session), so
// no-grant 403s are asserted with `groups`/content areas instead.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (50, 'Lena', 'Limited', 'Lena Limited', 'lena.limited@example.com', 'admin', 0, 'bulletins')`,
  ).run();
});

describe('limited admin route matrix', () => {
  const CASES: Array<[string, number]> = [
    ['/admin', 200],               // dashboard: every admin
    ['/admin/bulletins', 200],     // granted
    ['/admin/prayer-wall', 200],   // always-on default
    ['/admin/people', 200],        // member directory: always-on default
    ['/admin/sermons', 403],       // not granted
    ['/admin/groups', 403],        // not granted
    ['/admin/teams', 403],         // serve area, not granted
    ['/admin/reports', 403],
    ['/admin/settings', 403],      // reserved for super admins
    ['/admin/navigation', 403],
    ['/admin/does-not-exist', 403],// unknown /admin path fails closed
  ];
  for (const [path, status] of CASES) {
    it(`${path} -> ${status}`, async () => {
      const cookie = await sessionCookie(50, 'lena.limited@example.com');
      expect((await get(path, { cookie })).status).toBe(status);
    });
  }
  it('seeded limited admin (lydia, groups+events) reaches groups but not sermons', async () => {
    const cookie = await sessionCookie(11, 'lydia.kwan@example.com');
    expect((await get('/admin/groups', { cookie })).status).toBe(200);
    expect((await get('/admin/events', { cookie })).status).toBe(200);
    expect((await get('/admin/sermons', { cookie })).status).toBe(403);
  });
  it('super admin (person 1) is unaffected', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    for (const path of ['/admin/sermons', '/admin/settings', '/admin/teams']) {
      expect((await get(path, { cookie })).status).toBe(200);
    }
  });
});
```

- [ ] **Step 2: Run** `npm run test:e2e -- admin-permissions` → the 403 rows FAIL (all 200 today).

- [ ] **Step 3: Implement the middleware gate.** In `src/middleware.ts`, directly AFTER the existing `canAccess` block (after its two early-return branches, before `const res = await next()`):

```ts
    // Per-admin area gate (spec 2026-07-10): narrows LIMITED admins only — a
    // non-admin passing canAccess (editor / leader / finance member) is exactly
    // as authorized as before, and super admins pass everything. Runs after the
    // role gate so the failure modes stay distinct: module off = 404 (above,
    // pre-session), role short = 403 (canAccess), grant missing = 403 (here).
    // Unknown /admin paths carry no area and fail closed to super-admin-only.
    const u = context.locals.user;
    if (u?.isAdmin && !u.isSuperAdmin && (rest === '/admin' || rest.startsWith('/admin/'))) {
      if (rest !== '/admin') {
        const area = adminAreaForPath(rest);
        if (!area || !hasAreaAccess(u, area)) return finish(forbidden(context.locals.locale));
      }
    }
```

Add the import: `import { adminAreaForPath, hasAreaAccess } from './lib/adminAreas';`

- [ ] **Step 4: Run** `npm run test:e2e -- admin-permissions` → PASS. Run the FULL `npm run test:e2e` — the pre-existing `admin.e2e.test.ts` matrix must stay green (person 1 is super via seed). Run `npm test`.

- [ ] **Step 5: Commit** `feat: middleware enforcement of per-admin area grants`

---

### Task 5: adminDb write path — flags extension + last-super-admin guards

**Files:**
- Modify: `src/lib/adminDb.ts` (`setPersonFlags` ~line 268, `softDeletePerson` ~line 292)
- Create: `test/adminDb.permissions.test.ts`

**Interfaces:**
- Consumes: `parseAdminAreas`, `GrantableArea` (Task 2).
- Produces: `setPersonFlags(db, id, { role?, active?, finance?, superAdmin?, adminAreas? })` — `adminAreas: string[]` validated+joined CSV; throws `Error('last_super_admin')` when a change would leave zero active super admins. `softDeletePerson(db, id)` throws the same when deleting the last super admin.

- [ ] **Step 1: Write failing tests** `test/adminDb.permissions.test.ts` (workers project; truncate + seed in beforeEach like `test/adminDb.prayer.test.ts`):

```ts
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { setPersonFlags, softDeletePerson } from '../src/lib/adminDb';

const db = env.DB;
beforeEach(async () => {
  await db.prepare(`DELETE FROM people`).run();
  await db.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (1, 'S', 'One', 'S One', 's1@example.com', 'admin', 1, ''),
            (2, 'L', 'Two', 'L Two', 'l2@example.com', 'admin', 0, ''),
            (3, 'M', 'Three', 'M Three', 'm3@example.com', 'member', 0, '')`,
  ).run();
});

const superCount = async () =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM people WHERE role='admin' AND super_admin=1 AND active=1 AND deleted_at IS NULL`).first<{ n: number }>())!.n;

describe('setPersonFlags: permission writes', () => {
  it('writes superAdmin and validated adminAreas', async () => {
    await setPersonFlags(db, 2, { superAdmin: true });
    await setPersonFlags(db, 3, { adminAreas: ['groups', 'junk', 'settings', 'events'] });
    const two = await db.prepare(`SELECT super_admin FROM people WHERE id=2`).first<{ super_admin: number }>();
    expect(two!.super_admin).toBe(1);
    const three = await db.prepare(`SELECT admin_areas FROM people WHERE id=3`).first<{ admin_areas: string }>();
    expect(three!.admin_areas).toBe('groups,events');
  });
  it('leaves untouched fields alone (partial update)', async () => {
    await setPersonFlags(db, 2, { adminAreas: ['bulletins'] });
    const row = await db.prepare(`SELECT role, super_admin FROM people WHERE id=2`).first<{ role: string; super_admin: number }>();
    expect(row).toEqual({ role: 'admin', super_admin: 0 });
  });
});

describe('last super admin guard', () => {
  it('rejects unsetting the flag / demoting / deactivating the last super admin', async () => {
    await expect(setPersonFlags(db, 1, { superAdmin: false })).rejects.toThrow(/last_super_admin/);
    await expect(setPersonFlags(db, 1, { role: 'member' })).rejects.toThrow(/last_super_admin/);
    await expect(setPersonFlags(db, 1, { active: false })).rejects.toThrow(/last_super_admin/);
    await expect(softDeletePerson(db, 1)).rejects.toThrow(/last_super_admin/);
    expect(await superCount()).toBe(1);
  });
  it('allows all of those once another super admin exists', async () => {
    await setPersonFlags(db, 2, { superAdmin: true });
    await setPersonFlags(db, 1, { superAdmin: false });
    expect(await superCount()).toBe(1);
  });
  it('non-super rows are unaffected by the guard', async () => {
    await setPersonFlags(db, 2, { active: false });
    await softDeletePerson(db, 3);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/adminDb.permissions.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/lib/adminDb.ts`:

```ts
/** True when this person is the LAST active super admin — the guard that keeps
 *  grant management from being bricked (spec §5). */
async function isLastSuperAdmin(db: AppDb, id: number): Promise<boolean> {
  const target = await db
    .prepare(`SELECT super_admin FROM people WHERE id = ? AND role = 'admin' AND active = 1 AND deleted_at IS NULL`)
    .bind(id)
    .first<{ super_admin: number }>();
  if (!target || target.super_admin !== 1) return false;
  const others = await db
    .prepare(`SELECT COUNT(*) AS n FROM people WHERE role = 'admin' AND super_admin = 1 AND active = 1 AND deleted_at IS NULL AND id != ?`)
    .bind(id)
    .first<{ n: number }>();
  return (others?.n ?? 0) === 0;
}
```

Extend `setPersonFlags` signature to `{ role?: Role; active?: boolean; finance?: boolean; superAdmin?: boolean; adminAreas?: string[] }`. Before building the UPDATE, add:

```ts
  // Refuse any change that would leave zero active super admins: unsetting the
  // flag, demoting the role, or deactivating — each on the last super admin.
  const losesSuper =
    flags.superAdmin === false || (flags.role !== undefined && flags.role !== 'admin') || flags.active === false;
  if (losesSuper && (await isLastSuperAdmin(db, id))) throw new Error('last_super_admin');
```

Then two more assignment branches (import `parseAdminAreas`):

```ts
  if (flags.superAdmin !== undefined) {
    sets.push('super_admin = ?');
    binds.push(flags.superAdmin ? 1 : 0);
  }
  if (flags.adminAreas !== undefined) {
    sets.push('admin_areas = ?');
    binds.push(parseAdminAreas(flags.adminAreas.join(',')).join(','));
  }
```

`softDeletePerson`: first line `if (await isLastSuperAdmin(db, id)) throw new Error('last_super_admin');` (update its doc comment).

- [ ] **Step 4: Run** `npx vitest run test/adminDb.permissions.test.ts` → PASS; `npm test` green.

- [ ] **Step 5: Commit** `feat: admin-area grant writes with last-super-admin guard`

---

### Task 6: Person page — super-only flags form + grant checkboxes

**Files:**
- Modify: `src/pages/admin/people/[id].astro` (POST `flags`/`delete` branches ~lines 94-112; flags form markup ~lines 405-431)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts`
- Modify: `test/e2e/admin-permissions.e2e.test.ts` (append describe blocks)

**Interfaces:**
- Consumes: `hasAreaAccess`, `GRANTABLE_AREAS`, `GrantableArea` (Task 2); `setPersonFlags` extension (Task 5); `Astro.locals.dbBackend` (existing).
- Produces: form field names used by e2e: `action=flags`, `role`, `active`, `finance`, `super_admin`, repeated `areas` checkboxes (value = area key).

- [ ] **Step 1: Write failing e2e** (append to `test/e2e/admin-permissions.e2e.test.ts`; `post` helper posts form-encoded — mirror how `admin.e2e.test.ts` posts forms):

```ts
describe('flags form is super-admin only; grants apply instantly', () => {
  it('limited admin: flags POST -> 403; delete POST -> 403 (no people grant)', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const flags = await post('/admin/people/3', { action: 'flags', role: 'member', active: 'on' }, { cookie });
    expect(flags.status).toBe(403);
    const del = await post('/admin/people/3', { action: 'delete' }, { cookie });
    expect(del.status).toBe(403);
  });
  it('super admin grants sermons to lena; she gains access on her next request', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await post(
      '/admin/people/50',
      { action: 'flags', role: 'admin', active: 'on', areas: ['bulletins', 'sermons'] },
      { cookie: admin },
    );
    expect(res.status).toBe(303);
    const lena = await sessionCookie(50, 'lena.limited@example.com');
    expect((await get('/admin/sermons', { cookie: lena })).status).toBe(200);
  });
  it('unchecking super on the last super admin re-renders with an error and keeps the flag', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await post('/admin/people/1', { action: 'flags', role: 'admin', active: 'on' }, { cookie: admin });
    expect(res.status).toBe(200); // re-render with error banner, not a redirect
    expect((await get('/admin/settings', { cookie: admin })).status).toBe(200); // still super
  });
  it('limited admin sees no flags form on a person page', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).not.toContain('name="action" value="flags"');
  });
});
```

If the `post` helper doesn't support array values, encode repeated `areas` fields manually with `URLSearchParams` appends.

- [ ] **Step 2: Run** `npm run test:e2e -- admin-permissions` → new blocks FAIL.

- [ ] **Step 3: Implement in `[id].astro`.** Frontmatter near the `hasX` consts:

```ts
const canManagePeople = hasAreaAccess(user, 'people');
const isSuper = user.isSuperAdmin;
```

POST `delete` branch — wrap with people-grant + guard:

```ts
  if (action === 'delete' && id !== null) {
    if (!canManagePeople) return new Response(null, { status: 403 });
    try {
      await softDeletePerson(db, id);
    } catch (e) {
      if (e instanceof Error && e.message === 'last_super_admin') {
        flagsErrorKey = 'admin.person.lastSuperErr';
      } else throw e;
    }
    if (!flagsErrorKey) return Astro.redirect('/admin/people/?deleted=1', 303);
  }
```

POST `flags` branch — super only, read new fields, catch the guard:

```ts
  if (action === 'flags' && id !== null) {
    // Only a super admin may touch roles / grants — closes the pre-permissions
    // hole where any admin could promote anyone to admin.
    if (!isSuper) return new Response(null, { status: 403 });
    const roleRaw = String(fd.get('role') ?? '');
    const role = ROLES.find((r) => r === roleRaw);
    const nextSuper = role === 'admin' && fd.get('super_admin') !== null;
    const areas = fd.getAll('areas').map(String);
    try {
      await setPersonFlags(db, id, {
        role,
        active: fd.get('active') !== null,
        ...(hasGiving ? { finance: fd.get('finance') !== null } : {}),
        superAdmin: nextSuper,
        adminAreas: areas,
      });
      return Astro.redirect(`/admin/people/${id}?saved=1`, 303);
    } catch (e) {
      if (e instanceof Error && e.message === 'last_super_admin') {
        flagsErrorKey = 'admin.person.lastSuperErr';
      } else throw e;
    }
  }
```

Declare `let flagsErrorKey: string | null = null;` beside the other error keys. Re-fetch `person` after POST fallthrough if the file doesn't already (it fetches before POST — after a failed flags POST the pre-fetched row is stale only for fields the failed write didn't change, acceptable; keep simple).

Markup: wrap the whole flags `<form>` in `{isSuper && (...)}`; for non-super render a compact read-only summary (role + active + finance as plain `<dl>` rows using existing label keys — no form). Inside the super form, after the finance checkbox:

```astro
{person.role === 'admin' && (
  <label class="flex items-center gap-2">
    <input type="checkbox" name="super_admin" checked={person.super_admin === 1} />
    <span class="text-sm">{t(lang, 'admin.person.superAdmin')}</span>
  </label>
  <fieldset class="space-y-2">
    <legend class={lab}>{t(lang, 'admin.person.areasTitle')}</legend>
    <p class="text-xs text-ink-muted">{t(lang, 'admin.person.areasHint')}</p>
    {GRANTABLE_AREAS.map((a) => (
      <label class="flex items-center gap-2">
        <input type="checkbox" name="areas" value={a}
          checked={personAreas.includes(a)}
          disabled={(a === 'giving' || a === 'registration') && Astro.locals.dbBackend !== 'supabase'} />
        <span class="text-sm">{t(lang, AREA_LABEL_KEYS[a])}</span>
      </label>
    ))}
  </fieldset>
)}
```

with frontmatter `const personAreas = parseAdminAreas(person?.admin_areas)` and a label map:

```ts
const AREA_LABEL_KEYS: Record<GrantableArea, string> = {
  bulletins: 'admin.nav.bulletins', sermons: 'admin.nav.sermons',
  'prayer-sheets': 'admin.nav.prayerSheets', testimonies: 'admin.nav.testimonies',
  pages: 'admin.nav.pages', events: 'admin.nav.news', people: 'admin.areas.people',
  groups: 'admin.nav.groups', giving: 'admin.giving.title', registration: 'admin.reg.title',
  serve: 'admin.areas.serve',
};
```

NOTE: `getPerson` must return `super_admin`/`admin_areas` — check `src/lib/adminDb.ts` `getPerson`'s SELECT column list and add both columns (plus its row type). Show flags error banner: `{flagsErrorKey && <p class={noticeErr}>{t(lang, flagsErrorKey)}</p>}` above the flags form. Grey the super checkbox note when person is yourself? Not needed — the guard covers it.

- [ ] **Step 4: i18n.** Add to BOTH `en.ts`/`zh.ts` (zh values shown after `/`):

```
'admin.person.superAdmin': 'Super admin' / '总管理员'
'admin.person.areasTitle': 'Module access' / '模块权限'
'admin.person.areasHint': 'Prayer wall and the member directory are always available to every admin.' / '祷告墙和会员名录对所有管理员始终开放。'
'admin.person.lastSuperErr': 'At least one super admin must remain.' / '必须保留至少一位总管理员。'
'admin.areas.people': 'Member management' / '会员管理'
'admin.areas.serve': 'Volunteer ministry' / '义工事工'
```

(Check `admin.nav.news` exists for the events label; if the sidebar uses a different key for the News group, reuse that exact key.)

- [ ] **Step 5: Run** `npm run test:e2e -- admin-permissions` → PASS; `npm test` (i18n parity) green; `npm run check`.

- [ ] **Step 6: Commit** `feat: super-admin flags panel with per-module grant checkboxes`

---

### Task 7: Person page panels — people-grant gating + giving history panel

**Files:**
- Modify: `src/pages/admin/people/[id].astro` (POST save/household/notes/invite gating; identity form read-only; panel conditions; new giving section)
- Modify: `src/pages/admin/people/index.astro` (hide "New person" button without people grant)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts`
- Modify: `test/e2e/admin-permissions.e2e.test.ts` (append)
- Modify: `test/e2e-pg/` — add giving-panel spec (follow the dir's existing file pattern)

**Interfaces:**
- Consumes: `hasAreaAccess` (Task 2); `listHouseholdGifts(db, locale, personId)`, `householdYearTotals(db, personId)` from `src/lib/givingDb.ts` (read their exact signatures/return types before use); `GroupActivity` props unchanged.
- Produces: panel visibility semantics for Task 8's dashboard work (same `hasAreaAccess` conjunctions).

- [ ] **Step 1: Write failing e2e** (append to `admin-permissions.e2e.test.ts`):

```ts
describe('member profile activity respects the viewer’s grants', () => {
  it('limited admin without people grant: read-only identity, no household/notes forms, save POST -> 403', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).not.toContain('name="action" value="save"');       // no editable identity form
    expect(html).not.toContain('name="action" value="createHousehold"');
    expect(html).not.toContain('name="action" value="addNote"');
    const save = await post('/admin/people/3', { action: 'save', display_name: 'X', email: 's@x.com' }, { cookie });
    expect(save.status).toBe(403);
    // /admin/people/new is member management too
    expect((await get('/admin/people/new', { cookie })).status).toBe(403);
  });
  it('groups activity panel follows the groups grant', async () => {
    const lydia = await sessionCookie(11, 'lydia.kwan@example.com');   // groups granted
    const lena = await sessionCookie(50, 'lena.limited@example.com'); // not granted
    const withGroups = await (await get('/admin/people/3', { cookie: lydia })).text();
    const withoutGroups = await (await get('/admin/people/3', { cookie: lena })).text();
    const marker = 'admin.person.groups.title';
    // resolve the actual rendered heading text instead of the key:
    // grep src/i18n/en.ts for admin.person.groups.title and use its value here.
    expect(withGroups).toContain(GROUPS_HEADING);
    expect(withoutGroups).not.toContain(GROUPS_HEADING);
  });
  it('people index hides the New-person button without the people grant', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people', { cookie })).text();
    expect(html).not.toContain('/admin/people/new');
  });
});
```

(Define `GROUPS_HEADING` from the real en dictionary value; keep assertions marker-based like `smoke.sh` does.)

- [ ] **Step 2: Run** → FAIL (limited admin currently gets full page).

- [ ] **Step 3: Implement in `[id].astro`:**
  - `if (isNew && !canManagePeople) return new Response(null, { status: 404 });` — wait, existing pages use 403 for authority; use `403`.
  - POST `save` branch: first line `if (!canManagePeople) return new Response(null, { status: 403 });`
  - The people-module actions block: `if (hasPeople && id !== null)` → `if (hasPeople && canManagePeople && id !== null)` (household/notes/invite all inherit the grant).
  - Panel data loads: `if (hasPeople && person)` → `if (hasPeople && canManagePeople && person)`.
  - Panel render conditions `{hasPeople && (` → `{hasPeople && canManagePeople && (` (household/notes/applications/invite sections).
  - Groups: frontmatter `const canGroups = hasAreaAccess(user, 'groups');` and `const canRegistration = hasAreaAccess(user, 'registration');`; data `if (hasGroups && canGroups && person)`, inner registration fetch `if (Astro.locals.modules.has('registration') && canRegistration)`; render `{hasGroups && canGroups && (`.
  - Identity form read-only without the grant: wrap the identity form's inner content in `<fieldset class="contents" disabled={!canManagePeople}>` (native disabled inputs; `contents` keeps layout) and hide the submit button + avatar/remove controls when `!canManagePeople`. Delete form at the bottom: `{canManagePeople && (` wrap.
  - NEW giving panel. Frontmatter:

```ts
const canGiving = hasGiving && hasAreaAccess(user, 'giving'); // hasGiving is module+backend (force-off on D1)
let giftRows: HouseholdGiftRow[] = [];  // use givingDb's actual exported row type
let givingYtd: YearTotalsRow[] = [];    // ditto — read givingDb.ts first
if (canGiving && person) {
  [giftRows, givingYtd] = await Promise.all([
    listHouseholdGifts(db, lang, person.id),
    householdYearTotals(db, person.id),
  ]);
}
```

  Render after the groups section, mirroring the section/card idiom (`mt-6 ${card} max-w-2xl`): heading `t(lang,'admin.person.giving.title')`; YTD line(s) from `givingYtd`; a compact table of the first 10 of `giftRows` (date / fund / amount / method — reuse the money-formatting helper `/my/giving.astro` uses); empty state `admin.person.giving.empty`; footer link to `/admin/giving` labeled `admin.person.giving.viewAll`. Comment the section: giving history renders only for giving-granted admins (spec requirement #4).

  - `people/index.astro`: `const canManagePeople = hasAreaAccess(user, 'people');` and wrap the New-person `<a>` (line ~45) in `{canManagePeople && (...)}`.

- [ ] **Step 4: i18n** (both dictionaries):

```
'admin.person.giving.title': 'Giving history' / '奉献记录'
'admin.person.giving.ytd': 'This year: {amount}' / '今年累计：{amount}'
'admin.person.giving.empty': 'No gifts recorded.' / '暂无奉献记录。'
'admin.person.giving.viewAll': 'Open giving admin' / '打开奉献管理'
```

(Adjust `ytd` shape to whatever `householdYearTotals` actually returns — per-fund rows may fit a small list better; keep placeholders identical across locales.)

- [ ] **Step 5: pg-e2e giving panel.** Look at `test/e2e-pg/` for an existing spec to copy (setup differs: Postgres via Hyperdrive, giving module ON). Add `test/e2e-pg/admin-permissions.e2e.test.ts`: insert a limited admin with `admin_areas='giving'` and one with `''`; GET `/admin/people/<seeded person with gifts — check seed/giving-seed.sql for which person has gifts>`; assert the giving heading (en dictionary value) present for the granted admin + super admin, absent for the ungranted one. If sessions in pg-e2e are minted the same way, reuse the helper pattern.

- [ ] **Step 6: Run** `npm run test:e2e -- admin-permissions` → PASS; full `npm run test:e2e` green; `npm test` green. If local Postgres is available (`DATABASE_URL`), run `npm run test:e2e:pg`; otherwise note it for CI.

- [ ] **Step 7: Commit** `feat: grant-aware member profile (people management gate + giving history panel)`

---

### Task 8: Sidebar + dashboard + visibility

**Files:**
- Modify: `src/layouts/Admin.astro` (rawSections ~lines 77-111, filter logic)
- Modify: `src/pages/admin/index.astro` (cards/sections)
- Modify: `test/e2e/admin-permissions.e2e.test.ts` (append sidebar assertions)

**Interfaces:**
- Consumes: `hasAreaAccess`, `AdminAreaKey` (Task 2).

- [ ] **Step 1: Failing e2e** (append):

```ts
describe('sidebar and dashboard reflect grants', () => {
  it('limited admin sidebar: granted + default links only; no settings/navigation', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin', { cookie })).text();
    expect(html).toContain('href="/admin/bulletins"');
    expect(html).toContain('href="/admin/prayer-wall"');
    expect(html).toContain('href="/admin/people"');
    expect(html).not.toContain('href="/admin/sermons"');
    expect(html).not.toContain('href="/admin/groups"');
    expect(html).not.toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/navigation"');
  });
  it('super admin sidebar unchanged (spot check)', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const html = await (await get('/admin', { cookie })).text();
    for (const href of ['/admin/sermons', '/admin/settings', '/admin/navigation', '/admin/groups']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `Admin.astro`:**

```ts
import { hasAreaAccess, type AdminAreaKey } from '../lib/adminAreas';
// Per-admin area filter: only narrows admins — editors/leaders/finance keep
// their role-based rows (their `show` booleans), so non-admins pass areaOn.
const areaOn = (a?: AdminAreaKey) => !a || !user?.isAdmin || hasAreaAccess(user, a);
const isSuper = !!user?.isSuperAdmin;
```

- Types: `NavItem` and `NavSection` gain `area?: AdminAreaKey`.
- Rows: content children get `area: 'bulletins' | 'sermons' | 'prayer-sheets' | 'testimonies'` respectively and pages child `area: 'pages'`; news section `area: 'events'`; prayer-wall row `area: 'prayer-wall'`; people row `area: 'people-basic'`; groups row `area: 'groups'`; giving row `area: 'giving'`; registration row `area: 'registration'`; settings + navigation rows change `show: isAdmin` → `show: isSuper`.
- Filters: section `s.show && modOn(s.module) && areaOn(s.area)`; children `.filter((c) => modOn(c.module) && areaOn(c.area))`.

- [ ] **Step 4: Implement `admin/index.astro`:**

```ts
import { hasAreaAccess } from '../../lib/adminUi'; // NO — from '../../lib/adminAreas'
const areaOk = (a: Parameters<typeof hasAreaAccess>[1]) => !user.isAdmin || hasAreaAccess(user, a);
```

- Stat cards (~77-80): people card stays (`people-basic` is always-on → no change needed); bulletins/sermons/prayer-sheets cards add `&& areaOk('bulletins')` etc.
- Data fetches: guard the same way to skip needless queries — `if (user.isAdmin) peopleCount…` stays; content counts fetch `if (isStaff)` → leave fetches, they're batched; only add render-guards unless a fetch would run for an area the user can't see AND is expensive — keep it simple: render-guards only.
- Volunteer console section (~132): `(user.isAdmin || isLeader)` → `(areaOk2serve || isLeader)` where `const areaOk2serve = user.isAdmin ? hasAreaAccess(user, 'serve') : false;` — careful to keep leaders working. Also the pendingApps fetch (~66): `if (user.isAdmin)` → `if (user.isAdmin && areaOk('serve'))`.
- Groups section (~145): `user.isAdmin && modules.has('groups')` → `user.isAdmin && areaOk('groups') && modules.has('groups')`.
- Prayer-wall/testimonies combined section (~155): outer becomes `isStaff && (modules.has('prayer-wall') || (modules.has('testimonies') && areaOk('testimonies')))`; inner testimonies block adds `&& areaOk('testimonies')` (prayer-wall is always-on for admins — no guard needed).
- Week-prep/content section (~178): inner bulletins/sermons blocks add `&& areaOk('bulletins')` / `&& areaOk('sermons')`; outer condition mirrors the inner union.
- Recent revisions section (~226, `isStaff && (`): show when editor OR any content area: `const anyContent = ['bulletins','sermons','prayer-sheets','events','pages'].some((a) => areaOk(a));` → `(user.isEditor || anyContent) && (`. Keep a short comment.

- [ ] **Step 5: Run** e2e file → PASS; full e2e + `npm test` + `npm run check` green.

- [ ] **Step 6: Commit** `feat: grant-aware admin sidebar and dashboard`

---

### Task 9: In-page guard sweep (defense-in-depth) + secondary surfaces

**Files:**
- Modify (mapping table below): every `src/pages/admin/**` file with an inline role check; `src/pages/[locale]/profile/[id].astro`; groups/serve public console pages with site-admin overrides; `src/components/admin/*Tab.astro` if they check `isAdmin`.
- Modify: `test/e2e/admin-permissions.e2e.test.ts` (spot checks)

**Interfaces:**
- Consumes: `hasAreaAccess` (Task 2), `SessionUser.isSuperAdmin` (Task 3).

Mapping table (replace ONLY the `user.isAdmin` term inside each existing guard; keep each page's floor — editor/leader/finance disjuncts — intact):

| Files | Old admin term | New term |
|---|---|---|
| bulletins/*, sermons/*, prayer-sheets/*, announcements, events, pages, testimonies, prayer-wall (all `.astro` under those dirs) | `user.isAdmin` in `(user.isEditor \|\| user.isAdmin)` | `hasAreaAccess(user, '<area>')` (per-dir area; announcements+events → `'events'`) |
| registration/index.astro, [id].astro, [id]/export.csv.ts | same | `hasAreaAccess(user, 'registration')` |
| revisions/[entity]/[id].astro | same | map entity→area: `{bulletin:'bulletins', sermon:'sermons', prayer_sheet:'prayer-sheets', announcement:'events', event:'events', custom_page:'pages'}` then `hasAreaAccess(user, area)` |
| groups/index.astro, [id].astro | `!user?.isAdmin` | `!hasAreaAccess(user, 'groups')` |
| giving/index.astro, funds.astro, reconcile.astro | `user.isAdmin \|\| user.finance === 1` | `hasAreaAccess(user, 'giving') \|\| user.finance === 1` |
| ministries/index.astro (+ any `canAdmin` const, EmailTab admin-only tab) | `user.isAdmin` | `hasAreaAccess(user, 'serve')` |
| settings/index.astro, navigation/index.astro | `user.isAdmin` | `user.isSuperAdmin` |
| `[locale]/profile/[id].astro` (~line 40, 64, 75, 85) | `user.isAdmin` | `hasAreaAccess(user, 'serve')` (this page is the serve-scoped person view) |
| `[locale]/groups/**` site-admin overrides (manage/attendance pages; grep `isAdmin`) | `user.isAdmin` (site-admin override) | `hasAreaAccess(user, 'groups')` — do NOT touch group-internal `is_admin` membership columns/params |
| `[locale]/serve/**`, `[locale]/ministries/**` leader consoles (grep `isAdmin`) | `user.isAdmin` | `hasAreaAccess(user, 'serve')` |

- [ ] **Step 1:** `grep -rn "isAdmin" src/pages src/components --include='*.astro' --include='*.ts'` and classify EVERY hit against the table. Hits that are group-membership `is_admin`/`isGroupAdmin(person-level)` or the `Admin.astro`/dashboard files done in Task 8: leave. Anything ambiguous: leave and note it in the commit body.
- [ ] **Step 2: Failing e2e spot checks** (append): limited admin (lena, bulletins only) → `post('/admin/groups', {action:'anything'})` 403 even if middleware were bypassed is not directly testable; instead assert page-level: `get('/admin/giving')` on pg-e2e? Keep it simple — this task's regression risk is EXISTING roles, so assert: editor (person 2) still 200 on `/admin/bulletins`, `/admin/registration`; member 403 everywhere (reuse a couple of matrix rows). Also super admin 200 on `/admin/settings` (isSuperAdmin path).
- [ ] **Step 3:** Apply the table. Each file: import `hasAreaAccess` with the correct relative path; keep the guard as the first executable statement; preserve comments, extend them only where the meaning changed (e.g. settings: "super admin only — grant management lives here").
- [ ] **Step 4:** Full `npm test` + `npm run test:e2e` + `npm run check` green. The existing `admin.e2e.test.ts` editor rows are the canary for over-tightening.
- [ ] **Step 5: Commit** `feat: per-area in-page guards across admin + serve/groups consoles`

---

### Task 10: Docs, README, screenshots, full verification

**Files:**
- Create: `docs/features/admin-permissions.md`
- Modify: `README.md` (features list)
- Modify: `scripts/screenshots.mjs` (PAGES table)

- [ ] **Step 1: Write `docs/features/admin-permissions.md`** — English, non-technical first (audience: church staff): what super admins are; the two always-on defaults (prayer wall, member directory); how to grant module access (Members → person → Module access); what a limited admin's portal looks like; the giving example. Developer notes quarantined at the end: columns, area keys, 404-vs-403, enforcement points, last-super guard. Match the tone/structure of `docs/features/modules.md`.
- [ ] **Step 2: README** — add one feature bullet linking the doc (match existing bullet style).
- [ ] **Step 3: Screenshots** — read `scripts/screenshots.mjs` PAGES table; add `/admin/people/2` (super-admin view showing the Module-access fieldset). If the harness supports only one bypass email, that's fine (super admin view); regenerate only the new screenshot(s) per the script's docs and reference them in the feature doc like other feature docs do.
- [ ] **Step 4: Full gates:** `npm run tokens && npm run tokens:check && npm test && npm run check && npm run build && npm run db:migrate:local && npm run db:seed:local && bash scripts/smoke.sh && npm run test:e2e`. All green.
- [ ] **Step 5: Commit** `docs: admin permissions feature guide + screenshots`

---

## Self-review notes (planner)

- Spec §1-§10 → Tasks: vocabulary/registry (T2), storage (T1), SessionUser (T3), middleware (T4), UI grants + guards (T5/T6), person page + giving panel (T7), sidebar/dashboard (T8), sweep incl. profile/[id] + settings-super (T9), docs/tests (T10 + per-task).
- Types consistent: `GrantableArea`/`AdminAreaKey`/`hasAreaAccess(user, area)` used identically in T2/T4/T6-T9; `setPersonFlags({ superAdmin, adminAreas })` T5→T6.
- Known judgment calls an executor must NOT re-litigate: editors unchanged; settings/navigation super-only; flags form super-only; people-basic read-only default; last-super guard including softDelete; D1 giving = 404 not 403.
