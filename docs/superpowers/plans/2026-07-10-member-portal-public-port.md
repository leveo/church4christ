# Member Portal — Public-Repo Port Plan (fusion onto public groups module)

> Internal plan (stays local). Work happens in the worktree `/Users/leosong/Python/church-cms-public-port`
> (public repo main @ 06b11a8), branch `feat/member-portal`. The LOCAL repo checkout at
> `/Users/leosong/Python/church-cms` (main, post-merge 508e4bb) is the REFERENCE IMPLEMENTATION —
> implementers copy code from there and adapt. NEVER `git add -A`; NEVER commit `docs/superpowers/`
> or `.superpowers/` in the worktree.

**Owner decision (2026-07-10):** fuse, don't duplicate — the portal adapts onto the public repo's
existing groups module (`groups`/`group_members.is_admin`/`group_join_requests`/`group_events`+
materialized `group_event_occurrences`/attendance). One groups system in the product.

## Fusion mapping (locked)

| Portal (local) | Public port |
|---|---|
| `member_groups` + `member_group_i18n` | existing `groups` (single-name, no i18n) + NEW `kind`/`term_label`/`term_start`/`term_end` columns |
| `open_signup` | existing `is_public` (directory + join requests) — no new column |
| `group_members.is_leader` | existing `group_members.is_admin` |
| `group_applications` + apply/decide | existing `group_join_requests` + `createJoinRequest`/`decideJoinRequest` |
| meeting fields + computeMeetingDates | existing `group_events` + `group_event_occurrences` (richer; NOT ported) |
| `listMeetingOccurrencesForPerson` | NEW person-scoped occurrence read over `group_event_occurrences` |
| `/my/groups` pages | NOT ported — PortalNav "Groups" tab links to existing `/[locale]/groups` |
| DB-driven `/fellowships` page | NOT ported — public `/fellowships` stays content-driven (owner-visible note in PR body); fellowship-kind groups appear in `/groups` |
| group files | NEW `group_files` (Supabase-only) + lib + files panel on `/groups/[id]` (view/download for members) and `/groups/[id]/manage` (upload/delete for group admins) — panels gated in-page on `modules.has('portal')`; NEW auth-gated download route `/groups/[id]/files/[fileId]` |
| prayer group scope | `prayer_items.group_id → groups(id)`; approver = `group_members.is_admin` (+ church admin) |
| everything else (household owners, email change, giving tightening, /my/household, /my/events, /my/serving, dashboard cards, calendar+ICS, prayer wall, event_admins) | ported ~directly from the local reference, adapted to public conventions (adminAreas!, groupRegDb.listRegistrationsForPerson reconciliation) |

## Public-repo bookkeeping every task must respect
- Migrations: D1 `migrations/0010_member_portal.sql`, PG `migrations-supabase/0009_member_portal.sql`; append to `test/pg/schema.test.ts` D1_FILES.
- MODULE_KEYS → 17 with `portal` (`requiresBackend:'supabase'`, publicPrefixes `/my/household`,`/my/events`,`/my/serving`,`/my/prayer`,`/email-change`; NO `/my/groups`; adminPrefixes: NONE — kind/term live in existing `/admin/groups` (area `groups`), event_admins in `/admin/registration/[id]` (area `registration`)). Update: `test/modules.test.ts` ordered array + d1-drop count (16→17, d1 drops 3), `test/pg/parity.test.ts`, settings `moduleGroups` (Community group), i18n `modules.portal.*`.
- Admin pages must call `hasAreaAccess` per the PR #10 pattern (copy how `/admin/groups` pages gate).
- CI runs the FULL suite incl. pg e2e — everything must be green locally before push.

## Tasks (SDD; implementer copies from local reference then adapts)

### T1 — Migrations + module key + bookkeeping
D1 0010: `ALTER groups ADD kind/term_label/term_start/term_end`; `ALTER household_members ADD is_owner`; `ALTER people ADD pending_email`; tokens purpose CHECK rebuild (login/respond/email_change; rebuild idiom + recreate idx_tokens_person). PG 0009: same + `group_files` (r2_key group-files/{groupId}/…), `prayer_items` (group_id→groups, reg_event_id→reg_events, scope/status CHECKs + 3 indexes), `event_admins`. `kind` CHECK ('fellowship','sunday_school') default 'fellowship'. Module key + all count updates + `modules.portal.*` i18n. Gates: unit + pg schema/parity + build.

### T2 — Household owners + email change
Copy from local: `portalDb.ts` (drop group fns — public groupDb owns that namespace already; ONLY household owner fns + MemberProfilePatch), `emailChange.ts`, `auth.ts` additions, `notify.ts` senders, `/email-change/[token].astro`, signin `?changed=1` banner, routePolicy `/email-change/`, admin people owner toggle + ownerless flag (adminAreas: people page already area-gated — extend in place), tests (`portalDb.test.ts` household parts, `emailChange.test.ts`, householdDb is_owner column extension). Public `people` table has extra columns (membership_status, super_admin, admin_areas) — MEMBER_COL_NAMES etc. must match the PUBLIC householdDb.

### T3 — Portal shell: PortalNav + /my pages + giving + dashboard
Copy+adapt: `PortalNav.astro` (Groups tab → `/groups`), `/my/household.astro`, `/my/events.astro`, `/my/serving.astro`, dashboard cards on `/my/index.astro` (public my/index differs — re-derive the in-page-gated card row; groups card via existing `listGroupsForPerson`; pending-approvals card counts join requests via `listJoinRequests` over admined groups + prayer pending later in T5 — structure it so T5 extends), giving tightening (`givingDb` person fns + owner branch in `/my/giving.astro`), regDb `listRegistrationsForPerson` — public already has `groupRegDb.listRegistrationsForPerson(db, personId, locale)`: reconcile into ONE function in regDb with email matching (person_id OR lower(email), non-cancelled), update its existing callers. Port tests (regDb.person, calendar-independent parts).

### T4 — Groups fusion: kind/term admin fields, files, calendar + ICS
Admin `/admin/groups/[id]`: kind select + term fields (+ badges in directory/detail). NEW `listUpcomingOccurrencesForPerson(db, personId, from, to)` (join group_event_occurrences→group_events→group_members active, occurs_on window, exclude deleted). `groupFiles.ts` copied (keys `group-files/{groupId}/`), files panel on `/groups/[id]` (members see list+download) + upload/delete on `/groups/[id]/manage` (group admins), download route `/[locale]/groups/[id]/files/[fileId].ts`?? — NOTE `/groups` is groups-module-owned (works on D1) → files panel AND route must be in-page/in-route gated on `modules.has('portal')` (route returns 404 when portal off). Calendar page: occurrences + registrations marks (from local T4-P4, swapping the occurrence source). ICS: occurrences (UID `c4c-groupocc-<occurrenceId>@host`, real UTC→local times from starts_at/ends_at) + registrations (multi-day all-day rule from local). Port/adapt tests (groupFiles, ical, calendar, occurrence read).

### T5 — Prayer wall + event admins
Copy+adapt `prayerDb.ts` (group_id→groups; isGroupMember→active `group_members` row check; isGroupLeader→`isGroupAdmin`; eligibility via `listGroupsForPerson`), `/my/prayer.astro`, event_admins panel in `/admin/registration/[id]` (area `registration`, in-page portal gate), dashboard pending-approvals extension, `portal.prayer.*` i18n. Port `prayerDb.test.ts` adapted.

### T6 — Seeds + e2e + docs + gates
Seed: portal-seed equivalent for public seeds (check what public dev-seed carries for groups; add owners, a sunday_school-kind group w/ term, group files fixture path, prayer items) — respect public seed structure. Port/adapt pg e2e files (household/dashboard/prayer/calendar/groups-files scenarios). Feature doc `docs/features/member-portal.md` adapted (fellowships-page paragraph replaced with groups-directory reality; reuse local screenshots where UI matches — portal pages match; group screenshots differ → drop or re-shoot if cheap). README row. FULL gate suite (unit, e2e, pg unit, pg e2e, build, tokens, astro check, smoke.sh if CI runs it).

### T7 — Final review + push + PR
Whole-branch review (fresh reviewer, spec = this plan + local spec). Verify NO docs/superpowers or .superpowers files staged (`git status` + `git diff --stat origin/main`). Push `feat/member-portal` to origin; `gh pr create` (if the classifier blocks PR creation, leave the pushed branch + hand Leo the compare URL). PR body: feature summary + fusion notes (fellowships page unchanged; groups gained kind/term/files) + migration renumber note.
