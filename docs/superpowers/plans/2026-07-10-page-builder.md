# Page Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wix-like drag-and-drop builder for custom pages — React/@dnd-kit admin island editing a JSON layout tree, server-rendered to zero-JS public pages, shipped as the optional `page-builder` module.

**Architecture:** `custom_pages` gains `format` + `layout_json` columns; a pure `pageLayout.ts` validates the tree and a pure `blockStyles.ts` maps blocks to static Tailwind-token classes (shared by the React canvas and the Astro public renderer so they cannot drift). The builder lives at `/admin/pages/builder/[id]` (React island, `client:only`), saves via same-page JSON POST; `/[locale]/p/[slug]` branches on `format` to render blocks with no client JS.

**Tech Stack:** Astro 7 (server output, Cloudflare adapter), Tailwind 4 (CSS-first tokens), React 19 + @astrojs/react 6 + @dnd-kit (core 6.3, sortable 10 — sortable used only for its utilities; drag model is gap-droppables), D1/SQLite + Supabase/Postgres via the `AppDb` seam, Vitest (workers pool + built-worker e2e).

**Spec:** `docs/superpowers/specs/2026-07-10-page-builder-design.md` (read it first).

## Global Constraints

- Working dir is the worktree `/Users/leosong/Python/church-cms-builder`, branch `feat/page-builder`. Never touch `/Users/leosong/Python/church-cms` (has unrelated WIP).
- Before first `npm run dev`/`astro check`: run `npm run tokens` once (generated CSS/TS are gitignored).
- NO literal colors/fonts anywhere (`npm run tokens:check` fails the build). Only token utilities (`bg-primary-soft`, `text-ink`, `border-border`, …). Inline `style` is allowed only for the `customSizePx` escape hatch (a px font-size is not a color/font-family; the check only bans hex/rgb/hsl and `font-family` literals).
- Every new UI string goes in BOTH `src/i18n/en.ts` and `src/i18n/zh.ts` with identical keys/placeholders (`test/i18n.test.ts` enforces parity). Flat dot keys, append near related keys. zh is Simplified Chinese.
- Schema changes land as a mirrored pair: `migrations/0007_page_builder.sql` (D1) + `migrations-supabase/0006_page_builder.sql` (Postgres).
- All data access goes through `db: AppDb` params, `?N` placeholders, `db.batch([...])` for multi-statement writes.
- Code comments/commit messages in English. Commit format: `type(scope): summary` matching repo history (`feat(builder): …`, `test(builder): …`).
- Commits must end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01VTXqz8KtgXM4rBte86ECwn`
- Run `npm test` (fast suite) after each task; `npm run test:e2e` where the task says so (it builds first, ~2-4 min).
- Match surrounding style: file-header comment explaining the module's role, JSDoc on exported functions, adminUi class constants for admin UI, existing form/POST conventions.

---

## File map (who owns what)

| File | Role |
|---|---|
| `migrations/0007_page_builder.sql`, `migrations-supabase/0006_page_builder.sql` | `format` + `layout_json` columns (Task 1) |
| `src/lib/pagesDb.ts` | + `format`/`layout_json` in reads; + `savePageLayout` (Task 1) |
| `src/lib/pageLayout.ts` | layout tree types + `validateLayout` + `emptyLayout` (Task 2) |
| `src/lib/blockStyles.ts` | block → `{className, style}` maps, shared canvas/public (Task 3) |
| `src/components/blocks/PageBlocks.astro` (+ leaf renderers inline) | zero-JS public renderer (Task 4) |
| `src/pages/[locale]/p/[slug].astro` | format branch (Task 4) |
| `src/lib/modules.ts`, `src/pages/admin/settings/index.astro`, i18n | `page-builder` module (Task 5) |
| `astro.config.mjs`, `package.json`, `tsconfig.json` | React integration (Task 6) |
| `src/lib/validate.ts` | `parseBuilderSave` JSON-body parser (Task 7) |
| `src/lib/upload.ts` | + `listRecentImages` (Task 7) |
| `src/pages/admin/pages/builder/[id].astro` | builder route: GET island mount, POST save/upload (Task 7) |
| `src/components/builder/*` (`.ts`/`.tsx`) | the React island (Tasks 8-9) |
| `src/pages/admin/pages/index.astro` | Design links, badge, builder-page classic form (Task 10) |
| `README.md`, `docs/features/page-builder.md` | docs (Task 11) |
| `test/pageLayout.test.ts`, `test/blockStyles.test.ts`, `test/pagesDb.test.ts`, `test/e2e/pageBuilder.e2e.test.ts` | tests |

---

### Task 1: Migrations + data layer (`format`, `layout_json`, `savePageLayout`)

**Files:**
- Create: `migrations/0007_page_builder.sql`
- Create: `migrations-supabase/0006_page_builder.sql`
- Modify: `src/lib/pagesDb.ts`
- Test: `test/pagesDb.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `AppDb`, `saveCustomPage`, revisions table.
- Produces (later tasks rely on these exact shapes):
  - `CustomPageListRow` gains `format: 'markdown' | 'builder'`.
  - `CustomPageDetail` gains `format: 'markdown' | 'builder'` and `layout_json: string | null`.
  - `type PageFormat = 'markdown' | 'builder'` exported.
  - `savePageLayout(db, input: SavePageLayoutInput): Promise<{ok:true; id:string} | {ok:false; error:'slug_taken'}>` where
    `SavePageLayoutInput = { id: string | null; slug: string; published: boolean; title_en: string; title_zh: string; layoutJson: string; updatedBy: string }`.

- [ ] **Step 1: Write the migrations** (no test yet — the test DB migrates from `migrations/` automatically)

`migrations/0007_page_builder.sql`:
```sql
-- Page-builder module: custom pages gain a format discriminator and a JSON
-- layout tree (TEXT, app-layer JSON like revisions.snapshot_json — no native
-- JSON type on either backend). 'markdown' pages keep the classic body_md path;
-- 'builder' pages render layout_json through src/components/blocks. ADD COLUMN
-- is safe on both engines; the CHECK applies to new writes only, which is all
-- we need (every write goes through pagesDb.ts).
ALTER TABLE custom_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'
  CHECK (format IN ('markdown','builder'));
ALTER TABLE custom_pages ADD COLUMN layout_json TEXT;
```

`migrations-supabase/0006_page_builder.sql`:
```sql
-- Postgres mirror of migrations/0007_page_builder.sql (see that file's header).
ALTER TABLE custom_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'
  CHECK (format IN ('markdown','builder'));
ALTER TABLE custom_pages ADD COLUMN layout_json TEXT;
```

- [ ] **Step 2: Write the failing tests** — append to `test/pagesDb.test.ts` (follow the file's existing imports/reset helpers; it already imports from `src/lib/pagesDb`):

```ts
import { savePageLayout } from '../src/lib/pagesDb'; // merge into the existing import

describe('savePageLayout (builder pages)', () => {
  const LAYOUT = JSON.stringify({ v: 1, blocks: [] });

  it('creates a builder page: format, layout, titles persisted; body_md stays empty', async () => {
    const res = await savePageLayout(env.DB, {
      id: null, slug: 'built', published: false,
      title_en: 'Built', title_zh: '构建', layoutJson: LAYOUT, updatedBy: 'e@x',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const page = await getCustomPage(env.DB, res.id);
    expect(page?.format).toBe('builder');
    expect(page?.layout_json).toBe(LAYOUT);
    expect(page?.i18n.en.title).toBe('Built');
    expect(page?.i18n.zh.title).toBe('构建');
  });

  it('updating an existing markdown page flips format and PRESERVES body_md', async () => {
    const first = await saveCustomPage(env.DB, {
      id: null, slug: 'flip', published: true,
      title_en: 'Flip', title_zh: '', body_en: 'keep me', body_zh: '保留', updatedBy: 'e@x',
    });
    if (!first.ok) throw new Error('seed failed');
    const res = await savePageLayout(env.DB, {
      id: first.id, slug: 'flip', published: true,
      title_en: 'Flip 2', title_zh: '翻转', layoutJson: LAYOUT, updatedBy: 'e@x',
    });
    expect(res.ok).toBe(true);
    const page = await getCustomPage(env.DB, first.id);
    expect(page?.format).toBe('builder');
    expect(page?.i18n.en.title).toBe('Flip 2');
    expect(page?.i18n.en.body_md).toBe('keep me'); // classic body untouched
    expect(page?.i18n.zh.body_md).toBe('保留');
  });

  it('rejects a slug taken by a different page', async () => {
    await savePageLayout(env.DB, { id: null, slug: 'a', published: false, title_en: 'A', title_zh: '', layoutJson: LAYOUT, updatedBy: 'e@x' });
    const res = await savePageLayout(env.DB, { id: null, slug: 'a', published: false, title_en: 'B', title_zh: '', layoutJson: LAYOUT, updatedBy: 'e@x' });
    expect(res).toEqual({ ok: false, error: 'slug_taken' });
  });

  it('writes a v2 revision snapshot', async () => {
    const res = await savePageLayout(env.DB, { id: null, slug: 'rev', published: false, title_en: 'R', title_zh: '', layoutJson: LAYOUT, updatedBy: 'editor@x' });
    if (!res.ok) throw new Error('save failed');
    const row = await env.DB
      .prepare(`SELECT snapshot_json, edited_by FROM revisions WHERE entity='custom_page' AND entity_id=?1 ORDER BY id DESC`)
      .bind(res.id).first<{ snapshot_json: string; edited_by: string }>();
    const snap = JSON.parse(row!.snapshot_json);
    expect(snap.v).toBe(2);
    expect(snap.input.format).toBe('builder');
    expect(snap.input.layout_json).toBe(LAYOUT);
    expect(row!.edited_by).toBe('editor@x');
  });

  it('classic saveCustomPage on a builder page leaves format/layout_json alone', async () => {
    const created = await savePageLayout(env.DB, { id: null, slug: 'mixed', published: false, title_en: 'M', title_zh: '', layoutJson: LAYOUT, updatedBy: 'e@x' });
    if (!created.ok) throw new Error('seed failed');
    await saveCustomPage(env.DB, {
      id: created.id, slug: 'mixed', published: true,
      title_en: 'M2', title_zh: '', body_en: '', body_zh: '', updatedBy: 'e@x',
    });
    const page = await getCustomPage(env.DB, created.id);
    expect(page?.format).toBe('builder');
    expect(page?.layout_json).toBe(LAYOUT);
    expect(page?.published).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/pagesDb.test.ts`
Expected: FAIL — `savePageLayout` is not exported (and `format` missing from detail type).

- [ ] **Step 4: Implement in `src/lib/pagesDb.ts`**

1. Add to the interfaces:
```ts
export type PageFormat = 'markdown' | 'builder';
```
`CustomPageListRow` gains `format: PageFormat;` — add `p.format AS format` to the `listCustomPages` SELECT (no mapping needed, TEXT passes through).
`CustomPageDetail` gains `format: PageFormat; layout_json: string | null;` — extend the two single-page SELECTs to `SELECT id, slug, published, format, layout_json FROM custom_pages …` and thread through `toDetail` (update its param type and return: `{ id, slug, published: page.published === 1, format: page.format, layout_json: page.layout_json, i18n }`).

2. Add the save (below `saveCustomPage`, mirroring its comment style):
```ts
export interface SavePageLayoutInput {
  id: string | null;
  slug: string;
  published: boolean;
  title_en: string;
  title_zh: string;
  /** Validated + re-serialized JSON from pageLayout.validateLayout. */
  layoutJson: string;
  updatedBy: string;
}

/** Create or update a BUILDER page in one transaction (upsert + title upsert +
 *  revision snapshot). Differs from saveCustomPage in two ways: it writes
 *  format='builder' + layout_json, and it upserts i18n TITLES ONLY (per-locale
 *  ON CONFLICT) instead of delete+reinsert, so any classic body_md a page had
 *  before its builder conversion survives a later format flip back. */
export async function savePageLayout(
  db: AppDb,
  input: SavePageLayoutInput,
): Promise<{ ok: true; id: string } | { ok: false; error: 'slug_taken' }> {
  const id = input.id ?? crypto.randomUUID();

  const taken = await db
    .prepare(`SELECT id FROM custom_pages WHERE slug = ?1 AND id <> ?2`)
    .bind(input.slug, id)
    .first<{ id: string }>();
  if (taken) return { ok: false, error: 'slug_taken' };

  const published = input.published ? 1 : 0;
  const snapshotJson = JSON.stringify({
    v: 2,
    input: {
      slug: input.slug, published: input.published, format: 'builder',
      title_en: input.title_en, title_zh: input.title_zh, layout_json: input.layoutJson,
    },
  });

  const titleUpsert = (locale: string, title: string) =>
    db
      .prepare(
        `INSERT INTO custom_page_i18n (page_id, locale, title) VALUES (?1, ?2, ?3)
         ON CONFLICT(page_id, locale) DO UPDATE SET title = ?3`,
      )
      .bind(id, locale, title);

  await db.batch([
    db
      .prepare(
        `INSERT INTO custom_pages (id, slug, published, format, layout_json, updated_at)
         VALUES (?3, ?1, ?2, 'builder', ?4, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET slug = ?1, published = ?2, format = 'builder',
           layout_json = ?4, updated_at = datetime('now')`,
      )
      .bind(input.slug, published, id, input.layoutJson),
    titleUpsert('en', input.title_en),
    titleUpsert('zh', input.title_zh),
    db
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('custom_page', ?1, ?2, ?3)`)
      .bind(id, snapshotJson, input.updatedBy),
  ]);
  return { ok: true, id };
}
```
Note: `custom_page_i18n.body_md` has `DEFAULT ''` so the title-only INSERT is valid.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/pagesDb.test.ts` → PASS. Then `npm test` → all green (the migration also runs under the e2e configs later; nothing else reads the new columns yet).

- [ ] **Step 6: Commit**

```bash
git add migrations/0007_page_builder.sql migrations-supabase/0006_page_builder.sql src/lib/pagesDb.ts test/pagesDb.test.ts
git commit -m "feat(builder): custom_pages format + layout_json columns, savePageLayout"
```

---

### Task 2: Layout tree types + validation (`src/lib/pageLayout.ts`)

**Files:**
- Create: `src/lib/pageLayout.ts`
- Test: `test/pageLayout.test.ts`

**Interfaces:**
- Consumes: nothing (pure, dependency-free — importable from workers, Node, and the browser island).
- Produces (exact names later tasks import):
  - Types: `PageLayout`, `AnyNode`, `SectionNode`, `ColumnsNode`, `LeafNode`, `HeadingNode`, `TextNode`, `ImageNode`, `ButtonNode`, `SpacerNode`, `DividerNode`, `L10nString = { en: string; zh: string }`, `LeafType`, `Align`.
  - `LAYOUT_LIMITS = { maxNodes: 300, maxJsonBytes: 200_000, maxTextLen: 20_000, maxShortLen: 500 }` (exported const).
  - `validateLayout(raw: string): { ok: true; layout: PageLayout } | { ok: false; error: string }` — `error` is a short machine code like `'bad_json'`, `'too_large'`, `'bad_node'`, not prose.
  - `emptyLayout(): PageLayout` → `{ v: 1, blocks: [] }`.
  - `SAFE_HREF: RegExp`, `SAFE_IMG_SRC: RegExp`.

- [ ] **Step 1: Write the failing tests** — `test/pageLayout.test.ts`:

```ts
// Layout-tree validation matrix (pure module, workers project). validateLayout
// is the ONLY gate between untrusted island JSON and the server renderer, so
// every containment/enum/cap rule gets a case.
import { describe, expect, it } from 'vitest';
import { validateLayout, emptyLayout, LAYOUT_LIMITS } from '../src/lib/pageLayout';

const l10n = (en: string, zh = '') => ({ en, zh });
const heading = (id = 'h1') => ({ id, type: 'heading', props: { level: 2, text: l10n('Hi'), align: 'left', size: 'md' } });
const section = (id: string, children: unknown[]) => ({ id, type: 'section', props: { bg: 'none', width: 'content', padY: 'md' }, children });
const wrap = (blocks: unknown[]) => JSON.stringify({ v: 1, blocks });

describe('validateLayout', () => {
  it('accepts an empty layout and a full kitchen-sink page', () => {
    expect(validateLayout(JSON.stringify(emptyLayout())).ok).toBe(true);
    const full = wrap([
      section('s1', [
        heading('h1'),
        { id: 't1', type: 'text', props: { md: l10n('Hello **world**'), align: 'left' } },
        { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [
          [{ id: 'i1', type: 'image', props: { src: '/media/uploads/abc-x.png', alt: l10n('pic'), width: 'medium', rounded: true, align: 'center' } }],
          [{ id: 'b1', type: 'button', props: { label: l10n('Go'), href: '/en/visit', variant: 'primary', align: 'center' } },
           { id: 'sp1', type: 'spacer', props: { size: 'md' } },
           { id: 'd1', type: 'divider', props: {} }],
        ] },
      ]),
    ]);
    const res = validateLayout(full);
    expect(res).toMatchObject({ ok: true });
  });

  it('rejects non-JSON, oversized JSON, wrong version, and non-array blocks', () => {
    expect(validateLayout('nope').ok).toBe(false);
    expect(validateLayout(JSON.stringify({ v: 2, blocks: [] })).ok).toBe(false);
    expect(validateLayout(JSON.stringify({ v: 1, blocks: {} })).ok).toBe(false);
    const big = wrap([section('s1', [{ ...heading('h1'), props: { ...heading('h1').props, text: l10n('x'.repeat(LAYOUT_LIMITS.maxJsonBytes)) } }])]);
    expect(validateLayout(big)).toEqual({ ok: false, error: 'too_large' });
  });

  it('enforces containment: leaves at top level, columns-in-columns, sections in sections all rejected', () => {
    expect(validateLayout(wrap([heading('h1')])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [section('s2', [])])])).ok).toBe(false);
    const nested = { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [[{ id: 'c2', type: 'columns', props: { count: 2, gap: 'md' }, columns: [[], []] }], []] };
    expect(validateLayout(wrap([section('s1', [nested])])).ok).toBe(false);
  });

  it('rejects unknown types, bad enums, bad/duplicate ids, and count/columns mismatch', () => {
    expect(validateLayout(wrap([section('s1', [{ id: 'x1', type: 'video', props: {} }])])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [{ ...heading('h1'), props: { ...heading().props, align: 'justify' } }])])).ok).toBe(false);
    expect(validateLayout(wrap([section('bad id!', [])])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [heading('h1'), heading('h1')])])).ok).toBe(false);
    const mismatch = { id: 'c1', type: 'columns', props: { count: 3, gap: 'md' }, columns: [[], []] };
    expect(validateLayout(wrap([section('s1', [mismatch])])).ok).toBe(false);
  });

  it('gates href and image src schemes', () => {
    const evil = { id: 'b1', type: 'button', props: { label: l10n('x'), href: 'javascript:alert(1)', variant: 'primary', align: 'left' } };
    expect(validateLayout(wrap([section('s1', [evil])])).ok).toBe(false);
    const httpImg = { id: 'i1', type: 'image', props: { src: 'http://x/y.png', alt: l10n(''), width: 'full', rounded: false, align: 'left' } };
    expect(validateLayout(wrap([section('s1', [httpImg])])).ok).toBe(false); // https or /media/uploads/ only
    const emptyImg = { id: 'i2', type: 'image', props: { src: '', alt: l10n(''), width: 'full', rounded: false, align: 'left' } };
    expect(validateLayout(wrap([section('s1', [emptyImg])])).ok).toBe(true); // fresh block, no src chosen yet
  });

  it('clamps customSizePx and enforces node count cap', () => {
    const sized = { ...heading('h1'), props: { ...heading().props, customSizePx: 9 } };
    expect(validateLayout(wrap([section('s1', [sized])])).ok).toBe(false); // below 10
    const many = section('s1', Array.from({ length: LAYOUT_LIMITS.maxNodes + 1 }, (_, i) => heading(`h${i}`)));
    expect(validateLayout(wrap([many]))).toEqual({ ok: false, error: 'too_many_nodes' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pageLayout.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/pageLayout.ts`**

```ts
// Page-builder layout tree: types + the validation gate between untrusted
// island JSON and the server renderer (spec: docs/superpowers/specs/
// 2026-07-10-page-builder-design.md). Pure and dependency-free so the same
// module runs in workerd (save/render) and the browser island (canvas).
// Containment: sections at top level only; columns only inside sections;
// leaves inside sections or columns. Text is localized per-field ({en,zh}),
// structure is shared across locales by design.

export interface L10nString { en: string; zh: string }
export type Align = 'left' | 'center' | 'right';
export type LeafType = 'heading' | 'text' | 'image' | 'button' | 'spacer' | 'divider';

export interface HeadingNode { id: string; type: 'heading'; props: { level: 1 | 2 | 3; text: L10nString; align: Align; size: 'sm' | 'md' | 'lg' | 'xl'; customSizePx?: number } }
export interface TextNode { id: string; type: 'text'; props: { md: L10nString; align: Align } }
export interface ImageNode { id: string; type: 'image'; props: { src: string; alt: L10nString; width: 'full' | 'wide' | 'medium' | 'small'; rounded: boolean; align: Align } }
export interface ButtonNode { id: string; type: 'button'; props: { label: L10nString; href: string; variant: 'primary' | 'secondary'; align: Align } }
export interface SpacerNode { id: string; type: 'spacer'; props: { size: 'sm' | 'md' | 'lg' | 'xl' } }
export interface DividerNode { id: string; type: 'divider'; props: Record<string, never> }
export type LeafNode = HeadingNode | TextNode | ImageNode | ButtonNode | SpacerNode | DividerNode;

export interface ColumnsNode { id: string; type: 'columns'; props: { count: 2 | 3 | 4; gap: 'sm' | 'md' | 'lg' }; columns: LeafNode[][] }
export interface SectionNode { id: string; type: 'section'; props: { bg: 'none' | 'soft' | 'primary' | 'accent'; width: 'narrow' | 'content' | 'wide'; padY: 'sm' | 'md' | 'lg' }; children: (ColumnsNode | LeafNode)[] }
export type AnyNode = SectionNode | ColumnsNode | LeafNode;

export interface PageLayout { v: 1; blocks: SectionNode[] }

export const LAYOUT_LIMITS = { maxNodes: 300, maxJsonBytes: 200_000, maxTextLen: 20_000, maxShortLen: 500 } as const;

/** Same scheme gate markdown.ts applies to links. */
export const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;
/** Uploaded media path or an absolute https URL (no http/data/js schemes). */
export const SAFE_IMG_SRC = /^(\/media\/uploads\/[a-z0-9][a-z0-9.-]*|https:\/\/.+)$/;

const ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export function emptyLayout(): PageLayout {
  return { v: 1, blocks: [] };
}

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// --- tiny structural checkers (no schema lib: 8 node shapes don't earn one) ---
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isL10n = (x: unknown, max: number): x is L10nString =>
  isObj(x) && typeof x.en === 'string' && typeof x.zh === 'string' && x.en.length <= max && x.zh.length <= max;
const oneOf = <T,>(x: unknown, values: readonly T[]): x is T => values.includes(x as T);

const ALIGNS = ['left', 'center', 'right'] as const;

function checkLeaf(node: Record<string, unknown>): boolean {
  const p = node.props;
  if (!isObj(p)) return false;
  switch (node.type) {
    case 'heading':
      return oneOf(p.level, [1, 2, 3] as const) && isL10n(p.text, LAYOUT_LIMITS.maxShortLen) &&
        oneOf(p.align, ALIGNS) && oneOf(p.size, ['sm', 'md', 'lg', 'xl'] as const) &&
        (p.customSizePx === undefined || (typeof p.customSizePx === 'number' && p.customSizePx >= 10 && p.customSizePx <= 120));
    case 'text':
      return isL10n(p.md, LAYOUT_LIMITS.maxTextLen) && oneOf(p.align, ALIGNS);
    case 'image':
      // '' allowed: a freshly dropped image block has no src yet (the public
      // renderer skips the <img> until one is chosen).
      return typeof p.src === 'string' && (p.src === '' || SAFE_IMG_SRC.test(p.src)) && p.src.length <= LAYOUT_LIMITS.maxShortLen &&
        isL10n(p.alt, LAYOUT_LIMITS.maxShortLen) &&
        oneOf(p.width, ['full', 'wide', 'medium', 'small'] as const) &&
        typeof p.rounded === 'boolean' && oneOf(p.align, ALIGNS);
    case 'button':
      return isL10n(p.label, LAYOUT_LIMITS.maxShortLen) &&
        typeof p.href === 'string' && SAFE_HREF.test(p.href) && p.href.length <= LAYOUT_LIMITS.maxShortLen &&
        oneOf(p.variant, ['primary', 'secondary'] as const) && oneOf(p.align, ALIGNS);
    case 'spacer':
      return oneOf(p.size, ['sm', 'md', 'lg', 'xl'] as const);
    case 'divider':
      return true;
    default:
      return false;
  }
}

/**
 * Parse + validate an untrusted layout JSON string. Returns the parsed tree on
 * success so callers render/persist exactly what was validated. Error codes
 * (not prose): bad_json, too_large, bad_root, too_many_nodes, bad_node.
 */
export function validateLayout(raw: string): { ok: true; layout: PageLayout } | Fail {
  if (raw.length > LAYOUT_LIMITS.maxJsonBytes) return fail('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('bad_json');
  }
  if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.blocks)) return fail('bad_root');

  const seen = new Set<string>();
  let count = 0;
  const claimId = (node: Record<string, unknown>): boolean => {
    count += 1;
    if (typeof node.id !== 'string' || !ID_RE.test(node.id) || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  };

  for (const sec of parsed.blocks) {
    if (!isObj(sec) || sec.type !== 'section' || !claimId(sec)) return fail('bad_node');
    const sp = sec.props;
    if (!isObj(sp) || !oneOf(sp.bg, ['none', 'soft', 'primary', 'accent'] as const) ||
        !oneOf(sp.width, ['narrow', 'content', 'wide'] as const) ||
        !oneOf(sp.padY, ['sm', 'md', 'lg'] as const) || !Array.isArray(sec.children)) return fail('bad_node');
    for (const child of sec.children) {
      if (!isObj(child) || !claimId(child)) return fail('bad_node');
      if (child.type === 'columns') {
        const cp = child.props;
        if (!isObj(cp) || !oneOf(cp.count, [2, 3, 4] as const) || !oneOf(cp.gap, ['sm', 'md', 'lg'] as const) ||
            !Array.isArray(child.columns) || child.columns.length !== cp.count) return fail('bad_node');
        for (const col of child.columns) {
          if (!Array.isArray(col)) return fail('bad_node');
          for (const leaf of col) {
            if (!isObj(leaf) || !claimId(leaf) || !checkLeaf(leaf)) return fail('bad_node');
          }
        }
      } else if (!checkLeaf(child)) {
        return fail('bad_node');
      }
    }
  }
  if (count > LAYOUT_LIMITS.maxNodes) return fail('too_many_nodes');
  return { ok: true, layout: parsed as unknown as PageLayout };
}
```
Note on the node-count test: the cap check runs after the walk, so `too_many_nodes` wins over per-node errors only when all nodes are valid — the test's 301 headings are valid nodes, so it returns `too_many_nodes` as asserted. (If you find the count check must short-circuit inside the loop for the too_large interplay, keep the error codes as asserted by the tests.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/pageLayout.test.ts` → PASS. Fix any assertion/order mismatch by adjusting the implementation, not the intent of the tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pageLayout.ts test/pageLayout.test.ts
git commit -m "feat(builder): layout tree types + validation gate"
```

---

### Task 3: Shared style maps (`src/lib/blockStyles.ts`)

**Files:**
- Create: `src/lib/blockStyles.ts`
- Test: `test/blockStyles.test.ts`

**Interfaces:**
- Consumes: types from `./pageLayout`.
- Produces (exact signatures — the Astro renderer AND the React canvas import these):
  - `sectionOuterClass(props: SectionNode['props']): string` — bg band classes for the full-width wrapper.
  - `sectionInnerClass(props: SectionNode['props']): string` — container width + vertical padding.
  - `columnsClass(props: ColumnsNode['props']): string`
  - `headingRender(props: HeadingNode['props']): { className: string; style?: { fontSize: string } }`
  - `textClass(props: TextNode['props']): string` (includes `prose`)
  - `imageRender(props: ImageNode['props']): { wrapperClass: string; imgClass: string }`
  - `buttonRender(props: ButtonNode['props']): { wrapperClass: string; linkClass: string }`
  - `spacerClass(props: SpacerNode['props']): string`
  - `dividerClass(): string`

- [ ] **Step 1: Write the failing tests** — `test/blockStyles.test.ts`:

```ts
// Style-map totality: every enum value must map to a non-empty, token-only
// class string (the class literals living HERE is what makes Tailwind 4's
// static analysis keep them — the "safelist" is this module's source).
import { describe, expect, it } from 'vitest';
import {
  sectionOuterClass, sectionInnerClass, columnsClass, headingRender,
  textClass, imageRender, buttonRender, spacerClass, dividerClass,
} from '../src/lib/blockStyles';

const BASE_HEADING = { level: 2 as const, text: { en: '', zh: '' }, align: 'left' as const, size: 'md' as const };

describe('blockStyles totality', () => {
  it('every section bg/width/padY combination yields classes', () => {
    for (const bg of ['none', 'soft', 'primary', 'accent'] as const)
      for (const width of ['narrow', 'content', 'wide'] as const)
        for (const padY of ['sm', 'md', 'lg'] as const) {
          const outer = sectionOuterClass({ bg, width, padY });
          const inner = sectionInnerClass({ bg, width, padY });
          expect(inner).toContain(`container-${width}`);
          expect(inner).toMatch(/py-/);
          if (bg !== 'none') expect(outer.length).toBeGreaterThan(0);
        }
  });

  it('columns map count and gap', () => {
    for (const count of [2, 3, 4] as const)
      for (const gap of ['sm', 'md', 'lg'] as const) {
        const cls = columnsClass({ count, gap });
        expect(cls).toContain('grid');
        expect(cls).toMatch(/gap-/);
      }
  });

  it('heading sizes map; customSizePx becomes an inline style override', () => {
    for (const size of ['sm', 'md', 'lg', 'xl'] as const)
      expect(headingRender({ ...BASE_HEADING, size }).className).toMatch(/text-/);
    const custom = headingRender({ ...BASE_HEADING, customSizePx: 43 });
    expect(custom.style).toEqual({ fontSize: '43px' });
  });

  it('image, button, spacer, divider, text all render classes', () => {
    for (const width of ['full', 'wide', 'medium', 'small'] as const) {
      const r = imageRender({ src: '', alt: { en: '', zh: '' }, width, rounded: true, align: 'center' });
      expect(r.imgClass.length).toBeGreaterThan(0);
      expect(r.wrapperClass).toContain('flex');
    }
    for (const variant of ['primary', 'secondary'] as const)
      expect(buttonRender({ label: { en: '', zh: '' }, href: '/', variant, align: 'left' }).linkClass).toMatch(/rounded-full/);
    for (const size of ['sm', 'md', 'lg', 'xl'] as const) expect(spacerClass({ size })).toMatch(/h-/);
    expect(dividerClass()).toContain('border-t');
    expect(textClass({ md: { en: '', zh: '' }, align: 'right' })).toContain('prose');
  });

  it('no literal colors anywhere in the emitted classes', () => {
    const all = [
      sectionOuterClass({ bg: 'accent', width: 'wide', padY: 'lg' }),
      buttonRender({ label: { en: '', zh: '' }, href: '/', variant: 'primary', align: 'left' }).linkClass,
    ].join(' ');
    expect(all).not.toMatch(/#[0-9a-fA-F]{3}|rgb|hsl/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/blockStyles.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/blockStyles.ts`**

```ts
// Block → class/style maps, the ONE source both renderers share (the Astro
// public renderer in src/components/blocks and the React canvas in
// src/components/builder), so editor preview and published page cannot drift.
// Every class literal is written out statically: Tailwind 4's scanner keeps a
// utility because it appears HERE — this module IS the safelist. Token
// utilities only (tokens:check); the sole arbitrary user value, a custom
// heading size, exits through an inline style object per the design spec.
import type {
  SectionNode, ColumnsNode, HeadingNode, TextNode, ImageNode, ButtonNode, SpacerNode,
} from './pageLayout';

type Align = 'left' | 'center' | 'right';
const TEXT_ALIGN: Record<Align, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };
const FLEX_ALIGN: Record<Align, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };

const SECTION_BG: Record<SectionNode['props']['bg'], string> = {
  none: '',
  soft: 'bg-surface-sunken',
  primary: 'bg-primary-soft text-on-primary-soft',
  accent: 'bg-accent-soft text-on-accent-soft',
};
const SECTION_PAD: Record<SectionNode['props']['padY'], string> = { sm: 'py-6', md: 'py-10', lg: 'py-16' };
const SECTION_WIDTH: Record<SectionNode['props']['width'], string> = {
  narrow: 'container-narrow', content: 'container-content', wide: 'container-wide',
};

export function sectionOuterClass(props: SectionNode['props']): string {
  return SECTION_BG[props.bg];
}
export function sectionInnerClass(props: SectionNode['props']): string {
  return `${SECTION_WIDTH[props.width]} ${SECTION_PAD[props.padY]}`;
}

const COLUMNS_COUNT: Record<ColumnsNode['props']['count'], string> = {
  2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4',
};
const COLUMNS_GAP: Record<ColumnsNode['props']['gap'], string> = { sm: 'gap-4', md: 'gap-6', lg: 'gap-10' };

export function columnsClass(props: ColumnsNode['props']): string {
  return `grid ${COLUMNS_COUNT[props.count]} ${COLUMNS_GAP[props.gap]}`;
}

const HEADING_SIZE: Record<HeadingNode['props']['size'], string> = {
  sm: 'text-heading-sm', md: 'text-heading-md', lg: 'text-display-lg', xl: 'text-display-xl',
};

export function headingRender(props: HeadingNode['props']): { className: string; style?: { fontSize: string } } {
  const className = `font-display font-bold break-words ${HEADING_SIZE[props.size]} ${TEXT_ALIGN[props.align]}`;
  return props.customSizePx ? { className, style: { fontSize: `${props.customSizePx}px` } } : { className };
}

export function textClass(props: TextNode['props']): string {
  return `prose ${TEXT_ALIGN[props.align]}`;
}

const IMAGE_WIDTH: Record<ImageNode['props']['width'], string> = {
  full: 'w-full', wide: 'w-full max-w-3xl', medium: 'w-full max-w-xl', small: 'w-full max-w-sm',
};

export function imageRender(props: ImageNode['props']): { wrapperClass: string; imgClass: string } {
  return {
    wrapperClass: `flex ${FLEX_ALIGN[props.align]}`,
    imgClass: `${IMAGE_WIDTH[props.width]} h-auto${props.rounded ? ' rounded-xl' : ''}`,
  };
}

const BUTTON_VARIANT: Record<ButtonNode['props']['variant'], string> = {
  // Mirrors the public CTA idiom (see PrayerForm.astro's submit button).
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'border border-border-strong text-ink hover:bg-surface-sunken',
};

export function buttonRender(props: ButtonNode['props']): { wrapperClass: string; linkClass: string } {
  return {
    wrapperClass: `flex ${FLEX_ALIGN[props.align]}`,
    linkClass: `inline-block rounded-full px-8 py-3 font-semibold no-underline ${BUTTON_VARIANT[props.variant]}`,
  };
}

const SPACER_SIZE: Record<SpacerNode['props']['size'], string> = { sm: 'h-4', md: 'h-8', lg: 'h-16', xl: 'h-24' };
export function spacerClass(props: SpacerNode['props']): string {
  return SPACER_SIZE[props.size];
}

export function dividerClass(): string {
  return 'border-t border-border';
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/blockStyles.test.ts` → PASS. Also `npm run tokens:check` → PASS (no literals).

- [ ] **Step 5: Commit**

```bash
git add src/lib/blockStyles.ts test/blockStyles.test.ts
git commit -m "feat(builder): shared block style maps (canvas + public renderer)"
```

---

### Task 4: Zero-JS public renderer + `/[locale]/p/[slug]` format branch

**Files:**
- Create: `src/components/blocks/LeafBlock.astro`
- Create: `src/components/blocks/PageBlocks.astro`
- Modify: `src/pages/[locale]/p/[slug].astro`
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts` (one key)
- Test: `test/e2e/pageBuilder.e2e.test.ts` (created here with the public-rendering cases; Task 7 appends admin cases)

**Interfaces:**
- Consumes: `validateLayout`, `PageLayout`, `LeafNode`, `L10nString` from `src/lib/pageLayout`; all `blockStyles` functions; `renderMarkdown` from `src/lib/markdown`; `getCustomPageBySlug` (now returning `format`/`layout_json` from Task 1).
- Produces: `<PageBlocks layout={PageLayout} locale={Locale} />` — the only entry point Task 7's view links and future callers need.

- [ ] **Step 1: Add the i18n key** — in `src/i18n/en.ts` next to `'pages.draftNotice'`:
```ts
  'pages.layoutInvalid': 'This page has invalid layout data. Open it in the page builder and re-save.',
```
and in `src/i18n/zh.ts` at the same spot:
```ts
  'pages.layoutInvalid': '此页面的布局数据无效，请在页面构建器中重新保存。',
```

- [ ] **Step 2: Write the failing e2e tests** — `test/e2e/pageBuilder.e2e.test.ts`:

```ts
// Page-builder e2e against the BUILT worker. This file covers the public
// zero-JS rendering path (builder-format pages render their layout tree as
// plain HTML with no island); test/e2e/customPages.e2e.test.ts still covers
// the markdown path. Admin/builder-route cases are appended by Task 7.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { savePageLayout } from '../../src/lib/pagesDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

const LAYOUT = JSON.stringify({
  v: 1,
  blocks: [
    {
      id: 's1', type: 'section',
      props: { bg: 'primary', width: 'content', padY: 'lg' },
      children: [
        { id: 'h1', type: 'heading', props: { level: 1, text: { en: 'Welcome Home', zh: '欢迎回家' }, align: 'center', size: 'xl' } },
        { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [
          [{ id: 't1', type: 'text', props: { md: { en: 'We are **glad** you came.', zh: '' }, align: 'left' } }],
          [{ id: 'b1', type: 'button', props: { label: { en: 'Plan a visit', zh: '计划来访' }, href: '/en/visit', variant: 'primary', align: 'center' } }],
        ] },
      ],
    },
  ],
});

describe('builder pages render zero-JS on the public route', () => {
  it('a published builder page renders sections, columns, markdown text, and button — with NO island', async () => {
    await savePageLayout(env.DB, {
      id: null, slug: 'e2e-built', published: true,
      title_en: 'Built Page', title_zh: '构建页', layoutJson: LAYOUT, updatedBy: 'e@x',
    });
    const res = await get('/en/p/e2e-built');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Welcome Home');                       // heading text (en)
    expect(html).toContain('bg-primary-soft');                    // section bg class
    expect(html).toContain('container-content');                  // section width class
    expect(html).toContain('sm:grid-cols-2');                     // columns class
    expect(html).toContain('We are <strong>glad</strong> you came.'); // markdown-rendered text
    expect(html).toContain('Plan a visit');                       // button label
    expect(html).not.toContain('astro-island');                   // zero client JS
  });

  it('zh locale picks zh text and falls back per-field to en', async () => {
    const res = await get('/zh/p/e2e-built');
    const html = await res.text();
    expect(html).toContain('欢迎回家');                              // zh heading
    expect(html).toContain('We are <strong>glad</strong> you came.'); // text falls back to en (zh empty)
  });

  it('a corrupt stored layout renders empty for anon and shows a notice to an editor', async () => {
    const created = await savePageLayout(env.DB, {
      id: null, slug: 'e2e-corrupt', published: true,
      title_en: 'Corrupt', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    if (!created.ok) throw new Error('seed failed');
    await env.DB.prepare(`UPDATE custom_pages SET layout_json = '{"v":9}' WHERE id = ?1`).bind(created.id).run();

    const anon = await get('/en/p/e2e-corrupt');
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain('invalid layout data');

    const editor = await get('/en/p/e2e-corrupt', { cookie: await sessionCookie(2, 'pastor.david@example.com') });
    expect(await editor.text()).toContain('invalid layout data');
  });
});
```

- [ ] **Step 3: Implement `src/components/blocks/LeafBlock.astro`**

```astro
---
// One leaf block → plain HTML. Class/style come from src/lib/blockStyles (the
// module shared with the builder canvas); text falls back per-field to the
// other locale, mirroring the site-wide i18n convention. Text blocks go
// through renderMarkdown (XSS-safe: input is fully escaped before transforms).
import { renderMarkdown } from '../../lib/markdown';
import {
  headingRender, textClass, imageRender, buttonRender, spacerClass, dividerClass,
} from '../../lib/blockStyles';
import type { LeafNode, L10nString } from '../../lib/pageLayout';
import type { Locale } from '../../lib/locales';

interface Props { node: LeafNode; locale: Locale }
const { node, locale } = Astro.props;
const pick = (s: L10nString): string => (locale === 'zh' ? s.zh || s.en : s.en || s.zh);
---

{
  node.type === 'heading' &&
    (() => {
      const r = headingRender(node.props);
      const Tag = `h${node.props.level}` as 'h1' | 'h2' | 'h3';
      return (
        <Tag class={r.className} style={r.style}>
          {pick(node.props.text)}
        </Tag>
      );
    })()
}
{node.type === 'text' && <div class={textClass(node.props)} set:html={renderMarkdown(pick(node.props.md))} />}
{
  node.type === 'image' && node.props.src &&
    (() => {
      const r = imageRender(node.props);
      return (
        <div class={r.wrapperClass}>
          <img src={node.props.src} alt={pick(node.props.alt)} class={r.imgClass} loading="lazy" />
        </div>
      );
    })()
}
{
  node.type === 'button' &&
    (() => {
      const r = buttonRender(node.props);
      return (
        <div class={r.wrapperClass}>
          <a href={node.props.href} class={r.linkClass}>{pick(node.props.label)}</a>
        </div>
      );
    })()
}
{node.type === 'spacer' && <div class={spacerClass(node.props)} aria-hidden="true" />}
{node.type === 'divider' && <hr class={dividerClass()} />}
```

- [ ] **Step 4: Implement `src/components/blocks/PageBlocks.astro`**

```astro
---
// Server-side renderer for the page-builder layout tree: JSON in, semantic
// HTML out, zero client JS (the builder island exists only under /admin).
// Sections own their own width containers, so callers render this full-bleed.
import LeafBlock from './LeafBlock.astro';
import { sectionOuterClass, sectionInnerClass, columnsClass } from '../../lib/blockStyles';
import type { PageLayout } from '../../lib/pageLayout';
import type { Locale } from '../../lib/locales';

interface Props { layout: PageLayout; locale: Locale }
const { layout, locale } = Astro.props;
---

{
  layout.blocks.map((section) => (
    <section class={sectionOuterClass(section.props)}>
      <div class={`${sectionInnerClass(section.props)} space-y-6`}>
        {section.children.map((child) =>
          child.type === 'columns' ? (
            <div class={columnsClass(child.props)}>
              {child.columns.map((col) => (
                <div class="space-y-6">
                  {col.map((leaf) => (
                    <LeafBlock node={leaf} locale={locale} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <LeafBlock node={child} locale={locale} />
          ),
        )}
      </div>
    </section>
  ))
}
```

- [ ] **Step 5: Branch `src/pages/[locale]/p/[slug].astro`**

Replace the file's body (keep the frontmatter top up to `const loc = ...` intact) so builder pages skip ContentPage's prose shell and render full-bleed under Base (the author owns the whole canvas — no forced title band):

```astro
---
// (keep the existing header comment and imports, and add:)
import Base from '../../../layouts/Base.astro';
import PageBlocks from '../../../components/blocks/PageBlocks.astro';
import { validateLayout } from '../../../lib/pageLayout';

// ... existing locale/page/canPreview/404 logic stays unchanged ...

const loc = page.i18n[locale];
const fallback = page.i18n.en;
const title = loc.title || fallback.title;

// Builder pages: validate the stored tree; a corrupt blob renders an empty
// page (defensive-parse convention) plus a notice only editors can see.
const isBuilder = page.format === 'builder';
const layoutResult = isBuilder ? validateLayout(page.layout_json ?? '') : null;
const layout = layoutResult?.ok ? layoutResult.layout : null;

const bodyMd = loc.body_md || fallback.body_md;
const html = isBuilder ? '' : renderMarkdown(bodyMd);
---

{
  isBuilder ? (
    <Base title={title} locale={locale}>
      {(!page.published || (canPreview && !layout)) && (
        <div class="container-content pt-6 space-y-3">
          {!page.published && (
            <div class="rounded-md border border-border bg-info-soft text-info px-4 py-3 text-sm">
              {t(locale, 'pages.draftNotice')}
            </div>
          )}
          {canPreview && !layout && (
            <div class="rounded-md border border-border bg-warn-soft px-4 py-3 text-sm">
              {t(locale, 'pages.layoutInvalid')}
            </div>
          )}
        </div>
      )}
      {layout && <PageBlocks layout={layout} locale={locale} />}
    </Base>
  ) : (
    <ContentPage title={title} locale={locale}>
      {!page.published && (
        <div slot="before" class="rounded-md border border-border bg-info-soft text-info px-4 py-3 text-sm">
          {t(locale, 'pages.draftNotice')}
        </div>
      )}
      <Fragment set:html={html} />
    </ContentPage>
  )
}
```
(Check `bg-warn-soft` pairs with readable ink — the token exists; if the site pairs it with a `text-*`, copy the pairing used by an existing warn banner; if none exists, use `text-ink`.)

- [ ] **Step 6: Run the e2e suite**

Run: `npm run test:e2e -- test/e2e/pageBuilder.e2e.test.ts` (builds first). All three tests PASS. Then `npm test` (i18n parity picks up the new key) → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/blocks src/pages/[locale]/p/[slug].astro src/i18n/en.ts src/i18n/zh.ts test/e2e/pageBuilder.e2e.test.ts
git commit -m "feat(builder): zero-JS public renderer for builder-format pages"
```

---

### Task 5: `page-builder` module wiring

**Files:**
- Modify: `src/lib/modules.ts`
- Modify: `src/pages/admin/settings/index.astro` (Content group)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts` (label + desc)
- Test: `test/modules.test.ts` (append)

**Interfaces:**
- Consumes: existing module registry machinery (nothing new).
- Produces: `ModuleKey` union gains `'page-builder'`; `Astro.locals.modules.has('page-builder')` works everywhere (Tasks 7 & 10 rely on it); middleware 404-gates `/admin/pages/builder/**` when off.

- [ ] **Step 1: Write the failing test** — append to `test/modules.test.ts` (match its existing style):

```ts
describe('page-builder module', () => {
  it('owns the builder admin prefix; the classic pages admin stays core', () => {
    expect(moduleForPath('/admin/pages/builder')).toBe('page-builder');
    expect(moduleForPath('/admin/pages/builder/new')).toBe('page-builder');
    expect(moduleForPath('/admin/pages/builder/123-abc')).toBe('page-builder');
    expect(moduleForPath('/admin/pages')).toBeNull();
    expect(moduleForPath('/p/about')).toBeNull(); // public rendering never gated
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/modules.test.ts` → FAIL (`'page-builder'` not a ModuleKey / returns null).

- [ ] **Step 3: Implement**

In `src/lib/modules.ts`: add `'page-builder',` to `MODULE_KEYS` immediately after `'children',` (before the backend-gated tail — keep the comment about `giving`/`registration` last accurate), and to `MODULES`:

```ts
  'page-builder': {
    // Gates AUTHORING only: published builder pages keep rendering when off
    // (the /p/ route and block renderer are core, like the people module's
    // panels) — a module toggle never breaks live content.
    publicPrefixes: [],
    adminPrefixes: ['/admin/pages/builder'],
    navKeys: [],
    uses: [],
  },
```
Update the file-header comment's module count (15 → it says "The 15 module keys" on the portal branch but this base says 14 — make it match reality: 15 with page-builder).

In `src/pages/admin/settings/index.astro`, add `'page-builder'` to the Content group:
```ts
  { titleKey: 'admin.settings.modulesContentGroup', keys: ['bulletins', 'sermons', 'prayer-sheets', 'articles', 'fellowships', 'page-builder'] },
```

In `src/i18n/en.ts` (next to the other `modules.*` pairs):
```ts
  'modules.page-builder.label': 'Page Builder',
  'modules.page-builder.desc': 'Drag-and-drop layout editor for custom pages. Published pages keep rendering when this is off.',
```
In `src/i18n/zh.ts`:
```ts
  'modules.page-builder.label': '页面构建器',
  'modules.page-builder.desc': '自定义页面的拖放布局编辑器。关闭后已发布的页面仍会正常显示。',
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/modules.test.ts test/moduleGating.test.ts` → PASS (gating test iterates MODULE_KEYS; if it asserts a hardcoded count, update that count). Then `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/modules.ts src/pages/admin/settings/index.astro src/i18n/en.ts src/i18n/zh.ts test/modules.test.ts
git commit -m "feat(builder): page-builder optional module (gates authoring only)"
```

---

### Task 6: React + @dnd-kit integration

**Files:**
- Modify: `package.json` (via npm install), `astro.config.mjs`, `tsconfig.json`

**Interfaces:**
- Produces: `.tsx` components compile and hydrate via `client:only="react"`; Tasks 7-9 depend on this toolchain.

- [ ] **Step 1: Install**

```bash
npm install react react-dom @astrojs/react @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
npm install -D @types/react @types/react-dom
```
(Expected: react 19.x, @astrojs/react 6.x, @dnd-kit/core 6.3.x, @dnd-kit/sortable 10.x.)

- [ ] **Step 2: Wire the integration** — `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://church.yunfei-song.com',
  // Every route renders per-user (session, language); server output means a
  // forgotten `prerender = false` can never leak one user's page to another.
  output: 'server',
  adapter: cloudflare(),
  // React exists for ONE admin island (the page builder, client:only) — public
  // pages stay zero-JS and the worker never server-renders React.
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // Lets a Docker-hosted headless browser reach astro dev/preview for visual checks.
    server: { allowedHosts: ['host.docker.internal'] },
    preview: { allowedHosts: ['host.docker.internal'] },
  },
});
```

`tsconfig.json` compilerOptions gain:
```json
    "jsx": "react-jsx",
    "jsxImportSource": "react"
```

- [ ] **Step 3: Verify the toolchain**

Run: `npm run tokens && npm run build` → build succeeds. Run: `npm test` → still green.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json astro.config.mjs tsconfig.json
git commit -m "feat(builder): add React + @dnd-kit for the admin builder island"
```

---

### Task 7: Builder route — GET mount + POST save/upload (server side)

**Files:**
- Modify: `src/lib/validate.ts` (add `parseBuilderSave`)
- Modify: `src/lib/upload.ts` (add `listRecentImages`)
- Create: `src/pages/admin/pages/builder/[id].astro`
- Create: `src/components/builder/PageBuilder.tsx` (walking-skeleton stub this task; Tasks 8-9 flesh it out)
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts` (builder strings)
- Test: `test/e2e/pageBuilder.e2e.test.ts` (append), `test/validate.test.ts` (append if the file exists — check; otherwise the e2e covers the parser)

**Interfaces:**
- Consumes: `savePageLayout`, `getCustomPage` (Task 1), `validateLayout`/`emptyLayout` (Task 2), `saveImageUpload`/`uploadErrorKey` (existing), module gate (Task 5), React toolchain (Task 6).
- Produces (Tasks 8-9 island contract — EXACT prop names):
  ```ts
  interface PageBuilderProps {
    pageId: string | null;          // null for /new
    slug: string;
    published: boolean;
    titleEn: string;
    titleZh: string;
    layoutJson: string;             // valid JSON, emptyLayout() for new/corrupt
    media: { path: string; filename: string }[];
    strings: Record<string, string>; // admin.builder.* with prefix stripped
    uiLang: 'en' | 'zh';
  }
  ```
  POST contract (JSON): `{action:'save', id, slug, published, title_en, title_zh, layout}` →
  `200 {ok:true, id}` | `409 {ok:false, error:'slug_taken'}` | `400 {ok:false, error:'invalid_layout'|'bad_request'|'slug'|'title'}`.
  POST contract (multipart): `action=upload`, `file` → `200 {ok:true, key, path}` | `400 {ok:false, error:'<i18n key from uploadErrorKey>'}`.

- [ ] **Step 1: Add `parseBuilderSave` to `src/lib/validate.ts`** (below `parseCustomPageForm`, reusing `SLUG_RE`; note it validates a parsed JSON body, not FormData):

```ts
export interface BuilderSaveInput {
  id: string | null;
  slug: string;
  published: boolean;
  title_en: string;
  title_zh: string;
  /** The raw layout subtree, NOT yet validated — route passes it to validateLayout. */
  layout: unknown;
}

/**
 * Parse the builder island's JSON save body (same rules as parseCustomPageForm
 * for slug/titles; no bodies — builder pages carry a layout tree instead).
 * The layout itself is validated separately by pageLayout.validateLayout.
 */
export function parseBuilderSave(body: unknown): FormResult<BuilderSaveInput> {
  if (typeof body !== 'object' || body === null) return { ok: false, errors: { form: ERR.required } };
  const b = body as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : null;

  const slug = String(b.slug ?? '').trim().toLowerCase();
  if (!slug) errors.slug = ERR.required;
  else if (slug.length > 64 || !SLUG_RE.test(slug)) errors.slug = ERR.slug;

  const title_en = String(b.title_en ?? '').trim();
  const title_zh = String(b.title_zh ?? '').trim();
  if (!title_en && !title_zh) errors.title = ERR.required;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { id, slug, published: b.published === true, title_en, title_zh, layout: b.layout } };
}
```

- [ ] **Step 2: Add `listRecentImages` to `src/lib/upload.ts`**:

```ts
export interface RecentImage {
  /** Servable path (/media/uploads/...) — what an image block stores as src. */
  path: string;
  filename: string;
}

/** Latest uploaded images for the builder's media picker, newest first. */
export async function listRecentImages(db: AppDb, limit = 50): Promise<RecentImage[]> {
  const { results } = await db
    .prepare(
      `SELECT r2_key AS key, filename FROM media
       WHERE content_type LIKE 'image/%'
       ORDER BY uploaded_at DESC, id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<{ key: string; filename: string }>();
  return results.map((r) => ({ path: `/media/${r.key}`, filename: r.filename }));
}
```

- [ ] **Step 3: Builder i18n strings** — append to `src/i18n/en.ts` (new `admin.builder.*` section after the `admin.pages.*` keys) and mirror in zh. The island receives these with the `admin.builder.` prefix stripped (e.g. `strings.save`).

```ts
  // Page builder (admin island)
  'admin.builder.title': 'Page builder',
  'admin.builder.back': 'All pages',
  'admin.builder.save': 'Save',
  'admin.builder.savePublish': 'Save & publish',
  'admin.builder.saving': 'Saving…',
  'admin.builder.saved': 'Saved',
  'admin.builder.unsaved': 'Unsaved changes',
  'admin.builder.undo': 'Undo',
  'admin.builder.redo': 'Redo',
  'admin.builder.editingIn': 'Editing text in',
  'admin.builder.localeEn': 'English',
  'admin.builder.localeZh': '中文',
  'admin.builder.slug': 'Slug',
  'admin.builder.titleEn': 'Title (English)',
  'admin.builder.titleZh': 'Title (Chinese)',
  'admin.builder.published': 'Published',
  'admin.builder.view': 'View on site',
  'admin.builder.blocks': 'Blocks',
  'admin.builder.dragHint': 'Drag blocks onto the canvas, or click to append.',
  'admin.builder.emptyCanvas': 'Empty page — add a section to start.',
  'admin.builder.emptySection': 'Drop blocks here',
  'admin.builder.block.section': 'Section',
  'admin.builder.block.columns': 'Columns',
  'admin.builder.block.heading': 'Heading',
  'admin.builder.block.text': 'Text',
  'admin.builder.block.image': 'Image',
  'admin.builder.block.button': 'Button',
  'admin.builder.block.spacer': 'Spacer',
  'admin.builder.block.divider': 'Divider',
  'admin.builder.props': 'Properties',
  'admin.builder.propsNone': 'Select a block to edit its properties.',
  'admin.builder.prop.level': 'Heading level',
  'admin.builder.prop.size': 'Size',
  'admin.builder.prop.customSize': 'Custom size (px, 10-120, overrides Size)',
  'admin.builder.prop.align': 'Alignment',
  'admin.builder.prop.text': 'Text',
  'admin.builder.prop.markdownHint': 'Markdown: **bold**, *italic*, [link](url), lists.',
  'admin.builder.prop.background': 'Background',
  'admin.builder.prop.width': 'Width',
  'admin.builder.prop.padding': 'Vertical padding',
  'admin.builder.prop.columns': 'Columns',
  'admin.builder.prop.gap': 'Gap',
  'admin.builder.prop.imageUrl': 'Image URL',
  'admin.builder.prop.altText': 'Alt text',
  'admin.builder.prop.rounded': 'Rounded corners',
  'admin.builder.prop.label': 'Label',
  'admin.builder.prop.href': 'Link URL',
  'admin.builder.prop.variant': 'Style',
  'admin.builder.prop.variantPrimary': 'Primary',
  'admin.builder.prop.variantSecondary': 'Secondary',
  'admin.builder.prop.height': 'Height',
  'admin.builder.upload': 'Upload image',
  'admin.builder.uploading': 'Uploading…',
  'admin.builder.recentUploads': 'Recent uploads',
  'admin.builder.delete': 'Delete block',
  'admin.builder.duplicate': 'Duplicate block',
  'admin.builder.opt.none': 'None',
  'admin.builder.opt.soft': 'Soft',
  'admin.builder.opt.primary': 'Primary',
  'admin.builder.opt.accent': 'Accent',
  'admin.builder.opt.narrow': 'Narrow',
  'admin.builder.opt.content': 'Content',
  'admin.builder.opt.wide': 'Wide',
  'admin.builder.opt.left': 'Left',
  'admin.builder.opt.center': 'Center',
  'admin.builder.opt.right': 'Right',
  'admin.builder.opt.sm': 'Small',
  'admin.builder.opt.md': 'Medium',
  'admin.builder.opt.lg': 'Large',
  'admin.builder.opt.xl': 'Extra large',
  'admin.builder.opt.full': 'Full',
  'admin.builder.err.saveFailed': 'Save failed — check the fields and try again.',
  'admin.builder.err.slugTaken': 'That slug is already used by another page.',
  'admin.builder.err.invalidLayout': 'The layout could not be validated. Undo the last change and try again.',
  'admin.builder.err.uploadFailed': 'Upload failed: image must be JPEG/PNG/WebP/GIF under 10 MB.',
  'admin.builder.confirmLeave': 'You have unsaved changes.',
```

zh mirrors (same keys, Simplified Chinese values):
```ts
  // Page builder (admin island)
  'admin.builder.title': '页面构建器',
  'admin.builder.back': '所有页面',
  'admin.builder.save': '保存',
  'admin.builder.savePublish': '保存并发布',
  'admin.builder.saving': '保存中…',
  'admin.builder.saved': '已保存',
  'admin.builder.unsaved': '有未保存的更改',
  'admin.builder.undo': '撤销',
  'admin.builder.redo': '重做',
  'admin.builder.editingIn': '当前编辑语言',
  'admin.builder.localeEn': 'English',
  'admin.builder.localeZh': '中文',
  'admin.builder.slug': 'Slug（网址标识）',
  'admin.builder.titleEn': '标题（英文）',
  'admin.builder.titleZh': '标题（中文）',
  'admin.builder.published': '已发布',
  'admin.builder.view': '在网站上查看',
  'admin.builder.blocks': '区块',
  'admin.builder.dragHint': '将区块拖到画布上，或点击追加。',
  'admin.builder.emptyCanvas': '空白页面——先添加一个栏目开始。',
  'admin.builder.emptySection': '将区块拖放到这里',
  'admin.builder.block.section': '栏目',
  'admin.builder.block.columns': '分栏',
  'admin.builder.block.heading': '标题',
  'admin.builder.block.text': '文本',
  'admin.builder.block.image': '图片',
  'admin.builder.block.button': '按钮',
  'admin.builder.block.spacer': '间距',
  'admin.builder.block.divider': '分隔线',
  'admin.builder.props': '属性',
  'admin.builder.propsNone': '选择一个区块以编辑其属性。',
  'admin.builder.prop.level': '标题级别',
  'admin.builder.prop.size': '大小',
  'admin.builder.prop.customSize': '自定义大小（px，10-120，覆盖“大小”）',
  'admin.builder.prop.align': '对齐',
  'admin.builder.prop.text': '文字',
  'admin.builder.prop.markdownHint': 'Markdown：**粗体**、*斜体*、[链接](网址)、列表。',
  'admin.builder.prop.background': '背景',
  'admin.builder.prop.width': '宽度',
  'admin.builder.prop.padding': '上下间距',
  'admin.builder.prop.columns': '栏数',
  'admin.builder.prop.gap': '栏间距',
  'admin.builder.prop.imageUrl': '图片地址',
  'admin.builder.prop.altText': '替代文字',
  'admin.builder.prop.rounded': '圆角',
  'admin.builder.prop.label': '按钮文字',
  'admin.builder.prop.href': '链接地址',
  'admin.builder.prop.variant': '样式',
  'admin.builder.prop.variantPrimary': '主要',
  'admin.builder.prop.variantSecondary': '次要',
  'admin.builder.prop.height': '高度',
  'admin.builder.upload': '上传图片',
  'admin.builder.uploading': '上传中…',
  'admin.builder.recentUploads': '最近上传',
  'admin.builder.delete': '删除区块',
  'admin.builder.duplicate': '复制区块',
  'admin.builder.opt.none': '无',
  'admin.builder.opt.soft': '柔和',
  'admin.builder.opt.primary': '主色',
  'admin.builder.opt.accent': '强调色',
  'admin.builder.opt.narrow': '窄',
  'admin.builder.opt.content': '标准',
  'admin.builder.opt.wide': '宽',
  'admin.builder.opt.left': '左对齐',
  'admin.builder.opt.center': '居中',
  'admin.builder.opt.right': '右对齐',
  'admin.builder.opt.sm': '小',
  'admin.builder.opt.md': '中',
  'admin.builder.opt.lg': '大',
  'admin.builder.opt.xl': '特大',
  'admin.builder.opt.full': '全宽',
  'admin.builder.err.saveFailed': '保存失败——请检查字段后重试。',
  'admin.builder.err.slugTaken': '该 slug 已被其他页面使用。',
  'admin.builder.err.invalidLayout': '布局校验失败。请撤销最后一步后重试。',
  'admin.builder.err.uploadFailed': '上传失败：图片须为 JPEG/PNG/WebP/GIF 且小于 10 MB。',
  'admin.builder.confirmLeave': '您有未保存的更改。',
```

- [ ] **Step 4: Island stub** — `src/components/builder/PageBuilder.tsx` (walking skeleton so the route compiles/mounts; replaced in Task 8):

```tsx
// Page-builder island root. Tasks 8-9 replace this stub with the real canvas;
// the props contract here IS the server contract (see builder/[id].astro).
export interface PageBuilderProps {
  pageId: string | null;
  slug: string;
  published: boolean;
  titleEn: string;
  titleZh: string;
  layoutJson: string;
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  uiLang: 'en' | 'zh';
}

export default function PageBuilder(props: PageBuilderProps) {
  return <div data-testid="pb-root">{props.strings.title}</div>;
}
```

- [ ] **Step 5: The route** — `src/pages/admin/pages/builder/[id].astro`:

```astro
---
// Drag-and-drop page builder (page-builder module — middleware 404s this
// whole prefix when the module is off; console class via the /admin/pages
// prefix, narrowed to editor∪admin here like the classic pages admin).
// GET mounts the React island (client:only — the ONLY client-framework
// island in the app; public pages never ship it). POST is the island's
// same-page API, discriminated by content type:
//   application/json    → save (parseBuilderSave + validateLayout + savePageLayout)
//   multipart/form-data → image upload (saveImageUpload, same pipeline as settings)
import { env } from 'cloudflare:workers';
import Admin from '../../../../layouts/Admin.astro';
import PageBuilder from '../../../../components/builder/PageBuilder';
import { t } from '../../../../lib/i18n';
import type { Locale } from '../../../../lib/locales';
import { getCustomPage, savePageLayout } from '../../../../lib/pagesDb';
import { validateLayout, emptyLayout } from '../../../../lib/pageLayout';
import { parseBuilderSave } from '../../../../lib/validate';
import { listRecentImages } from '../../../../lib/upload';
import { saveImageUpload, uploadErrorKey, type MediaBucket } from '../../../../lib/mediaUpload';

const user = Astro.locals.user;
if (!user || !(user.isEditor || user.isAdmin)) return new Response(null, { status: 403 });
const lang: Locale = user.lang ?? 'en';
const db = Astro.locals.db;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

if (Astro.request.method === 'POST') {
  const ct = Astro.request.headers.get('content-type') ?? '';

  if (ct.includes('application/json')) {
    let body: unknown;
    try {
      body = await Astro.request.json();
    } catch {
      return json(400, { ok: false, error: 'bad_request' });
    }
    const parsed = parseBuilderSave(body);
    if (!parsed.ok) return json(400, { ok: false, error: parsed.errors.slug ? 'slug' : 'title' });
    const layoutRes = validateLayout(JSON.stringify(parsed.data.layout ?? null));
    if (!layoutRes.ok) return json(400, { ok: false, error: 'invalid_layout' });
    const saved = await savePageLayout(db, {
      id: parsed.data.id,
      slug: parsed.data.slug,
      published: parsed.data.published,
      title_en: parsed.data.title_en,
      title_zh: parsed.data.title_zh,
      layoutJson: JSON.stringify(layoutRes.layout),
      updatedBy: user.email,
    });
    if (!saved.ok) return json(409, { ok: false, error: 'slug_taken' });
    return json(200, { ok: true, id: saved.id });
  }

  if (ct.includes('multipart/form-data')) {
    let fd: FormData;
    try {
      fd = await Astro.request.formData();
    } catch {
      return json(400, { ok: false, error: 'bad_request' });
    }
    const file = fd.get('file');
    if (!(file instanceof File)) return json(400, { ok: false, error: 'bad_request' });
    try {
      const media = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
      const key = await saveImageUpload({ db, media, file, uploadedBy: user.email });
      return json(200, { ok: true, key, path: `/media/${key}` });
    } catch (e) {
      return json(400, { ok: false, error: uploadErrorKey(e) });
    }
  }

  return json(400, { ok: false, error: 'bad_request' });
}

const idParam = Astro.params.id ?? '';
const page = idParam === 'new' ? null : await getCustomPage(db, idParam);
if (idParam !== 'new' && !page) return new Response(null, { status: 404 });

// A markdown page opened here converts to builder format on first save (its
// body_md is preserved by savePageLayout's title-only i18n upsert).
const stored = page?.layout_json ?? '';
const parsedStored = stored ? validateLayout(stored) : null;
const layoutJson = JSON.stringify(parsedStored?.ok ? parsedStored.layout : emptyLayout());

const media = await listRecentImages(db);

// The island gets pre-translated copy — it never touches the i18n dicts.
const S = (k: string) => t(lang, `admin.builder.${k}`);
const strings = Object.fromEntries(
  [
    'title', 'back', 'save', 'savePublish', 'saving', 'saved', 'unsaved', 'undo', 'redo',
    'editingIn', 'localeEn', 'localeZh', 'slug', 'titleEn', 'titleZh', 'published', 'view',
    'blocks', 'dragHint', 'emptyCanvas', 'emptySection',
    'block.section', 'block.columns', 'block.heading', 'block.text', 'block.image',
    'block.button', 'block.spacer', 'block.divider',
    'props', 'propsNone', 'prop.level', 'prop.size', 'prop.customSize', 'prop.align',
    'prop.text', 'prop.markdownHint', 'prop.background', 'prop.width', 'prop.padding',
    'prop.columns', 'prop.gap', 'prop.imageUrl', 'prop.altText', 'prop.rounded',
    'prop.label', 'prop.href', 'prop.variant', 'prop.variantPrimary', 'prop.variantSecondary',
    'prop.height', 'upload', 'uploading', 'recentUploads', 'delete', 'duplicate',
    'opt.none', 'opt.soft', 'opt.primary', 'opt.accent', 'opt.narrow', 'opt.content',
    'opt.wide', 'opt.left', 'opt.center', 'opt.right', 'opt.sm', 'opt.md', 'opt.lg',
    'opt.xl', 'opt.full',
    'err.saveFailed', 'err.slugTaken', 'err.invalidLayout', 'err.uploadFailed', 'confirmLeave',
  ].map((k) => [k, S(k)]),
);
---

<Admin title={t(lang, 'admin.builder.title')}>
  <PageBuilder
    client:only="react"
    pageId={page?.id ?? null}
    slug={page?.slug ?? ''}
    published={page?.published ?? false}
    titleEn={page?.i18n.en.title ?? ''}
    titleZh={page?.i18n.zh.title ?? ''}
    layoutJson={layoutJson}
    media={media}
    strings={strings}
    uiLang={lang}
  />
</Admin>
```

- [ ] **Step 6: Append the admin e2e cases** to `test/e2e/pageBuilder.e2e.test.ts`:

```ts
import { post } from './helpers'; // merge into the existing import from './helpers'
import { SELF } from 'cloudflare:test';
import { t } from '../../src/lib/i18n';
import { ORIGIN } from './helpers';

function jsonPost(path: string, body: unknown, cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('builder admin route', () => {
  it('anon GET redirects to signin; editor GET mounts the island', async () => {
    const anon = await get('/admin/pages/builder/new');
    expect(anon.status).toBe(303);

    const editor = await get('/admin/pages/builder/new', { cookie: await sessionCookie(2, 'pastor.david@example.com') });
    expect(editor.status).toBe(200);
    const html = await editor.text();
    expect(html).toContain('astro-island'); // client:only mount point
  });

  it('module off → 404; back on → 200 (modules panel round-trip, admin session)', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    // Disable: write every module row except page-builder as '1' (full write,
    // like the panel does) — mirror test/e2e/modules.e2e.test.ts's helper.
    const off = new URLSearchParams({ action: 'modules' });
    const { MODULE_KEYS } = await import('../../src/lib/modules');
    for (const key of MODULE_KEYS) if (key !== 'page-builder') off.append(`module.${key}`, '1');
    await post('/admin/settings', off.toString(), { cookie: admin });

    const gated = await get('/admin/pages/builder/new', { cookie: admin });
    expect(gated.status).toBe(404);
    // Classic pages admin stays reachable (core, not module-owned).
    const classic = await get('/admin/pages', { cookie: admin });
    expect(classic.status).toBe(200);

    const on = new URLSearchParams({ action: 'modules' });
    for (const key of MODULE_KEYS) on.append(`module.${key}`, '1');
    await post('/admin/settings', on.toString(), { cookie: admin });
    const back = await get('/admin/pages/builder/new', { cookie: admin });
    expect(back.status).toBe(200);
  });

  it('JSON save creates a builder page that renders publicly; id echoes back', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const res = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-saved', published: true,
      title_en: 'Saved', title_zh: '', layout: {
        v: 1,
        blocks: [{ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' },
          children: [{ id: 'h1', type: 'heading', props: { level: 2, text: { en: 'From the island', zh: '' }, align: 'left', size: 'md' } }] }],
      },
    }, editor);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; id: string }>();
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();

    const pub = await get('/en/p/e2e-saved');
    expect(pub.status).toBe(200);
    expect(await pub.text()).toContain('From the island');
  });

  it('rejects a hostile layout (400 invalid_layout) and a duplicate slug (409)', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const evil = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-evil', published: false, title_en: 'X', title_zh: '',
      layout: { v: 1, blocks: [{ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' },
        children: [{ id: 'b1', type: 'button', props: { label: { en: 'x', zh: '' }, href: 'javascript:alert(1)', variant: 'primary', align: 'left' } }] }] },
    }, editor);
    expect(evil.status).toBe(400);
    expect((await evil.json<{ error: string }>()).error).toBe('invalid_layout');

    const dup = await jsonPost('/admin/pages/builder/new', {
      action: 'save', id: null, slug: 'e2e-saved', published: false, title_en: 'Dup', title_zh: '',
      layout: { v: 1, blocks: [] },
    }, editor);
    expect(dup.status).toBe(409);
    expect((await dup.json<{ error: string }>()).error).toBe('slug_taken');
  });

  it('upload rejects a non-image with the mapped i18n error key', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const fd = new FormData();
    fd.append('action', 'upload');
    fd.append('file', new File(['hello'], 'x.txt', { type: 'text/plain' }));
    const res = await SELF.fetch(`${ORIGIN}/admin/pages/builder/new`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: editor }, body: fd, redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('errors.imageType');
  });
});
```
(Adjust the modules-panel round-trip to reuse the exact helper shape in `test/e2e/modules.e2e.test.ts` — read that file first; the settings POST needs any hidden fields its parser requires. If the panel parser requires none beyond `action=modules` + checkboxes, the above stands.)

- [ ] **Step 7: Run**

Run: `npm test` → PASS (validate/upload changes are covered indirectly; i18n parity now checks the ~70 new keys). Run: `npm run test:e2e -- test/e2e/pageBuilder.e2e.test.ts` → all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/validate.ts src/lib/upload.ts src/pages/admin/pages/builder src/components/builder src/i18n/en.ts src/i18n/zh.ts test/e2e/pageBuilder.e2e.test.ts
git commit -m "feat(builder): builder route — island mount, JSON save, image upload"
```

---

### Task 8: Island model — tree operations, history, block factory (pure logic + tests)

**Files:**
- Create: `src/components/builder/model.ts`
- Create: `src/components/builder/newBlock.ts`
- Test: `test/builderModel.test.ts`

**Interfaces:**
- Consumes: types from `src/lib/pageLayout`.
- Produces (Task 9 imports these exactly):
  - `type ContainerRef = 'root' | `sec:${string}` | `col:${string}:${number}``
  - `containerRefFor(kind: 'root') | ...` — build refs via template literals directly; export `parseContainerRef(ref): {kind:'root'} | {kind:'sec', id:string} | {kind:'col', id:string, col:number}`.
  - `interface BuilderState { layout: PageLayout; selectedId: string | null; past: PageLayout[]; future: PageLayout[] }`
  - `type BuilderAction = {type:'insert', container: ContainerRef, index:number, node:AnyNode} | {type:'move', container:ContainerRef, index:number, id:string} | {type:'update', id:string, props:Record<string,unknown>} | {type:'remove', id:string} | {type:'duplicate', id:string} | {type:'select', id:string|null} | {type:'undo'} | {type:'redo'}`
  - `builderReducer(state: BuilderState, action: BuilderAction): BuilderState` — invalid actions (bad container, containment violation, unknown id) return `state` unchanged.
  - `canDrop(nodeType: AnyNode['type'], container: ContainerRef): boolean`
  - `findNode(layout: PageLayout, id: string): { node: AnyNode; container: ContainerRef; index: number } | null`
  - `initialState(layout: PageLayout): BuilderState`
  - `newBlock(type: AnyNode['type']): AnyNode` (from `newBlock.ts`) — fresh `crypto.randomUUID()` ids, sensible defaults, image starts with `src:''`.

- [ ] **Step 1: Write the failing tests** — `test/builderModel.test.ts`:

```ts
// Builder island tree ops (pure reducer — the React components are thin
// views over this). Runs in the workers pool like every other unit test;
// crypto.randomUUID is available there.
import { describe, expect, it } from 'vitest';
import { builderReducer, canDrop, findNode, initialState } from '../src/components/builder/model';
import { newBlock } from '../src/components/builder/newBlock';
import type { PageLayout, SectionNode } from '../src/lib/pageLayout';

const start = (): ReturnType<typeof initialState> => {
  const section = newBlock('section') as SectionNode;
  const layout: PageLayout = { v: 1, blocks: [section] };
  return { ...initialState(layout), layout };
};

describe('canDrop containment', () => {
  it('sections only at root; columns only in sections; leaves in sections/columns', () => {
    expect(canDrop('section', 'root')).toBe(true);
    expect(canDrop('heading', 'root')).toBe(false);
    expect(canDrop('columns', 'sec:x')).toBe(true);
    expect(canDrop('columns', 'col:x:0')).toBe(false);
    expect(canDrop('section', 'sec:x')).toBe(false);
    expect(canDrop('button', 'col:x:1')).toBe(true);
  });
});

describe('builderReducer', () => {
  it('insert appends into a section and records history + selection', () => {
    const s0 = start();
    const secId = s0.layout.blocks[0].id;
    const h = newBlock('heading');
    const s1 = builderReducer(s0, { type: 'insert', container: `sec:${secId}`, index: 0, node: h });
    expect((s1.layout.blocks[0] as SectionNode).children[0].id).toBe(h.id);
    expect(s1.selectedId).toBe(h.id);
    expect(s1.past.length).toBe(1);
  });

  it('rejects containment violations without changing state', () => {
    const s0 = start();
    const s1 = builderReducer(s0, { type: 'insert', container: 'root', index: 0, node: newBlock('heading') });
    expect(s1).toBe(s0);
  });

  it('move adjusts the index when moving later within the same container', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const a = newBlock('heading'); const b = newBlock('text'); const c = newBlock('divider');
    for (const [i, n] of [a, b, c].entries()) s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: i, node: n });
    // Move a (index 0) to "before index 3" (the end): with same-container
    // removal adjustment it must land AFTER c, order b,c,a.
    s = builderReducer(s, { type: 'move', container: `sec:${secId}`, index: 3, id: a.id });
    const ids = (s.layout.blocks[0] as SectionNode).children.map((n) => n.id);
    expect(ids).toEqual([b.id, c.id, a.id]);
  });

  it('move between containers works and respects canDrop', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const cols = newBlock('columns');
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: cols });
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 1, node: h });
    s = builderReducer(s, { type: 'move', container: `col:${cols.id}:0`, index: 0, id: h.id });
    const sec = s.layout.blocks[0] as SectionNode;
    expect(sec.children.length).toBe(1);
    expect(findNode(s.layout, h.id)?.container).toBe(`col:${cols.id}:0`);
    // a section cannot be moved into a column
    const s2 = builderReducer(s, { type: 'move', container: `col:${cols.id}:1`, index: 0, id: secId });
    expect(s2).toBe(s);
  });

  it('update merges props; columns count change reflows the column arrays', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const cols = newBlock('columns');
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: cols });
    s = builderReducer(s, { type: 'insert', container: `col:${cols.id}:1`, index: 0, node: h });
    // shrink 2 → … grow to 4 first, then shrink to 2 keeping h (merged into last kept col)
    s = builderReducer(s, { type: 'update', id: cols.id, props: { count: 4 } });
    let found = findNode(s.layout, cols.id)!.node as ReturnType<typeof newBlock> & { columns: unknown[][] };
    expect(found.columns.length).toBe(4);
    s = builderReducer(s, { type: 'update', id: cols.id, props: { count: 2 } });
    found = findNode(s.layout, cols.id)! .node as typeof found;
    expect(found.columns.length).toBe(2);
    expect(findNode(s.layout, h.id)).not.toBeNull(); // survived the shrink
  });

  it('remove, duplicate (fresh unique ids), undo, redo', () => {
    let s = start();
    const secId = s.layout.blocks[0].id;
    const h = newBlock('heading');
    s = builderReducer(s, { type: 'insert', container: `sec:${secId}`, index: 0, node: h });
    s = builderReducer(s, { type: 'duplicate', id: h.id });
    const sec = s.layout.blocks[0] as SectionNode;
    expect(sec.children.length).toBe(2);
    expect(sec.children[1].id).not.toBe(h.id);

    const before = s.layout;
    s = builderReducer(s, { type: 'remove', id: h.id });
    expect(findNode(s.layout, h.id)).toBeNull();
    s = builderReducer(s, { type: 'undo' });
    expect(s.layout).toEqual(before);
    s = builderReducer(s, { type: 'redo' });
    expect(findNode(s.layout, h.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/builderModel.test.ts` → FAIL (modules not found).

- [ ] **Step 3: Implement `src/components/builder/newBlock.ts`**

```ts
// Factory for freshly dropped blocks. Defaults are chosen so a new block is
// immediately visible on the canvas AND already passes validateLayout —
// except image, which starts with src:'' (validation allows the empty src;
// the public renderer skips the <img> until one is chosen).
import type { AnyNode } from '../../lib/pageLayout';

const l10n = (en = '') => ({ en, zh: '' });

export function newBlock(type: AnyNode['type']): AnyNode {
  const id = crypto.randomUUID();
  switch (type) {
    case 'section':
      return { id, type, props: { bg: 'none', width: 'content', padY: 'md' }, children: [] };
    case 'columns':
      return { id, type, props: { count: 2, gap: 'md' }, columns: [[], []] };
    case 'heading':
      return { id, type, props: { level: 2, text: l10n('Heading'), align: 'left', size: 'md' } };
    case 'text':
      return { id, type, props: { md: l10n('Write something…'), align: 'left' } };
    case 'image':
      return { id, type, props: { src: '', alt: l10n(), width: 'medium', rounded: false, align: 'center' } };
    case 'button':
      return { id, type, props: { label: l10n('Learn more'), href: '/', variant: 'primary', align: 'left' } };
    case 'spacer':
      return { id, type, props: { size: 'md' } };
    case 'divider':
      return { id, type, props: {} };
  }
}
```

- [ ] **Step 4: Implement `src/components/builder/model.ts`**

```ts
// Pure state model for the builder island: container addressing, containment
// rules, and an undo-capable reducer. React components stay thin views; every
// tree mutation lives here where it is unit-tested (test/builderModel.test.ts).
import type { AnyNode, ColumnsNode, LeafNode, PageLayout, SectionNode } from '../../lib/pageLayout';

export type ContainerRef = 'root' | `sec:${string}` | `col:${string}:${number}`;

export function parseContainerRef(ref: ContainerRef):
  | { kind: 'root' }
  | { kind: 'sec'; id: string }
  | { kind: 'col'; id: string; col: number } {
  if (ref === 'root') return { kind: 'root' };
  if (ref.startsWith('sec:')) return { kind: 'sec', id: ref.slice(4) };
  const [, id, col] = ref.split(':');
  return { kind: 'col', id, col: Number(col) };
}

export interface BuilderState {
  layout: PageLayout;
  selectedId: string | null;
  past: PageLayout[];
  future: PageLayout[];
}

export type BuilderAction =
  | { type: 'insert'; container: ContainerRef; index: number; node: AnyNode }
  | { type: 'move'; container: ContainerRef; index: number; id: string }
  | { type: 'update'; id: string; props: Record<string, unknown> }
  | { type: 'remove'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_CAP = 50;

export function initialState(layout: PageLayout): BuilderState {
  return { layout, selectedId: null, past: [], future: [] };
}

/** Containment rules — mirrors validateLayout so the canvas can never build a
 *  tree the server would reject. */
export function canDrop(nodeType: AnyNode['type'], container: ContainerRef): boolean {
  const target = parseContainerRef(container);
  if (nodeType === 'section') return target.kind === 'root';
  if (nodeType === 'columns') return target.kind === 'sec';
  return target.kind === 'sec' || target.kind === 'col';
}

/** The mutable array a container ref addresses inside `layout`, or null. */
function containerArray(layout: PageLayout, ref: ContainerRef): AnyNode[] | null {
  const target = parseContainerRef(ref);
  if (target.kind === 'root') return layout.blocks;
  for (const sec of layout.blocks) {
    if (target.kind === 'sec' && sec.id === target.id) return sec.children;
    if (target.kind === 'col') {
      for (const child of sec.children) {
        if (child.type === 'columns' && child.id === target.id) return child.columns[target.col] ?? null;
      }
    }
  }
  return null;
}

export function findNode(
  layout: PageLayout,
  id: string,
): { node: AnyNode; container: ContainerRef; index: number } | null {
  for (const [i, sec] of layout.blocks.entries()) {
    if (sec.id === id) return { node: sec, container: 'root', index: i };
    for (const [j, child] of sec.children.entries()) {
      if (child.id === id) return { node: child, container: `sec:${sec.id}`, index: j };
      if (child.type === 'columns') {
        for (const [c, col] of child.columns.entries()) {
          for (const [k, leaf] of col.entries()) {
            if (leaf.id === id) return { node: leaf, container: `col:${child.id}:${c}`, index: k };
          }
        }
      }
    }
  }
  return null;
}

function withFreshIds<T extends AnyNode>(node: T): T {
  const clone = structuredClone(node);
  const stamp = (n: AnyNode): void => {
    n.id = crypto.randomUUID();
    if (n.type === 'section') n.children.forEach(stamp);
    if (n.type === 'columns') n.columns.forEach((col) => col.forEach(stamp));
  };
  stamp(clone);
  return clone;
}

/** Resize a columns node's arrays: grow with empty columns, shrink by merging
 *  overflow leaves into the last kept column (nothing is silently deleted). */
function reflowColumns(node: ColumnsNode, count: 2 | 3 | 4): void {
  while (node.columns.length < count) node.columns.push([]);
  if (node.columns.length > count) {
    const overflow = node.columns.slice(count).flat();
    node.columns = node.columns.slice(0, count);
    node.columns[count - 1].push(...overflow);
  }
}

function commit(state: BuilderState, next: PageLayout, selectedId: string | null): BuilderState {
  return {
    layout: next,
    selectedId,
    past: [...state.past.slice(-(HISTORY_CAP - 1)), state.layout],
    future: [],
  };
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'select':
      return { ...state, selectedId: action.id };

    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { ...state, layout: prev, past: state.past.slice(0, -1), future: [state.layout, ...state.future] };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...state, layout: next, past: [...state.past, state.layout], future: rest };
    }

    case 'insert': {
      if (!canDrop(action.node.type, action.container)) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, action.container);
      if (!arr) return state;
      arr.splice(Math.min(action.index, arr.length), 0, structuredClone(action.node));
      return commit(state, next, action.node.id);
    }

    case 'move': {
      const found = findNode(state.layout, action.id);
      if (!found || !canDrop(found.node.type, action.container)) return state;
      const next = structuredClone(state.layout);
      const fromArr = containerArray(next, found.container);
      if (!fromArr) return state;
      const [node] = fromArr.splice(found.index, 1);
      let index = action.index;
      if (found.container === action.container && found.index < index) index -= 1;
      const toArr = containerArray(next, action.container);
      if (!toArr || !node) return state;
      toArr.splice(Math.min(index, toArr.length), 0, node);
      return commit(state, next, action.id);
    }

    case 'update': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const target = findNode(next, action.id);
      if (!target) return state;
      const node = target.node as AnyNode & { props: Record<string, unknown> };
      const { count, ...rest } = action.props as { count?: 2 | 3 | 4 } & Record<string, unknown>;
      node.props = { ...node.props, ...rest };
      if (node.type === 'columns' && count !== undefined) {
        (node.props as ColumnsNode['props']).count = count;
        reflowColumns(node as ColumnsNode, count);
      } else if (count !== undefined) {
        node.props = { ...node.props, count };
      }
      return commit(state, next, state.selectedId);
    }

    case 'remove': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, found.container);
      if (!arr) return state;
      arr.splice(found.index, 1);
      return commit(state, next, null);
    }

    case 'duplicate': {
      const found = findNode(state.layout, action.id);
      if (!found) return state;
      const next = structuredClone(state.layout);
      const arr = containerArray(next, found.container);
      if (!arr) return state;
      const copy = withFreshIds(found.node);
      arr.splice(found.index + 1, 0, copy);
      return commit(state, next, copy.id);
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/builderModel.test.ts` → PASS. `npx astro check` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/builder/model.ts src/components/builder/newBlock.ts test/builderModel.test.ts
git commit -m "feat(builder): island tree model — containment, moves, history"
```

---

### Task 9: Island UI — canvas, palette, properties, top bar, save/upload

**Files:**
- Replace: `src/components/builder/PageBuilder.tsx` (stub → real)
- Create: `src/components/builder/Canvas.tsx`
- Create: `src/components/builder/Palette.tsx`
- Create: `src/components/builder/PropertiesPanel.tsx`
- Create: `src/components/builder/TopBar.tsx`

**Interfaces:**
- Consumes: `model.ts`/`newBlock.ts` (Task 8), `blockStyles` (Task 3), `renderMarkdown` (existing), adminUi class constants, the props contract from Task 7.
- Produces: the working island. No new exports for later tasks.

**Shared conventions inside these components:** strings come from `props.strings` (keys as listed in Task 7, dots intact: `strings['block.heading']`, `strings['prop.align']`, `strings['opt.left']`, `strings['err.slugTaken']`). dnd ids: draggable palette items `pal|<type>`, canvas blocks `blk|<id>`, droppable gaps `gap|<container>|<index>` with `data: { container, index }`. The canvas shows content in the CURRENT editing locale with per-field fallback (same rule the public renderer uses), the properties panel edits the exact string of the current editing locale.

- [ ] **Step 1: `src/components/builder/Canvas.tsx`**

```tsx
// Canvas: renders the layout tree through the SAME blockStyles maps the
// public renderer uses (visual parity), wrapped in selection/drag chrome.
// Drop model: explicit gap droppables between blocks (Wix-style insertion
// lines) rather than sortable lists — one mechanism covers palette drops,
// reorders, and cross-container moves.
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { AnyNode, ColumnsNode, LeafNode, PageLayout, SectionNode, L10nString } from '../../lib/pageLayout';
import {
  sectionOuterClass, sectionInnerClass, columnsClass, headingRender,
  textClass, imageRender, buttonRender, spacerClass, dividerClass,
} from '../../lib/blockStyles';
import { renderMarkdown } from '../../lib/markdown';
import { canDrop, type ContainerRef } from './model';

export interface CanvasProps {
  layout: PageLayout;
  selectedId: string | null;
  editLocale: 'en' | 'zh';
  draggingType: AnyNode['type'] | null;
  strings: Record<string, string>;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
}

function pickL10n(s: L10nString, locale: 'en' | 'zh'): string {
  return locale === 'zh' ? s.zh || s.en : s.en || s.zh;
}

function DropGap({ container, index, draggingType }: { container: ContainerRef; index: number; draggingType: AnyNode['type'] | null }) {
  const { isOver, setNodeRef } = useDroppable({ id: `gap|${container}|${index}`, data: { container, index } });
  const valid = draggingType !== null && canDrop(draggingType, container);
  if (draggingType !== null && !valid) return <div className="h-1" />;
  return (
    <div
      ref={setNodeRef}
      className={`rounded transition-all ${draggingType ? 'h-3' : 'h-1'} ${isOver && valid ? 'bg-primary h-6' : draggingType ? 'bg-surface-sunken' : ''}`}
    />
  );
}

function LeafView({ node, editLocale }: { node: LeafNode; editLocale: 'en' | 'zh' }) {
  switch (node.type) {
    case 'heading': {
      const r = headingRender(node.props);
      const Tag = `h${node.props.level}` as 'h1' | 'h2' | 'h3';
      return <Tag className={r.className} style={r.style}>{pickL10n(node.props.text, editLocale)}</Tag>;
    }
    case 'text':
      return (
        <div
          className={textClass(node.props)}
          // Safe: renderMarkdown fully escapes its input before transforming.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(pickL10n(node.props.md, editLocale)) }}
        />
      );
    case 'image': {
      const r = imageRender(node.props);
      return (
        <div className={r.wrapperClass}>
          {node.props.src ? (
            <img src={node.props.src} alt={pickL10n(node.props.alt, editLocale)} className={r.imgClass} />
          ) : (
            <div className={`${r.imgClass} flex h-40 items-center justify-center border border-dashed border-border-strong bg-surface-sunken text-sm text-ink-subtle`}>
              🖼
            </div>
          )}
        </div>
      );
    }
    case 'button': {
      const r = buttonRender(node.props);
      return (
        <div className={r.wrapperClass}>
          <span className={r.linkClass}>{pickL10n(node.props.label, editLocale)}</span>
        </div>
      );
    }
    case 'spacer':
      return <div className={`${spacerClass(node.props)} rounded bg-surface-sunken/50`} aria-hidden="true" />;
    case 'divider':
      return <hr className={dividerClass()} />;
  }
}

function BlockFrame({
  node, selected, strings, onSelect, onRemove, onDuplicate, children,
}: {
  node: AnyNode; selected: boolean; strings: Record<string, string>;
  onSelect: (id: string) => void; onRemove: (id: string) => void; onDuplicate: (id: string) => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `blk|${node.id}`,
    data: { from: 'canvas', id: node.id, nodeType: node.type },
  });
  return (
    <div
      ref={setNodeRef}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      className={`relative rounded ${isDragging ? 'opacity-40' : ''} ${selected ? 'ring-2 ring-ring' : 'hover:ring-1 hover:ring-border-strong'}`}
    >
      {selected && (
        <div className="absolute -top-3 right-2 z-10 flex gap-1 rounded-md border border-border bg-surface-raised px-1 py-0.5 text-xs shadow-sm">
          <button type="button" className="cursor-grab px-1" title={strings['block.' + node.type]} {...listeners} {...attributes}>⠿</button>
          <button type="button" className="px-1" title={strings.duplicate} onClick={(e) => { e.stopPropagation(); onDuplicate(node.id); }}>⧉</button>
          <button type="button" className="px-1 text-danger" title={strings.delete} onClick={(e) => { e.stopPropagation(); onRemove(node.id); }}>✕</button>
        </div>
      )}
      {children}
    </div>
  );
}

export default function Canvas(props: CanvasProps) {
  const { layout, selectedId, editLocale, draggingType, strings } = props;
  const frame = (node: AnyNode, children: React.ReactNode) => (
    <BlockFrame
      key={node.id}
      node={node}
      selected={selectedId === node.id}
      strings={strings}
      onSelect={props.onSelect}
      onRemove={props.onRemove}
      onDuplicate={props.onDuplicate}
    >
      {children}
    </BlockFrame>
  );

  const renderLeaves = (leaves: LeafNode[], container: ContainerRef) => (
    <>
      <DropGap container={container} index={0} draggingType={draggingType} />
      {leaves.map((leaf, i) => (
        <div key={leaf.id}>
          {frame(leaf, <LeafView node={leaf} editLocale={editLocale} />)}
          <DropGap container={container} index={i + 1} draggingType={draggingType} />
        </div>
      ))}
      {leaves.length === 0 && draggingType === null && (
        <p className="py-3 text-center text-xs text-ink-subtle">{strings.emptySection}</p>
      )}
    </>
  );

  return (
    <div className="min-h-[60vh] rounded-xl border border-border bg-surface p-2" onClick={() => props.onSelect(null)}>
      <DropGap container="root" index={0} draggingType={draggingType} />
      {layout.blocks.map((section: SectionNode, i) => (
        <div key={section.id}>
          {frame(
            section,
            <section class-placeholder="" className={`${sectionOuterClass(section.props)} rounded border border-dashed border-border`}>
              <div className={`${sectionInnerClass(section.props)} space-y-2`}>
                {section.children.length === 0 && <p className="py-6 text-center text-xs text-ink-subtle">{strings.emptySection}</p>}
                <DropGap container={`sec:${section.id}`} index={0} draggingType={draggingType} />
                {section.children.map((child, j) => (
                  <div key={child.id}>
                    {child.type === 'columns'
                      ? frame(
                          child,
                          <div className={columnsClass((child as ColumnsNode).props)}>
                            {(child as ColumnsNode).columns.map((col, c) => (
                              <div key={c} className="min-h-16 space-y-2 rounded border border-dashed border-border p-1">
                                {renderLeaves(col, `col:${child.id}:${c}`)}
                              </div>
                            ))}
                          </div>,
                        )
                      : frame(child, <LeafView node={child as LeafNode} editLocale={editLocale} />)}
                    <DropGap container={`sec:${section.id}`} index={j + 1} draggingType={draggingType} />
                  </div>
                ))}
              </div>
            </section>,
          )}
          <DropGap container="root" index={i + 1} draggingType={draggingType} />
        </div>
      ))}
      {layout.blocks.length === 0 && (
        <p className="py-16 text-center text-sm text-ink-muted">{strings.emptyCanvas}</p>
      )}
    </div>
  );
}
```
(Remove the stray `class-placeholder=""` attribute when transcribing — it is not part of the design; the `<section>` carries only `className`.)

- [ ] **Step 2: `src/components/builder/Palette.tsx`**

```tsx
// Block palette: drag onto the canvas, or click to append somewhere sensible
// (root for sections, the selected/last section otherwise — PageBuilder owns
// that logic via onQuickAdd).
import { useDraggable } from '@dnd-kit/core';
import type { AnyNode } from '../../lib/pageLayout';

const TYPES: AnyNode['type'][] = ['section', 'columns', 'heading', 'text', 'image', 'button', 'spacer', 'divider'];
const ICONS: Record<AnyNode['type'], string> = {
  section: '▭', columns: '◫', heading: 'H', text: '¶', image: '🖼', button: '⏺', spacer: '↕', divider: '—',
};

function PaletteItem({ type, label, onQuickAdd }: { type: AnyNode['type']; label: string; onQuickAdd: (t: AnyNode['type']) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pal|${type}`,
    data: { from: 'palette', nodeType: type },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onQuickAdd(type)}
      className={`flex w-full cursor-grab items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-left text-sm hover:border-border-strong ${isDragging ? 'opacity-40' : ''}`}
    >
      <span aria-hidden="true" className="w-5 text-center text-ink-muted">{ICONS[type]}</span>
      {label}
    </button>
  );
}

export default function Palette({ strings, onQuickAdd }: { strings: Record<string, string>; onQuickAdd: (t: AnyNode['type']) => void }) {
  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{strings.blocks}</h2>
      {TYPES.map((type) => (
        <PaletteItem key={type} type={type} label={strings[`block.${type}`]} onQuickAdd={onQuickAdd} />
      ))}
      <p className="text-xs text-ink-subtle">{strings.dragHint}</p>
    </div>
  );
}
```

- [ ] **Step 3: `src/components/builder/PropertiesPanel.tsx`**

```tsx
// Properties for the selected block. Text-bearing props edit the CURRENT
// editing locale's exact string (no fallback here — that's a render-time
// behavior); everything else maps 1:1 onto layout enums.
import { useRef, useState } from 'react';
import type { AnyNode, L10nString } from '../../lib/pageLayout';
import { tin, lab } from '../../lib/adminUi';

export interface PropertiesPanelProps {
  node: AnyNode | null;
  editLocale: 'en' | 'zh';
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  onUpdate: (id: string, props: Record<string, unknown>) => void;
  onUpload: (file: File) => Promise<string | null>; // resolves to /media/... path or null on failure
}

export default function PropertiesPanel({ node, editLocale, media, strings, onUpdate, onUpload }: PropertiesPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  if (!node) return <p className="text-sm text-ink-subtle">{strings.propsNone}</p>;
  const set = (props: Record<string, unknown>) => onUpdate(node.id, props);
  const setL10n = (key: string, current: L10nString, value: string) =>
    set({ [key]: { ...current, [editLocale]: value } });

  const select = (label: string, value: string | number, options: [string | number, string][], onChange: (v: string) => void) => (
    <label className="block">
      <span className={lab}>{label}</span>
      <select className={tin} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>{text}</option>
        ))}
      </select>
    </label>
  );

  const alignSelect = (value: string) =>
    select(strings['prop.align'], value, [['left', strings['opt.left']], ['center', strings['opt.center']], ['right', strings['opt.right']]], (v) => set({ align: v }));

  const sizeOptions: [string, string][] = [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']], ['xl', strings['opt.xl']]];

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        {strings.props} — {strings[`block.${node.type}`]}
      </h2>

      {node.type === 'section' && (
        <>
          {select(strings['prop.background'], node.props.bg, [['none', strings['opt.none']], ['soft', strings['opt.soft']], ['primary', strings['opt.primary']], ['accent', strings['opt.accent']]], (v) => set({ bg: v }))}
          {select(strings['prop.width'], node.props.width, [['narrow', strings['opt.narrow']], ['content', strings['opt.content']], ['wide', strings['opt.wide']]], (v) => set({ width: v }))}
          {select(strings['prop.padding'], node.props.padY, [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']]], (v) => set({ padY: v }))}
        </>
      )}

      {node.type === 'columns' && (
        <>
          {select(strings['prop.columns'], node.props.count, [[2, '2'], [3, '3'], [4, '4']], (v) => set({ count: Number(v) }))}
          {select(strings['prop.gap'], node.props.gap, [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']]], (v) => set({ gap: v }))}
        </>
      )}

      {node.type === 'heading' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.text']}</span>
            <textarea className={tin} rows={2} value={node.props.text[editLocale]} onChange={(e) => setL10n('text', node.props.text, e.target.value)} />
          </label>
          {select(strings['prop.level'], node.props.level, [[1, 'H1'], [2, 'H2'], [3, 'H3']], (v) => set({ level: Number(v) }))}
          {select(strings['prop.size'], node.props.size, sizeOptions, (v) => set({ size: v }))}
          <label className="block">
            <span className={lab}>{strings['prop.customSize']}</span>
            <input
              className={tin}
              type="number"
              min={10}
              max={120}
              value={node.props.customSizePx ?? ''}
              onChange={(e) => {
                const n = e.target.value === '' ? undefined : Math.min(120, Math.max(10, Number(e.target.value)));
                set({ customSizePx: n });
              }}
            />
          </label>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'text' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.text']}</span>
            <textarea className={`${tin} font-mono`} rows={8} value={node.props.md[editLocale]} onChange={(e) => setL10n('md', node.props.md, e.target.value)} />
          </label>
          <p className="text-xs text-ink-subtle">{strings['prop.markdownHint']}</p>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'image' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.imageUrl']}</span>
            <input className={`${tin} font-mono`} value={node.props.src} onChange={(e) => set({ src: e.target.value })} />
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              const path = await onUpload(file);
              setUploading(false);
              if (path) set({ src: path });
              e.target.value = '';
            }}
          />
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-sunken" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? strings.uploading : strings.upload}
          </button>
          {media.length > 0 && (
            <div>
              <span className={lab}>{strings.recentUploads}</span>
              <div className="mt-1 grid max-h-40 grid-cols-4 gap-1 overflow-y-auto">
                {media.map((m) => (
                  <button key={m.path} type="button" title={m.filename} onClick={() => set({ src: m.path })} className="aspect-square overflow-hidden rounded border border-border hover:ring-2 hover:ring-ring">
                    <img src={m.path} alt={m.filename} className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="block">
            <span className={lab}>{strings['prop.altText']}</span>
            <input className={tin} value={node.props.alt[editLocale]} onChange={(e) => setL10n('alt', node.props.alt, e.target.value)} />
          </label>
          {select(strings['prop.width'], node.props.width, [['full', strings['opt.full']], ['wide', strings['opt.wide']], ['medium', strings['opt.md']], ['small', strings['opt.sm']]], (v) => set({ width: v }))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={node.props.rounded} onChange={(e) => set({ rounded: e.target.checked })} /> {strings['prop.rounded']}
          </label>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'button' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.label']}</span>
            <input className={tin} value={node.props.label[editLocale]} onChange={(e) => setL10n('label', node.props.label, e.target.value)} />
          </label>
          <label className="block">
            <span className={lab}>{strings['prop.href']}</span>
            <input className={`${tin} font-mono`} value={node.props.href} onChange={(e) => set({ href: e.target.value })} />
          </label>
          {select(strings['prop.variant'], node.props.variant, [['primary', strings['prop.variantPrimary']], ['secondary', strings['prop.variantSecondary']]], (v) => set({ variant: v }))}
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'spacer' &&
        select(strings['prop.height'], node.props.size, sizeOptions, (v) => set({ size: v }))}
    </div>
  );
}
```

- [ ] **Step 4: `src/components/builder/TopBar.tsx`**

```tsx
// Top bar: page meta (slug/titles/published), locale toggle for text entry,
// undo/redo, save actions, and the dirty/saved indicator.
import { btn, btnSecondary, tin, lab } from '../../lib/adminUi';

export interface TopBarProps {
  slug: string;
  titleEn: string;
  titleZh: string;
  published: boolean;
  editLocale: 'en' | 'zh';
  dirty: boolean;
  saving: boolean;
  savedFlash: boolean;
  canUndo: boolean;
  canRedo: boolean;
  viewHref: string | null;
  error: string | null;
  strings: Record<string, string>;
  onMeta: (patch: Partial<{ slug: string; titleEn: string; titleZh: string; published: boolean }>) => void;
  onLocale: (l: 'en' | 'zh') => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: (publish?: boolean) => void;
}

export default function TopBar(p: TopBarProps) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-raised p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={lab}>{p.strings.slug}</span>
          <input className={`${tin} font-mono`} value={p.slug} onChange={(e) => p.onMeta({ slug: e.target.value })} />
        </label>
        <label className="block">
          <span className={lab}>{p.strings.titleEn}</span>
          <input className={tin} value={p.titleEn} onChange={(e) => p.onMeta({ titleEn: e.target.value })} />
        </label>
        <label className="block">
          <span className={lab}>{p.strings.titleZh}</span>
          <input className={tin} value={p.titleZh} onChange={(e) => p.onMeta({ titleZh: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a href="/admin/pages" className="text-sm text-primary hover:underline">← {p.strings.back}</a>
        <span className="text-sm text-ink-subtle">{p.strings.editingIn}:</span>
        <div className="flex overflow-hidden rounded-md border border-border text-sm">
          {(['en', 'zh'] as const).map((l) => (
            <button key={l} type="button" onClick={() => p.onLocale(l)}
              className={`px-3 py-1 ${p.editLocale === l ? 'bg-primary text-on-primary' : 'bg-surface hover:bg-surface-sunken'}`}>
              {l === 'en' ? p.strings.localeEn : p.strings.localeZh}
            </button>
          ))}
        </div>
        <button type="button" className={btnSecondary} disabled={!p.canUndo} onClick={p.onUndo} title={p.strings.undo}>↩</button>
        <button type="button" className={btnSecondary} disabled={!p.canRedo} onClick={p.onRedo} title={p.strings.redo}>↪</button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.published} onChange={(e) => p.onMeta({ published: e.target.checked })} /> {p.strings.published}
        </label>
        <span className="grow" />
        {p.error && <span className="text-sm text-danger">{p.error}</span>}
        {!p.error && p.dirty && !p.saving && <span className="text-sm text-warn">{p.strings.unsaved}</span>}
        {!p.error && p.savedFlash && !p.dirty && <span className="text-sm text-success">{p.strings.saved}</span>}
        {p.viewHref && <a href={p.viewHref} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">{p.strings.view}</a>}
        <button type="button" className={btnSecondary} disabled={p.saving} onClick={() => p.onSave()}>
          {p.saving ? p.strings.saving : p.strings.save}
        </button>
        <button type="button" className={btn} disabled={p.saving} onClick={() => p.onSave(true)}>
          {p.strings.savePublish}
        </button>
      </div>
    </div>
  );
}
```
(If `text-warn`/`text-success`/`text-danger` utilities are not already used elsewhere, they still exist — every `--color-*` token maps to a utility via the `@theme inline` block. Verify with `npm run build` + a grep of tokens.generated.css; do NOT introduce literals.)

- [ ] **Step 5: Replace `src/components/builder/PageBuilder.tsx`**

```tsx
// Page-builder island root: owns the reducer state, the DndContext, page meta,
// and the save/upload calls to its own route (same-page JSON POST — the CSRF
// middleware validates Origin on every non-GET). Everything below the fold is
// split into Canvas / Palette / PropertiesPanel / TopBar.
import { useMemo, useReducer, useRef, useState, useEffect, useCallback } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { AnyNode, PageLayout } from '../../lib/pageLayout';
import { builderReducer, canDrop, findNode, initialState, type ContainerRef } from './model';
import { newBlock } from './newBlock';
import Canvas from './Canvas';
import Palette from './Palette';
import PropertiesPanel from './PropertiesPanel';
import TopBar from './TopBar';

export interface PageBuilderProps {
  pageId: string | null;
  slug: string;
  published: boolean;
  titleEn: string;
  titleZh: string;
  layoutJson: string;
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  uiLang: 'en' | 'zh';
}

export default function PageBuilder(props: PageBuilderProps) {
  const [state, dispatch] = useReducer(builderReducer, JSON.parse(props.layoutJson) as PageLayout, initialState);
  const [meta, setMeta] = useState({ slug: props.slug, titleEn: props.titleEn, titleZh: props.titleZh, published: props.published });
  const [pageId, setPageId] = useState(props.pageId);
  const [editLocale, setEditLocale] = useState<'en' | 'zh'>(props.uiLang);
  const [draggingType, setDraggingType] = useState<AnyNode['type'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedSnapshot = useRef(JSON.stringify({ layout: JSON.parse(props.layoutJson), meta: { slug: props.slug, titleEn: props.titleEn, titleZh: props.titleZh, published: props.published } }));

  const snapshot = JSON.stringify({ layout: state.layout, meta });
  const dirty = snapshot !== savedSnapshot.current;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (e: DragStartEvent) => {
    setDraggingType((e.active.data.current?.nodeType as AnyNode['type']) ?? null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDraggingType(null);
    const over = e.over?.data.current as { container: ContainerRef; index: number } | undefined;
    const active = e.active.data.current as { from: 'palette' | 'canvas'; nodeType: AnyNode['type']; id?: string } | undefined;
    if (!over || !active) return;
    if (active.from === 'palette') {
      dispatch({ type: 'insert', container: over.container, index: over.index, node: newBlock(active.nodeType) });
    } else if (active.id) {
      dispatch({ type: 'move', container: over.container, index: over.index, id: active.id });
    }
  };

  // Click-to-add fallback: sections go to the end of the page; anything else
  // lands in the selected section/column, else the last section (created on
  // demand for an empty page).
  const quickAdd = useCallback((type: AnyNode['type']) => {
    if (type === 'section') {
      dispatch({ type: 'insert', container: 'root', index: state.layout.blocks.length, node: newBlock(type) });
      return;
    }
    let container: ContainerRef | null = null;
    if (state.selectedId) {
      const found = findNode(state.layout, state.selectedId);
      if (found) {
        if (found.node.type === 'section' && canDrop(type, `sec:${found.node.id}`)) container = `sec:${found.node.id}`;
        else if (canDrop(type, found.container)) container = found.container;
      }
    }
    if (!container) {
      const last = state.layout.blocks[state.layout.blocks.length - 1];
      if (last) container = `sec:${last.id}`;
      else {
        const section = newBlock('section');
        dispatch({ type: 'insert', container: 'root', index: 0, node: section });
        // The reducer call above hasn't landed yet in `state`; append into the
        // new section on the next tick via its id.
        setTimeout(() => dispatch({ type: 'insert', container: `sec:${section.id}`, index: 0, node: newBlock(type) }), 0);
        return;
      }
    }
    const arr = findNode(state.layout, state.selectedId ?? '')?.container; // unused; length below is simplest
    void arr;
    dispatch({ type: 'insert', container, index: Number.MAX_SAFE_INTEGER, node: newBlock(type) });
  }, [state]);

  const save = async (publish?: boolean) => {
    setSaving(true);
    setError(null);
    const published = publish ? true : meta.published;
    try {
      const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save', id: pageId, slug: meta.slug, published,
          title_en: meta.titleEn, title_zh: meta.titleZh, layout: state.layout,
        }),
      });
      const body = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!body.ok) {
        setError(
          body.error === 'slug_taken' ? props.strings['err.slugTaken']
          : body.error === 'invalid_layout' ? props.strings['err.invalidLayout']
          : props.strings['err.saveFailed'],
        );
        return;
      }
      const newMeta = { ...meta, published };
      setMeta(newMeta);
      if (body.id && !pageId) {
        setPageId(body.id);
        window.history.replaceState(null, '', `/admin/pages/builder/${body.id}`);
      }
      savedSnapshot.current = JSON.stringify({ layout: state.layout, meta: newMeta });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch {
      setError(props.strings['err.saveFailed']);
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File): Promise<string | null> => {
    try {
      const fd = new FormData();
      fd.append('action', 'upload');
      fd.append('file', file);
      const res = await fetch(window.location.pathname, { method: 'POST', body: fd });
      const body = (await res.json()) as { ok: boolean; path?: string };
      if (!body.ok || !body.path) {
        setError(props.strings['err.uploadFailed']);
        return null;
      }
      return body.path;
    } catch {
      setError(props.strings['err.uploadFailed']);
      return null;
    }
  };

  const selectedNode = useMemo(
    () => (state.selectedId ? findNode(state.layout, state.selectedId)?.node ?? null : null),
    [state.layout, state.selectedId],
  );
  const viewHref = pageId && meta.published && !dirty ? `/${props.uiLang}/p/${meta.slug}` : null;

  return (
    <div className="space-y-4">
      <TopBar
        slug={meta.slug}
        titleEn={meta.titleEn}
        titleZh={meta.titleZh}
        published={meta.published}
        editLocale={editLocale}
        dirty={dirty}
        saving={saving}
        savedFlash={savedFlash}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        viewHref={viewHref}
        error={error}
        strings={props.strings}
        onMeta={(patch) => setMeta((m) => ({ ...m, ...patch }))}
        onLocale={setEditLocale}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onSave={save}
      />
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDraggingType(null)}>
        <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
          <Palette strings={props.strings} onQuickAdd={quickAdd} />
          <Canvas
            layout={state.layout}
            selectedId={state.selectedId}
            editLocale={editLocale}
            draggingType={draggingType}
            strings={props.strings}
            onSelect={(id) => dispatch({ type: 'select', id })}
            onRemove={(id) => dispatch({ type: 'remove', id })}
            onDuplicate={(id) => dispatch({ type: 'duplicate', id })}
          />
          <PropertiesPanel
            node={selectedNode}
            editLocale={editLocale}
            media={props.media}
            strings={props.strings}
            onUpdate={(id, p) => dispatch({ type: 'update', id, props: p })}
            onUpload={upload}
          />
        </div>
        <DragOverlay>
          {draggingType && (
            <div className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm shadow-md">
              {props.strings[`block.${draggingType}`]}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
```
Cleanups while transcribing: the `quickAdd` dead `arr` lines are a plan artifact — drop `const arr = …; void arr;`. The reducer clamps `Number.MAX_SAFE_INTEGER` to the array length (`Math.min(index, arr.length)`), which is why append-via-huge-index is safe.

- [ ] **Step 6: Verify**

Run: `npx astro check` → no errors. `npm run build` → succeeds. `npm test` → green.
Then a manual smoke: `npm run dev`, sign in as the dev-bypass admin, open `/admin/pages/builder/new`, confirm the three-pane UI renders and palette click-to-add inserts blocks. (Full drag verification happens in the final browser pass.)

- [ ] **Step 7: Commit**

```bash
git add src/components/builder
git commit -m "feat(builder): drag-and-drop canvas, palette, properties, save/upload"
```

---

### Task 10: Classic pages admin integration

**Files:**
- Modify: `src/pages/admin/pages/index.astro`
- Modify: `src/i18n/en.ts`, `src/i18n/zh.ts`
- Test: `test/e2e/pageBuilder.e2e.test.ts` (append one describe)

**Interfaces:**
- Consumes: `CustomPageListRow.format` (Task 1), module gate (Task 5).
- Produces: nothing downstream.

- [ ] **Step 1: i18n keys** — en:
```ts
  'admin.pages.formatBuilder': 'Builder',
  'admin.pages.design': 'Design',
  'admin.pages.newBuilder': 'New page (builder)',
  'admin.pages.builderNote': 'This page is designed with the page builder — its content is edited there.',
  'admin.pages.openBuilder': 'Open in builder',
```
zh:
```ts
  'admin.pages.formatBuilder': '构建器',
  'admin.pages.design': '设计',
  'admin.pages.newBuilder': '新建页面（构建器）',
  'admin.pages.builderNote': '此页面使用页面构建器设计——内容请在构建器中编辑。',
  'admin.pages.openBuilder': '在构建器中打开',
```

- [ ] **Step 2: Write the failing e2e** — append to `test/e2e/pageBuilder.e2e.test.ts`:

```ts
describe('classic pages admin integrates the builder', () => {
  it('shows the New page (builder) button and per-row Design links to editors', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    await savePageLayout(env.DB, {
      id: null, slug: 'e2e-list-builder', published: false,
      title_en: 'Listed', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    const res = await get('/admin/pages', { cookie: editor });
    const html = await res.text();
    expect(html).toContain('/admin/pages/builder/new');   // the new-page button
    expect(html).toContain(t('en', 'admin.pages.formatBuilder')); // badge on the builder row
    expect(html).toMatch(/\/admin\/pages\/builder\/[0-9a-f-]{36}/); // per-row Design link
  });

  it('classic edit form for a builder page hides body textareas, links to the builder, and does not wipe the layout on save', async () => {
    const editor = await sessionCookie(2, 'pastor.david@example.com');
    const created = await savePageLayout(env.DB, {
      id: null, slug: 'e2e-classic-edit', published: false,
      title_en: 'CE', title_zh: '', layoutJson: JSON.stringify({ v: 1, blocks: [] }), updatedBy: 'e@x',
    });
    if (!created.ok) throw new Error('seed failed');

    const form = await get(`/admin/pages?edit=${created.id}`, { cookie: editor });
    const html = await form.text();
    expect(html).toContain(t('en', 'admin.pages.builderNote'));
    expect(html).not.toContain('name="body_en"');

    // Classic save (slug/title/publish) must leave format/layout intact.
    const body = new URLSearchParams({ action: 'save', id: created.id, slug: 'e2e-classic-edit', title_en: 'CE2', title_zh: '', body_en: '', body_zh: '' });
    await post('/admin/pages', body.toString(), { cookie: editor });
    const row = await env.DB.prepare(`SELECT format, layout_json FROM custom_pages WHERE id = ?1`).bind(created.id).first<{ format: string; layout_json: string }>();
    expect(row!.format).toBe('builder');
    expect(row!.layout_json).toBe(JSON.stringify({ v: 1, blocks: [] }));
  });
});
```

- [ ] **Step 3: Implement in `src/pages/admin/pages/index.astro`**

Frontmatter additions:
```ts
const canBuild = Astro.locals.modules.has('page-builder');
const editingBuilderPage = editingPage?.format === 'builder';
```

Template changes (all inside the existing structure):
1. Next to the `h1`, add the new-page button:
```astro
{canBuild && (
  <a href="/admin/pages/builder/new" class={`${btn} mt-4 inline-block`}>{t(lang, 'admin.pages.newBuilder')}</a>
)}
```
2. In the edit form, wrap the two body `<label>`s (the `grid gap-4 sm:grid-cols-2` div containing body_en/body_zh textareas AND the markdownHint `<p>`) in a conditional, and add the builder note branch:
```astro
{editingBuilderPage ? (
  <p class="text-sm text-ink-muted">
    {t(lang, 'admin.pages.builderNote')}
    {canBuild && (
      <a href={`/admin/pages/builder/${editId}`} class="ml-2 text-primary hover:underline">{t(lang, 'admin.pages.openBuilder')}</a>
    )}
  </p>
) : (
  <> ...the existing bodies grid + markdown hint, unchanged... </>
)}
```
(No hidden body inputs: `parseCustomPageForm` reads absent fields as `''`, which wipes `custom_page_i18n.body_md` for builder pages — that column is unused by builder rendering, and `savePageLayout`'s title-only upsert is what preserves bodies in the OTHER direction. The e2e above asserts what actually matters: `format`/`layout_json` survive a classic save.)
3. In the table's status cell, add the format badge beside the publish badge:
```astro
{r.format === 'builder' && <span class={`${badge} ${badgeScheduled} ml-1`}>{t(lang, 'admin.pages.formatBuilder')}</span>}
```
(`badgeScheduled` is an existing neutral badge variant in adminUi.ts — verify the exported name; if it does not exist use `badgeInactive`.)
4. In the row actions, before Edit:
```astro
{canBuild && r.format === 'builder' && (
  <a href={`/admin/pages/builder/${r.id}`} class={rowBtn}>{t(lang, 'admin.pages.design')}</a>
)}
```

- [ ] **Step 4: Run**

Run: `npm run test:e2e -- test/e2e/pageBuilder.e2e.test.ts` → PASS. `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/pages/index.astro src/i18n/en.ts src/i18n/zh.ts test/e2e/pageBuilder.e2e.test.ts
git commit -m "feat(builder): classic pages admin — design links, badge, builder-page form"
```

---

### Task 11: Documentation — README + feature doc

**Files:**
- Modify: `README.md`
- Create: `docs/features/page-builder.md`
- Modify: `docs/features/modules.md` (mention the module and its authoring-only gating)

**Interfaces:** none — prose. Written for a NON-TECHNICAL church audience per Leo's documentation preference (plain English, no stack jargon in feature docs; README may mention the stack briefly).

- [ ] **Step 1: Read first** — `README.md` (feature list area), `docs/features/children-checkin.md` (tone/structure exemplar), `docs/features/modules.md`.

- [ ] **Step 2: `docs/features/page-builder.md`** — follow children-checkin.md's structure (what it is → how staff use it → what visitors see → module toggle → tips). Content it must cover, in that plain-English register: pages can now be designed by dragging blocks (sections, columns, headings, text, images, buttons, spacers, dividers) onto a canvas; text is entered in English and Chinese with a language toggle; properties (background, width, alignment, sizes) are chosen from menus that always match the church's chosen theme and dark mode; images upload straight into the page; Save keeps a draft, Save & publish makes it live; published pages load as plain fast web pages with no editor code; the classic Markdown editor still exists and old pages are untouched; the whole builder can be switched off under Settings → Modules, and pages built with it keep working when it is off.

- [ ] **Step 3: README** — add the feature to the feature list/table in the same style as existing rows (children check-in row is the newest exemplar), plus a short "Page builder" subsection if the README gives features subsections. Mention: drag-and-drop page designer for custom pages, bilingual, theme-aware, optional module, published pages ship zero JavaScript.

- [ ] **Step 4: `docs/features/modules.md`** — add `page-builder` wherever modules are enumerated, noting the one deliberate difference: it gates the DESIGN TOOL only; pages already published with it keep rendering when off.

- [ ] **Step 5: Verify + commit**

Run: `npm test` (parity/tokens unaffected but cheap).
```bash
git add README.md docs/features/page-builder.md docs/features/modules.md
git commit -m "docs: page builder feature guide + README row"
```

---

## Self-review results (already applied)

- **Spec coverage:** data model (T1), validation (T2), Tailwind-catch strategy (T3), zero-JS render (T4), module semantics (T5), stack additions (T6), builder route + save/upload + strings (T7), island (T8-9), admin list (T10), README/docs (T11). Revisions covered in T1; draft preview + corrupt-layout degrade in T4; CSRF rides the existing middleware (asserted implicitly by e2e POSTs carrying Origin).
- **Type consistency:** `savePageLayout`/`SavePageLayoutInput` (T1) match T7's route; `ContainerRef`/`builderReducer`/`canDrop`/`findNode`/`initialState` (T8) match T9's imports; `PageBuilderProps` identical in T7 stub and T9 final; blockStyles signatures (T3) match T4 + T9 call sites; e2e helpers used as defined in test/e2e/helpers.ts.
- **Known judgment calls an implementer must NOT "fix" silently:** builder pages render full-bleed under Base (no ContentPage title band) — deliberate; module gates authoring only — deliberate; classic save may blank body_md of a builder page — deliberate (asserted in T10 e2e); colors limited to theme tokens — deliberate.

## Execution notes

- Task order is dependency order; T2/T3 can run in parallel after T1; T4 needs T1-3; T5 anytime; T6 before T7; T8 before T9; T10 after T7; T11 last.
- After every task: `npm test`; after T4/T7/T10: the e2e file too. Before the final review: `npm run tokens:check`, `npx astro check`, `npm run test:e2e`, and (if a local Postgres is up) `npm run test:e2e:pg`.
