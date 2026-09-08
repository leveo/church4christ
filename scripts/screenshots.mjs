#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Reusable public-site screenshot harness.
//
// Drives system Chrome in headless mode over the Chrome DevTools Protocol (CDP)
// via Node's built-in global WebSocket + fetch — no third-party dependency. It
// contains the CAPTURE_ROWS manifest below and captures rows selected with `--only` at
// a fixed 1280x800 viewport. The manifest intentionally mixes D1/Supabase and
// several signed-in identities, so an unfiltered run is rejected before Chrome
// starts or any file is written. Regeneration is split into the precise passes
// documented below. Every capture is written under docs/images/** and asserted
// to be exactly 1280x800 and larger than 20 KB (guards against blank captures).
//
// PREREQUISITES
//   1. A migrated and seeded dev server matching the selected rows is running.
//      For public and D1 admin rows:
//        npm run db:migrate:local && npm run db:seed:local
//        npm run db:seed-media:local
//        npm run dev                       # astro dev on http://localhost:4321
//      Every authenticated README row uses an exact, five-minute screenshot
//      session. Set the
//      same ephemeral SCREENSHOT_SESSION_SECRET in both local processes; it is
//      independent of SESSION_SECRET and must never be persisted or logged.
//   2. Google Chrome / Chromium installed. Override the binary with CHROME_PATH.
//
// USAGE
//   node scripts/screenshots.mjs --base http://localhost:4321 --only readme
//   npm run screenshots -- --only public/events.png,public/ministries.png
//   node scripts/screenshots.mjs --base http://localhost:4321 --only public/events.png,public/ministries.png
//   node scripts/screenshots.mjs --only public/events.png,public/ministries.png
//
// README SHOTS (see docs/design/readme-screenshot-inventory.md)
//   Use the seeded identities listed in README_CAPTURE_ROWS. Run astro dev with
//   AUTH_DEV_BYPASS_EMAIL unset and the same ephemeral SCREENSHOT_SESSION_SECRET
//   in the server and capture process. Each shot gets its own browser context;
//   a dedicated HttpOnly cookie identifies only that row's seeded person.
//   `--only readme` selects all 29 interface images against a fully enabled,
//   seeded Supabase server (including local Learning fixtures and R2 media).
//   Public rows receive no session. The secret is independent of SESSION_SECRET
//   and must not be printed, persisted, or used against a deployed server.
//   Select exact output-path tokens with --only, in passes matching the backend.
//   No README capture submits forms, creates merge operations, or contacts a
//   learning/payment provider. The four diagrams are maintained separately.
//
// LEGACY FEATURE-DOCUMENT SHOTS (outside the README inventory)
//   The legacy dev bypass is a single global env (AUTH_DEV_BYPASS_EMAIL) the dev server
//   reads at boot, so a page needing a *different* identity than the running
//   server can't be shot in the same pass. Each authed PAGES row carries a
//   `bypass` email documenting whose session it needs (admin rows imply
//   admin@example.com). Capture them in separate passes, each with a dev server
//   booted for that identity and `--only` selecting the matching shot(s):
//     # public + admin pass
//     AUTH_DEV_BYPASS_EMAIL=admin@example.com npm run dev &
//     node scripts/screenshots.mjs --only serve/opportunities.png,admin/person-detail.png
//     # D1 member profile (David Chen) pass
//     AUTH_DEV_BYPASS_EMAIL=pastor.david@example.com npm run dev &
//     node scripts/screenshots.mjs --only public/profile-household.png
//     # Supabase member portal (David Chen) pass
//     AUTH_DEV_BYPASS_EMAIL=pastor.david@example.com npm run dev &
//     node scripts/screenshots.mjs --only portal/dashboard.png,portal/household.png,portal/events.png,portal/prayer-moderation.png
//     # member portal group-files (Ben Wu) pass
//     AUTH_DEV_BYPASS_EMAIL=ben.wu@example.com npm run dev &
//     node scripts/screenshots.mjs --only portal/group-files.png
//   README and Learning captures do not depend on that global bypass. Supply one ephemeral
//   secret to both the dev-server and harness environments without printing or
//   writing it; each fresh CDP target receives only its exact seeded identity's
//   short-lived HttpOnly cookie. After setting the same ephemeral variable in
//   this capture shell without echoing its value, run:
//     node scripts/screenshots.mjs \
//       --only learning/genesis-1-en.png,learning/genesis-1-zh.png,learning/admin-overview.png
//   `--only <substr[,substr...]>` keeps only rows whose `out` contains a token.
//   Prefer full output-path tokens for batches so short filenames do not select
//   unrelated outputs that happen to contain the same substring.
//
// VARIANTS (see CAPTURE_ROWS)
//   theme + mode : the theme is normally driven by the DB `theme.name` /
//     `theme.default_mode` settings. Rather than mutate the database per shot,
//     this harness flips data-theme / data-mode on <html> via CDP *after* load
//     (document.documentElement.setAttribute) and waits a frame. Because every
//     token is a CSS custom property keyed off those attributes, the result is
//     pixel-identical to a real settings flip — an honest demo of each theme.
//   hant : Traditional-Chinese shots reproduce the "繁" header toggle, which
//     persists localStorage `c4c-hant='1'` and reloads. The harness seeds that
//     same key at document-start (addScriptToEvaluateOnNewDocument) so the page
//     traditionalizes itself on first paint — same end state as a user click,
//     without a reload race. The baseline script also clears the key for every
//     other shot, so capture order never cross-contaminates localStorage.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertExpectedScreenshotPage,
  requireLocalScreenshotBase,
  requireScreenshotOnly,
  validateScreenshotManifest,
} from './lib/screenshot-validation.mjs';
import { mintScreenshotSession, requireScreenshotSessionEnvironment } from './lib/screenshot-session.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VIEWPORT = { width: 1280, height: 800 };
const MIN_BYTES = 20 * 1024;

// --- config -----------------------------------------------------------------
// Each row: { path, out, admin?, bypass?, hant?, theme?, mode?, backend?, expectedText? }
//   path   — URL path on --base (default http://localhost:4321)
//   out    — repo-relative PNG/JPEG destination (extension selects real encoding)
//   admin  — page needs an admin dev-bypass session (AUTH_DEV_BYPASS_EMAIL=
//            admin@example.com); default false
//   bypass — page needs a specific non-admin member session; the value is the
//            email the dev server must be booted with (see AUTH'D SHOTS above)
//   hant   — seed localStorage c4c-hant='1' so the page renders Traditional
//   theme  — inject data-theme (sanctuary | harvest | midnight) after load
//   mode   — inject data-mode (light | dark) after load
//   anchor — heading text to frame: clip the 1280x800 shot to start just above
//            the first heading containing it (for below-the-fold panels)
//   backend — documentation only, not enforced by this script: 'supabase' means
//            the page 404s on the default D1 backend and needs its own dev-server
//            pass with DB_BACKEND=supabase plus a migrated+seeded local Postgres
//            (CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE must be
//            exported in the host shell before npm run dev; never put it in
//            .dev.vars; see docs/supabase-setup.md §9). Capture these together
//            with --only.
//   expectedText — page marker required before capture; guards authenticated
//            shots against redirects and other unexpected rendered pages
//   sessionIdentity — exact seeded person + epoch, signed by the dedicated
//            development-only screenshot secret (all authenticated README rows)
//   openDisclosure — open this desktop header group before capture; missing
//            disclosure is an error rather than a closed-navigation screenshot
//   openDetails — selectors for native details panels to open before capture
//   waitForSelector — wait for a client-rendered editor before validating/capture
//   postForm — after load, click every element matching `checkAll` (if given)
//            then `requestSubmit()` the element matching `form` and wait for
//            the resulting navigation before continuing. Used for the one shot
//            that needs to show a *real* server response (the kiosk pickup
//            code), which only exists after an actual check-in POST.
export const RELEASE_SCREENSHOTS = validateScreenshotManifest([
  { path: '/admin/people/export', out: 'docs/images/admin/people-export.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Export people and households', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/admin/people/import/map', out: 'docs/images/admin/people-import-mapping.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Map and import a source CSV', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/admin/attendance', out: 'docs/images/admin/attendance-entry.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Record attendance', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/admin/attendance', out: 'docs/images/admin/attendance-report.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Attendance report', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/en/new-here', out: 'docs/images/public/new-here-en.png', locale: 'en', backend: 'either', identity: 'public', viewport: VIEWPORT, expectedText: 'New here?', rejectionTexts: ['Service unavailable', 'Page not found'] },
  { path: '/zh/new-here', out: 'docs/images/public/new-here-zh.png', locale: 'zh', backend: 'either', identity: 'public', viewport: VIEWPORT, expectedText: '第一次来吗？', rejectionTexts: ['服务暂时不可用', '页面未找到'] },
  { path: '/admin/newcomers', out: 'docs/images/admin/newcomers-queue.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Newcomer follow-up', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/admin/newcomers/70000000-0000-4000-8000-000000000001', out: 'docs/images/admin/newcomer-detail.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Jamie New', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/admin/onboarding', out: 'docs/images/admin/onboarding.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Launch checklist', rejectionTexts: ['Sign in', '403', 'Page not found'] },
  { path: '/en/groups/1/manage', out: 'docs/images/groups/member-checklist.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Members', rejectionTexts: ['Sign in', '404', 'Page not found'] },
]);

// Seed-backed capture definitions only. The release documentation task owns
// actual PNG generation and promotion into RELEASE_SCREENSHOTS.
export const LEARNING_DEMO_SCREENSHOTS = validateScreenshotManifest([
  { path: '/en/learn/21000', out: 'docs/images/learning/genesis-1-en.png', locale: 'en', backend: 'either', identity: 'member', viewport: VIEWPORT, expectedText: 'Genesis 1: Creation', rejectionTexts: ['Sign in', '404', 'Page not found'] },
  { path: '/zh/learn/21000', out: 'docs/images/learning/genesis-1-zh.png', locale: 'zh', backend: 'either', identity: 'member', viewport: VIEWPORT, expectedText: 'Genesis 1: Creation', rejectionTexts: ['登录', '404', '页面未找到'] },
  { path: '/admin/learning', out: 'docs/images/learning/admin-overview.png', locale: 'en', backend: 'either', identity: 'admin', viewport: VIEWPORT, expectedText: 'Learning provider connections', rejectionTexts: ['Sign in', '403', 'Page not found'] },
]);

export const LEARNING_DEMO_CAPTURE_ROWS = Object.freeze(LEARNING_DEMO_SCREENSHOTS.map((row) => Object.freeze({
  ...row,
  ...(row.identity === 'admin' ? {
    admin: true,
    bypass: 'admin@example.com',
    anchor: 'Learning provider connections',
    sessionIdentity: Object.freeze({ personId: 1, email: 'admin@example.com', sessionEpoch: 0 }),
    identityExpectedText: 'admin@example.com',
    requiredTexts: Object.freeze([
      'Local fictional Canvas snapshot',
      'https://canvas-learning.example.test',
    ]),
  } : row.locale === 'zh' ? {
    bypass: 'grace.lin@example.com',
    anchor: '课程活动',
    sessionIdentity: Object.freeze({ personId: 4, email: 'grace.lin@example.com', sessionEpoch: 0 }),
    identityExpectedText: '已退回',
    identityRejectionTexts: Object.freeze(['Not submitted', '未提交']),
  } : {
    bypass: 'sarah.johnson@example.com',
    anchor: 'Course activities',
    sessionIdentity: Object.freeze({ personId: 3, email: 'sarah.johnson@example.com', sessionEpoch: 0 }),
    identityExpectedText: 'Not submitted',
    identityRejectionTexts: Object.freeze(['Returned', '已退回']),
  }),
})));

const LEGACY_CAPTURE_ROWS = [
  ...RELEASE_SCREENSHOTS.map((row) => ({ ...row, admin: row.identity === 'admin', anchor: row.out.endsWith('attendance-report.png') ? 'Attendance report' : row.out.endsWith('member-checklist.png') ? 'Members' : undefined })),
  ...LEARNING_DEMO_CAPTURE_ROWS,
  // Multi-campus core capability — top-level management and the below-the-fold
  // campus-local role form, both captured as the seeded master administrator.
  { path: '/admin/campuses', out: 'docs/images/admin/campuses-overview.png', admin: true, expectedText: 'Campus management' },
  { path: '/admin/campuses', out: 'docs/images/admin/campus-roles.png', admin: true, anchor: 'Campus roles', expectedText: 'Campus roles' },
  // Public tour — sanctuary theme, light mode (the shipped default), /en/ unless noted.
  { path: '/en/', out: 'docs/images/public/home-en.png' },
  { path: '/zh/', out: 'docs/images/public/home-zh.png' },
  { path: '/zh/', out: 'docs/images/public/home-zh-hant.png', hant: true },
  { path: '/en/sermons', out: 'docs/images/public/sermons.png' },
  { path: '/en/bulletin', out: 'docs/images/public/bulletin.png' },
  { path: '/en/prayer', out: 'docs/images/public/prayer.png' },
  { path: '/en/events', out: 'docs/images/public/events.png' },
  { path: '/en/ministries', out: 'docs/images/public/ministries.png' },
  { path: '/en/ministries/worship', out: 'docs/images/public/ministry-detail.png' },
  { path: '/en/visit', out: 'docs/images/public/visit.png' },
  { path: '/en/about/staff', out: 'docs/images/public/staff.png' },
  { path: '/en/articles', out: 'docs/images/public/articles.png' },
  { path: '/en/articles/psalms-of-ascent', out: 'docs/images/public/article.png' },
  { path: '/en/fellowships', out: 'docs/images/public/fellowships.png' },
  { path: '/en/give', out: 'docs/images/public/give.png' },
  { path: '/en/signin', out: 'docs/images/public/signin.png' },

  // People module (Slice 9). The opportunity board is public; the household
  // self-service card needs David Chen's member session; the admin person detail
  // (person 2) needs an admin session. See AUTH'D SHOTS in the header.
  { path: '/en/serve/opportunities', out: 'docs/images/serve/opportunities.png' },
  { path: '/en/profile', out: 'docs/images/public/profile-household.png', bypass: 'pastor.david@example.com', anchor: 'Household' },
  { path: '/admin/people/2', out: 'docs/images/admin/person-detail.png', admin: true, anchor: 'Household' },

  // Member Portal — Supabase-only authenticated pages. Use full output-path
  // tokens to avoid filename collisions.
  // David: --only portal/dashboard.png,portal/household.png,portal/events.png,portal/prayer-moderation.png
  // Ben: --only portal/group-files.png (in a separate identity pass)
  { path: '/en/my', out: 'docs/images/portal/dashboard.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Chen Family' },
  { path: '/en/my/household', out: 'docs/images/portal/household.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Chen Family' },
  { path: '/en/my/events', out: 'docs/images/portal/events.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'My registrations' },
  { path: '/en/my/prayer?tab=pending', out: 'docs/images/portal/prayer-moderation.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Pending' },
  { path: '/en/groups/1', out: 'docs/images/portal/group-files.png', bypass: 'ben.wu@example.com', backend: 'supabase', anchor: 'Files', anchorMargin: 0, expectedText: 'young-adults-welcome.pdf' },

  // Admin permissions — a super admin's view of a limited admin's person page
  // (person 11, Lydia Kwan), framed on the "Access & status" panel so the
  // Module access checklist (with her granted groups/events already checked)
  // is visible. See docs/features/admin-permissions.md.
  { path: '/admin/people/11', out: 'docs/images/admin/person-permissions.png', admin: true, anchor: 'Access & status' },

  // Groups module — public directory (one public group, seeded) and the
  // site-admin console (CRUD over every group). D1 works fine; no backend flag.
  { path: '/en/groups', out: 'docs/images/groups/directory.png' },
  { path: '/admin/groups', out: 'docs/images/admin/groups.png', admin: true },

  // dcfc design-parity stat rows. prayer-wall runs on D1 like the rows above;
  // giving/registration/give-form are Supabase-only (see `backend` above) — they
  // 404 on D1 and need a separate dev-server pass against a migrated+seeded
  // local Postgres. give-form is the module-ON checkout branch of /en/give
  // (distinct from the module-OFF public/give.png row above).
  { path: '/admin/prayer-wall', out: 'docs/images/admin/prayer-wall.png', admin: true },
  { path: '/en/give', out: 'docs/images/giving/give-form.png', backend: 'supabase' },
  { path: '/admin/giving', out: 'docs/images/admin/giving.png', admin: true, backend: 'supabase' },
  { path: '/admin/registration', out: 'docs/images/admin/registration.png', admin: true, backend: 'supabase' },
  // Children's check-in (Task 8). The kiosk needs no session — the token in
  // the URL is the gate — so it captures in the same admin-bypass pass. The
  // dev seed fixes the kiosk token and gives Chen Family two children, which
  // `kiosk-search.png` finds by name. `kiosk-code.png` performs a REAL
  // check-in via a native form POST (the `postForm` step below) so the
  // confirmation screen shows a genuine pickup code; it must run BEFORE
  // `children-today.png`, which depends on that same check-in appearing in
  // the day's roster. Keep them in this order.
  { path: '/kiosk/devkiosk1234567890abcdef12345678/?lang=en&q=Chen', out: 'docs/images/public/kiosk-search.png' },
  {
    path: '/kiosk/devkiosk1234567890abcdef12345678/household/1?lang=en&q=Chen',
    out: 'docs/images/public/kiosk-code.png',
    postForm: { checkAll: 'input[name="member"]', form: 'form[method="post"]' },
  },
  { path: '/admin/children?tab=dashboard', out: 'docs/images/admin/children-dashboard.png', admin: true },
  { path: '/admin/children?tab=today', out: 'docs/images/admin/children-today.png', admin: true },

  // Page builder: the drag-and-drop editor opened on the seeded 'welcome' page
  // (fixed id in dev-seed.sql), plus the zero-JS public page it publishes.
  { path: '/admin/pages/builder/seedbuilderwelcome0000000000pb01', out: 'docs/images/admin/page-builder.png', admin: true },
  { path: '/en/p/welcome', out: 'docs/images/public/page-builder-page.png' },

  // Theme matrix — 3 themes x light/dark, home page, applied via injection.
  { path: '/en/', out: 'docs/images/themes/home-sanctuary-light.png', theme: 'sanctuary', mode: 'light' },
  { path: '/en/', out: 'docs/images/themes/home-sanctuary-dark.png', theme: 'sanctuary', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-harvest-light.png', theme: 'harvest', mode: 'light' },
  { path: '/en/', out: 'docs/images/themes/home-harvest-dark.png', theme: 'harvest', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-midnight-dark.png', theme: 'midnight', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-midnight-light.png', theme: 'midnight', mode: 'light' },
];

// README is the release gallery. Keep its complete capture contract separate
// from additional feature-documentation screenshots so omissions are testable.
const ACTORS = Object.freeze({
  admin: Object.freeze({ personId: 1, email: 'admin@example.com', sessionEpoch: 0 }),
  david: Object.freeze({ personId: 2, email: 'pastor.david@example.com', sessionEpoch: 0 }),
  sarah: Object.freeze({ personId: 3, email: 'sarah.johnson@example.com', sessionEpoch: 0 }),
  grace: Object.freeze({ personId: 4, email: 'grace.lin@example.com', sessionEpoch: 0 }),
});

function readmeShot(path, output, expectedText, { actor = 'public', ...options } = {}) {
  const locale = path.startsWith('/zh/') ? 'zh' : 'en';
  const identity = actor === 'public' ? 'public' : actor === 'admin' ? 'admin' : 'member';
  return Object.freeze({
    path, out: `docs/images/${output}`, locale, backend: 'either', identity,
    viewport: VIEWPORT, expectedText, theme: 'sanctuary', mode: 'light',
    rejectionTexts: locale === 'zh' ? ['页面未找到', '服务暂时不可用'] : ['Page not found', 'Service unavailable'],
    ...(actor === 'public' ? {} : {
      sessionIdentity: ACTORS[actor],
      ...(actor === 'admin' ? { admin: true, identityExpectedText: ACTORS.admin.email } : {}),
    }),
    ...options,
  });
}

export const README_CAPTURE_ROWS = Object.freeze([
  readmeShot('/en/', 'public/home-en.png', 'Life together. Faith that grows.'),
  readmeShot('/zh/', 'public/home-zh.png', '在这里， 一起成长。'),
  readmeShot('/en/', 'public/grouped-navigation.png', 'Life together. Faith that grows.', { openDisclosure: 'Connect', requiredTexts: ['Find people to share life with.'] }),
  readmeShot('/en/', 'themes/home-midnight-dark.png', 'Life together. Faith that grows.', { theme: 'midnight', mode: 'dark' }),
  readmeShot('/en/sermons', 'public/sermons.png', 'Sermons', { requiredTexts: ['You Are the Light of the World'] }),
  readmeShot('/admin', 'admin/dashboard.png', 'Dashboard', { actor: 'admin' }),
  readmeShot('/admin/prayer-wall', 'admin/prayer-wall.png', 'Prayer Wall', { actor: 'admin' }),
  readmeShot('/admin/people/11', 'admin/person-permissions.png', 'Lydia Kwan', { actor: 'admin', requiredTexts: ['Access & status'] }),
  readmeShot('/admin/campuses', 'admin/campuses-overview.png', 'Campus management', { actor: 'admin' }),
  readmeShot('/admin/bulletins/1', 'admin/bulletin-editor.png', 'Edit bulletin', { actor: 'admin', requiredTexts: ['Order of worship', 'Publishing'] }),
  readmeShot('/admin/people/export', 'admin/people-export.png', 'Export people and households', { actor: 'admin' }),
  readmeShot('/admin/people/identity/merge', 'identity/merge-review-queue.jpg', 'Merge review queue', { actor: 'admin', requiredTexts: ['Confirmed same-person cases', 'Merge operations'] }),
  readmeShot('/en/groups/1/manage', 'groups/member-checklist.png', 'Manage Young Adults', { actor: 'admin', anchor: 'Members', identityExpectedText: 'Alex Admin' }),
  readmeShot('/admin/children?tab=dashboard', 'admin/children-dashboard.png', 'Children check-in', { actor: 'admin' }),
  readmeShot('/admin/attendance', 'admin/attendance-report.png', 'Attendance report', { actor: 'admin', anchor: 'Attendance report' }),
  readmeShot('/admin/newcomers', 'admin/newcomers-queue.png', 'Newcomer follow-up', { actor: 'admin', requiredTexts: ['Jamie New'] }),
  readmeShot('/admin/onboarding', 'admin/onboarding.png', 'Launch checklist', { actor: 'admin' }),
  readmeShot('/admin/pages/builder/seedbuilderwelcome0000000000pb01', 'admin/page-builder.png', 'Design your page', { actor: 'admin', waitForSelector: '.builder-topbar', requiredTexts: ['Save & publish'] }),
  readmeShot('/admin/giving', 'admin/giving.png', 'Giving', { actor: 'admin', backend: 'supabase', requiredTexts: ['Gifts', 'Offline entry', 'Amounts are listed per gift in their recorded currency'] }),
  readmeShot('/admin/registration', 'admin/registration.png', 'Registration', { actor: 'admin', backend: 'supabase' }),
  readmeShot('/admin/ministries?tab=email', 'admin/email-tab.png', 'Automation rules', { actor: 'admin', anchor: 'Automation rules', requiredTexts: ['Email templates', 'Recent emails'] }),
  readmeShot('/admin/settings', 'admin/settings-modules.png', 'Site Settings', { actor: 'admin', anchor: 'Modules', requiredTexts: ['Save modules'] }),
  readmeShot('/admin/learning', 'learning/admin-overview.png', 'Learning provider connections', { actor: 'admin', anchor: 'Learning provider connections', requiredTexts: ['Local fictional Canvas snapshot', 'https://canvas-learning.example.test'] }),
  readmeShot('/en/my', 'portal/dashboard.png', 'Welcome, David Chen', { actor: 'david', backend: 'supabase', identityExpectedText: 'David Chen', requiredTexts: ['Chen Family'] }),
  readmeShot('/en/my/opportunities', 'portal/member-opportunities.png', 'Find Your Place', { actor: 'sarah', backend: 'supabase', identityExpectedText: 'Sarah Johnson', requiredTexts: ['My participation', 'Open opportunities'] }),
  readmeShot('/en/manage', 'portal/leader-panel.png', 'Leader Panel', { actor: 'sarah', requiredTexts: ['Worship'] }),
  readmeShot('/en/serve/matrix/1', 'serve/matrix.png', 'Scheduling Matrix', { actor: 'sarah', requiredTexts: ['Sunday Worship (English)', 'WORSHIP TEAM'] }),
  ...LEARNING_DEMO_CAPTURE_ROWS.filter((row) => row.identity === 'member').map((row) => Object.freeze({ ...row, theme: 'sanctuary', mode: 'light' })),
]);

export const README_SCREENSHOTS = validateScreenshotManifest(README_CAPTURE_ROWS.map((row) => {
  const { path, out, locale, backend, identity, viewport, expectedText, rejectionTexts } = row;
  return { path, out, locale, backend, identity, viewport, expectedText, rejectionTexts };
}));

// These explain architecture/workflows and are authored separately, not browser pages.
export const README_DIAGRAMS = Object.freeze([
  'docs/images/diagrams/product-overview.png',
  'docs/images/learning/learning-flow.png',
  'docs/images/diagrams/member-opportunity-workflow.png',
  'docs/images/diagrams/setup-paths-overview.png',
]);

export const CAPTURE_ROWS = Object.freeze([
  ...LEGACY_CAPTURE_ROWS.map((row) => README_CAPTURE_ROWS.find((readme) => readme.out === row.out) ?? row),
  ...README_CAPTURE_ROWS.filter((row) => !LEGACY_CAPTURE_ROWS.some((legacy) => legacy.out === row.out)),
  readmeShot('/admin/onboarding', 'admin/onboarding-readiness.png', 'Launch checklist', { actor: 'admin' }),
  readmeShot('/admin/activity-score', 'admin/activity-score-overview.png', 'Activity score', { actor: 'admin', requiredTexts: ['Member activity', 'Source coverage'], rejectionTexts: ['The activity score report could not be loaded.'] }),
  readmeShot('/admin/activity-score', 'admin/activity-score-calculation.png', 'Activity score', { actor: 'admin', anchor: 'Member activity', openDetails: ['.activity-people-table tbody tr:first-child details'], requiredTexts: ['Show calculation'] }),
  readmeShot('/admin/activity-score', 'admin/activity-score-model.png', 'Activity score', { actor: 'admin', anchor: 'Scoring model', openDetails: ['.activity-config'], requiredTexts: ['Scoring model'] }),
]);

export function selectScreenshotRows(argv) {
  requireScreenshotOnly(argv);
  const tokens = (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean);
  if (tokens.length === 1 && tokens[0] === 'readme') return README_CAPTURE_ROWS;
  const pages = CAPTURE_ROWS.filter((row) => tokens.some((token) => row.out.includes(token)));
  if (pages.length === 0) throw new Error(`--only matched no pages (tokens: ${tokens.join(', ')})`);
  return pages;
}

// --- Chrome discovery + launch ----------------------------------------------
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
}

async function launchChrome() {
  const bin = resolveChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), 'c4c-shots-'));
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0', // 0 → Chrome picks a free port, written to DevToolsActivePort
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  // Read the chosen port from DevToolsActivePort (line 1 = port, line 2 = ws path).
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const [line] = (await readFile(portFile, 'utf8')).split('\n');
      if (line && line.trim()) { port = line.trim(); break; }
    }
    await sleep(100);
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome did not report a debugging port'); }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return { proc, userDataDir, wsUrl: version.webSocketDebuggerUrl };
}

// --- minimal CDP client (flat protocol over one browser WebSocket) -----------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket error')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const eventHandlers = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const onceEvent = (method, sessionId, timeoutMs, predicate = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { eventHandlers.delete(h); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const h = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId) && predicate(msg.params)) {
          clearTimeout(timer); eventHandlers.delete(h); resolve(msg.params);
        }
      };
      eventHandlers.add(h);
    });
  return { ws, send, onceEvent };
}

// --- Image format/dimensions -------------------------------------------------
export function screenshotFormat(output) {
  if (/\.png$/i.test(output)) return 'png';
  if (/\.jpe?g$/i.test(output)) return 'jpeg';
  throw new Error(`Unsupported screenshot format: ${output}`);
}

export function screenshotImageDimensions(buf, format) {
  if (format === 'jpeg') {
    if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG (missing SOI)');
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset++] !== 0xff) break;
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > buf.length) break;
      const length = buf.readUInt16BE(offset);
      if (length < 2 || offset + length > buf.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: buf.readUInt16BE(offset + 5), height: buf.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    throw new Error('not a JPEG (missing valid frame dimensions)');
  }
  // 8-byte signature, 4-byte length, "IHDR", then width/height (big-endian u32).
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG (missing IHDR)');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function screenshotClip(row, anchorY) {
  if (!row.anchor) return undefined;
  if (!Number.isFinite(anchorY) || anchorY < 0) throw new Error(`${row.out}: required anchor ${JSON.stringify(row.anchor)} was not found`);
  return { x: 0, y: Math.max(0, anchorY - (row.anchorMargin ?? 40)), width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 };
}

export async function createScreenshotTarget({ send }) {
  // New tabs in the default context share cookies. An incognito context also
  // isolates localStorage, campus choices, and the preceding shot's identity.
  const { browserContextId } = await send('Target.createBrowserContext', {});
  const close = () => send('Target.disposeBrowserContext', { browserContextId });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    return { sessionId, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

// --- capture one page --------------------------------------------------------
async function capture(cdp, base, row) {
  const { send, onceEvent } = cdp;
  const { sessionId, close } = await createScreenshotTarget(cdp);

  try {
    await send('Page.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }, sessionId);

    if (row.sessionIdentity) {
      const value = await mintScreenshotSession(process.env, row.sessionIdentity);
      const cookie = await send('Network.setCookie', {
        name: 'c4c_session',
        value,
        url: new URL(base).origin,
        path: '/',
        httpOnly: true,
        secure: new URL(base).protocol === 'https:',
        sameSite: 'Lax',
      }, sessionId);
      if (cookie.success !== true) throw new Error(`${row.out}: screenshot session cookie was rejected`);
    }

    // Document-start baseline: deterministically set the localStorage state this
    // shot needs (c4c-hant on/off, c4c-mode cleared) before any page script runs.
    const hantExpr = row.hant ? "localStorage.setItem('c4c-hant','1');" : "localStorage.removeItem('c4c-hant');";
    await send('Page.addScriptToEvaluateOnNewDocument',
      { source: `try{ ${hantExpr} localStorage.removeItem('c4c-mode'); }catch(e){}` }, sessionId);

    const url = new URL(row.path, base).href;
    const mainDocument = onceEvent('Network.responseReceived', sessionId, 20000,
      (params) => params.type === 'Document' && new URL(params.response.url).pathname === new URL(url).pathname);
    const loaded = onceEvent('Page.loadEventFired', sessionId, 20000).catch(() => {});
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    const mainResponse = await mainDocument;

    if (row.waitForSelector) {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const { result } = await send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(row.waitForSelector)})`, returnByValue: true,
        }, sessionId);
        if (result.value === true) { ready = true; break; }
        await sleep(100);
      }
      if (!ready) throw new Error(`${row.out}: editor did not mount (${row.waitForSelector})`);
    }

    // A scripted form submission: check every box matching `checkAll`, then
    // submit the form and wait for the real server-rendered response page
    // (a native POST navigation, not a fetch) before capturing.
    if (row.postForm) {
      if (row.postForm.checkAll) {
        await send('Runtime.evaluate',
          { expression: `document.querySelectorAll(${JSON.stringify(row.postForm.checkAll)}).forEach((el) => el.click())` }, sessionId);
      }
      const resubmitted = onceEvent('Page.loadEventFired', sessionId, 20000).catch(() => {});
      await send('Runtime.evaluate',
        { expression: `document.querySelector(${JSON.stringify(row.postForm.form)}).requestSubmit()` }, sessionId);
      await resubmitted;
    }

    // Wait for webfonts, then for the 繁 conversion (lang flips to zh-Hant) if applicable.
    await send('Runtime.evaluate',
      { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true, returnByValue: true }, sessionId);
    if (row.hant) {
      for (let i = 0; i < 30; i++) {
        const { result } = await send('Runtime.evaluate',
          { expression: "document.documentElement.lang==='zh-Hant'", returnByValue: true }, sessionId);
        if (result.value) break;
        await sleep(100);
      }
      await sleep(400); // let the text-node conversion pass settle
    }

    // Theme/mode: flip the CSS-var-driving attributes on <html> after load.
    if (row.theme || row.mode) {
      const set = [];
      if (row.theme) set.push(`d.setAttribute('data-theme',${JSON.stringify(row.theme)});`);
      if (row.mode) set.push(`d.setAttribute('data-mode',${JSON.stringify(row.mode)});`);
      await send('Runtime.evaluate',
        { expression: `(()=>{const d=document.documentElement;${set.join('')}})()` }, sessionId);
    }
    await sleep(300); // paint settle

    // Drop the Astro dev-toolbar overlay so it never bleeds into a shot (a no-op
    // in preview/prod builds, where the element does not exist).
    await send('Runtime.evaluate',
      { expression: "document.querySelectorAll('astro-dev-toolbar, #astro-dev-toolbar-root').forEach(e=>e.remove())" }, sessionId);

    if (row.openDisclosure) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(()=>{const d=[...document.querySelectorAll('header details')].find(e=>e.querySelector('summary')?.textContent.trim().startsWith(${JSON.stringify(row.openDisclosure)}));if(!d)return false;d.open=true;return d.open;})()`,
        returnByValue: true,
      }, sessionId);
      if (result.value !== true) throw new Error(`${row.out}: required disclosure ${JSON.stringify(row.openDisclosure)} was not found`);
      await sleep(100);
    }

    for (const selector of row.openDetails ?? []) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(()=>{const d=document.querySelector(${JSON.stringify(selector)});if(!(d instanceof HTMLDetailsElement))return false;d.open=true;return d.open;})()`,
        returnByValue: true,
      }, sessionId);
      if (result.value !== true) throw new Error(`${row.out}: required details panel ${JSON.stringify(selector)} was not found`);
    }

    // Anchored shots frame a below-the-fold panel (e.g. the household / notes
    // cards): find the first heading containing `anchor` and clip a 1280x800
    // window starting `anchorMargin` px above it (captureBeyondViewport renders
    // the region even below the live viewport). A missing panel fails capture.
    let clip;
    if (row.anchor) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(()=>{const h=[...document.querySelectorAll('h1,h2,h3')].find(e=>e.textContent.includes(${JSON.stringify(row.anchor)}));return h?Math.round(h.getBoundingClientRect().top+window.scrollY):-1;})()`,
        returnByValue: true,
      }, sessionId);
      clip = screenshotClip(row, result.value);
    }

    const { result: pageState } = await send('Runtime.evaluate', {
      expression: `({url:location.href,status:${Number(mainResponse.response.status)},title:document.title,headings:[...document.querySelectorAll('h1,h2,h3')].map((e)=>e.textContent||''),body:document.body?.innerText||'',links:[...document.querySelectorAll('a[href]')].map((e)=>e.href)})`,
      returnByValue: true,
    }, sessionId);
    assertExpectedScreenshotPage(row, pageState.value);

    // Decode local media in the actual capture region, including lazy images
    // below the live viewport in an anchored shot. External video thumbnails
    // may remain pending; the product's packaged poster is already visible.
    const { result: mediaState } = await send('Runtime.evaluate', {
      expression: `(async()=>{const top=${clip?.y ?? 0};const bottom=top+${VIEWPORT.height};const images=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.width>0&&r.height>0&&r.top+scrollY<bottom&&r.bottom+scrollY>top&&new URL(img.currentSrc||img.src,location.href).origin===location.origin;});const ready=Promise.all(images.map(async img=>{img.loading='eager';await img.decode();})).then(()=>true);return Promise.race([ready,new Promise(resolve=>setTimeout(()=>resolve(false),10000))]);})()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (mediaState.value !== true) throw new Error(`${row.out}: local capture media did not decode`);

    const format = screenshotFormat(row.out);
    const { data } = await send('Page.captureScreenshot',
      { format, ...(format === 'jpeg' ? { quality: 90 } : {}), ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId);
    const buf = Buffer.from(data, 'base64');

    const { width, height } = screenshotImageDimensions(buf, format);
    if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
      throw new Error(`${row.out}: expected ${VIEWPORT.width}x${VIEWPORT.height}, got ${width}x${height}`);
    }
    if (buf.length < MIN_BYTES) {
      throw new Error(`${row.out}: ${buf.length} bytes < ${MIN_BYTES} (likely blank)`);
    }

    const outPath = join(ROOT, row.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    console.log(`  ok  ${row.out}  ${width}x${height}  ${(buf.length / 1024).toFixed(0)}KB`);
  } finally {
    await close().catch(() => {});
  }
}

// --- main --------------------------------------------------------------------
async function main() {
  requireScreenshotOnly(process.argv);

  const baseIdx = process.argv.indexOf('--base');
  const base = requireLocalScreenshotBase(
    baseIdx !== -1 ? process.argv[baseIdx + 1] : 'http://localhost:4321',
  );

  // `--only <substr[,substr...]>` captures just the rows whose `out` contains a
  // token — used to shoot the admin/member pages against a dev server booted for
  // that identity without re-capturing the whole table.
  const pages = selectScreenshotRows(process.argv);
  if (pages.some((row) => row.sessionIdentity)) requireScreenshotSessionEnvironment(process.env);

  // Fail fast if the dev server is not up.
  try {
    await fetch(new URL('/en/', base).href, { redirect: 'manual' });
  } catch {
    throw new Error(`Dev server unreachable at ${base}. Start it with: npm run dev`);
  }

  console.log(`Capturing ${pages.length} pages from ${base}`);
  const { proc, userDataDir, wsUrl } = await launchChrome();
  const cdp = await connect(wsUrl);
  let failures = 0;
  try {
    for (const row of pages) {
      try {
        await capture(cdp, base, row);
      } catch (err) {
        failures++;
        console.error(`  FAIL ${row.out}: ${err.message}`);
      }
    }
  } finally {
    try { cdp.ws.close(); } catch {}
    proc.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (failures) { console.error(`\n${failures} capture(s) failed.`); process.exit(1); }
  console.log(`\nAll ${pages.length} captures passed (1280x800, >20KB).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
