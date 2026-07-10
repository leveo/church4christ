# Member Portal — Phase 3 (Events / Serving / Giving / Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/my/events` (my registrations + open events), `/my/serving` (full serving surface), owner-only giving household view, and the `/my` dashboard expansion — almost entirely recomposition of existing data functions.

**Architecture:** Two new portal pages copy the `my/groups` shell; the two existing serve-owned pages (`/my`, `/my/giving`) get surgical in-page additions. **Hard rule: `/my` keeps ALL its current serving functionality (accept/decline/claim) untouched — it must keep working on D1 installs where the portal module is off.** New data functions: `regDb.listRegistrationsForPerson`, `givingDb.listPersonGifts`/`personYearTotals`, `portalDb.isHouseholdOwner`. Spec: `docs/superpowers/specs/2026-07-10-member-portal-design.md`.

**Tech Stack:** unchanged (Astro 7 SSR, AppDb, Tailwind tokens, Vitest + pg e2e).

## Global Constraints

- `/my` and `/my/giving` run on D1 — every portal addition to them is gated in-page (`Astro.locals.modules.has('portal')`, and `modules.has('registration')` for anything touching reg tables). NOTHING existing on those pages moves or is removed.
- Giving visibility (spec): household statement is OWNER-only (`household_members.is_owner=1` for the viewer); non-owners see only gifts where `person_id = viewer` — applies regardless of the portal module (the is_owner column is shared schema).
- My registrations query: `r.person_id = ? OR LOWER(r.email) = LOWER(viewer.email)`, exclude `cancelled`.
- Pages pass no admin authority; PRG + `?ok=`/`?err=`; i18n both locales identical keys Simplified Chinese (`portal.events.*`, `portal.serving.*`, extend `portal.dashboard.*`/`giving.*` as needed); tokens only.
- After each task: named tests, then commit with the message given; suffix:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01LXG31UsdHggtkv9S8KYNBY`.

---

### Task 1: Data layer — registrations by person, person-scoped giving, owner check

**Files:** Modify `src/lib/regDb.ts`, `src/lib/givingDb.ts`, `src/lib/portalDb.ts`; tests `test/regDb.person.test.ts` (new; fabricate reg tables like test/groupDb.test.ts fabricates group tables — check whether an existing regDb/givingDb unit test already does this and extend it instead), `test/portalDb.test.ts`.

**Interfaces:**
```ts
// regDb.ts (mirror EVENT_SELECT i18n style)
export interface MyRegistration { id: number; event_id: number; event_title: string; starts_at: string; ends_at: string | null; location: string | null; status: 'pending' | 'confirmed'; amount_cents: number; currency: string; created_at: string; }
export async function listRegistrationsForPerson(db: AppDb, locale: Locale, personId: number, email: string): Promise<MyRegistration[]>; // person_id match OR lower(email) match, status != 'cancelled', ORDER BY starts_at DESC

// givingDb.ts (siblings of listHouseholdGifts/householdYearTotals, same GiftRow shape)
export async function listPersonGifts(db: AppDb, locale: Locale, personId: number): Promise<(GiftRow & { giver_name: string })[]>; // WHERE g.person_id = ? only
export async function personYearTotals(db: AppDb, personId: number): Promise<{ year: string; total_cents: number }[]>;

// portalDb.ts
export async function isHouseholdOwner(db: AppDb, personId: number): Promise<boolean>; // is_owner=1 row in the person's LIVE household (h.deleted_at IS NULL)
```

Steps: failing tests first (registration matching matrix: person_id hit / email-only hit incl. case-insensitive / cancelled excluded / other-person excluded; giving: person-scoped excludes household others; owner check: owner true / member false / deleted household false) → implement → `npx vitest run` full green → commit `feat(portal): person-scoped registrations, giving and owner lookup`.

---

### Task 2: `/my/events` + `/my/serving` pages

**Files:** Create `src/pages/[locale]/my/events.astro`, `src/pages/[locale]/my/serving.astro`; i18n both locales.

- **events.astro** (shell from `my/groups/index.astro`, import depth like `giving.astro`): PortalNav active="events". Sections: **My registrations** (`listRegistrationsForPerson(db, locale, user.id, user.email)`: title, date via formatDate, location, status badge pending/confirmed, amount when >0) with empty state; **Open for registration** (gate on `modules.has('registration')`; `listOpenEvents(db, locale)`: title/date/price/spots, card links to `/{locale}/register/{id}`). No mutations (registration/cancel stay in the existing public flow) — no POST handler at all.
- **serving.astro** (recompose from `my/index.astro`'s sections + `myDb`/`planDb` fns — READ my/index.astro first and reuse its exact form/action patterns): PortalNav active="serving". Sections: pending responses (accept/decline forms — same `respondToAssignment` actions, duplicated deliberately from `/my`; keep the code idiomatically identical), upcoming confirmed, open slots + claim (`listOpenSlotsForPerson`/`claimOpenSlot`), my teams (`listPersonTeams` chips), serving history (`listPersonServingHistory`, cap display at ~20 rows), my applications (`listApplicationsByPerson`). POST handler mirrors my/index.astro's accept/decline/claim.
- Verify: full `npx vitest run`, `npm run build`, `npm run tokens:check`, `npx astro check`. Commit `feat(portal): /my/events and /my/serving pages`.

---

### Task 3: Giving tightening + dashboard expansion

**Files:** Modify `src/pages/[locale]/my/giving.astro`, `src/pages/[locale]/my/index.astro`; i18n.

- **giving.astro:** load `isHouseholdOwner(db, user.id)`. Owner → existing household sections unchanged (add a small "household statement" heading note). Non-owner → swap in `listPersonGifts`/`personYearTotals` and a one-line explainer (`portal.giving.ownScopeNote`: EN "Showing your own giving. Household statements are visible to household owners." / ZH matching). `listRecurringForPerson` is already person-scoped — unchanged for both. Replace the back-link strip with `PortalNav active="giving"` ONLY if trivially compatible; otherwise keep the back-link (surgical rule) — decide by looking; report the choice.
- **index.astro (dashboard):** keep every existing section and POST action byte-identical. Changes: (1) swap the ad-hoc link strip for `<PortalNav locale={locale} active="dashboard" />` (PortalNav self-gates tabs by module, and dashboard/calendar links work on D1 — confirm the giving tab only shows when giving module on, which PortalNav already does); (2) prepend a portal-gated card row (`modules.has('portal')`): household card (`getPortalHousehold`: name + member count + owner badge + link `/my/household`), groups card (`listMyGroups` count + link), and — additionally gated on `modules.has('registration')` — upcoming events card (`listRegistrationsForPerson` next 1-2 non-past + link `/my/events`); pending-approvals card for group leaders (`listPendingApplicationsForGroups` over leader group ids, count + link) gated on portal. Load these in the existing `Promise.all` ONLY inside the module gate (D1 must not touch supabase-only tables — follow the pattern `modules.has('portal') ? realQuery : Promise.resolve(null)`).
- Verify: full suite, build, tokens, astro check, AND `npm run test:e2e` (D1 e2e exercises /my and /my/giving — must stay green, proving the D1 path untouched). Commit `feat(portal): dashboard cards and owner-scoped giving`.

---

### Task 4: pg e2e + phase gate

**Files:** `seed/portal-seed.sql` (extend), `test/e2e-pg/portal-dashboard.test.ts` (new; or extend portal-groups file — follow the suite's per-file reseed cost judgment), possibly `seed/registration-seed.sql` interplay — READ how the pg harness loads registration seed (Task 6 of Phase 2 noted the harness skips giving/registration seeds; if so, fabricate a reg_event + registration via direct SQL in the test itself instead of seed files — decide by reading `test/e2e-pg/setup.ts`).

Scenarios: owner (David) GET /en/my/giving → household table incl. Amy's gifts (needs a seeded gift — check whether pg harness has giving data; if not, insert via SQL in-test); non-owner (Amy) GET → own-only + explainer; David GET /en/my → dashboard cards (household name, groups count); GET /en/my/events with an in-test reg_event + registration for Amy (email-match case: registration with person_id NULL but Amy's email) → listed; /en/my/serving 200 with sections. Phase gate: all five commands green.

Commit `feat(portal): seed + e2e for portal read models`.

---

## Phase-gate checklist
- Five gate commands green; D1 e2e proves /my and /my/giving unregressed; one commit per task.
