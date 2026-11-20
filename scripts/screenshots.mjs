#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Reusable public-site screenshot harness.
//
// Drives system Chrome in headless mode over the Chrome DevTools Protocol (CDP)
// via Node's built-in global WebSocket + fetch — no third-party dependency. It
// contains the CAPTURE_ROWS manifest below and captures rows selected with `--only` at
// a 1280x800 desktop viewport, or at a 375x812 phone viewport (2x, mobile emulation) for rows
// that carry MOBILE_VIEWPORT (see MOBILE_CAPTURE_ROWS). The manifest intentionally mixes D1/Supabase and
// several signed-in identities, so an unfiltered run is rejected before Chrome
// starts or any file is written. Regeneration is split into the precise passes
// documented below. Every capture is written under docs/images/** and asserted
// to be exactly its row's viewport size (1280x800, or 750x1624 for phone rows) and larger than 20 KB (guards against blank captures).
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
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  assertExpectedScreenshotPage,
  requireLocalScreenshotBase,
  requireScreenshotOnly,
  validateScreenshotManifest,
} from './lib/screenshot-validation.mjs';
import { mintScreenshotSession, requireScreenshotSessionEnvironment } from './lib/screenshot-session.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VIEWPORT = DESKTOP_VIEWPORT;

/** Per-row viewport: rows are desktop (1280x800) unless they carry MOBILE_VIEWPORT. */
export function viewportOf(row) {
  return row.viewport ?? VIEWPORT;
}

/** Pixel size the PNG/JPEG must have for a row (CSS size times device scale factor). */
export function expectedImageSize(row) {
  const viewport = viewportOf(row);
  const scale = viewport.deviceScaleFactor ?? 1;
  return { width: viewport.width * scale, height: viewport.height * scale };
}

/** Throws when the page is wider than the viewport (horizontal page scroll). */
export function assertNoHorizontalOverflow(row, metrics) {
  if (!metrics || !Number.isFinite(metrics.scrollWidth) || !Number.isFinite(metrics.innerWidth)) {
    throw new Error(`${row.out}: could not measure horizontal overflow`);
  }
  if (metrics.scrollWidth > metrics.innerWidth) {
    throw new Error(`${row.out}: horizontal overflow, document scrollWidth ${metrics.scrollWidth} > viewport ${metrics.innerWidth}${metrics.widest ? ` (widest: ${metrics.widest})` : ''}`);
  }
}
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
//   interact — ordered steps run after load (and after postForm): { click: selector },
//            { fill: { selector: value } } (inputs and selects; fires input/change),
//            { submit: formSelector } (requestSubmit, waits for the page it loads) and
//            { wait: selector }. Used to walk the registration flow for real (fill the
//            party, review, confirm) so the review and manage pages show genuine output.
//   finalPath — pathname (and query) the page is expected to END on when `interact`
//            navigates away from `path` (e.g. the manage page after a confirm)
//   anchorSelector — like `anchor`, but frames the first element matching this selector
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

const DAVID = Object.freeze({ personId: 2, email: 'pastor.david@example.com', sessionEpoch: 0 });

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
  // Event Registration on D1 (free events, preview and waitlist): the seeded D1 dev server shows
  // event 920 (open, capacity 3) and 930 (preview). Capture with --only registration/
  { path: '/en/register', out: 'docs/images/registration/public-list.png', backend: 'd1', expectedText: 'Neighbors Potluck Night' },
  { path: '/en/register/920', out: 'docs/images/registration/event-detail.png', backend: 'd1', expectedText: 'What will you bring?' },
  { path: '/en/register/930', out: 'docs/images/registration/event-preview.png', backend: 'd1', expectedText: 'Registration is not open yet' },
  { path: '/en/register/done?ok=1&status=waitlist', out: 'docs/images/registration/done-waitlist.png', backend: 'd1', expectedText: 'on the waitlist' },
  { path: '/admin/registration', out: 'docs/images/registration/admin-events.png', admin: true, backend: 'd1', expectedText: 'Neighbors Potluck Night' },
  { path: '/admin/registration?edit=920', out: 'docs/images/registration/admin-editor.png', admin: true, backend: 'd1', anchor: 'Edit event', expectedText: 'Poster image' },
  // Registration party flow (D1). The member rows walk the real form with David Chen (household
  // with Amy and the children Ethan and Mia), so they need SCREENSHOT_SESSION_SECRET in the
  // server and this process. The review and manage rows REGISTER for real (the confirm posts),
  // so run them on a disposable seeded database and raise event 920's capacity first
  // (UPDATE reg_events SET capacity = 10 WHERE id = 920) so the whole family is confirmed.
  // Run each registering row in its own pass: they share the member's one seat budget.
  ...[
    ['docs/images/registration/party-form.png', null],
    ['docs/images/mobile/register-party-form.png', MOBILE_VIEWPORT],
  ].map(([out, viewport]) => ({
    path: '/en/register/920', out, backend: 'd1', sessionIdentity: DAVID, anchorSelector: '#f-party', anchorMargin: viewport ? 20 : 70, ...(viewport ? { viewport } : {}),
    expectedText: 'Who is coming?',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Amy Chen"]' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { fill: { 'input[name="phone"]': '(555) 010-2020', 'select[name="921"]': 'Main dish' } },
    ],
  })),
  ...[
    ['docs/images/registration/review.png', null],
    ['docs/images/mobile/register-review.png', MOBILE_VIEWPORT],
  ].map(([out, viewport]) => ({
    path: '/en/register/920', out, backend: 'd1', sessionIdentity: DAVID, ...(viewport ? { viewport, anchor: 'Check your registration', anchorMargin: 20 } : {}),
    expectedText: 'Check your registration',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Amy Chen"]' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { fill: { 'input[name="phone"]': '(555) 010-2020', 'select[name="921"]': 'Main dish' } },
      { submit: '[data-register-form]' },
    ],
  })),
  ...[
    ['docs/images/registration/manage.png', null],
    ['docs/images/mobile/register-manage.png', MOBILE_VIEWPORT],
  ].map(([out, viewport]) => ({
    path: '/en/register/920', out, backend: 'd1', sessionIdentity: DAVID, ...(viewport ? { viewport } : {}),
    finalPath: '/en/register/manage', expectedText: 'Doors open at 5:30 pm',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Amy Chen"]' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { fill: { 'input[name="phone"]': '(555) 010-2020', 'select[name="921"]': 'Main dish' } },
      { submit: '[data-register-form]' },
      { submit: 'form[action="/api/register/submit"]' },
      { wait: '[data-confirmation]' },
    ],
  })),
  // The lower half of the manage page: the edit form and the cancel section (registers for real, like manage.png).
  {
    path: '/en/register/920', out: 'docs/images/registration/manage-edit.png', backend: 'd1', sessionIdentity: DAVID,
    finalPath: '/en/register/manage', anchorSelector: '#reg-edit', anchorMargin: 40, expectedText: 'Doors open at 5:30 pm',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Amy Chen"]' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { fill: { 'input[name="phone"]': '(555) 010-2020', 'select[name="921"]': 'Main dish' } },
      { submit: '[data-register-form]' },
      { submit: 'form[action="/api/register/submit"]' },
      { wait: '[data-confirmation]' },
    ],
  },
  // Ticket types, per-person questions and show-if (Phase 3). These rows use the sample event "Family Camp Weekend"
  // (931 on the throwaway state built for the builder rows above: Adult / Child tickets, a childcare yes/no with a
  // conditional number, per-person shirt size, diet and a conditional badge name, and a terms question). The review
  // and manage rows REGISTER for real: run each in its own pass on a disposable database.
  ...[
    ['docs/images/registration/form-tickets.png', null],
    ['docs/images/mobile/register-form-tickets.png', MOBILE_VIEWPORT],
  ].map(([out, viewport]) => ({
    path: '/en/register/931', out, backend: 'd1', sessionIdentity: DAVID, anchorSelector: '#f-party', anchorMargin: viewport ? 20 : 40, ...(viewport ? { viewport } : {}),
    expectedText: 'Ticket type',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { click: 'input[name="ticket_0"][value="1"]' },
      { click: 'input[name="ticket_1"][value="2"]' },
      { click: 'input[name="924"][value="yes"]' },
      { fill: { 'input[name="925"]': '1', 'select[name="pq_0_926"]': 'm', 'select[name="pq_1_926"]': 's', 'input[name="pq_0_928"]': 'Dave' } },
    ],
  })),
  // The same form further down: the second person's own block, then the once-per-registration questions with the
  // conditional "How many children?" shown because the childcare answer is Yes.
  ...[
    ['docs/images/registration/form-person-two.png', '#f-ticket-1', 'Person 2'],
    ['docs/images/registration/form-questions.png', '[data-qid="923"]', 'About your family'],
  ].map(([out, anchorSelector, expectedText]) => ({
    path: '/en/register/931', out, backend: 'd1', sessionIdentity: DAVID, anchorSelector, anchorMargin: 40, expectedText,
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { click: 'input[name="ticket_0"][value="1"]' },
      { click: 'input[name="ticket_1"][value="2"]' },
      { click: 'input[name="924"][value="yes"]' },
      { fill: { 'input[name="925"]': '1', 'select[name="pq_0_926"]': 'm', 'select[name="pq_1_926"]': 's', 'input[name="pq_0_928"]': 'Dave' } },
    ],
  })),
  ...[
    ['docs/images/registration/review-tickets.png', null],
    ['docs/images/mobile/register-review-tickets.png', MOBILE_VIEWPORT],
  ].map(([out, viewport]) => ({
    path: '/en/register/931', out, backend: 'd1', sessionIdentity: DAVID, ...(viewport ? { viewport, anchor: 'Check your registration', anchorMargin: 20 } : {}),
    expectedText: 'Check your registration',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { click: 'input[name="ticket_0"][value="1"]' },
      { click: 'input[name="ticket_1"][value="2"]' },
      { click: 'input[name="924"][value="yes"]' },
      { fill: { 'input[name="925"]': '1', 'select[name="pq_0_926"]': 'm', 'select[name="pq_1_926"]': 's', 'input[name="pq_0_928"]': 'Dave' } },
      { click: 'input[name="930"]' },
      { submit: '[data-register-form]' },
    ],
  })),
  ...[
    ['docs/images/registration/manage-tickets.png', null, null],
    ['docs/images/registration/manage-tickets-edit.png', null, '#reg-edit'],
    ['docs/images/mobile/register-manage-tickets.png', MOBILE_VIEWPORT, '.reg-people'],
  ].map(([out, viewport, anchorSelector]) => ({
    path: '/en/register/931', out, backend: 'd1', sessionIdentity: DAVID, ...(viewport ? { viewport } : {}), ...(anchorSelector ? { anchorSelector, anchorMargin: 40 } : {}),
    finalPath: '/en/register/manage', expectedText: 'Ticket type',
    interact: [
      { wait: '[data-household]:not([hidden])' },
      { click: '[data-chip][data-name="Mia Chen"]' },
      { click: 'input[name="ticket_0"][value="1"]' },
      { click: 'input[name="ticket_1"][value="2"]' },
      { click: 'input[name="924"][value="yes"]' },
      { fill: { 'input[name="925"]': '1', 'select[name="pq_0_926"]': 'm', 'select[name="pq_1_926"]': 's', 'input[name="pq_0_928"]': 'Dave' } },
      { click: 'input[name="930"]' },
      { submit: '[data-register-form]' },
      { submit: 'form[action="/api/register/submit"]' },
      { wait: '[data-confirmation]' },
    ],
  })),
  { path: '/admin/registration?edit=920', out: 'docs/images/registration/admin-editor-party.png', admin: true, backend: 'd1', anchorSelector: 'input[name="max_party_size"]', anchorMargin: 120, expectedText: 'Max people per registration' },
  // Registration form builder (Phase 3). These rows need a sample event with several questions (one with a
  // show-if condition, per-person ones with options), ticket types and two templates. Build them on a throwaway
  // persist dir by posting to the real endpoints (see the Phase 3 plan): create "Family Camp Weekend", save its
  // form with the builder's JSON POST, then "Save as template" on it and on the seeded potluck. The event id is
  // 931 on a freshly seeded D1; the rows use #reg-form-heading so they follow the page, not the id.
  { path: '/admin/registration/931', out: 'docs/images/registration/builder-questions.png', admin: true, backend: 'd1', anchorSelector: '[data-testid="reg-form-builder"] ol > li:nth-child(2)', anchorMargin: 24, waitForSelector: '[data-testid="reg-form-builder"] ol > li', expectedText: 'Registration form',
    interact: [{ click: '[data-testid="reg-form-builder"] ol > li:nth-child(3) button[aria-expanded]' }] },
  { path: '/admin/registration/931', out: 'docs/images/registration/builder-options.png', admin: true, backend: 'd1', anchorSelector: '[data-testid="reg-form-builder"] ol > li:nth-child(4)', anchorMargin: 24, waitForSelector: '[data-testid="reg-form-builder"] ol > li', expectedText: 'T-shirt size',
    interact: [{ click: '[data-testid="reg-form-builder"] ol > li:nth-child(4) button[aria-expanded]' }] },
  { path: '/admin/registration/931', out: 'docs/images/registration/builder-tickets.png', admin: true, backend: 'd1', anchor: 'Ticket types', anchorMargin: 24, waitForSelector: '[data-testid="ticket-card"]', expectedText: 'Ticket types' },
  // Registration back office (Phase 4). These rows need an approval event on a throwaway persist dir (a free camp
  // with a registration question, per-person questions, two ticket types, a few registrations in review / waitlist /
  // confirmed, a staff note, a decision, a queued bulk email and two per-event roles), built by posting to the real
  // endpoints. The event is 931 on a freshly seeded D1; registration 1 is in review, registration 2 has history.
  { path: '/admin/registration/931', out: 'docs/images/registration/backoffice-overview.png', admin: true, backend: 'd1', anchorSelector: '[data-testid="reg-overview"]', anchorMargin: 16, expectedText: 'Youth Summer Camp' },
  { path: '/admin/registration/931?status=review', out: 'docs/images/registration/backoffice-roster.png', admin: true, backend: 'd1', anchorSelector: '#roster', anchorMargin: 16, expectedText: 'Youth Summer Camp' },
  { path: '/admin/registration/931?reg=2', out: 'docs/images/registration/backoffice-drawer.png', admin: true, backend: 'd1', anchorSelector: '#reg-drawer', anchorMargin: 16, expectedText: 'Daniel Reyes' },
  { path: '/admin/registration/931?reg=2', out: 'docs/images/registration/backoffice-history.png', admin: true, backend: 'd1', anchorSelector: '[data-testid="reg-history"]', anchorMargin: 24, expectedText: 'Daniel Reyes' },
  { path: '/admin/registration/931?reg=1', out: 'docs/images/registration/backoffice-approval.png', admin: true, backend: 'd1', anchorSelector: '#reg-drawer', anchorMargin: 16, expectedText: 'Maya Okafor' },
  { path: '/admin/registration/931?reg=1', out: 'docs/images/registration/backoffice-drawer-mobile.png', admin: true, backend: 'd1', viewport: MOBILE_VIEWPORT, anchorSelector: '#reg-drawer', anchorMargin: 8, expectedText: 'Maya Okafor' },
  { path: '/admin/registration/931?tab=add', out: 'docs/images/registration/backoffice-manual-add.png', admin: true, backend: 'd1', anchorSelector: '#add', anchorMargin: 16, expectedText: 'Add a registration by hand' },
  { path: '/admin/registration/931?tab=email', out: 'docs/images/registration/backoffice-bulk-email.png', admin: true, backend: 'd1', anchorSelector: '#email', anchorMargin: 16, expectedText: 'Email the registrants',
    interact: [{ fill: { 'input[name="subject"]': 'Packing list for camp', 'textarea[name="body"]': 'Hi {name}, here is what to bring to {event}: a sleeping bag, a warm jacket and a water bottle.' } }] },
  { path: '/admin/registration/931/badges', out: 'docs/images/registration/backoffice-badges.png', admin: true, backend: 'd1', expectedText: 'Youth Summer Camp', waitForSelector: '[data-badge]' },
  { path: '/admin/registration/931?people=sarah', out: 'docs/images/registration/backoffice-access.png', admin: true, backend: 'd1', anchorSelector: '#access', anchorMargin: 16, expectedText: 'Access to this event' },
  { path: '/admin/registration?edit=931', out: 'docs/images/registration/backoffice-settings.png', admin: true, backend: 'd1', anchorSelector: '[data-testid="back-office-settings"]', anchorMargin: 120, expectedText: 'Requires approval' },
  { path: '/admin/registration', out: 'docs/images/registration/admin-templates.png', admin: true, backend: 'd1', anchorSelector: '#reg-templates', anchorMargin: 24, expectedText: 'Save as template' },
  // Page-builder registration block (Phase 3). Needs a page with the block on a throwaway database: save a page
  // (slug "gatherings") through the builder's JSON POST with three registration blocks in columns (events 920, 930,
  // 931). The builder row opens that page by its id and selects the first block so the properties panel shows.
  { path: '/en/p/gatherings', out: 'docs/images/public/page-builder-registration.png', backend: 'd1', expectedText: 'Join us this season' },
  { path: '/admin/pages/builder/20b5038d-5321-41ef-8b28-74ffb462bbe1', out: 'docs/images/admin/page-builder-registration.png', admin: true, sessionIdentity: Object.freeze({ personId: 1, email: 'admin@example.com', sessionEpoch: 0 }), identityExpectedText: 'admin@example.com', backend: 'd1', anchorSelector: '.builder-canvas-panel', anchorMargin: 24, waitForSelector: '[data-testid="builder-registration"]', expectedText: 'Registration',
    interact: [{ click: '[data-testid="builder-registration"]' }] },
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
  readmeShot('/en/my', 'portal/dashboard.png', 'Welcome, David Chen', { actor: 'david', backend: 'supabase', requiredTexts: ['Chen Family'] }),
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

// Project brand artwork shown in the README. Maintained by hand in docs/images/brand/,
// never captured from a page.
export const README_BRAND_IMAGES = Object.freeze([
  'docs/images/brand/church4christ-logo.png',
]);

// Phone captures (375x812 at 2x, mobile emulation) for the children's check-in and
// volunteer scheduling work. Each row carries MOBILE_VIEWPORT, which also turns on the
// horizontal-overflow check in capture(). Output lives in docs/images/mobile/. Two passes:
//   admin pass  (AUTH_DEV_BYPASS_EMAIL=admin@example.com):
//     --only mobile/kiosk-search.png,mobile/kiosk-code.png,mobile/children-today.png
//   sarah pass  (AUTH_DEV_BYPASS_EMAIL=sarah.johnson@example.com):
//     --only mobile/serve-matrix.png,mobile/my-calendar.png,mobile/my-blockouts.png,mobile/planning-run-sheet.png
// kiosk-code performs the real check-in that children-today then lists, so keep that order.
export const MOBILE_CAPTURE_ROWS = Object.freeze([
  { path: '/kiosk/devkiosk1234567890abcdef12345678/?lang=en&q=Chen', out: 'docs/images/mobile/kiosk-search.png', viewport: MOBILE_VIEWPORT },
  {
    path: '/kiosk/devkiosk1234567890abcdef12345678/household/1?lang=en&q=Chen',
    out: 'docs/images/mobile/kiosk-code.png',
    viewport: MOBILE_VIEWPORT,
    postForm: { checkAll: 'input[name="member"]', form: 'form[method="post"]' },
  },
  { path: '/admin/children?tab=today', out: 'docs/images/mobile/children-today.png', admin: true, viewport: MOBILE_VIEWPORT, expectedText: 'Child' },
  { path: '/en/serve/matrix/1', out: 'docs/images/mobile/serve-matrix.png', anchor: 'day, ', anchorMargin: 20, bypass: 'sarah.johnson@example.com', viewport: MOBILE_VIEWPORT, expectedText: 'Sunday Worship (English)' },
  { path: '/en/my/calendar', out: 'docs/images/mobile/my-calendar.png', anchor: 'This month', anchorMargin: 60, bypass: 'sarah.johnson@example.com', viewport: MOBILE_VIEWPORT, expectedText: 'Calendar' },
  { path: '/en/my/blockouts', out: 'docs/images/mobile/my-blockouts.png', anchor: 'Add a blockout', anchorMargin: 20, bypass: 'sarah.johnson@example.com', viewport: MOBILE_VIEWPORT, expectedText: 'Add' },
  // Event Registration on D1 at phone width (public pages, no session).
  { path: '/en/register', out: 'docs/images/mobile/register-list.png', viewport: MOBILE_VIEWPORT, backend: 'd1', expectedText: 'Neighbors Potluck Night' },
  { path: '/en/register/920', out: 'docs/images/mobile/register-detail.png', viewport: MOBILE_VIEWPORT, anchor: 'Your registration', anchorMargin: 20, backend: 'd1', expectedText: 'What will you bring?' },
  { path: '/en/p/gatherings', out: 'docs/images/mobile/page-builder-registration.png', viewport: MOBILE_VIEWPORT, backend: 'd1', expectedText: 'Join us this season' },
  // Seeded Christmas Service run sheet (planning_events id 31000 in seed/dev-seed.sql); Sarah coordinates it.
  { path: '/en/planning/31000', out: 'docs/images/mobile/planning-run-sheet.png', bypass: 'sarah.johnson@example.com', viewport: MOBILE_VIEWPORT, expectedText: 'Christmas Service' },
]);

export const CAPTURE_ROWS = Object.freeze([
  ...LEGACY_CAPTURE_ROWS.map((row) => README_CAPTURE_ROWS.find((readme) => readme.out === row.out) ?? row),
  ...README_CAPTURE_ROWS.filter((row) => !LEGACY_CAPTURE_ROWS.some((legacy) => legacy.out === row.out)),
  ...MOBILE_CAPTURE_ROWS,
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
  const viewport = viewportOf(row);
  return { x: 0, y: Math.max(0, anchorY - (row.anchorMargin ?? 40)), width: viewport.width, height: viewport.height, scale: 1 };
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
    const viewport = viewportOf(row);
    await send('Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor ?? 1, mobile: viewport.mobile === true }, sessionId);

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

    // Scripted steps (see `interact` above): real clicks, fills and form submissions.
    // A dev server can reload the page under the script (its file watcher sees local database
    // writes), so every target is awaited briefly before it is used.
    const exists = async (selector) => {
      for (let i = 0; i < 50; i++) {
        const { result } = await send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(selector)})`, returnByValue: true,
        }, sessionId);
        if (result.value === true) return true;
        await sleep(100);
      }
      return false;
    };
    for (const step of row.interact ?? []) {
      if (step.click) await exists(step.click);
      if (step.fill) for (const selector of Object.keys(step.fill)) await exists(selector);
      if (step.submit) await exists(step.submit);
      if (step.click) {
        const { result } = await send('Runtime.evaluate', {
          expression: `(()=>{const el=document.querySelector(${JSON.stringify(step.click)});if(!el)return false;el.click();return true;})()`,
          returnByValue: true,
        }, sessionId);
        if (result.value !== true) throw new Error(`${row.out}: interact click target ${JSON.stringify(step.click)} was not found`);
      } else if (step.fill) {
        for (const [selector, value] of Object.entries(step.fill)) {
          const { result } = await send('Runtime.evaluate', {
            expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
            returnByValue: true,
          }, sessionId);
          if (result.value !== true) throw new Error(`${row.out}: interact fill target ${JSON.stringify(selector)} was not found`);
        }
      } else if (step.submit) {
        const navigated = onceEvent('Page.loadEventFired', sessionId, 20000).catch(() => {});
        const { result } = await send('Runtime.evaluate', {
          expression: `(()=>{const f=document.querySelector(${JSON.stringify(step.submit)});if(!(f instanceof HTMLFormElement))return false;f.requestSubmit();return true;})()`,
          returnByValue: true,
        }, sessionId);
        if (result.value !== true) throw new Error(`${row.out}: interact form ${JSON.stringify(step.submit)} was not found`);
        await navigated;
      } else if (step.wait) {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          const { result } = await send('Runtime.evaluate', {
            expression: `!!document.querySelector(${JSON.stringify(step.wait)})`, returnByValue: true,
          }, sessionId);
          if (result.value === true) { ready = true; break; }
          await sleep(100);
        }
        if (!ready) throw new Error(`${row.out}: interact wait target ${JSON.stringify(step.wait)} never appeared`);
      }
      await sleep(150);
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
    if (row.anchorSelector) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(()=>{const el=document.querySelector(${JSON.stringify(row.anchorSelector)});return el?Math.round(el.getBoundingClientRect().top+window.scrollY):-1;})()`,
        returnByValue: true,
      }, sessionId);
      clip = screenshotClip({ ...row, anchor: row.anchorSelector }, result.value);
    } else if (row.anchor) {
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
    assertExpectedScreenshotPage(row.finalPath ? { ...row, path: row.finalPath } : row, pageState.value);

    // Decode local media in the actual capture region, including lazy images
    // below the live viewport in an anchored shot. External video thumbnails
    // may remain pending; the product's packaged poster is already visible.
    const { result: mediaState } = await send('Runtime.evaluate', {
      expression: `(async()=>{const top=${clip?.y ?? 0};const bottom=top+${viewportOf(row).height};const images=[...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.width>0&&r.height>0&&r.top+scrollY<bottom&&r.bottom+scrollY>top&&new URL(img.currentSrc||img.src,location.href).origin===location.origin;});const ready=Promise.all(images.map(async img=>{img.loading='eager';await img.decode();})).then(()=>true);return Promise.race([ready,new Promise(resolve=>setTimeout(()=>resolve(false),10000))]);})()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (mediaState.value !== true) throw new Error(`${row.out}: local capture media did not decode`);

    // Phone rows must not scroll sideways: fail loudly instead of shipping a clipped shot.
    if (row.viewport?.mobile === true) {
      const { result: overflow } = await send('Runtime.evaluate', {
        expression: `(()=>{const iw=innerWidth;let widest='';let max=0;for(const e of document.querySelectorAll('body *')){const r=e.getBoundingClientRect();if(r.width>0&&r.right>max&&getComputedStyle(e).position!=='fixed'){max=r.right;widest=e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\\s+/)[0]:'');}}return {scrollWidth:document.documentElement.scrollWidth,innerWidth:iw,widest};})()`,
        returnByValue: true,
      }, sessionId);
      assertNoHorizontalOverflow(row, overflow.value);
    }

    const format = screenshotFormat(row.out);
    const { data } = await send('Page.captureScreenshot',
      { format, ...(format === 'jpeg' ? { quality: 90 } : {}), ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId);
    const buf = Buffer.from(data, 'base64');

    const { width, height } = screenshotImageDimensions(buf, format);
    const expected = expectedImageSize(row);
    if (width !== expected.width || height !== expected.height) {
      throw new Error(`${row.out}: expected ${expected.width}x${expected.height}, got ${width}x${height}`);
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
  console.log(`\nAll ${pages.length} captures passed (1280x800 desktop or 375x812 phone at 2x, >20KB).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
