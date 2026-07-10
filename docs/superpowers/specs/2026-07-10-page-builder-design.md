# Page Builder — drag-and-drop custom pages (design)

Date: 2026-07-10
Status: approved for implementation (authored autonomously from Leo's /goal brief; Leo reviews the finished branch)
Base: local `main` @ e077ce0, branch `feat/page-builder`, worktree `../church-cms-builder`

## Goal

Upgrade the existing custom-pages feature ("add a page") from Markdown textareas to a
Wix-like drag-and-drop builder, while keeping the Astro + Tailwind stack and the
zero-JS published output. The builder is an optional module that can be switched
off like any other. README documents the feature when done.

From Leo's brief (verbatim constraints):
- Canvas as a client-side island (React/Vue/Svelte + @dnd-kit or pragmatic-drag-and-drop)
  managing a JSON layout tree.
- Dynamic renderer maps the JSON tree to components.
- Styling controls map to Tailwind utility classes; safelisted/static classes for
  structural utilities, inline `style` objects for arbitrary user values.
- Publish path: server renders the JSON tree to pure semantic HTML + the existing
  Tailwind stylesheet — no builder JS ships to visitors.

## Assumptions (made autonomously; call out if wrong)

1. **The builder is an authoring mode over the existing `custom_pages`**, not a
   parallel page system. Slug, publish flag, nav integration (`{type:'page', slug}`
   nav items), revisions, and the `/{locale}/p/{slug}` route are reused.
2. **Disabling the module hides authoring, never content.** Published builder pages
   keep rendering when `page-builder` is off (rendering is core, like the `people`
   module gating panels rather than routes). Content is never held hostage by a toggle.
3. **One layout tree per page, localized text per block** (`{en, zh}` props), not one
   tree per locale. Structure stays in sync; text falls back per-field to `en`,
   matching the site-wide i18n convention.
4. **React + @dnd-kit** for the island (Leo's first-listed option; dnd-kit is the
   most mature kit for sortable trees). Admin-only cost; public pages stay zero-JS.
5. **Colors stay on semantic theme tokens in v1** (`primary`, `accent`, surface
   variants). A free hex picker would bypass the token pipeline's WCAG contrast gate
   and break dark mode/theme switching; arbitrary values are demonstrated via the
   custom-size escape hatch instead (inline style). A palette-mapped color picker can
   come later.
6. **v1 block set** (below) is deliberately small but composes into real pages;
   more block types are follow-ups, not part of this slice.

## Approaches considered

**A. Authoring mode over `custom_pages` (chosen).** Add `format` + `layout_json` to
`custom_pages`; builder writes the same rows the Markdown editor writes. Reuses slug
uniqueness, publish/preview gating, revisions, nav resolution, and the public route.
Smallest diff, one mental model for "a page".

**B. Separate `builder_pages` table + routes.** Cleaner isolation, but duplicates
slug/publish/nav/revision/preview infrastructure and splits "Pages" into two admin
concepts. Rejected: more code for a worse UX.

**C. Per-locale layout trees** (`layout_json` on `custom_page_i18n`). Maximum
flexibility, but every structural edit must be repeated in both locales and layouts
drift. Rejected — bilingual parity is the point of this site.

Framework: React+dnd-kit (chosen) vs Svelte+pragmatic-drag-and-drop (lighter runtime,
but no ecosystem sortable-tree primitives and Leo listed React first) vs extending the
vanilla-script pattern (fine for the prayer-wall kanban, insufficient for a
palette → canvas → properties builder with live reorder previews).

## Data model

Mirrored migration pair — D1 `migrations/0007_page_builder.sql`, Supabase
`migrations-supabase/0006_page_builder.sql` (numbering per this branch's base, `main`;
note: unmerged `feat/member-portal` also claims 0007/0006 — whichever merges second
renumbers):

```sql
ALTER TABLE custom_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'
  CHECK (format IN ('markdown','builder'));
ALTER TABLE custom_pages ADD COLUMN layout_json TEXT;  -- JSON tree, TEXT on both backends
```

No new tables. `layout_json` follows the repo's JSON-as-TEXT convention (like
`snapshot_json`), parsed defensively at the app layer. Both statements are valid,
identical DDL on SQLite and Postgres (only the file pair differs, per convention).

## Layout tree (v1 schema)

`src/lib/pageLayout.ts` — types + validation, pure and dependency-free:

```ts
interface PageLayout { v: 1; blocks: SectionNode[] }

// containers
SectionNode { id, type:'section',
  props: { bg:'none'|'soft'|'primary'|'accent', width:'narrow'|'content'|'wide',
           padY:'sm'|'md'|'lg' },
  children: (ColumnsNode | LeafNode)[] }
ColumnsNode { id, type:'columns',
  props: { count:2|3|4, gap:'sm'|'md'|'lg' },
  columns: LeafNode[][] }            // exactly `count` arrays; no nesting deeper

// leaves — L10n = { en: string, zh: string }
HeadingNode { id, type:'heading', props:{ level:1|2|3, text:L10n,
  align:'left'|'center'|'right', size:'sm'|'md'|'lg'|'xl', customSizePx?:number } }
TextNode    { id, type:'text',    props:{ md:L10n, align } }   // markdown, XSS-safe renderer
ImageNode   { id, type:'image',   props:{ src, alt:L10n,
  width:'full'|'wide'|'medium'|'small', rounded:boolean, align } }
ButtonNode  { id, type:'button',  props:{ label:L10n, href,
  variant:'primary'|'secondary', align } }
SpacerNode  { id, type:'spacer',  props:{ size:'sm'|'md'|'lg'|'xl' } }
DividerNode { id, type:'divider', props:{} }
```

`validateLayout(raw: string)` → `{ok:true, layout}` | `{ok:false, error}`. Enforces:
type/enum allowlists, node ids `[A-Za-z0-9_-]{1,36}` and unique, max 300 nodes,
containment rules (sections top-level only; columns only inside sections; leaves
inside sections or columns; no columns-in-columns), string length caps,
`customSizePx` clamped 10–120, `href` gated by the same
`^(https?://|/|#|mailto:)` rule markdown.ts uses, image `src` restricted to
`/media/uploads/…` or `https://…`, total JSON ≤ 200 KB. Reads are defensive: an
invalid stored layout renders as an empty page plus (for editors) a notice — never a 500.

## Styling pipeline — the Tailwind compiler catch

`src/lib/blockStyles.ts` — a pure module mapping every block/prop combination to
`{ className: string, style?: Record<string,string> }`, with each utility string
written out **statically in lookup tables** (e.g. `bg: { soft:'bg-surface-sunken',
primary:'bg-primary-soft', … }`). Because the class strings live in source, Tailwind 4's
static analysis keeps them — no safelist config needed (Tailwind 4 here is CSS-first;
there is no `tailwind.config.mjs` to safelist in). Only token-mapped utilities are
used (passes `npm run tokens:check`; survives all three themes + dark mode).
Arbitrary user values (`customSizePx`) emit inline `style` — exactly the split
Leo's brief prescribes. Section widths reuse the existing `.container-narrow/-content/-wide`
components; text blocks reuse `.prose`.

**This module is shared by both renderers** (the Astro public renderer and the React
canvas), so canvas and published page can't drift on classes. The two renderers
duplicate only trivial HTML structure.

## Public rendering (zero-JS)

`src/pages/[locale]/p/[slug].astro` branches on `page.format`:
- `markdown` → existing `renderMarkdown` path, unchanged.
- `builder` → `<PageBlocks layout={layout} locale={locale} />` —
  `src/components/blocks/PageBlocks.astro` recursively renders the tree through
  per-type Astro components using `blockStyles`. Text blocks render through the
  existing XSS-safe `renderMarkdown`; everything else is Astro-escaped by default.
  No client JS is emitted. Draft preview banner and 404 gating unchanged.

## Builder (admin island)

Route: `src/pages/admin/pages/builder/[id].astro` (`id` = page id or `new`).
- Route class: inherits `console` via the existing `/admin/pages` prefix in
  routePolicy — no routePolicy change. Frontmatter re-checks `isEditor || isAdmin`
  (403), same as `/admin/pages`.
- Module gate: middleware 404s the route when `page-builder` is off (see Module below).
- GET: loads the page (or blank for `new`), recent media rows (last 50 uploads, for
  the image picker), and a server-translated strings object; renders
  `<PageBuilder client:only="react" …props />` full-viewport under the Admin layout.
- POST (JSON, same-page handler per repo convention; CSRF covered by the existing
  middleware Origin check):
  - `{action:'save', id|null, slug, published, title_en, title_zh, layout}` →
    `validateLayout` → `savePageLayout` in `pagesDb.ts` (one `db.batch`: upsert row
    with `format='builder'` + `layout_json`, i18n title rewrite preserving existing
    `body_md`, revision snapshot `{v:2, format:'builder', …}`) → JSON `{ok:true, id}`
    on 200, or `{ok:false, error:'slug_taken'}` on 409 / `{ok:false,
    error:'invalid_layout'|'bad_request'}` on 400; the island switches on the
    body's `ok`/`error`, statuses are for logs/tools.
  - multipart `{action:'upload', file}` → existing `saveImageUpload` → `{ok:true, key, path}`
    or mapped `uploadErrorKey` error.

Island (`src/components/builder/PageBuilder.tsx` + small React components):
- Three panes: block palette (left), canvas (center), properties panel (right);
  top bar: locale toggle for text entry (EN/中文), undo/redo, slug/title/published
  controls, Save, Save & Publish, View-on-site link.
- @dnd-kit: palette → canvas insertion, sortable reorder within/between containers.
- Canvas renders blocks via React components that call the same `blockStyles` maps;
  text blocks live-preview through the same `renderMarkdown` import (pure TS,
  output already escaped → safe with `dangerouslySetInnerHTML`).
- Undo/redo = bounded snapshot stack; `beforeunload` guard when dirty; save errors
  surface as localized banners (strings passed from the server).
- New stack deps: `react`, `react-dom`, `@astrojs/react`, `@dnd-kit/core`,
  `@dnd-kit/sortable`, `@dnd-kit/utilities` (+ types). `client:only="react"` keeps
  React out of the worker SSR bundle entirely.

## Admin pages list changes

`/admin/pages` (classic editor) keeps working unchanged for markdown pages. Additions,
all gated on `locals.modules.has('page-builder')`:
- "New page (builder)" button → `/admin/pages/builder/new`.
- Per-row "Design" link for builder pages; format badge in the table.
- Editing a `builder` page in the classic form hides the body textareas and shows an
  "edit layout in the builder" link (slug/title/publish stay editable there; both
  surfaces write through the same atomic save).

## Module wiring

New key `page-builder` appended to `MODULE_KEYS` (modules.ts):
```ts
'page-builder': { publicPrefixes: [], adminPrefixes: ['/admin/pages/builder'],
                  navKeys: [], uses: [] }
```
- Middleware 404-gates the builder route when off (longest-prefix beats the core
  `/admin/pages`, which stays ungated core).
- Settings → Modules panel picks it up automatically (`MODULE_KEYS` iteration);
  add its label i18n keys. Default ON like every module; no `requiresBackend`
  (TEXT columns exist on both backends).
- Admin pages list buttons and the classic-form builder link check
  `locals.modules.has('page-builder')`.

## i18n

New flat keys in both `src/i18n/en.ts` and `src/i18n/zh.ts` (parity test enforces):
`admin.builder.*` (palette labels, property labels, save states, errors),
`admin.pages.formatBuilder`, module label key for the settings panel. The island
never calls `t()` — it receives a pre-translated strings object as props.

## Error handling

- Save: slug collision → `slug_taken` banner (reuses existing key); invalid layout →
  `invalid_layout`; malformed JSON body → 400. All localized in the island.
- Upload: type/size errors via existing `uploadErrorKey` mapping.
- Read path: `layout_json` that fails validation renders empty with an editor-only
  notice (defensive-parse convention, like `parseJsonArray`).
- Middleware DB-failure fallbacks unaffected (module defaults on).

## Testing

- Unit (workers pool, real D1): `test/pageLayout.test.ts` (validation matrix:
  allowlists, containment, caps, href/src gating), `test/blockStyles.test.ts`
  (mapping totality — every enum value maps; no literal colors),
  `test/pagesDb.test.ts` additions (layout save/load roundtrip, format flip,
  revision snapshot written, slug collision).
- E2E (built worker, `SELF.fetch`): builder route 404 when module off / 200 when on
  (editor session); POST save creates a builder page; public route renders block HTML
  (headings/buttons/columns classes present, no island script tag); draft gating
  unchanged; upload rejects a non-image.
- i18n parity + tokens:check run in the existing suites.
- Manual: drive the builder in a real browser (drag, reorder, properties, save,
  publish, view) with screenshots — per Leo's preference.

## Out of scope (v1)

Nested columns, free color pickers, rich-text WYSIWYG toolbar (text uses markdown),
templates/page duplication, SEO meta fields, publish scheduling, autosave,
collaborative editing, migrating existing markdown pages to blocks, public-repo
publishing (separate step after Leo's review).

## README

After implementation: feature bullet + a "Page builder" section (what it is, blocks,
module toggle, zero-JS output), consistent with existing feature docs style;
screenshots to `docs/` per repo convention if the docs pattern calls for them.
