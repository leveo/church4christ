# Church4Christ — Open-Source Church CMS Design Spec

**Date:** 2026-07-05 · **Author:** Fable (planning/design) · **Status:** Approved for execution

## 1. Vision

A production-quality, open-source demonstration of a complete church website + CMS +
volunteer-management platform on the Cloudflare stack (Workers, D1, R2). It merges the
features of three private reference apps — `dcfc-website` (Chinese public site + CMS),
`dcfc-website-english` (English fork), and `dcfc-serve` (volunteer scheduler) — into
**one repo, one Worker, one D1 database, one R2 bucket**, correcting the reference
architecture's two biggest costs:

1. **Per-language repo forks** → real i18n in a single app (locale-prefixed routes,
   translation tables, dictionary parity tests). ~50% of the reference `src/lib` was
   duplicated across the two site repos differing only in strings.
2. **Duplicated people/teams/roster tables** between website and serve app → one shared
   schema; the public bulletin's "serving this Sunday" renders from the same roster the
   volunteer module schedules.

All branding, contact info, and content are **fictional** (see §11). Example deployment
domain: `church.yunfei-song.com`.

**Non-goals:** Planning Center API sync (keep external-id columns only), SMS/push
notifications, WordPress import tooling, legacy redirects, payments (giving = external link).

## 2. Feature inventory (parity map)

| Feature | Source | Disposition |
|---|---|---|
| Home: hero, news ticker, event cards, service times, prayer form | website | keep, redesign |
| Evergreen pages (visit / about / beliefs / resources / privacy) | both sites | content collections, per-locale |
| Staff directory + bio pages | both sites | content collection, fictional people |
| Pastor's articles archive | website (52 md) | keep as `articles` collection (6 fictional samples) |
| Fellowships directory + detail | website | keep, content collection |
| Sermons by year/month, YouTube facade embeds | both sites | keep; facade falls back to styled placeholder on missing thumb |
| Weekly bulletins (program, announcements, offering, attendance, memory verse, flowers, service time) | website+english (diverged) | **unified superset**, tied to service type not locale |
| Prayer sheets | website (zh-only) | keep, optional per-locale |
| Homepage announcements (ticker) with date windowing | both sites | keep + i18n table |
| Event cards with R2 image + external registration URL | both sites | keep + i18n table |
| Public prayer-request form (honeypot) → admin kanban prayer wall | both sites | keep |
| Admin CMS: bulletins/sermons/prayer-sheets/announcements/events, repeat-row forms, draft/publish, `publish_at` | website | keep |
| Revisions (full-row snapshot + restore) | website | keep |
| R2 media upload (content-addressed, type allowlist, 10MB, SVG banned) + `/media` proxy | website | keep |
| Nightly D1 → R2 backup cron | website | keep, flag-gated on `D1_EXPORT_TOKEN` |
| 繁简 client-side conversion toggle | website (t2s) | keep, **s2t** direction (base zh-Hans), generated table |
| Ministries directory (bilingual, icons, leaders, open-role badges) | serve | keep (DB + i18n table) |
| Teams / positions / membership / leaders | serve | keep |
| Plans (dated services), needs, open-signup slots | serve | keep |
| Plan generation (weekly, copies needs forward, ≤370d) | serve | keep |
| Matrix view (plans × positions inline assign) | serve | keep |
| Assignment flow: leader assign (U) → email respond link → C/D; conflicts warn + force | serve | keep |
| Volunteer open-slot self-claim (→C) | serve | keep |
| Decline → notify team leaders (replacement flow) | serve | keep |
| Blockout dates (ranges, partial-day, recurring) | serve | keep |
| My Schedule / month calendar / iCal feed (`webcal`) | serve | keep |
| Team applications (apply-to-serve, P/A/R, magic link for guests) | serve | keep |
| Spiritual-gifts quiz (40 Q, 9 gifts) → interests → potential-volunteer recruiting | serve | keep, bilingual question bank |
| Testimonies (submit → review → publish) | serve | keep, per-locale rows |
| Email: magic link, scheduling request, decline notice, application result, remind 7/3d cron, weekly digest cron; rules + editable templates + send log | serve | keep (Cloudflare Email Service binding, `EMAIL_DEV_LOG` dev fallback) |
| Admin console: overview / needs-attention / applications / ministries / new-ministry wizard / email tab / availability matrix | serve | keep |
| Serving report + CSV export (formula-injection-safe) | serve | keep |
| Magic-link auth, JWT session, session_epoch revocation, CSRF origin check, security headers | serve | keep — **this is the unified auth for everything, replacing Cloudflare Access** |
| Site settings (name, contact, socials, theme, giving URL) | — (was hardcoded PII) | **new**: `settings` table + admin page |
| Multi-theme design system | — (both sites hardcoded) | **new**: token-file-driven, 3 themes × light/dark (§9) |

Reference gaps we do NOT fill (documented in README roadmap): check-in/attendance,
swap marketplace, DB-template-driven cron emails.

## 3. Architecture

- **Astro ^7** `output: 'server'` (all SSR; personalization in header) + **@astrojs/cloudflare ^14**.
- Custom worker entry `src/worker.ts`: `{ fetch: handle, scheduled }` — cron dispatch by pattern.
- **One D1** (`DB`), **one R2** (`MEDIA`), static assets binding. **Email**: `send_email` binding (`EMAIL`).
- No client framework. Progressive enhancement islands (vanilla JS in Astro scripts) for:
  repeat-row editor, kanban drag-drop, menu/dropdown a11y, zh conversion toggle, wizard stepper,
  double-submit guard. Every interactive flow must work without JS (form POST fallback).
- Server-rendered forms: POST → validate → save → 303; errors re-render with echoed values.
- `src/` layout:
  - `lib/` — pure/testable core: `db.ts`, `adminDb.ts`, `planDb.ts`, `ministryDb.ts`, `auth.ts`,
    `session.ts`, `routePolicy.ts`, `validate.ts`, `upload.ts`, `email.ts`, `notify.ts`, `digest.ts`,
    `ical.ts`, `backup.ts`, `youtube.ts`, `dates.ts`, `i18n.ts`, `locales.ts`, `settings.ts`,
    `giftQuiz.ts`, `s2t.ts` (+generated table), `revisions.ts`
  - `pages/` — routes (§6); `components/`; `layouts/Base.astro` + `layouts/Admin.astro`
  - `content/` — collections: `pages`, `articles`, `fellowships`, `staff` (each with `en/` + `zh/`)
  - `i18n/` — `en.ts`, `zh.ts` dictionaries (identical key sets, unit-tested)
  - `styles/` — `base.css` (+ `tokens.generated.css`, gitignored)
- `design/` — foundation + themes (already authored); `scripts/build-tokens.mjs`, `scripts/check-tokens.mjs`, `scripts/generate-s2t.mjs`
- Version pins (proven set from references): astro ^7.0.5, @astrojs/cloudflare ^14.1.0,
  jose ^6.2.3, tailwindcss ^4.3.2 + @tailwindcss/vite, typescript ^6, vitest ^4.1 +
  @cloudflare/vitest-pool-workers ^0.17, wrangler ^4.106, @astrojs/check ^0.9.9, Node 22.

## 4. Auth & security (unified, from dcfc-serve)

- **Passwordless magic link for everyone** (members, editors, admins). No Cloudflare Access
  dependency (README documents how to optionally layer Access in front of `/admin`).
- `tokens` table stores **sha256 hash only**; login TTL 15 min, respond TTL 14 days;
  rate limit 3 login requests / 15 min / email; anti-enumeration (always "sent").
- Two-step consume: GET peeks (mail-scanner safe), POST atomically consumes
  (`UPDATE … RETURNING` where unused) and mints session.
- Session: jose HS256 JWT in `c4c_session` HttpOnly cookie, SameSite=Lax, Secure in prod,
  30d; claims `sub`, `email`, `ep` (session_epoch). Middleware reloads person each request:
  `active=0` immediate lockout; `/signout` bumps epoch (revokes all devices).
- Roles: `people.role` ∈ `member|editor|admin` (site CMS role) + team leadership via
  `team_members.is_leader`. Route policy (dependency-free, unit-tested):
  - public: home, content pages, sermons, bulletins, prayer sheets, events, ministries,
    gifts quiz, testimonies, apply, signin, auth/respond tokens, cal feed, media, api/prayer-request
  - authed: `/my/*`, `/profile`, claim/respond actions
  - member/leader: `/serve/plans*`, `/serve/matrix*`, `/serve/teams*`
  - editor∪admin∪leader: `/admin` console (leader sees scoped tabs)
  - editor∪admin: CMS content sections; admin-only: people, service-types, users/roles,
    settings, reports
  - unknown-path fallback is namespace-scoped (public site ≠ internal tool): unknown
    under /admin → adminOnly, under /my|/profile|/settings → authed, under /serve →
    team; everywhere else → public (falls through to a natural 404 rather than a
    signin redirect)
- CSRF: Origin (fallback Sec-Fetch-Site) check on non-GET → 403. Honeypots on public forms.
- Headers on non-asset responses: `x-content-type-options: nosniff`, `x-frame-options: DENY`,
  `referrer-policy: strict-origin-when-cross-origin`; `cache-control: no-store` when session attached.
- Dev conveniences (compiled out of prod builds, guarded by `import.meta.env.DEV`):
  `AUTH_DEV_BYPASS_EMAIL`, `EMAIL_DEV_LOG=1`.

## 5. Database schema (D1, migration 0001 + 0002)

Conventions: INTEGER PK rowids; TEXT dates `YYYY-MM-DD`; `datetime('now')` defaults;
soft delete `deleted_at` unless noted; status vocab — assignments `U/C/D`,
review flows `P/A/R`, content `draft/published`.

**i18n pattern:** translatable entities get `<entity>_i18n (entity_id, locale, …fields,
PRIMARY KEY(entity_id, locale))`. Reads: LEFT JOIN requested locale + LEFT JOIN default
locale (`en`), `COALESCE` per field. One helper builds these joins; no per-locale columns
anywhere (N-locale by inserting rows).

**0001_init.sql**

Identity & volunteer core (per dcfc-serve, with role superset):
- `people(id, first_name, last_name, display_name, email UNIQUE lowercased, phone,
  avatar_url, role CHECK(member|editor|admin) DEFAULT member, active DEFAULT 1,
  session_epoch DEFAULT 0, calendar_token UNIQUE, lang, created_at, updated_at, deleted_at)`
- `ministries(id, slug UNIQUE, category, icon, cover_key, leader_person_id→people,
  meeting_time, active, sort, deleted_at)` + `ministry_i18n(name, intro)`
- `teams(id, ministry_id→ministries, sort, deleted_at)` + `team_i18n(name)`
- `positions(id, team_id→teams, sort, deleted_at)` + `position_i18n(name)`
- `team_members(team_id, person_id, is_leader, UNIQUE(team_id, person_id))`
- `service_types(id, start_time, end_time, sort, deleted_at)` + `service_type_i18n(name)`
- `plans(id, service_type_id, plan_date, title, series, UNIQUE(service_type_id, plan_date), deleted_at)`
- `plan_positions(plan_id, position_id, needed, open_signup, UNIQUE(plan_id, position_id))`
- `roster_assignments(plan_id, position_id, person_id, status U/C/D, decline_reason,
  is_signup, assigned_by, notified_at, responded_at, deleted_at,
  UNIQUE(plan_id, position_id, person_id))`
- `blockout_dates(person_id, start_date, end_date, start_time, end_time, reason,
  recurrence_group)` — hard delete
- `team_applications(person_id, team_id, position_id?, message, status P/A/R,
  decided_by, decided_at, created_at)` + partial unique index (one pending per person+team)
- `person_interests(person_id, category, UNIQUE)`
- `gift_results(person_id, top_gifts_json, recommended_json, created_at)`
- `testimonies(id, person_id?, author_name, locale, title, body, category,
  status P/A/R, published_at, created_at, deleted_at)`
- `tokens(id, token_hash UNIQUE, person_id, purpose login|respond, assignment_id?,
  expires_at, used_at, created_at)`

Content (per dcfc-website superset; bulletins/sermons tied to **service type**, not locale):
- `bulletins(id, service_type_id, bulletin_date, service_time_label, program_json,
  offering_json, attendance_json, memory_verse, flowers, status, publish_at,
  updated_by, updated_at, deleted_at, UNIQUE(service_type_id, bulletin_date))`
- `bulletin_announcements(bulletin_id, seq, title, body, link_url, link_label)`
- `sermons(id, service_type_id, sermon_date, title, speaker, scripture, youtube_id,
  series, status, deleted_at, UNIQUE(service_type_id, sermon_date))`
- `prayer_sheets(id, sheet_date UNIQUE, locale, sections_json, status, publish_at,
  updated_by, updated_at, deleted_at)`
- `announcements(id, url, sort, active, starts_at, ends_at)` + `announcement_i18n(title)` — hard delete
- `events(id, image_key, url, sort, active, starts_at, ends_at)` + `event_i18n(title, blurb)` — hard delete
- `prayer_requests(id, name, email, message, status CHECK(new|praying|long_term|waiting|answered|cancelled) DEFAULT new, created_at)`
- `prayer_activity(request_id, author, kind CHECK(prayed|comment|moved), body, created_at)`
- `revisions(entity, entity_id, snapshot_json, edited_by, edited_at)` — entities:
  bulletin, sermon, prayer_sheet, announcement, event
- `media(r2_key UNIQUE, filename, content_type, size, uploaded_by, uploaded_at)`
- `settings(key TEXT PRIMARY KEY, value TEXT)` — namespaced keys:
  `site.name.<locale>`, `site.tagline.<locale>`, `site.address`, `site.email`, `site.phone`,
  `site.map_url`, `site.giving_url`, `site.youtube_url`, `site.facebook_url`,
  `site.service_times.<locale>`, `theme.name`, `theme.default_mode`, `locale.default`
- `external_ids(entity, entity_id, system, external_id)` — future-proofing stub

**0002_email.sql**
- `email_rules(rule_key PK, enabled)` seeds remind7=1, remind3=0, digestAM=1
- `email_templates(template_key PK, locale, subject, body)` seeds en+zh for
  remind / request / appResult / digestAM
- `email_log(id, to_email, to_name, kind, detail, status CHECK(sent|delivered|opened|bounced|failed|devlog), created_at)`

Indexes mirror the references (dates, per-plan, per-service, revisions, statuses).

## 6. Route map

Locale scheme: `en` (default), `zh` (Simplified base; client-side 简→繁 toggle).
`/` → 302 to best `Accept-Language` match. All public + volunteer pages under
`/{locale}/…`; `hreflang` alternates in `<head>`; switcher preserves path.
Admin under `/admin` (not locale-prefixed; UI language via dictionary + user pref).

**Public** (`/{locale}/…`): `/` home · `/visit` · `/about` · `/about/beliefs` ·
`/about/staff` + `/about/staff/[slug]` · `/articles` + `/articles/[slug]` ·
`/fellowships` + `/fellowships/[slug]` · `/ministries` + `/ministries/[slug]` ·
`/events` · `/sermons` + `/sermons/[year]` · `/bulletin` + `/bulletin/[date]` ·
`/prayer` + `/prayer/[date]` · `/give` · `/privacy` · `/404`

**Volunteer** (`/{locale}/serve/…` unless noted): `/serve` landing ·
`/serve/gifts` quiz · `/serve/apply` · `/serve/testimonies` · `/serve/plans` +
`/serve/plans/[id]` · `/serve/matrix` + `/serve/matrix/[serviceTypeId]` ·
`/serve/teams` + `/serve/teams/[id]` · `/{locale}/my` + `/my/calendar` + `/my/blockouts` ·
`/{locale}/profile` + `/profile/[id]` · `/{locale}/signin`

**Locale-free utility:** `/auth/[token]` · `/respond/[token]` · `/signout` (POST) ·
`/lang` (POST) · `/cal/[token].ics` · `/media/[...key]` · `/api/prayer-request` (POST)

**Admin:** `/admin` dashboard (overview, needs-attention, quick links) ·
`/admin/bulletins(+/[id])` · `/admin/sermons(+/[id])` · `/admin/prayer-sheets(+/[id])` ·
`/admin/announcements` · `/admin/events` · `/admin/prayer-wall` ·
`/admin/people(+/[id])` · `/admin/teams` · `/admin/ministries` (tabs incl. new-ministry
wizard, applications, email, availability) · `/admin/service-types` · `/admin/reports`
(+`.csv`) · `/admin/settings` · `/admin/revisions/[entity]/[id]`

## 7. i18n implementation

- `src/lib/locales.ts`: `LOCALES = ['en','zh']`, `DEFAULT_LOCALE='en'`, helpers
  `parseLocale`, `localePath(locale, path)`, `alternateLinks`.
- Dictionaries `src/i18n/{en,zh}.ts`: flat keys, `t(locale, key, vars)` with `{var}`
  interpolation + HTML escaping. Unit tests: identical key sets, identical placeholders,
  non-empty values (per dcfc-serve `i18n.test.ts`).
- DB content via `_i18n` join+COALESCE helper (§5). Admin edit forms show one field
  group per locale side-by-side.
- Content collections: `src/content/<coll>/{en,zh}/slug.md`; loader filters by locale
  prefix; missing translation → fall back to default locale entry, badge "not translated".
- zh-Hans → zh-Hant client toggle: `scripts/generate-s2t.mjs` builds table from OpenCC
  data (dev-dependency), lazy-loaded only when toggled; TreeWalker conversion incl.
  title/alt/placeholder/aria-label; skips `[data-no-convert]`; preference in localStorage.
- CJK typography: `body:lang(zh)` gets `line-height: var(--leading-cjk)`; font stacks
  already carry CJK fallbacks (design tokens).
- Emails: bilingual stack or single language via `people.lang` (dcfc-serve pattern).

## 8. Email / cron / calendar

- `lib/email.ts` single choke point: `env.EMAIL.send` (Cloudflare Email Service);
  `EMAIL_DEV_LOG=1` → console + `email_log(status='devlog')`. All sends best-effort
  (failures never break the user action). Vars HTML-escaped.
- Touchpoints: magic link, scheduling request (respond link), decline notice → leaders,
  application received → leaders, application result → applicant, remind 7/3d (cron),
  weekly digest (cron).
- Crons (wrangler triggers): `0 13 * * *` reminders · `0 14 * * 4` digest ·
  `0 9 * * *` D1→R2 backup (skips gracefully without `D1_EXPORT_TOKEN`).
- iCal: `/cal/[token].ics` RFC 5545, per-person token, timed events when service has
  start/end else all-day; `webcal://` subscribe link on `/my/calendar`.

## 9. Design system (token-file-driven theming)

Already authored: `design/foundation.json` (type scale, containers, z, motion) and
`design/themes/{sanctuary,harvest,midnight}.json` (fonts+fontsource pkg, radius, shadow,
full semantic palette × light+dark). Default theme **sanctuary**; midnight is dark-first.

- `scripts/build-tokens.mjs` → `src/styles/tokens.generated.css` (gitignored; `npm run tokens`
  runs before dev/build): emits `:root[data-theme=X]` + `[data-theme=X][data-mode=dark]`
  custom-property blocks, foundation vars, and **fails the build if any WCAG pair
  (ink/surface, on-primary/primary, on-accent/accent, feedback pairs) < 4.5:1**.
- `src/styles/base.css`: `@import "tailwindcss"` + `@theme inline` mapping Tailwind color/
  font/radius/shadow utilities onto the CSS vars → components use `bg-primary`,
  `text-ink-muted`, `rounded-md`, `shadow-md`, `font-display` only.
- `<html data-theme data-mode lang>` set server-side from `settings.theme.name` +
  cookie/localStorage mode override; tiny inline script prevents dark-mode flash;
  user-facing mode toggle in footer; admin theme picker in `/admin/settings` (live
  switch = 1 DB row, zero rebuild).
- Fonts self-hosted via `@fontsource-variable/*`; only the active theme's families are
  requested by the browser (unused `@font-face` declarations don't download).
- **Enforcement:** `scripts/check-tokens.mjs` fails CI on raw hex/rgb()/hsl()/font-family
  literals in `src/` (allowlist: tokens.generated.css, og-image gen). No hardcoded colors,
  fonts, radii, or shadows in any component — semantic utilities only.
- Component look: generous whitespace, `container-content` max-width, cards on
  `surface-raised` with `border`+`shadow-sm`, pill CTAs, `header-bg/ink` +
  `footer-bg/ink` tokens so themes can restyle chrome, hero images under `scrim`
  gradient for text contrast.

## 10. Media & uploads

R2 keys `uploads/<sha256-16>-<sanitized-name>`; allowlist jpeg/png/webp/gif (no SVG),
10 MB cap; registered in `media`; served only via `/media/[...key]` (`uploads/` prefix
only, inline allowlist, nosniff, 1y immutable). Backups under `backups/` unreachable
from the proxy. Seed images live in `public/images/` as **original SVG placeholder art**
(hero scenes, ministry covers, avatar initials) — fully MIT-licensable, no hotlinks,
no stock-photo license ambiguity; README documents swapping in real photography.

## 11. Fictional content profile (no real PII)

- EN name **Church4Christ**, ZH name **四方基督教会**; tagline "A church for the city ·
  城市中的教会". Domain example `church.yunfei-song.com`; contact
  `hello@church.yunfei-song.com`, `(555) 010-4444`, "123 Grace Avenue, Springfield, TX 75000".
- People (all fictional, SVG avatars): Senior Pastor David Chen 陈大卫牧师; English Pastor
  Sarah Johnson; Assistant Pastor 林恩慈传道 (Pastor Grace Lin); Elders 王信实 Faithful Wang,
  Mark Liu 刘马可; Deacons/staff ×4; ~10 volunteers with `@example.com` emails.
- Ministries (10): Worship 敬拜 · Children 儿童 · Youth 青少年 · College 大学事工 ·
  Family 家庭 · Seniors 乐龄 · Missions 宣教 · Care 关怀 · Hospitality 招待 · AV/Tech 媒体技术.
- Fellowships (5): Young Professionals 职青团契 · Family 家庭团契 · Seniors 长者团契 ·
  Campus 学生团契 · English Young Adults.
- Sermon series: "Sermon on the Mount 登山宝训", "Psalms of Ascent 上行之诗"; dummy
  `youtube_id`s; embed facade falls back to placeholder art.
- Seed: 2 service types (Sunday Worship EN 9:30 / 中文主日崇拜 11:00), 8 weeks of plans,
  3 teams + 8 positions, roster with U/C/D examples, blockouts, 3 applications,
  4 testimonies (2 locales), 2 published + 1 draft bulletin per service type, 10 sermons,
  2 prayer sheets, 4 announcements + 3 events (both locales), prayer requests across
  kanban columns, gift results, full settings rows, admin `admin@example.com` +
  `AUTH_DEV_BYPASS_EMAIL` preset in `.dev.vars.example`.

## 12. Testing & CI

- Unit (vitest-pool-workers + `readD1Migrations`): validate, adminDb, planDb (generation/
  conflicts/claims/responds), ministryDb, auth (hash-only tokens, two-step, rate limit),
  session (epoch), routePolicy, i18n parity, upload, youtube, dates, digest, giftQuiz,
  settings, s2t.
- E2E (built worker, `SELF.fetch`): locale redirect, home renders both locales, security
  headers, authz redirects/403s, magic-link happy path + replay-safe, honeypot, CSRF 403,
  admin 403 for member role, media allowlist.
- `scripts/smoke.sh`: build + preview + curl assertions. `npm run check` (astro check),
  `npm run tokens:check`.
- GitHub Actions: Node 22 → `npm ci` → `wrangler types` → tokens build+check → test →
  check → build → conditional `wrangler deploy` (secret-gated). E2E in CI.

## 13. Docs & DX

README suite (ALL ENGLISH, per owner directive 2026-07-05): a non-technical **landing
README.md** written for church staff/volunteers (minimal jargon) that (a) states the
mission — the simplest, fastest, cheapest way for churches and nonprofits to run a
website, easy to maintain especially with AI assistance; (b) compares honestly with
WordPress / Wix / paid SaaS ($0 hosting on Cloudflare's free tier, fast global edge,
full data ownership and control, no vendor lock-in, no plugin treadmill); (c) actively
encourages building and maintaining the site with Claude Code or Codex, including
pointing the AI at this repo's docs and code; (d) explains the GPL v3 copyleft in one
friendly paragraph; (e) links to per-feature docs. Per-feature docs live in
`docs/features/*.md` (public site & themes, CMS admin, bulletins, sermons, prayer wall,
volunteer/serve module, i18n, email & automation) — each with SCREENSHOTS and an
original SVG (or HTML) structure diagram explaining how the feature works. Technical
docs: architecture, design-system, i18n, deploy (quickstart:
`npm i && npm run db:migrate:local && npm run db:seed:local && npm run dev`; deploy
guide incl. D1/R2/Email/domain setup with `church.yunfei-song.com` example; theme
customization tutorial). CONTRIBUTING.md, **GPL v3 LICENSE** (derivative works must
remain open source; no closed-source commercialization), `.dev.vars.example`,
`wrangler.jsonc` with `<PLACEHOLDER>` ids. Screenshots are captured during execution
(dev server, seeded) — not deferred to the end. Final acceptance review is performed
by Fable (the most capable model), with Opus subagents executing.

## 14. Execution slices (each gets its own implementation plan)

1. **Foundation**: scaffold, tokens pipeline + base.css, Base/Admin layouts, header/footer,
   locale routing + dictionaries, middleware skeleton, CI, smoke. Gate: build+dev+checks pass.
2. **Schema & core libs**: migrations, seed, db helpers (i18n join helper), settings,
   validate, dates, youtube + their tests. Gate: unit tests green.
3. **Auth & people**: tokens/session/routePolicy/middleware enforcement, signin/auth/
   respond/signout, email.ts (dev-log), people admin. Gate: auth unit+e2e green.
4. **Public site**: all public pages + components (hero, ticker, event grid, sermon grid,
   bulletin view, staff/fellowship/article pages, prayer form), s2t toggle. Gate: e2e public.
5. **CMS admin**: dashboards, content CRUD + repeat-rows, uploads, prayer wall, revisions,
   settings page. Gate: adminDb tests + e2e admin.
6. **Volunteer module**: ministries/teams/plans/matrix/assignments/blockouts/my/apply/
   gifts/testimonies/applications/wizard/availability/reports. Gate: planDb+ministryDb tests.
7. **Email/cron/ical + polish**: notify/digest/backup/ical, seed completion, README+docs,
   screenshots, final verify (full test suite, smoke, token lint, fresh-clone dry run).

Dependencies: 1→2→3→{4,5,6}→7. Slices 4/5/6 are file-disjoint enough to parallelize
with worktrees if desired; default sequential for review quality.
