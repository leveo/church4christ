# Member Portal — Phase 2 (Member Groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Member groups (fellowships + Sunday School) go live: admin editor, DB-driven public fellowships page (content collection retired), `/my/groups` with application flow, and R2-backed group file areas with an auth-gated download route.

**Architecture:** Schema already exists (Phase 1: `member_groups`/`member_group_i18n` both backends; `group_members`/`group_applications`/`group_files` Supabase-only). This phase is wiring: new `src/lib/groupDb.ts` + `src/lib/groupFiles.ts` against the AppDb seam, admin CRUD copied from existing archetypes, public page via `i18nJoin`, portal pages copied from `my/household.astro`. One genuinely new mechanism: an auth-gated R2 streaming route (no precedent — existing `/media/[...key].ts` is public-only). Spec: `docs/superpowers/specs/2026-07-10-member-portal-design.md`.

**Tech Stack:** Astro 7 SSR on Cloudflare Workers, D1/Postgres via AppDb, R2 (`MEDIA` binding), Tailwind v4 tokens, Vitest (workers pool + pg e2e).

## Global Constraints

- Shared-table queries (member_groups, member_group_i18n) in portable SQLite dialect; Supabase-only-table queries may assume PG but keep the same `?` placeholder style.
- Public `/fellowships` page must work on **D1** (definitions are shared; membership/leaders are NOT available there — the public page must not query `group_members`).
- Authorization lives in the data layer: group functions take the viewer's person id; pages pass `isAdmin: false` — the portal NEVER operates with admin authority (Phase 1 Critical; same rule here). Admin pages pass `isAdmin: true`.
- Group file rules (spec): members of the group (or church admin) view/download; ONLY that group's leaders (`group_members.is_leader=1`) or church admin upload/delete. Extension/MIME allowlist: pdf, doc, docx, xls, xlsx, ppt, pptx, png, jpg, jpeg, webp, txt, md. Size cap 20 MB. Downloads stream through an authenticated route with `content-disposition: attachment` — never a public URL.
- Every UI string in BOTH `src/i18n/en.ts` and `src/i18n/zh.ts`, identical keys, Simplified Chinese, under `portal.groups.*` / `admin.groups.*` (+ `admin.nav.groups`).
- Design tokens only; member/admin UI classes from `src/lib/adminUi.ts`; forms POST-to-self + 303 PRG with `?ok=`/`?err=` codes (copy `my/household.astro`'s `done`/`fail` helpers).
- After each task: run the named tests, then commit with the message given.
- All commits on branch `feat/member-portal`, suffix:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01LXG31UsdHggtkv9S8KYNBY`.

---

### Task 1: `groupDb.ts` data layer

**Files:**
- Create: `src/lib/groupDb.ts`
- Test: `test/groupDb.test.ts` (harness copied from `test/portalDb.test.ts`)

**Interfaces (later tasks rely on these exact signatures):**

```ts
export type GroupKind = 'fellowship' | 'sunday_school';
export interface MemberGroup {
  id: number; slug: string; kind: GroupKind;
  term_label: string | null; term_start: string | null; term_end: string | null;
  meeting_weekday: number | null; meeting_time: string | null;
  meeting_frequency: 'weekly' | 'biweekly' | 'monthly' | null; meeting_location: string | null;
  open_signup: number; active: number; sort: number;
  name: string; description: string | null;      // i18nJoin-coalesced
}
/** Public/portal list: active, non-deleted, localized. kind filter optional. Portable SQL (runs on D1). */
export async function listGroups(db: AppDb, locale: Locale, opts?: { kind?: GroupKind }): Promise<MemberGroup[]>;
/** Single group by slug (public detail) or by id (portal/admin). Portable. */
export async function getGroupBySlug(db: AppDb, slug: string, locale: Locale): Promise<MemberGroup | null>;
export async function getGroup(db: AppDb, id: number, locale: Locale): Promise<MemberGroup | null>;
/** Admin CRUD (both backends). GroupInput carries slug/kind/term*/meeting*/open_signup/active/sort + nameEn/nameZh/descEn/descZh; upserts i18n rows like saveServiceType (src/lib/teamDb.ts:89). */
export interface GroupInput { slug: string; kind: GroupKind; termLabel: string | null; termStart: string | null; termEnd: string | null; meetingWeekday: number | null; meetingTime: string | null; meetingFrequency: string | null; meetingLocation: string | null; openSignup: boolean; active: boolean; sort: number; nameEn: string; nameZh: string | null; descEn: string | null; descZh: string | null; }
export async function saveGroup(db: AppDb, id: number | null, input: GroupInput): Promise<number>; // returns id; throws 'slug_taken' on unique violation (isUniqueViolation)
export async function softDeleteGroup(db: AppDb, id: number): Promise<void>;

// ---- membership (Supabase-only tables; only reachable when portal module on) ----
export interface GroupMemberRow { id: number; person_id: number; is_leader: number; joined_at: string; display_name: string; }
export async function listGroupMembers(db: AppDb, groupId: number): Promise<GroupMemberRow[]>; // joins people (active, not deleted), display_name COALESCE(display_name, first||' '||last)
export async function listMyGroups(db: AppDb, personId: number, locale: Locale): Promise<(MemberGroup & { is_leader: number })[]>;
export async function isGroupMember(db: AppDb, groupId: number, personId: number): Promise<boolean>;
export async function isGroupLeader(db: AppDb, groupId: number, personId: number): Promise<boolean>;
/** Admin member management. addGroupMember dedupes via ON CONFLICT DO NOTHING; setGroupLeader flips is_leader; removeGroupMember hard-deletes the row. */
export async function addGroupMember(db: AppDb, groupId: number, personId: number, isLeader?: boolean): Promise<void>;
export async function setGroupLeader(db: AppDb, groupId: number, personId: number, isLeader: boolean): Promise<void>;
export async function removeGroupMember(db: AppDb, groupId: number, personId: number): Promise<void>;

// ---- applications (pattern: teamDb.ts createApplication/decideApplication, but no position_id, field is `note`) ----
export async function hasPendingGroupApplication(db: AppDb, personId: number, groupId: number): Promise<boolean>;
/** Rejects with 'closed' if group inactive/deleted/open_signup=0; 'already_member' if member; silent dedupe on concurrent pending. */
export async function applyToGroup(db: AppDb, personId: number, groupId: number, note: string | null): Promise<number | null>;
export interface GroupApplicationRow { id: number; group_id: number; person_id: number; status: string; note: string | null; created_at: string; applicant_name: string; applicant_email: string; group_name: string; }
export async function listPendingApplicationsForGroups(db: AppDb, groupIds: number[], locale: Locale): Promise<GroupApplicationRow[]>;
/** Guard: status='P' AND (expectedGroupId absent or matches). Approve batches status flip + INSERT group_members ON CONFLICT DO NOTHING. Returns {person_id, group_id} | null. deciderPersonId recorded in decided_by. */
export async function decideGroupApplication(db: AppDb, applicationId: number, approve: boolean, deciderPersonId: number, expectedGroupId?: number): Promise<{ person_id: number; group_id: number } | null>;
```

Steps:
- [ ] **Failing tests first** covering: listGroups localized fallback (zh row missing → en name), kind filter, inactive/deleted excluded, sort order; saveGroup create + update + slug_taken; membership add/list/leader flip/remove + dedupe; listMyGroups joins i18n; applyToGroup happy / closed (open_signup=0) / closed (inactive) / already_member / double-apply pending no-op / re-apply after reject allowed; decideGroupApplication approve→member row exists + status A / reject→R no member / wrong expectedGroupId → null / already-decided → null.
  - NOTE the unit harness runs on SQLite: the Supabase-only tables don't exist in D1 migrations. Check how existing tests handle this (test/portalDb.test.ts creates its fixtures against the migrated D1 schema). For the membership/application tables, create them in the test setup with `CREATE TABLE IF NOT EXISTS` matching the PG DDL minus identity (plain INTEGER PRIMARY KEY) — precedent: check how giving/registration unit tests fabricate supabase-only tables (grep `test/` for `reg_events` or `gifts` CREATE TABLE). Follow whatever那 precedent is; if none exists, the CREATE-in-test approach is the documented fallback (pg e2e in Task 6 covers the real PG DDL).
- [ ] Implement `groupDb.ts` (i18nJoin('member_group_i18n','g','group_id',['name','description'],locale); ON CONFLICT partial-unique dedupe needs the actual partial index — the migration didn't create one for group_applications, unlike team_applications. Add the pending-dedupe as a WHERE-guarded INSERT ... SELECT WHERE NOT EXISTS instead (portable, no schema change), keeping 'already pending' silent no-op semantics.)
- [ ] Tests green: `npx vitest run test/groupDb.test.ts`, then full `npx vitest run`.
- [ ] **Commit** `feat(portal): group data layer`

---

### Task 2: Admin group editor + module ownership fix

**Files:**
- Modify: `src/lib/modules.ts` (+ `test/modules.test.ts`)
- Modify: `src/layouts/Admin.astro` (nav entry)
- Create: `src/pages/admin/fellowships/index.astro` (list + create)
- Create: `src/pages/admin/fellowships/[id].astro` (edit + members/leaders panel)
- Modify: `src/i18n/en.ts` / `zh.ts`
- Modify: `src/lib/routePolicy.ts` ONLY if admin routes need explicit registration — read how `/admin/children` was classified first; follow that exactly.

**Module ownership decision (controller-adjudicated):** `/admin/fellowships` moves from `portal.adminPrefixes` to `fellowships.adminPrefixes` so D1 churches (portal off) can still edit fellowship DEFINITIONS after the content collection retires. The members/leaders panel inside `[id].astro` is gated in-page with `Astro.locals.modules.has('portal')` (Supabase-only tables). Update the Task-2 Phase-1 test that asserted `moduleForPath('/admin/fellowships')==='portal'` to expect `'fellowships'`, and the modules.ts doc comment.

Steps:
- [ ] modules.ts ownership move + test update (`npx vitest run test/modules.test.ts`).
- [ ] Admin nav: `{ label: t(lang,'admin.nav.groups'), href: '/admin/fellowships', show: isStaff, module: 'fellowships' }` in `Admin.astro` rawSections (read lines ~77-111 first; place near Ministries).
- [ ] `index.astro`: table of groups (name, kind badge, term_label, meeting summary, open_signup, active, sort) + "New group" form (slug + kind + nameEn) posting `_action=create` → redirect to `[id]`. Copy list/actions shape from `src/pages/admin/service-types/index.astro`; PRG.
- [ ] `[id].astro`: full edit form (all GroupInput fields; en/zh name+description pairs like `admin/ministries/index.astro` updateBasics; weekday select 0-6 reusing existing weekday i18n keys if present — grep for how checkin events or plans render weekdays; term fields shown only when kind=sunday_school is fine as always-visible optional inputs — no JS). `_action=save|delete`. **Members panel** (in-page `modules.has('portal')` gate): person picker (copy the person `<select>` pattern from `admin/people/[id].astro` link-household picker), add member, toggle leader, remove; uses addGroupMember/setGroupLeader/removeGroupMember with `isAdmin` authority implicit (admin console).
- [ ] i18n keys both locales (`admin.nav.groups` EN "Groups" / ZH "小组", `admin.groups.*` for labels incl. kind names EN "Fellowship"/"Sunday School", ZH "团契"/"主日学").
- [ ] `npx vitest run` full + `npm run build` + `npm run tokens:check`.
- [ ] **Commit** `feat(portal): admin group editor`

---

### Task 3: Public fellowships page → DB; retire content collection

**Files:**
- Modify: `src/pages/[locale]/fellowships/index.astro`, `src/pages/[locale]/fellowships/[slug].astro`
- Modify: `src/content.config.ts` (drop fellowships collection)
- Delete: `src/content/fellowships/` (10 files)
- Modify: `seed/dev-seed.sql` (port the 5 legacy fellowships as member_groups rows + en/zh i18n; keep the 2 Phase-1 seed groups)
- Check/modify: `src/lib/content.ts` + `contentCore.ts` consumers (grep `'fellowships'` across src/ and test/ — update any collection references, e.g. sitemap, search, tests)

Steps:
- [ ] `index.astro`: `listGroups(db, locale, { kind: 'fellowship' })` → same card layout as today (name, description excerpt, meeting line built from weekday/time/frequency/location via new i18n helpers `portal.groups.weekday.0..6` / `portal.groups.freq.weekly|biweekly|monthly` — add both locales). Card links to `/fellowships/[slug]`. NOTE: page currently prerenders from content; it must become SSR DB-read like other DB pages (check how ministries page does it — no `prerender` export).
- [ ] `[slug].astro`: `getGroupBySlug`; render name + full description (plain text, render newlines as paragraphs — `description.split(/\n{2,}/)`) + meeting info block. 404 when missing/inactive. Do NOT show members/leaders (not available on D1; portal has its own surface).
- [ ] Seed: 5 legacy fellowships (family/campus/english-young-adults/young-professionals/seniors) with their real en/zh names + meeting info as structured fields + 1-2 sentence descriptions from the old markdown; deterministic ids continuing from the Phase-1 rows; PG sequence bump if the seed does that (check the tail of dev-seed.sql).
- [ ] Delete content files + config entry; fix all references (`grep -rn "fellowships" src/ test/ scripts/` — nav key stays, module stays).
- [ ] `npx vitest run` full + `npm run test:e2e` (public pages are covered there) + `npm run build`.
- [ ] **Commit** `feat(portal): DB-driven fellowships page, retire content collection`

---

### Task 4: Group files — lib + auth-gated download route

**Files:**
- Create: `src/lib/groupFiles.ts`
- Create: `src/pages/[locale]/my/groups/[id]/files/[fileId].ts` (GET download)
- Test: `test/groupFiles.test.ts`

**Interfaces:**

```ts
// groupFiles.ts
export const ALLOWED_GROUP_FILE_EXTS: string[]; // per Global Constraints
export const MAX_GROUP_FILE_BYTES = 20 * 1024 * 1024;
export interface GroupFileRow { id: number; group_id: number; uploaded_by: number; file_name: string; r2_key: string; content_type: string; size_bytes: number; created_at: string; }
/** Validates ext+MIME allowlist ('file_type') and size ('file_too_large'); key `group-files/${groupId}/${16-hex-random}`; puts to R2 with httpMetadata; inserts group_files row; returns id. NOT content-addressed (no cross-group dedupe/leak). */
export async function saveGroupFile(db: AppDb, media: MediaBucket, args: { groupId: number; uploadedBy: number; file: File }): Promise<number>;
export async function listGroupFiles(db: AppDb, groupId: number): Promise<(GroupFileRow & { uploader_name: string })[]>; // deleted_at IS NULL
/** Soft-delete row + best-effort MEDIA.delete. Caller enforces leader/admin. */
export async function deleteGroupFile(db: AppDb, media: MediaBucket, fileId: number, groupId: number): Promise<boolean>;
/** ACL + fetch for the download route: returns the row only if person is a member of the file's group (or isAdmin). */
export async function getGroupFileForDownload(db: AppDb, args: { fileId: number; groupId: number; personId: number; isAdmin: boolean }): Promise<GroupFileRow | null>;
```

Steps:
- [ ] Failing tests: allowlist accept/reject (pdf ok, exe/svg rejected by ext AND by MIME mismatch), size cap, key prefix shape, list excludes soft-deleted, delete soft-deletes + R2 delete called, ACL matrix for getGroupFileForDownload (member yes / non-member null / admin yes / wrong groupId in URL null / deleted file null). Mock MediaBucket the way existing mediaUpload tests do (read `test/` for saveImageUpload's test double).
- [ ] Implement lib. Ext check from sanitized original filename; store original name in `file_name` (sanitize like `upload.ts` sanitizeFilename); MIME from `file.type` with allowlist mapping (accept `application/octet-stream` only when ext is allowlisted? NO — reject; document).
- [ ] Download route (`.ts` APIRoute, GET): `locals.user` else 404; parse ints; `getGroupFileForDownload(db, { fileId, groupId, personId: user.id, isAdmin: false })` — note: church admins download via their membership OR pass `isAdmin: locals.user.isAdmin` here? **Spec says church admin may view/download** — pass the real `isAdmin` flag in this READ-ONLY route (the Phase-1 "portal never carries admin authority" rule was about mutations; document this in a comment referencing the spec's permission table). 404 on null. Stream `MEDIA.get(row.r2_key)` → 404 if missing → `new Response(object.body, { headers })` with content-type from row, `content-disposition: attachment; filename*=UTF-8''<RFC5987-encoded file_name>`, `cache-control: no-store`. Copy streaming mechanics from `src/pages/media/[...key].ts` (writeHttpMetadata NOT needed — set headers explicitly from the DB row).
- [ ] Verify route policy: `/my/...` is authed-classed and `/my/groups` is portal-owned (both already true — confirm with the existing modules test, no change expected).
- [ ] `npx vitest run test/groupFiles.test.ts` + full suite.
- [ ] **Commit** `feat(portal): group file storage with auth-gated downloads`

---

### Task 5: `/my/groups` + group detail pages + notifications

**Files:**
- Create: `src/pages/[locale]/my/groups/index.astro`
- Create: `src/pages/[locale]/my/groups/[id].astro`
- Modify: `src/lib/notify.ts` (sendGroupApplicationReceived → leaders; sendGroupApplicationResult → applicant; copy sendApplicationReceived/sendApplicationResult at src/lib/notify.ts:319/:413, bilingualEmail pattern)
- Modify: `src/i18n/en.ts` / `zh.ts` (`portal.groups.*`, email strings following how team application emails define theirs — check whether email copy lives in i18n dicts or email_templates defaults)

Steps:
- [ ] `index.astro` (copy my/household.astro shell + PortalNav active="groups"): sections — **My groups** (listMyGroups: name, kind badge, term, meeting line, leader badge, link to detail) with empty state; **Open for sign-up** (listGroups minus my groups, `open_signup=1`, both kinds, Sunday School shows term): apply form per group (`_action=apply`, optional note textarea in a `<details>`) → applyToGroup; err codes `closed`/`already_member`/`already_pending` (pre-check hasPendingGroupApplication for the friendly code); ok code `applied`; on success sendGroupApplicationReceived. Show "application pending" state instead of the button when pending.
- [ ] `[id].astro`: 404 unless viewer is member OR admin-and-member rule — decision: **members only** (church admins use the admin console; keeps page logic clean and matches "portal never carries admin authority" for reads too — EXCEPT the download route decision in Task 4 stands). Sections: group header (name/kind/term/meeting/description), members list (names only, leaders badged), **Files** (listGroupFiles: name, size human-readable, uploader, date, download link to the Task-4 route; upload form + per-file delete form ONLY when `isGroupLeader(...)` — pass viewer's leadership, never isAdmin), **Pending applications** (leaders only: listPendingApplicationsForGroups([id]) with approve/reject buttons → decideGroupApplication(expectedGroupId=id, deciderPersonId=user.id) → sendGroupApplicationResult). PRG all actions; upload err codes `file_type`/`file_too_large`/`generic`.
- [ ] Notifications: follow the team-application email pattern exactly (recipients: group leaders' emails via listGroupMembers is_leader=1 join people; applicant email on result). Bilingual body, EMAIL_DEV_LOG-safe.
- [ ] i18n keys both locales; `npx vitest run` full; `npm run build`; `npm run tokens:check`; `npx astro check`.
- [ ] **Commit** `feat(portal): /my/groups pages with applications and files`

---

### Task 6: pg e2e + phase gate

**Files:**
- Modify: `seed/dev-seed.sql` (group members/leaders for the seeded groups: make seeded person 2 (David) leader of the fellowship group; person 7 (Amy) member; one seeded pending application from a third person)
- Create: `test/e2e-pg/portal-groups.test.ts` (harness from `test/e2e-pg/portal-household.test.ts`)

Steps:
- [ ] Seed additions (portable inserts; PG sequence bumps at tail like existing).
- [ ] E2E scenarios: member GET /en/my/groups 200 lists seeded group; non-member applies to open group → row P; leader approves via POST on detail page → applicant now member (DB assert) ; leader uploads a file via multipart POST → group_files row + member GET download route 200 with attachment header + correct bytes; NON-member GET download → 404; non-leader upload POST → 404/err; public /en/fellowships lists seeded fellowships (D1 e2e also covers this page — add/adjust there if the existing public-pages e2e asserts fellowship content from the deleted collection).
- [ ] Phase gate: `npx vitest run`, `npm run test:e2e`, `npm run test:e2e:pg` (docker postgres per CONTRIBUTING.md), `npm run build`, `npm run tokens:check` — ALL green.
- [ ] **Commit** `feat(portal): seed + e2e for member groups`

---

## Phase-gate checklist (reviewer runs)
- All five gate commands green; one commit per task on `feat/member-portal`.
- D1 smoke: `/en/fellowships` renders from DB; `/admin/fellowships` reachable (fellowships module), members panel hidden; `/en/my/groups` 404s.
- Supabase smoke (or pg e2e proxy): apply→approve→member; leader-only upload; member-only download.
