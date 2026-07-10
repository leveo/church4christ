# Admin Nav / Custom Pages / Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can (1) customize the public top-nav menu, (2) create/edit custom pages with a basic Markdown page editor, and (3) change the church name and upload a logo — all from the admin panel.

**Architecture:** Everything follows existing repo seams. Branding reuses the `settings` key/value table and the hero-image upload pattern (new key `site.logo_image_key`). Custom pages get a new `custom_pages` + `custom_page_i18n` table pair (mirroring the events/event_i18n pattern), a `pagesDb.ts` data module over `AppDb`, a hand-rolled XSS-safe Markdown renderer (`markdown.ts`, escape-first — no new dependency), an admin CRUD screen modeled on `admin/events/index.astro`, and a public dynamic route `/[locale]/p/[slug]`. Nav customization stores an ordered JSON array in settings key `nav.items` (schema in `nav.ts`), validated on read with fallback to the current hardcoded default; `Header.astro` renders from `resolveNav()` instead of its hardcoded array. A new admin screen `/admin/navigation` edits the array with no-JS server-round-trip forms.

**Tech Stack:** Astro 7 SSR on Cloudflare Workers, TypeScript, Tailwind v4 token utilities via `src/lib/adminUi.ts`, D1 + Supabase via `AppDb` (`src/lib/appDb.ts`), Vitest 4 (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- All DB access via `AppDb`-typed functions in `src/lib/*Db.ts` / `settings.ts`; positional `?` binds; multi-statement writes via `db.batch([...])`.
- Every schema change lands in BOTH `migrations/` (next number: `0005_*.sql`) and `migrations-supabase/` (next number: `0004_*.sql`). Mirror the type/style conventions each dir already uses for the events tables.
- Classic `<form method="post">` + hidden `action` field + `Astro.redirect(..., 303)` with `?saved=1`; echo form values on validation failure. No client-side fetch/JSON. No new npm dependencies.
- Admin screens use the `Admin.astro` layout and class constants from `src/lib/adminUi.ts` (`tin`, `lab`, `card`, `btn`, `noticeOk`, ...). Token utilities only — never literal colors.
- All user-facing strings go through i18n dicts `src/i18n/en.ts` + `src/i18n/zh.ts` (both must be updated together; zh values in Simplified Chinese).
- New `/admin/*` routes must be added to `routePolicy.ts` (`ADMIN_ONLY` or `ADMIN_CONSOLE`) AND covered in `test/routePolicy.test.ts` and the role-matrix e2e (`test/e2e/admin.e2e.test.ts` pattern).
- Inline role re-check at the top of every admin page (defense in depth), copying the exact pattern of the analog page.
- TDD: each task writes its tests first where a pure function is involved; run `npm test` before every commit. Commit messages in English, conventional-commit style, ending with the Co-Authored-By line used in this repo's history.
- Uploaded logo restricted to `ALLOWED_IMAGE_TYPES` (`src/lib/upload.ts`) — no SVG.

---

### Task 1: Church name wiring + logo upload (branding)

**Files:**
- Modify: `src/lib/settings.ts` (add `getLogoImageKey`)
- Modify: `src/lib/validate.ts:611-628` (add `'site.logo_image_key'` to `SETTINGS_KEYS`)
- Modify: `src/pages/admin/settings/index.astro` (logo upload field + POST handling, clone the hero-image pattern at lines ~70-84 and ~204-221)
- Modify: `src/components/Header.astro` (brand block: DB-backed name + optional logo image)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts` (labels for the logo field; reuse existing naming style of the hero-image labels)
- Test: `test/settingsSave.test.ts` or new `test/branding.test.ts`

**Interfaces:**
- Produces: `getLogoImageKey(db: AppDb): Promise<string>` in `src/lib/settings.ts` (returns `''` when unset).
- Header brand resolution: `identity.name || t(locale, 'site.name')` — the i18n constant stays as final fallback.

**Steps:**

- [ ] **Step 1: Failing test** — add to `test/settingsSave.test.ts` (workers pool, live `env.DB`):

```ts
import { getLogoImageKey, setSetting } from '../src/lib/settings';
// inside describe:
it('logo image key round-trips and defaults empty', async () => {
  expect(await getLogoImageKey(env.DB)).toBe('');
  await setSetting(env.DB, 'site.logo_image_key', 'uploads/abc-logo.png');
  expect(await getLogoImageKey(env.DB)).toBe('uploads/abc-logo.png');
});
```

Also add to the `parseSettingsForm` test file (find where SETTINGS keys are tested): a FormData containing `site.logo_image_key` passes through.

- [ ] **Step 2: Run** `npm test` → new tests FAIL (getLogoImageKey not exported / key dropped).
- [ ] **Step 3: Implement** — in `settings.ts` next to `getHeroImageKey`:

```ts
export async function getLogoImageKey(db: AppDb): Promise<string> {
  return getSetting(db, 'site.logo_image_key', '');
}
```

Add `'site.logo_image_key',` to `SETTINGS_KEYS` right after `'site.hero_image_key',`.

- [ ] **Step 4: Settings admin form** — in `admin/settings/index.astro`, clone the hero-image upload verbatim as a second block: file input `name="logo_image"`, remove-checkbox `name="logo_image_remove"`, POST branch calls `saveImageUpload({db, media: Astro.locals.runtime.env.MEDIA, file, uploadedBy: user.id})` (copy exact call shape from the hero branch) and stores the returned key via the same settings-save path under `site.logo_image_key`; remove-checkbox writes `''`. Show a small `<img>` preview when a key is set (src via `mediaPath(key)` from `src/lib/mediaRef.ts`). Add i18n label keys for "Logo" mirroring the hero-image label naming in both dicts.
- [ ] **Step 5: Header brand** — in `Header.astro` frontmatter add:

```ts
import { getSiteIdentity, getLogoImageKey } from '../lib/settings';
import { mediaPath } from '../lib/mediaRef';
const db = Astro.locals.db;
const identity = await getSiteIdentity(db, locale);
const siteName = identity.name || t(locale, 'site.name');
const logoKey = await getLogoImageKey(db);
const logoSrc = logoKey ? mediaPath(logoKey) : '';
```

Brand anchor becomes:

```astro
<a href={home} class="font-display font-bold text-lg whitespace-nowrap shrink-0 flex items-center gap-2">
  {logoSrc && <img src={logoSrc} alt="" class="h-8 w-auto" />}
  <span>{siteName}</span>
</a>
```

(Verify `mediaPath`'s actual signature/import path before use.)

- [ ] **Step 6: Run** `npm test` → PASS; `npm run check` → clean.
- [ ] **Step 7: Commit** `feat: admin-editable church name in header + logo upload`

### Task 2: Custom pages data layer (migrations + pagesDb + markdown renderer)

**Files:**
- Create: `migrations/0005_custom_pages.sql`, `migrations-supabase/0004_custom_pages.sql`
- Create: `src/lib/pagesDb.ts`, `src/lib/markdown.ts`
- Test: `test/markdown.test.ts`, `test/pagesDb.test.ts`

**Interfaces (produced — later tasks rely on these exact signatures):**

```ts
// pagesDb.ts
export interface CustomPageListRow { id: string; slug: string; published: boolean; title_en: string; title_zh: string; updated_at: string }
export interface CustomPageDetail { id: string; slug: string; published: boolean; i18n: { en: { title: string; body_md: string }; zh: { title: string; body_md: string } } }
export function listCustomPages(db: AppDb): Promise<CustomPageListRow[]>
export function getCustomPage(db: AppDb, id: string): Promise<CustomPageDetail | null>
export function getCustomPageBySlug(db: AppDb, slug: string): Promise<CustomPageDetail | null>
export function saveCustomPage(db: AppDb, input: { id: string | null; slug: string; published: boolean; title_en: string; title_zh: string; body_en: string; body_zh: string; updatedBy: string }): Promise<{ ok: true; id: string } | { ok: false; error: 'slug_taken' }>
export function deleteCustomPage(db: AppDb, id: string): Promise<void>
export function listPublishedPageTitles(db: AppDb, slugs: string[], locale: Locale): Promise<Map<string, string>>  // title with .en fallback; only published pages
// markdown.ts
export function renderMarkdown(md: string): string  // escape-first, XSS-safe HTML
```

**Steps:**

- [ ] **Step 1: Migrations.** D1 `migrations/0005_custom_pages.sql`:

```sql
CREATE TABLE custom_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE custom_page_i18n (
  page_id TEXT NOT NULL REFERENCES custom_pages(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (page_id, locale)
);
```

Before writing, open `migrations/0001_init.sql` and mirror the exact style used by `events`/`event_i18n` (timestamps, FK syntax, index conventions). Then write the Supabase mirror in `migrations-supabase/0004_custom_pages.sql` following how that dir translates the same events tables (types like TIMESTAMPTZ/BOOLEAN if that's what it does — parity with the dir's own conventions wins over the SQL above).

- [ ] **Step 2: Failing tests for `renderMarkdown`** — `test/markdown.test.ts` (node or workers project, no DB). Must cover at least: heading `# Hi` → `<h1>Hi</h1>`; paragraph merging with `<br />`; `**b**`/`*i*`/`` `code` ``; fenced code block preserves content verbatim (no inline parsing inside); unordered + ordered lists; blockquote; `---` rule; link `[a](https://x)` renders, `[a](javascript:alert(1))` does NOT become a link; image `![x](/media/uploads/k)` renders; raw HTML `<script>alert(1)</script>` comes out escaped (`&lt;script&gt;`); `"` in alt text cannot break out of the attribute.
- [ ] **Step 3: Run** → FAIL (module missing).
- [ ] **Step 4: Implement `src/lib/markdown.ts`:**

```ts
// Minimal, safe Markdown renderer for admin-authored page bodies. The whole
// input is HTML-escaped BEFORE any transformation, so raw HTML can never
// reach the output. Supports: #..###### headings, paragraphs, **bold**,
// *italic*, `code`, ``` fenced blocks, [text](href), ![alt](src),
// -/* and 1. lists, > blockquotes, --- rules. hrefs/srcs restricted to
// https?://, /, #, mailto:.
const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(escaped: string): string {
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) =>
    SAFE_HREF.test(src) ? `<img src="${src}" alt="${alt}" />` : m,
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
    SAFE_HREF.test(href) ? `<a href="${href}">${label}</a>` : m,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replaceAll('\r\n', '\n')).split('\n');
  const html: string[] = [];
  let i = 0;
  const isBlank = (s: string) => s.trim() === '';
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; html.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { html.push('<hr />'); i++; continue; }
    if (line.startsWith('&gt;')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('&gt;')) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
      html.push(`<blockquote><p>${buf.map(inline).join('<br />')}</p></blockquote>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/;
    const ol = /^\s*\d+\.\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const buf: string[] = [];
      while (i < lines.length && re.test(lines[i])) buf.push(`<li>${inline(lines[i++].match(re)![1])}</li>`);
      html.push(ordered ? `<ol>${buf.join('')}</ol>` : `<ul>${buf.join('')}</ul>`);
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,6}\s|```|&gt;|\s*[-*]\s|\s*\d+\.\s|\s*(---+|\*\*\*+)\s*$)/.test(lines[i])) buf.push(lines[i++]);
    html.push(`<p>${buf.map((l) => inline(l.trim())).join('<br />')}</p>`);
  }
  return html.join('\n');
}
```

- [ ] **Step 5: Failing tests for pagesDb** — `test/pagesDb.test.ts` (workers pool, `env.DB`; migrations auto-apply via `test/setup.ts`). Cover: save new page → listed; `getCustomPageBySlug` returns detail; duplicate slug on a DIFFERENT id → `{ok:false, error:'slug_taken'}`; update same id keeps slug; `deleteCustomPage` removes page + i18n rows; `listPublishedPageTitles` returns only published pages, zh locale falls back to en title when zh title empty.
- [ ] **Step 6: Implement `src/lib/pagesDb.ts`** with the exact interface above. Follow `saveEvent` in `src/lib/adminDb.ts:1089-1201` as the canonical pattern: `crypto.randomUUID()`-style id (use whatever events use), `db.batch([...])` upserting `custom_pages` + two `custom_page_i18n` rows, bump `updated_at`, and write a `revisions` snapshot the same way events do (copy the exact revisions insert shape; entity type string `'custom_page'`). Slug-uniqueness check: `SELECT id FROM custom_pages WHERE slug = ? AND id <> ?` before the batch.
- [ ] **Step 7: Run** `npm test` → PASS (all new + existing).
- [ ] **Step 8: Commit** `feat: custom pages data layer with safe markdown renderer`

### Task 3: Admin custom-pages CRUD screen (`/admin/pages`)

**Files:**
- Create: `src/pages/admin/pages/index.astro`
- Modify: `src/lib/validate.ts` (add `parseCustomPageForm`), `src/lib/routePolicy.ts:72-88` (`ADMIN_CONSOLE` += `'/admin/pages'`), `src/layouts/Admin.astro:63-89` (nav link in the content section), `src/i18n/en.ts` + `src/i18n/zh.ts`
- Test: `test/validate.customPage.test.ts` (or the existing validate test file), `test/routePolicy.test.ts`, e2e additions per `test/e2e/admin.e2e.test.ts` pattern

**Interfaces:**
- Consumes: `listCustomPages`, `getCustomPage`, `saveCustomPage`, `deleteCustomPage` (Task 2), `renderMarkdown` (Task 2).
- Produces: `parseCustomPageForm(fd: FormData): FormResult<{ id: string | null; slug: string; published: boolean; title_en: string; title_zh: string; body_en: string; body_zh: string }>`

**Steps:**

- [ ] **Step 1: Failing tests for `parseCustomPageForm`:** valid form passes; slug rules: lowercase `a-z0-9` groups joined by single hyphens (regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), max 64 chars, required — uppercase input is lowercased before validation; at least one of title_en/title_zh required; `published` = checkbox presence; bodies pass through (cap length at 100_000 chars → error beyond). Reuse `str`/`ERR`/`FormResult` helpers from `validate.ts` (add an `ERR.slug` message if none fits, mirroring existing ERR style in both i18n dicts if ERR messages are i18n keys — check how ERR is consumed first).
- [ ] **Step 2: Run** → FAIL. **Implement** parser in `validate.ts` under a new `// Custom pages` section header comment matching file style. Run → PASS.
- [ ] **Step 3: Route policy:** add `'/admin/pages'` to `ADMIN_CONSOLE` (alphabetical/logical position near other content areas). Extend `test/routePolicy.test.ts` with `classifyRoute('/admin/pages') === 'console'` and `classifyRoute('/admin/navigation') === 'adminOnly'` (Task 6 adds the entry; write only the pages assertion now).
- [ ] **Step 4: Build `src/pages/admin/pages/index.astro`** modeled directly on `src/pages/admin/events/index.astro` (read it fully first; copy its GET/POST skeleton, inline role check `user.isEditor || user.isAdmin`, `?edit=<id>` pattern, hidden `action` = `save`/`toggle`/`delete`, 303 redirects, error echo). Content requirements:
  - List: slug, en/zh titles, published badge, updated_at, Edit link, per-row toggle-publish and delete buttons (delete uses a confirm pattern only if events has one — otherwise plain button, matching events).
  - Edit/new form: slug input (prefix hint showing `/{locale}/p/`), published checkbox, and per locale (en, zh): title input + `<textarea rows="14" class="... font-mono">` for `body_en`/`body_zh` with a one-line Markdown hint (i18n string listing `# heading, **bold**, [link](url), - list`).
  - When editing an existing page, render a read-only preview panel below the form: `<div class="prose ..." set:html={renderMarkdown(current.i18n[adminLocale].body_md)} />` inside a `card` — check how public `.prose` styling is applied in `ContentPage.astro` and reuse the class string.
  - "View page" link to `/{en}/p/{slug}` when published.
  - On slug conflict (`saveCustomPage` returns `slug_taken`), re-render with an error on the slug field like events does for its validation errors.
- [ ] **Step 5: Admin nav + i18n:** add a "Pages" link in `Admin.astro`'s content section (visible to editor∪admin — copy visibility conditions from the Events entry) and all new i18n keys to `en.ts`/`zh.ts` (`admin.pages.*`; zh: 页面/新增页面/标题/内容/已发布/草稿 etc.).
- [ ] **Step 6: e2e role matrix:** extend `test/e2e/admin.e2e.test.ts` (or its route list) so `/admin/pages` asserts anon→303, member→403, editor→200, admin→200.
- [ ] **Step 7: Run** `npm test` → PASS. `npm run test:e2e` → PASS.
- [ ] **Step 8: Commit** `feat: admin custom pages CRUD with markdown editor`

### Task 4: Public custom-page route (`/[locale]/p/[slug]`)

**Files:**
- Create: `src/pages/[locale]/p/[slug].astro`
- Modify: `test/routePolicy.test.ts` (assert `/p/foo` is public)
- Test: `test/e2e/customPages.e2e.test.ts`

**Interfaces:**
- Consumes: `getCustomPageBySlug` (Task 2), `renderMarkdown` (Task 2), `ContentPage.astro`, `parseLocale`.

**Steps:**

- [ ] **Step 1:** Confirm `classifyRoute('/p/anything')` already returns `'public'` (fall-through) — add the assertion to `test/routePolicy.test.ts`.
- [ ] **Step 2: Failing e2e** — `test/e2e/customPages.e2e.test.ts` using `SELF.fetch` + helpers from `test/e2e/helpers.ts`: seed a published page directly via SQL/`saveCustomPage` into `env.DB`; GET `/en/p/<slug>` → 200 containing the title and rendered body; unpublished page → 404 for anon; unpublished + editor session cookie (mint via `mintSession` as the existing e2e does) → 200 with a draft notice; unknown slug → 404; zh locale with empty zh body falls back to en content.
- [ ] **Step 3: Implement the route.** Frontmatter logic:

```ts
const locale = parseLocale(Astro.params.locale);
if (!locale) return Astro.rewrite('/404');
const page = await getCustomPageBySlug(Astro.locals.db, Astro.params.slug ?? '');
const user = Astro.locals.user;
const canPreview = !!user && (user.isEditor || user.isAdmin);
if (!page || (!page.published && !canPreview)) return Astro.rewrite('/404');
const loc = page.i18n[locale];
const fallback = page.i18n.en;
const title = loc.title || fallback.title;
const bodyMd = loc.body_md || fallback.body_md;
const html = renderMarkdown(bodyMd);
```

Render through `ContentPage.astro` exactly the way `src/pages/[locale]/privacy.astro` does (read it first; pass title and inject `set:html={html}` into the prose slot). When `!page.published`, show a small draft banner above the content (i18n key, e.g. `pages.draftNotice`; zh: 草稿——仅管理员可见).

- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat: public route for admin-created custom pages`

### Task 5: Nav config library + Header renders from settings

**Files:**
- Create: `src/lib/nav.ts`
- Modify: `src/components/Header.astro` (replace hardcoded array with `resolveNav`)
- Test: `test/nav.test.ts`

**Interfaces (produced):**

```ts
export const NAV_SETTING_KEY = 'nav.items';
export const BUILTIN_NAV: { key: string; path: string }[]; // the 11 entries currently hardcoded in Header.astro:13-25, same order
export type NavItem =
  | { type: 'builtin'; key: string }
  | { type: 'page'; slug: string }
  | { type: 'link'; url: string; label: { en: string; zh: string } };
export const DEFAULT_NAV: NavItem[]; // BUILTIN_NAV mapped to builtin items
export function parseNavItems(raw: string): NavItem[];        // '' / bad JSON / non-array → DEFAULT_NAV; invalid entries dropped
export function serializeNavItems(items: NavItem[]): string;  // JSON.stringify
export interface ResolvedNavLink { label: string; href: string }
export function resolveNav(db: AppDb, locale: Locale, modules: Set<string>): Promise<ResolvedNavLink[]>;
```

**Steps:**

- [ ] **Step 1: Failing tests** — `test/nav.test.ts` (workers pool for the db-backed parts): `parseNavItems('')` and `parseNavItems('not json')` → `DEFAULT_NAV`; unknown `type` and unknown builtin `key` dropped; link with `javascript:` url dropped; link with neither label dropped; round-trip through `serializeNavItems`. For `resolveNav` against `env.DB`: default (no setting) equals module-gated builtins with i18n labels; with a setting containing a published page slug → that entry resolves to the page title and `/{locale}/p/{slug}`; unpublished page entry dropped; builtin whose module is off dropped; zh locale prefers zh labels with en fallback.
- [ ] **Step 2: Run** → FAIL. **Implement `src/lib/nav.ts`:**

```ts
// Admin-customizable top navigation. The menu is an ordered JSON array in
// settings key `nav.items`; when unset or unparsable the hardcoded default
// (the pre-customization menu) is used, so a bad save can never blank the nav.
import type { AppDb } from './appDb';
import type { Locale } from './locales';
import { localePath } from './locales';
import { t } from './i18n';
import { MODULE_KEYS, MODULES } from './modules';
import { getSetting } from './settings';
import { listPublishedPageTitles } from './pagesDb';

export const NAV_SETTING_KEY = 'nav.items';

export const BUILTIN_NAV: { key: string; path: string }[] = [
  { key: 'nav.visit', path: '/visit' },
  { key: 'nav.about', path: '/about' },
  { key: 'nav.sermons', path: '/sermons' },
  { key: 'nav.bulletin', path: '/bulletin' },
  { key: 'nav.events', path: '/events' },
  { key: 'nav.register', path: '/register' },
  { key: 'nav.ministries', path: '/ministries' },
  { key: 'nav.serve', path: '/serve' },
  { key: 'nav.opportunities', path: '/serve/opportunities' },
  { key: 'nav.fellowships', path: '/fellowships' },
  { key: 'nav.articles', path: '/articles' },
];

export type NavItem =
  | { type: 'builtin'; key: string }
  | { type: 'page'; slug: string }
  | { type: 'link'; url: string; label: { en: string; zh: string } };

export const DEFAULT_NAV: NavItem[] = BUILTIN_NAV.map((b) => ({ type: 'builtin' as const, key: b.key }));

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_URL = /^(https?:\/\/|\/)/i;

export function parseNavItems(raw: string): NavItem[] {
  if (!raw) return DEFAULT_NAV;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return DEFAULT_NAV; }
  if (!Array.isArray(parsed)) return DEFAULT_NAV;
  const items: NavItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (o.type === 'builtin' && typeof o.key === 'string' && BUILTIN_NAV.some((b) => b.key === o.key)) {
      items.push({ type: 'builtin', key: o.key });
    } else if (o.type === 'page' && typeof o.slug === 'string' && SLUG_RE.test(o.slug)) {
      items.push({ type: 'page', slug: o.slug });
    } else if (o.type === 'link' && typeof o.url === 'string' && SAFE_URL.test(o.url) && o.label && typeof o.label === 'object') {
      const l = o.label as Record<string, unknown>;
      const en = typeof l.en === 'string' ? l.en.trim() : '';
      const zh = typeof l.zh === 'string' ? l.zh.trim() : '';
      if (en || zh) items.push({ type: 'link', url: o.url, label: { en, zh } });
    }
  }
  return items;
}

export function serializeNavItems(items: NavItem[]): string {
  return JSON.stringify(items);
}

export interface ResolvedNavLink { label: string; href: string }

/** The links Header actually renders: setting parsed, builtins module-gated,
 *  page items resolved to published titles (drafts drop out), link items as-is. */
export async function resolveNav(db: AppDb, locale: Locale, modules: Set<string>): Promise<ResolvedNavLink[]> {
  const items = parseNavItems(await getSetting(db, NAV_SETTING_KEY, ''));
  const navKeyModule = new Map<string, string>();
  for (const key of MODULE_KEYS) for (const nk of MODULES[key].navKeys) navKeyModule.set(nk, key);
  const slugs = items.flatMap((x) => (x.type === 'page' ? [x.slug] : []));
  const titles = slugs.length ? await listPublishedPageTitles(db, slugs, locale) : new Map<string, string>();
  const out: ResolvedNavLink[] = [];
  for (const item of items) {
    if (item.type === 'builtin') {
      const owner = navKeyModule.get(item.key);
      if (owner && !modules.has(owner)) continue;
      const path = BUILTIN_NAV.find((b) => b.key === item.key)!.path;
      out.push({ label: t(locale, item.key), href: localePath(locale, path) });
    } else if (item.type === 'page') {
      const title = titles.get(item.slug);
      if (!title) continue;
      out.push({ label: title, href: localePath(locale, `/p/${item.slug}`) });
    } else {
      const label = (locale === 'zh' ? item.label.zh : item.label.en) || item.label.en || item.label.zh;
      out.push({ label, href: item.url });
    }
  }
  return out;
}
```

(If `t()`'s key parameter is a strict literal-union type, cast the builtin key at the single call site with a comment.) Check `Astro.locals.modules`' actual type in `src/middleware.ts` / `env.d.ts` and match it.

- [ ] **Step 3: Header** — delete the hardcoded `nav` array and module-gating block from `Header.astro` (lines 13-36); replace with `const links = await resolveNav(db, locale, Astro.locals.modules);` and render `links.map((l) => <a href={l.href} ...>{l.label}</a>)` in BOTH the desktop nav and the mobile disclosure nav (keep Give CTA, LocaleSwitch, zh toggle untouched).
- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS (existing e2e asserting nav content must still pass — default path unchanged).
- [ ] **Step 5: Commit** `feat: settings-driven top navigation with safe fallback`

### Task 6: Admin navigation editor (`/admin/navigation`)

**Files:**
- Create: `src/pages/admin/navigation/index.astro`
- Modify: `src/lib/routePolicy.ts:68` (`ADMIN_ONLY` += `'/admin/navigation'`), `src/layouts/Admin.astro` (nav link, admin-only section), `src/i18n/en.ts` + `src/i18n/zh.ts`
- Test: `test/routePolicy.test.ts`, e2e role matrix additions

**Interfaces:**
- Consumes: `parseNavItems`, `serializeNavItems`, `DEFAULT_NAV`, `BUILTIN_NAV`, `NAV_SETTING_KEY`, `resolveNav` (Task 5); `listCustomPages` (Task 2); `getSetting`/`setSetting` (settings.ts); `isHttpUrl` (validate.ts).

**Steps:**

- [ ] **Step 1: Route policy + tests:** `ADMIN_ONLY` += `'/admin/navigation'`; `test/routePolicy.test.ts` asserts `adminOnly`; e2e role matrix: anon→303, member→403, editor→403, admin→200.
- [ ] **Step 2: Build the page** (inline admin check `if (!user || !user.isAdmin) return new Response(null, { status: 403 })`, matching `admin/settings/index.astro`). GET renders, POST mutates-and-303s. Every POST branch starts from `const items = parseNavItems(await getSetting(db, NAV_SETTING_KEY, ''))`, applies ONE mutation, then `await setSetting(db, NAV_SETTING_KEY, serializeNavItems(items))` — except `reset`. Actions (hidden `action` field + hidden `idx` where relevant, `idx` bounds-checked):
  - `up` / `down`: swap `items[idx]` with its neighbor.
  - `remove`: splice out `items[idx]`.
  - `add-builtin`: `<select name="key">` listing `BUILTIN_NAV` entries not already present (label via `t`); push `{type:'builtin', key}`.
  - `add-page`: `<select name="slug">` listing pages from `listCustomPages` not already present (show slug + en title; note: unpublished pages may be added but only appear once published — render a hint saying so); push `{type:'page', slug}`.
  - `add-link`: inputs `url`, `label_en`, `label_zh`. Validate: url passes `isHttpUrl` OR starts with `/`; at least one label. Push `{type:'link', url, label:{en,zh}}`. Echo errors inline on failure.
  - `reset`: `DELETE FROM settings WHERE key = ?` via a small `deleteSetting(db, key)` helper added to `settings.ts` (one-liner, exported, used only here) — falls back to `DEFAULT_NAV` on next read.
  - Item list UI: one `card` per item showing resolved label(s) (`en` and `zh` forms), a type badge (builtin/page/link) and target path/url, with ↑ ↓ ✕ button forms per row (each its own `<form method="post">`; buttons use `btn` classes; first row's ↑ and last row's ↓ disabled).
  - A `noticeOk` "saved" banner on `?saved=1` like other admin pages.
- [ ] **Step 3: Admin.astro nav link** (admin-only section, next to Settings) + i18n keys `admin.nav.*` in both dicts (zh: 导航菜单/上移/下移/移除/添加内置项/添加页面/添加链接/恢复默认 etc.).
- [ ] **Step 4: Run** `npm test && npm run test:e2e` → PASS. `npm run check` → clean.
- [ ] **Step 5: Commit** `feat: admin navigation menu editor`

### Task 7: Full verification (owner: main session, not a subagent)

- [ ] `npm test`, `npm run test:e2e`, `npm run check` all green.
- [ ] Local run: `npm run db:migrate:local && npm run db:seed:local && npm run db:seed-media:local && npm run dev`; walk through: settings→change name+upload logo→header updates; pages→create+publish a page→visible at `/en/p/<slug>`; navigation→reorder/remove/add page+link→header menu updates; screenshots of each for the user.
- [ ] Update `README.md` feature list only if it enumerates admin features (check first; surgical).
