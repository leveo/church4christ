# Slice 5 — CMS Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The full content-management admin: dashboard, CRUD for bulletins / sermons /
prayer sheets / announcements / events with per-locale fields, R2 uploads + media proxy,
prayer-wall kanban, revisions with restore, and site settings (incl. live theme switch).

**Architecture:** Port the proven server-rendered form CMS from
`/Users/leosong/Python/dcfc-website/src/pages/admin/**` + `src/lib/{adminDb,adminUi}.ts`
+ `src/layouts/Admin.astro` (repeat-row editor island), adapted to: unified auth
(locals.user from slice 3; roles editor/admin per routePolicy), i18n companion tables
(announcements/events edit en+zh side-by-side), service-type-scoped bulletins/sermons,
dictionary-driven admin copy, token-only styling.

## Global Constraints

- Admin routes already gated by middleware (slice 3). Pages additionally assert role
  where policy is coarser (e.g. `/admin/settings` adminOnly — policy covers it; forms
  re-check before mutation: fail 403).
- Every content save: single `db.batch` transaction upserting entity + child rows +
  a `revisions` full-snapshot row. Port `resolveDateSlot`/revive-on-unique-collision +
  `DuplicateDateError` handling from dcfc-website adminDb.
- Forms: POST-redirect-GET (303), validation error re-render with echoed values +
  localized error messages from validate.ts error KEYS via `t()`.
- Repeat-row editor: `<template>` clone island in Admin.astro (port from dcfc), works
  no-JS (server accepts blank rows and skips them).
- Uploads: `src/lib/upload.ts` — ALLOWED_IMAGE_TYPES jpeg/png/webp/gif (no SVG),
  MAX 10 MB, key `uploads/<sha256hex16>-<sanitized>`, register in media table.
  `/media/[...key].ts` GET: only `uploads/` prefix, inline allowlist (non-svg image/
  audio/video/pdf), otherwise attachment octet-stream; nosniff; `cache-control:
  public, max-age=31536000, immutable`.
- Prayer wall: 6 kanban columns (new/praying/long_term/waiting/answered/cancelled),
  drag-drop island + no-JS `<select>`+move fallback, 🙏 prayed, 💬 comment, every action
  → prayer_activity with author email; terminal columns hide cards >90d unless
  `?all=1`; public message text always escaped.
- Settings page: edit all `site.*` keys (grouped, per-locale inputs), theme picker
  (radio cards showing the 3 themes' primary/accent swatches — rendered via inline
  `style` attr fed from theme JSONs at build? NO — swatches must come from a small
  generated map `src/lib/themeMeta.generated.ts` emitted by build-tokens (add to Task 1
  of this slice); default mode select; locale default select. Saving theme.name takes
  effect on next render (Base.astro reads settings — wire `locals.theme` in middleware
  with per-isolate 60s cache in `src/lib/theme.ts`).
- Dashboard `/admin`: this-week prep status (bulletin/sermon per service type),
  recent revisions, new prayer-request count, quick links; volunteer-side cards appear
  in slice 6.
- Commits per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Tasks

### Task 1: Admin shell + adminUi + theme wiring + themeMeta
Admin.astro full nav (sections by role), repeat-row island, `src/lib/adminUi.ts`
(shared class constants — token utilities only), build-tokens emits
`src/lib/themeMeta.generated.ts` (`{name,label,defaultMode,swatches:{primary,accent,surface}}[]`
— gitignored, wired into tokens script + vitest globalSetup? simplest: check-in? NO:
gitignore + `npm run tokens` prerequisite already in dev/build), middleware sets
`locals.theme` from settings via cached `getActiveTheme(db)`. Tests: theme cache
(set → within TTL stale OK → after clear fresh), themeMeta emitted.

### Task 2: Bulletins + sermons + prayer-sheets CRUD
Pages `admin/{bulletins,sermons,prayer-sheets}/{index,[id]}.astro` (id=new create);
adminDb: `listBulletins/getBulletinForEdit/saveBulletin/deleteBulletin` (+sermon/sheet
equivalents) with revive + revisions; service-type select on bulletin/sermon forms;
YouTube URL paste → id extract. Tests: port dcfc adminDb tests (save/upsert/announce
rewrite/revision snapshot/soft-delete/revive/duplicate date error).

### Task 3: Announcements + events CRUD + uploads
Pages `admin/{announcements,events}/index.astro` (inline-row CRUD like dcfc);
en+zh title (+blurb) inputs; event image upload → R2 (multipart form); upload.ts +
media proxy route + tests (type rejected, size cap, key format, proxy allowlist,
attachment fallback) — port dcfc upload/media tests.

### Task 4: Prayer wall + revisions + settings pages
`admin/prayer-wall/index.astro` (kanban per constraints), `admin/revisions/[entity]/[id].astro`
(list 50 + restore incl. recreate-hard-deleted-under-same-id), `admin/settings/index.astro`.
adminDb: prayer-wall functions (port), `restoreRevision`. settings save via
parseSettingsForm. Tests: prayer wall move/comment/prayed/delete + activity log,
restore announcement recreates id, settings roundtrip + theme switch reflected by
getActiveTheme after cache clear.

### Task 5: Admin e2e sweep
e2e: role matrix (anon 303, member 403, editor 200 content pages but 403 people/settings,
admin 200 all); create bulletin via POST → appears on public /en/bulletin;
upload happy path (small png fixture) → served by /media; prayer wall move via no-JS
fallback; settings theme change → home HTML `data-theme` flips. Fix findings.

## Self-review checklist
Full suite + tokens:check + check + build + smoke green; manual dev pass: create
bulletin w/ program rows + announcements, publish, view public page both locales;
switch theme in admin → all pages restyle; `rg -n "set:html" src/pages/admin` reviewed —
only safe internal HTML if any.
