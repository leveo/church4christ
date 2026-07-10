# Member Portal — Phase 4 (Calendar + ICS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The personal calendar (`/my/calendar` month grid) and the ICS feed (`/cal/[token].ics`) gain registered events and group-meeting occurrences. The subscribe box (webcal + regenerate) ALREADY EXISTS — nothing to build there beyond copy check.

**Architecture:** One new pure occurrence-computation function (unit-testable date math) + additive extensions to `buildCalendarMarks`/`DayMark`, the calendar page, and the feed route. Both surfaces run on D1 (`serve`-owned / public) — every new data source is gated in-page on `modules.has('portal')` (and `registration` where reg tables are touched). Spec: `docs/superpowers/specs/2026-07-10-member-portal-design.md`.

## Global Constraints

- `/my/calendar` and `/cal/[token].ics` keep working IDENTICALLY on D1 (portal off): additions strictly behind `locals.modules.has('portal')` (feed route: compute the enabled set the same way middleware does — check how `locals.modules` is populated and whether the feed route receives it; it does via middleware `locals`).
- `reg_events.starts_at`/`ends_at` are `'YYYY-MM-DD HH:MM:SS'` UTC; `buildICal` emits floating LOCAL times — convert with `utcToDatetimeLocal` (src/lib/dates.ts:122, church TZ default) before splitting date/time. NEVER emit raw UTC into the feed or grid.
- Occurrence rules (deterministic, no Date.now dependencies beyond the passed window):
  - weekly: every date in [from,to] with `getUTCDay() === meeting_weekday`.
  - biweekly: anchor = first matching weekday ON/AFTER (`term_start` if set, else the group's `created_at` date part); every 14 days from anchor.
  - monthly: the FIRST matching weekday of each calendar month.
  - Term clipping: if `term_start`/`term_end` set, occurrences outside them are dropped. Groups need `meeting_weekday IS NOT NULL` to produce occurrences; `active=1`, not deleted.
- Feed window: -30 days … +180 days (serving stays at its existing -30…∞). UIDs: `c4c-reg-<registrationId>@<host>`, `c4c-group-<groupId>-<YYYYMMDD>@<host>` (stable). Meetings with `meeting_time` are timed with a 2-hour default duration (documented); without, all-day. Registered events: timed when both start/end convert cleanly, else all-day on the start date.
- i18n both locales identical keys Simplified Chinese; tokens only; PRG untouched.
- Commits on `feat/member-portal`, suffix:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01LXG31UsdHggtkv9S8KYNBY`.

---

### Task 1: Occurrence computation + person-scoped calendar reads

**Files:** Modify `src/lib/groupDb.ts`; test `test/groupDb.test.ts` (extend) or new `test/meetings.test.ts` for the pure function.

**Interfaces:**
```ts
/** Pure date math — exported for tests. group fields: meeting_weekday/time/frequency/location, term_start/term_end, created_at. */
export interface MeetingOccurrence { date: string; group_id: number; group_name: string; meeting_time: string | null; meeting_location: string | null; }
export function computeMeetingDates(group: { meeting_weekday: number | null; meeting_frequency: string | null; term_start: string | null; term_end: string | null; created_at: string }, from: string, to: string): string[];
/** Occurrences for all of the person's groups in [from,to] (uses listMyGroups; Supabase-only — caller gates on portal). */
export async function listMeetingOccurrencesForPerson(db: AppDb, personId: number, from: string, to: string, locale: Locale): Promise<MeetingOccurrence[]>;
```
TDD matrix: weekly across month boundary; biweekly anchored to term_start (and to created_at when no term); monthly first-matching-weekday incl. month starting ON the weekday; term clipping start+end; null weekday → []; frequency null → treat as weekly (document); from>to → []. Use `addDays`/date helpers from src/lib/dates.ts — no `new Date()` free of arguments. Commit `feat(portal): group meeting occurrence computation`.

---

### Task 2: Calendar month grid gains events + meetings

**Files:** Modify `src/lib/calendar.ts` (+its test), `src/components/MonthCalendar.astro`, `src/pages/[locale]/my/calendar.astro`; i18n.

- Extend `DayMark` ADDITIVELY (new optional fields, e.g. `events?: string[]`, `meetings?: string[]`) and `buildCalendarMarks` with new optional args — existing callers/tests unchanged (read src/lib/calendar.ts + its test first; keep backward-compatible signature, e.g. an options object param).
- `MonthCalendar.astro`: render small distinct dots/short labels for events and meetings (title attr with names; token colors distinct from assignment/blockout marks — look at what mark styling exists and extend consistently). Add a legend row under the grid (i18n `portal.calendar.legend*`).
- `calendar.astro`: inside `modules.has('portal')` load `listMeetingOccurrencesForPerson(db, user.id, monthStart, monthEnd, locale)`; additionally `modules.has('registration')` → `listRegistrationsForPerson(...)` filtered to the month, converting `starts_at` UTC→local date via `utcToDatetimeLocal` before comparing. D1 path loads nothing new.
- Verify: `npx vitest run` (extend calendar test for the new marks), `npm run test:e2e` (D1 /my/calendar unregressed), build, tokens, astro check. Commit `feat(portal): events and meetings on the personal calendar`.

---

### Task 3: ICS feed expansion

**Files:** Modify `src/pages/cal/[token].ics.ts`; test — check whether a feed unit/e2e test exists (grep test/ for `cal/` or `ics`); extend it, else add coverage in Task 4's pg e2e only and unit-test the conversion helpers.

- After the existing serving query: compute `enabled` modules for the current backend (the middleware already sets `locals.modules` for every request INCLUDING this public route — verify by reading middleware; if locals.modules is unavailable here, call `getEnabledModules(db, backend)` directly with backend from `locals`/dbProvider — read how locals exposes backend).
- If portal on: meetings occurrences (window `addDays(today,-30)`…`addDays(today,180)`, EN group names — feed convention is EN) → ICalEvents (timed +2h or all-day; UID `c4c-group-<gid>-<yyyymmdd>@host`). If portal AND registration on: `listRegistrationsForPerson`-equivalent for the feed — but the feed knows only person id, not session email: query registrations by `person_id = ?` ONLY here (email-matched guest rows stay web-only; document why — no email on hand... actually the person row HAS email: reuse it. Decide: use person.email from the token lookup SELECT — extend it to select email; then match person_id OR email exactly like the page). Convert UTC→wall-clock; UID `c4c-reg-<id>@host`; status pending → summary suffix ' (?)' mirroring the serving convention.
- Feed stays one flat VCALENDAR; serving section byte-identical when portal off.
- Verify: full unit suite, build; D1 e2e (feed route is exercised? check) green. Commit `feat(portal): registered events and group meetings in the ICS feed`.

---

### Task 4: pg e2e + phase gate

**Files:** `test/e2e-pg/portal-calendar.test.ts` (new; harness patterns from siblings).

Scenarios (fixtures via library writers like portal-dashboard.test.ts): group 1 gets meeting_weekday/time via saveGroup (or direct UPDATE); reg_event + registration for David; David GET /en/my/calendar 200 → meeting + event marks visible in the month containing the fixtures (pick fixture dates inside the current month via todayInTz-derived strings — the page defaults to current month); David generates calendar token (POST _action=token) → GET /cal/<token>.ics 200 → contains `c4c-group-1-` UID and `c4c-reg-` UID and correct local times; regenerate → old URL 404s (already covered? add if quick). Amy (not in a meeting-weekday group... she IS in group 1 — pick Ben for the negative: his feed lacks group-1 meetings). Phase gate: all five commands green.

Commit `feat(portal): e2e for calendar and ICS expansion`.

---

## Phase-gate checklist
- Five gates green; D1 e2e proves /my/calendar + feed unregressed; one commit per task (+fixes).
