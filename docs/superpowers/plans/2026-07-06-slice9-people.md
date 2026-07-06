# Slice 9 — People (Member Management) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Authoritative design: docs/superpowers/specs/2026-07-06-people-and-modules-addendum.md §B
> (schema, privacy rules, capability list are binding — read it FIRST for every task).

**Goal:** PCO-People-style member management as the `people` module: profile depth +
households (with name-only dependents), admin directory/notes/outreach, leader invites,
and the serve-integrated opportunity board.

## Global Constraints
- Privacy rules from the addendum are BINDING (notes admin-only; leaders never see
  birthday/address/household/children; children never on public/leader surfaces).
- Migration 0003_people.sql additive-only per addendum schema (exact tables/columns/
  partial unique indexes). people.email stays NOT NULL (dependents = name-only rows).
- membership_status/joined_on admin-set only; self-service can never touch them
  (server-side strip like role/active).
- All surfaces token-styled, dictionary parity both locales, module-gated (`people`;
  board gated by `serve`).
- Commits conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migration 0003 + libs + parsers

**Files:** migrations/0003_people.sql; src/lib/householdDb.ts (NEW), src/lib/notesDb.ts
(NEW); validate.ts (parsePersonForm gains birthday/address + ADMIN variant gains
membership_status/joined_on; parseHouseholdForm, parseDependentForm); modules.ts people
prefixes fill (['/serve/opportunities'] belongs to serve; people gets admin prefixes
['/admin/households'?] — no: people admin lives inside /admin/people (pre-existing core)
so people module gates ONLY the new panels via locals check, not routes; document);
tests: schema (0003 tables/indexes/CHECKs incl. one-household-per-person + name-only
dependent rows), householdDb, notesDb, parsers.

**householdDb interfaces (used by T2/T3):** createHousehold(db, {name,address,phone},
creatorPersonId) → adds creator as adult+primary; getHouseholdForPerson(db, personId)
(members incl. name-only, ordered primary/adults/children); updateHousehold (adult
member or admin — callers enforce, lib takes actorPersonId+isAdmin and verifies);
addDependent/removeDependent (adult member or admin; dependents only — person_id NULL
rows); leaveHousehold(personId) (removes own row; last real member leaving soft-deletes
household + its dependent rows); admin-only: linkPersonToHousehold (fails if already in
one), unlinkPerson, setMemberRole/primary, listHouseholds(search).
**notesDb:** addNote/softDeleteNote/listNotes(personId) — no visibility logic in lib
(pages enforce admin).

### Task 2: Self-service profile + household + opportunity board

**Files:** src/pages/[locale]/profile.astro (extend: birthday/address inputs; household
card per addendum §B.1 — create/edit/add-remove dependents/leave; strict server checks:
actor must be adult member of THAT household); src/pages/[locale]/serve/opportunities.astro
(public, serve-gated): sections (a) teams accepting applications — active teams w/
ministry name, role chips, leaders count, Apply CTA → /serve/apply?team=X (existing
param support — verify/extend apply to preselect team) (b) upcoming open-signup slots
grouped by team (aggregate query in teamDb or new opportunityDb: future non-deleted
open slots w/ remaining>0, date, position, service). Cross-links: serve landing +
ministries index link the board; nav under serve? (add nav.opportunities under serve
module navKeys). e2e: household round-trip (create→add dependent→edit→leave), strip
attempt on membership_status via self POST → unchanged, board renders seeded
opportunities + apply preselects team, people-module-off hides profile household card
(section absent) while profile basics still render.

### Task 3: Admin directory + person page + notes + outreach + leader invites

**Files:** admin/people/index.astro (filters status/serving/household + columns),
admin/people/[id].astro (household panel: create/link/unlink/role/primary — uses
householdDb admin fns; notes timeline add/delete; membership_status+joined_on controls;
applications list (team_applications by person); serving summary reuse); notify.ts
sendServeInvite(env, db, {personId, teamId, invitedBy}) — i18n-key bilingual email
linking board + team apply, email_log kind 'outreach', respects person.lang; invite UI:
admin person page (any team) + /profile/[id] and team potential-volunteers panel
(leader: ONLY their teams — server re-check via leaderTeamIds); people-module gating for
new panels (people off → panels hidden, invite hidden, notes routes... all these live
inside existing pages: gate via locals.modules.has('people')). Privacy e2e: leader
session on /profile/[id] sees NO notes/birthday/address/household markers; leader
invite for non-their-team → 403; notes visible only to admin; invite → email_log
outreach row. Unit: notesDb, invite recipient/team guards.

### Task 4: Seed + e2e sweep + screenshots

Seed per addendum (3 households incl. child dependent, statuses spread, joined_on,
2 notes, board-visible opportunities — reuse existing open slots; add one team with
open_signup future slots if needed); seed.test extensions; full e2e regression run;
screenshots: docs/images/serve/opportunities.png, docs/images/admin/person-detail.png,
docs/images/public/profile-household.png (self-service view), settings-modules refresh
if people toggle text changed (1280×800).

### Task 5: Docs + i18n audit

docs/features/people-households.md (+original SVG diagram: person↔household↔dependents
+ opportunity→application flow, palette rules), README feature-gallery row + mission
paragraph touch if needed, cms-admin.md cross-link, volunteer-serve.md board mention;
dictionary parity audit (the i18n test enforces; also eyeball zh naturalness for all
people.* household.* opportunities.* keys); gates all green.

## Self-review checklist
Full gates; privacy matrix manually probed in dev (admin vs leader vs member vs anon on
person/household/notes surfaces); module off/on for people + serve leaves no 500s and no
orphan nav; fresh-clone migrate includes 0003 cleanly; ledger updated.
