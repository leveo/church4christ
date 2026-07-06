# Spec Addendum — People (Member Management) + Modular Capabilities

**Date:** 2026-07-06 · **Author:** Fable · **Extends:** 2026-07-05-church4christ-design.md
**Process:** Fable plans/designs + final review; Opus subagents execute (owner directive).

## A. Modularity (ships first — People lands as a module)

Goal: every capability is a **module** a church can switch off to simplify onboarding.
All default **ON** (the demo shows everything); turning one off hides it everywhere.

**Module keys** (11): `bulletins`, `sermons`, `prayer-sheets`, `prayer-wall`, `events`
(event cards + homepage announcements ticker), `serve` (ministries, teams, plans,
matrix, apply, my-schedule, availability, reports), `gifts` (quiz), `testimonies`,
`articles`, `fellowships`, `people` (member management, slice 9).
**Always-on core:** home/visit/about/staff/give/privacy, auth, settings, media, i18n,
backup cron.

Design:
- `src/lib/modules.ts` (pure, tested): `MODULES` registry — per module: key, public
  route prefixes (locale-stripped), admin route prefixes, nav dictionary keys, dashboard
  card ids, soft `uses: []` (gifts→serve, people→serve) for degrade-only (no hard deps).
- Storage: settings rows `module.<key>` = '1'|'0'; absent = '1' (default on).
  `getEnabledModules(db)` with 60s isolate cache + `clearModuleCache()` (theme pattern);
  `locals.modules: Set<string>`.
- Enforcement (single choke point in middleware, after locale, before route policy):
  path belongs to a disabled module → **404** (public and admin alike; anon or authed).
  Route policy unchanged (module check is orthogonal, runs first).
- Soft-degrade: enabled pages hide cross-links into disabled modules (e.g. home hides
  events strip when `events` off; serve landing hides gifts CTA when `gifts` off; quiz
  hides ministry recommendations when `serve` off). Home sections each check their module.
- Crons: reminders + digest run only when `serve` on; backup always.
- Admin: Settings page gains a **Modules** panel (adminOnly): checkbox per module,
  grouped (Content / Community / Volunteering), one-line description each (dictionary,
  both locales), save → setSettings + clearModuleCache. Admin nav + dashboard cards
  render only for enabled modules.
- Seed: no module rows (= all on). docs: `docs/features/modules.md` + README "pick your
  modules" onboarding paragraph.

## B. People — member management (PCO-People-like, integrated with serve)

Positioning: `people` table stays the single identity source (auth, roles, serve). The
module adds **membership profile depth, households, notes/outreach, and an opportunity
board** so non-serving members are first-class.

### Schema (migration 0003_people.sql)
- `people` ALTERs (additive only): `birthday TEXT` (YYYY-MM-DD), `address TEXT`,
  `membership_status TEXT NOT NULL DEFAULT 'visitor' CHECK IN
  ('visitor','regular','member','inactive')`, `joined_on TEXT`.
- `households(id, name TEXT NOT NULL, address TEXT, phone TEXT, created_at, updated_at,
  deleted_at)`.
- `household_members(id, household_id→households, person_id NULL→people, display_name
  TEXT NOT NULL, role CHECK('adult','child') DEFAULT 'adult', is_primary INTEGER DEFAULT 0,
  created_at)`. **Key decision:** dependents without accounts (children) are
  **name-only rows** (`person_id NULL`) — we do NOT make `people.email` nullable (it is
  the auth key; SQLite constraint surgery not worth it). Partial unique indexes: one
  household per real person (`UNIQUE(person_id) WHERE person_id IS NOT NULL`);
  `UNIQUE(household_id, person_id) WHERE person_id IS NOT NULL`.
- `person_notes(id, person_id→people, author_email, body TEXT NOT NULL, created_at,
  deleted_at)` — pastoral notes, **admin-only** read/write (privacy rule: ministry
  leaders never see notes; their outreach tool is the invite email, which is logged).

### Capabilities
1. **Self-service profile** (`/{locale}/profile`, existing page extends): birthday,
   address; membership_status/joined_on are **admin-set only** (never self-service).
   New **household card**: create household (becomes adult+primary), edit name/address/
   phone (adults only), add/remove **name-only dependents**, leave household. Linking
   another REAL person into a household is admin-only (v1).
2. **Opportunity board** `/{locale}/serve/opportunities` (public, gated by `serve`
   module): aggregates (a) teams accepting applications (with ministry, open roles) and
   (b) future open-signup slots (from listOpenSlots aggregation), each with Apply CTA →
   existing `/serve/apply?team=X` (+position preselect). This is the "apply for any open
   opportunity" surface; serve landing + people pages link to it.
3. **Admin directory** (`/admin/people`, adminOnly, existing page extends): filters
   (membership_status, serving yes/no via team_members, has-household), new columns,
   CSV-free v1. Person editor gains: birthday/address/status/joined_on fields
   (parsePersonForm extends), **household panel** (assign to household / create /
   link real persons / set role+primary), **notes timeline** (add/soft-delete,
   admin-only), applications list for that person, serving summary.
4. **Outreach ("proactively reach out")**: button on admin person page AND on leader
   surfaces (`/profile/[id]`, potential-volunteers panel): "Invite to serve" — picks a
   team (leaders: only their teams; admins: any), sends localized email (new notify.ts
   touchpoint `sendServeInvite`, template via i18n keys, links the opportunity board /
   team apply URL), logged in email_log kind `outreach`. Leaders get no notes access.
5. **Applications visibility**: existing (team page + console tab). Add: person-centric
   list on admin person page.

### Privacy rules (binding)
Notes: admin-only. Birthday/address: self + admin (leaders see neither on
/profile/[id] — only serve-relevant info + blockout dates as today). Household details:
own members (self-service), admin; leaders see nothing household-related. Children
(name-only rows): never rendered on any public or leader surface; admin + own household
only. Directory remains adminOnly.

### Integration & module gating
`people` module off → profile page keeps auth basics but hides membership/household
sections; opportunity board is `serve`-gated; admin people page keeps the pre-existing
(slice-3) core (it predates the module) but hides household/notes/status panels. Emails:
outreach touchpoint disabled when `people` off.

### Seed
3 households (incl. one with a child dependent + one single-adult), statuses spread
across all four values, joined_on dates, 2 admin notes, board shows ≥3 opportunities.

### Docs/tests
`docs/features/people-households.md` (+SVG diagram, screenshots), README feature row,
e2e: self-service household round-trip, dependent add/remove, admin status/notes,
leader invite (email_log row + no notes visible), board → apply flow, module-off 404s +
hidden nav (for both `people` and one content module), privacy assertions (leader
cannot fetch notes/household). Unit: householdDb (one-household-per-person, dependent
rules), notesDb, opportunity aggregation, modules registry/cache/gating.

## Slices
- **Slice 8 — Modularity**: T1 registry+cache+middleware gating+unit tests; T2 nav/home
  sections/dashboard/crons/settings-panel+e2e; T3 docs+screenshots.
- **Slice 9 — People**: T1 migration+libs(householdDb/notesDb/people extensions)+parsers
  +tests; T2 self-service profile+household + opportunity board; T3 admin directory/
  person page/notes/outreach + leader invite + emails; T4 seed+e2e sweep+screenshots;
  T5 feature doc+README+i18n audit.
- **Slice 10 — Ship**: full gates, Fable acceptance, publish via PR (branch protection).
