# Member Portal — Phase 5 (Prayer Wall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The portal prayer wall: members post prayer items scoped church / group / event / private; church-public items need church-admin approval, group items the group leader's, event items the event admin's; private items are auto-approved and visible only to the author.

**Architecture:** `prayer_items` + `event_admins` tables exist (Supabase-only, Phase 1). New `src/lib/prayerDb.ts` enforces ALL visibility/eligibility/approval rules in the data layer; `/my/prayer` renders tabs + approval queues (approvers act in the portal — NO admin-console moderation page); the reg-event admin editor gains an event-admins panel. Spec: `docs/superpowers/specs/2026-07-10-member-portal-design.md` §Permission model.

## Global Constraints

- Authorization in the data layer; the portal page passes viewer id only, never admin authority for MUTATIONS — EXCEPT: church-scope approval is by `role='admin'` and church admins may moderate every scope (spec grants it); prayerDb approval functions therefore take `{ approverId, isAdmin }` and the PAGE may pass the real `user.isAdmin` **into prayerDb approval/queue functions only** (document the divergence like the Task-4 download route did). Posting/reading always use plain member identity (church-public approved items are visible to every signed-in member regardless of role).
- Eligibility to POST: church → any member; group → `isGroupMember`; event → registered for that event (person_id or email match, non-cancelled — same rule as `listRegistrationsForPerson`) OR that event's event_admin; private → always. Server-side enforced ('not_eligible').
- Visibility to READ: church tab → approved church items (any member); group tab → approved items of MY groups only; event tab → approved items of events I'm registered for (or admin of); private tab → my own private items; plus "my items" view of my own pending/rejected in every scope. Approvers see pending items ONLY within their authority (leader → their groups; event admin → their events; church admin → everything).
- Approve/reject sets status + approved_by + approved_at; body length cap 2000 chars ('too_long'); soft-delete own items (author) or by an approver within authority.
- Every UI string in BOTH i18n dicts, Simplified Chinese, `portal.prayer.*` (bare `prayer.*` is TAKEN by prayer-sheets). Tokens only; PRG.
- Commits on `feat/member-portal`, suffix:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01LXG31UsdHggtkv9S8KYNBY`.

---

### Task 1: `prayerDb.ts` + event-admin helpers

**Files:** Create `src/lib/prayerDb.ts`; modify `src/lib/regDb.ts` (or prayerDb) for event_admins helpers; test `test/prayerDb.test.ts` (fabricate `prayer_items`/`event_admins` in the D1 harness per the groupDb test convention; reg/group tables as needed).

**Interfaces:**
```ts
export type PrayerScope = 'church' | 'group' | 'event' | 'private';
export interface PrayerItem { id: number; author_person_id: number; author_name: string; scope: PrayerScope; group_id: number | null; group_name: string | null; reg_event_id: number | null; event_title: string | null; body: string; status: 'pending' | 'approved' | 'rejected'; created_at: string; }
/** Throws 'not_eligible' | 'too_long' | 'invalid'. private → status 'approved', others 'pending'. Returns id. */
export async function postPrayerItem(db: AppDb, args: { authorPersonId: number; authorEmail: string; scope: PrayerScope; groupId?: number | null; regEventId?: number | null; body: string }): Promise<number>;
/** Tab reads (locale for group/event names). */
export async function listChurchPrayers(db: AppDb, locale: Locale): Promise<PrayerItem[]>;                        // approved church, newest first
export async function listGroupPrayersForPerson(db: AppDb, personId: number, locale: Locale): Promise<PrayerItem[]>;   // approved, my groups
export async function listEventPrayersForPerson(db: AppDb, personId: number, email: string, locale: Locale): Promise<PrayerItem[]>; // approved, my events (registered or event_admin)
export async function listMyPrayerItems(db: AppDb, personId: number, locale: Locale): Promise<PrayerItem[]>;     // all my items incl. private/pending/rejected
/** Pending queue scoped to the approver's authority. isAdmin → all pending. */
export async function listPendingForApprover(db: AppDb, approverId: number, isAdmin: boolean, locale: Locale): Promise<PrayerItem[]>;
/** Throws 'not_authorized' when the item is outside the approver's authority; returns false when already decided/missing. */
export async function decidePrayerItem(db: AppDb, args: { itemId: number; approve: boolean; approverId: number; isAdmin: boolean }): Promise<boolean>;
/** Author deletes own; approver deletes within authority. Soft delete. */
export async function deletePrayerItem(db: AppDb, args: { itemId: number; actorId: number; isAdmin: boolean }): Promise<boolean>;
// event admins (put beside the other reg helpers)
export async function listEventAdmins(db: AppDb, regEventId: number): Promise<{ person_id: number; display_name: string }[]>;
export async function addEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<void>;   // dedupe ON CONFLICT
export async function removeEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<void>;
export async function isEventAdmin(db: AppDb, regEventId: number, personId: number): Promise<boolean>;
```
TDD matrix: post eligibility per scope (member/non-member group; registered/unregistered/admin event; private auto-approved; body 2001 chars too_long; scope/id mismatch invalid); tab visibility (non-member sees no group items; unregistered sees no event items; pending church item invisible in church tab; private invisible to others); approver queues (leader sees only own group's pending; event admin only own event's; admin sees all); decide (leader approves own group ok; leader on other group not_authorized; double-decide false; admin any); delete (author own ok; other member not_authorized-ish false/throw — pick and document). Commit `feat(portal): prayer wall data layer`.

---

### Task 2: Event-admins panel in the reg-event admin editor

**Files:** Find the reg-event editor (`src/pages/admin/registration/…` — read the dir), add an "Event admins" panel: person picker add + remove list (pattern: the members panel from `src/pages/admin/fellowships/[id].astro`). Panel + POST actions gated in-page on `modules.has('portal')` (event_admins is a portal table; registration module alone doesn't create it… BOTH tables are Supabase-only so the backend matches — the gate is about the portal module being licensed). i18n `admin.groups.*`-style keys under `admin.registration.eventAdmins*`. Full suite + build + tokens green. Commit `feat(portal): event admins management`.

---

### Task 3: `/my/prayer` page + dashboard pending count

**Files:** Create `src/pages/[locale]/my/prayer.astro`; modify `src/pages/[locale]/my/index.astro` (extend the existing pending-approvals card with a prayer-pending count — same portal gate, `listPendingForApprover(...).length`, keep byte-discipline elsewhere); i18n.

- Tabs via `?tab=church|groups|events|mine|pending` (server-rendered links, default church). Sections per Global Constraints. Post form: scope `<select>` + conditional group/event `<select>`s populated from my groups / my registrations (+ my admin events) — no client JS: render all three selects, name them scope/group_id/reg_event_id, validate server-side. Body `<textarea maxlength=2000>` + server cap. `_action=post|approve|reject|delete` with PRG (`?ok=posted|approved|rejected|deleted&tab=…`, errs `not_eligible|too_long|generic`). Pending tab visible only when the viewer has any authority (leader/event-admin/church-admin) — compute via a cheap `listPendingForApprover(...).length` or dedicated exists-check. Own pending/rejected shown in "mine" tab with status badges. Author delete button on own items; approver delete on items in their queues.
- PortalNav: `prayer` tab already exists.
- Full suite + D1 e2e + build + tokens + astro check green. Commit `feat(portal): prayer wall page`.

---

### Task 4: pg e2e + phase gate

**Files:** `test/e2e-pg/portal-prayer.test.ts`; extend `seed/portal-seed.sql` ONLY if needed (fixtures via lib writers in beforeAll preferred, per the dashboard/calendar precedent).

Scenarios: Amy posts group prayer → pending, invisible in Amy's group tab; David (leader) sees it in pending tab, approves → visible to Amy AND David in groups tab; Ben (non-member) never sees it; Amy posts church prayer → pending until admin (person 1) approves → visible to Ben; Amy posts private → immediately in her mine tab, absent from everyone else's tabs; event flow: registration for Amy + event admin David → Amy posts event prayer, David approves, visible to Amy; non-registered Ben's events tab empty. Phase gate: all five commands green.

Commit `feat(portal): e2e for prayer wall`.

---

## Phase-gate checklist
- Five gates green; scoped-approval matrix proven in pg e2e; no admin-console moderation page; one commit per task (+fixes).
