# Modules (switch off what you don't need)

## What it does

Church4Christ can ship with bulletins, sermons, a prayer wall, volunteer scheduling,
events, articles, and more. That is a lot for a church that just
wants a simple site with service times and a sermon archive. **Modules** let you keep
only the parts you use.

Each capability is a **module** you can switch off from one panel in Settings. When a
module is off, it disappears from the whole site: its navigation links, its pages, its
home-page sections, and even its background emails. Nothing is deleted — the content and
history stay exactly where they are — so if you change your mind, you flip the switch back
on and everything returns. New churches start with a smaller, less intimidating site;
established churches can turn features on as they grow into them.

New setup records an explicit on/off row for every module based on the selected preset or
custom feature list. Older installations remain compatible: a legacy missing row defaults
to on. Turning a module off never touches the always-on core: the home page, visit and about
pages, staff directory, the `/give` page, sign-in, settings, and the nightly backup are
always present.

## How your team uses it

**The Modules panel.** An admin opens **Settings** and scrolls to **Modules**. Each
capability is a checkbox, grouped into Content, Community, and Volunteering. Uncheck the
ones you do not need and click **Save modules** — the change takes effect immediately.

![The Modules panel in Settings](../images/admin/settings-modules.png)

**The 17 modules:**

<!-- capabilities:start -->
| Key | English | 中文 | Required database |
|---|---|---|---|
| `bulletins` | Bulletins | 周报 | Either |
| `sermons` | Sermons | 讲道 | Either |
| `prayer-sheets` | Prayer Sheets | 祷告单 | Either |
| `prayer-wall` | Prayer Wall | 祷告墙 | Either |
| `events` | Events | 活动 | Either |
| `serve` | Volunteer Scheduling | 服事排班 | Either |
| `gifts` | Spiritual Gifts | 恩赐探索 | Either |
| `testimonies` | Testimonies | 见证 | Either |
| `articles` | Articles | 文章 | Either |
| `fellowships` | Fellowships | 团契 | Either |
| `groups` | Groups | 小组 | Either |
| `people` | People & Households | 会友与家庭 | Either |
| `children` | Children Check-in | 儿童报到 | Either |
| `page-builder` | Page Builder | 页面编辑器 | Either |
| `portal` | Member Portal | 会友平台 | Supabase |
| `giving` | Giving | 奉献 | Supabase |
| `registration` | Registration | 活动报名 | Supabase |
<!-- capabilities:end -->

**Three modules need the Supabase database.** Member Portal, Giving, and Registration run
only on the optional **Supabase** backend (see
[`docs/supabase-setup.md`](../supabase-setup.md)) — a church on the default Cloudflare **D1**
database sees their checkboxes **greyed out** in the Modules panel with a note explaining
why, and their pages simply do not exist (404) on D1. Every
other module works the same on either database.

**What happens when a module is off.** The capability is hidden everywhere at once, not
half-removed:

- Its **navigation links vanish** from the header and footer, and its **cards leave the
  admin dashboard** — nobody sees a button that would only say "not allowed."
- Its **pages return "not found" (404)** for everyone, whether they are signed in or not,
  and whether the page is public or in the admin area. There is no back door.
- Its **automatic emails stop** — turn Serve off and the weekly serving reminders and
  digest simply do not send.
- Its **content is kept**. Bulletins, sermons, and every other record stay in the
  database untouched. **Flip the module back on and every page, link, and email returns**
  exactly as it was.

**Soft-degrade: a module takes its cross-links with it.** Modules are not islands — some
features point at each other, and turning one off tidies up those references too, so you
never get a link to a page that no longer exists:

- Turn **Events off** and the home page's **announcements strip and events section
  disappear** along with the events pages.
- Turn **Serve off** and the **ministries directory** (and its navigation link) is hidden
  with it, since ministries live inside the serve module.
- Turn **Gifts off** and the serve landing page **stops showing the gifts-quiz call to
  action** — the rest of scheduling keeps working.
- Turn **Serve off** but leave the gifts quiz on and the quiz still runs, just **without
  the ministry recommendations** that would point people at teams.

The Full Church preset enables all 17 modules; Website enables 8; Website + Community
enables all 14 modules that are compatible with D1. Custom setup can select individual
modules.

## How it fits together

One panel writes a simple on/off setting per module. On every request the site reads that
set of enabled modules and reacts: an enabled module shows its nav links, opens its pages,
and runs its crons; a disabled one hides its links, returns 404 for its pages, and skips
its crons. Nothing is erased, so the switch is fully reversible, and cross-links
soft-degrade so an off module never leaves a dangling reference.

![How a module switches its navigation, pages, and crons on or off](../images/diagrams/modules.svg)

## For developers

- **Registry:** `config/capabilities.json` is the canonical, validated catalog, adapted by
  `src/lib/modules.ts` for runtime use. It maps each of the 17 keys to the locale-stripped
  route prefixes it owns (public and admin), its
  nav dictionary keys, its soft `uses` (degrade-only, never a hard gate), and an optional
  `requiresBackend: 'supabase'` for Portal, Giving, and Registration. `moduleForPath` is the
  classifier — longest matching prefix wins, so `/serve/gifts` resolves to `gifts` even
  though `/serve` also matches.
- **Authoring-only exception:** `page-builder` owns only its `/admin/pages/builder` admin
  prefix — no public prefix. Off, that admin route 404s (the design tool is gone), but the
  public `/‹locale›/p/‹slug›` renderer is core code with no module check of its own, so a
  page a church already built and published with the tool keeps rendering unchanged. Every
  other module gates a whole surface, public and admin together; this one deliberately
  gates authoring only, never already-published content.
- **Enablement + cache:** new setup writes all 17 `module.<key>` rows explicitly. For legacy
  installs, an absent row remains on; only the exact string `'0'` disables. A shared
  `filterByBackend` helper then drops any
  module whose `requiresBackend` doesn't match the current database — so a Supabase-only
  module can never turn on for a D1 deployment even if its setting row says so.
  `getEnabledModules(db, backend)` applies both and caches per (backend, 60s); the middleware
  puts the result on `locals.modules` (a `Set<ModuleKey>`) and, on a DB read failure, falls
  back to "everything enabled" filtered through the same `filterByBackend` — so the fail-safe
  can never re-enable a backend-gated module either.
- **Enforcement:** `src/middleware.ts` is the single choke point — after locale resolution
  and before route policy, a path owned by a disabled module rewrites to `/404` with a 404
  status. A DB failure fails open to all-enabled so a fresh install never 500s.
- **Surface reactions:** the header, footer, home page, admin dashboard, and settings all
  read `Astro.locals.modules` to hide links and sections; `src/lib/digest.ts` gates the
  serving reminder and digest crons on the `serve` module; `src/worker.ts` clears the module
  cache before each scheduled run so a warm isolate reads fresh state.
- **Admin panel:** `src/pages/admin/settings/index.astro` renders the grouped checkboxes and
  writes all 17 `module.<key>` rows explicitly (an unchecked box is written as `'0'`, not
  left partial), then calls `clearModuleCache()`.
- **Tests:** `test/modules.test.ts` (registry, cache, `moduleForPath`) and
  `test/moduleGating.test.ts` (middleware 404s + hidden surfaces); module-off e2e assertions
  live in `test/e2e/`.
