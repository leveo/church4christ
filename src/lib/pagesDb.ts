// Custom pages data-access layer (admin-authored static pages, e.g. "About",
// "Give"). Mirrors saveEvent's shape in adminDb.ts (db.batch upsert + i18n
// rewrite + revisions snapshot), with one structural difference: custom_pages.id
// is an app-generated TEXT key (crypto.randomUUID(), migrations/0005), not an
// auto-increment rowid, so the id is minted up front and the same upsert
// statement (INSERT ... ON CONFLICT(id) DO UPDATE) covers both create and
// update — no RETURNING-id branch is needed.
import type { AppDb } from './appDb';
import type { Locale } from './locales';

export interface CustomPageListRow {
  id: string;
  slug: string;
  published: boolean;
  title_en: string;
  title_zh: string;
  updated_at: string;
}

export interface CustomPageDetail {
  id: string;
  slug: string;
  published: boolean;
  i18n: { en: { title: string; body_md: string }; zh: { title: string; body_md: string } };
}

export interface SaveCustomPageInput {
  id: string | null;
  slug: string;
  published: boolean;
  title_en: string;
  title_zh: string;
  body_en: string;
  body_zh: string;
  updatedBy: string;
}

/** Every custom page, both-locale titles for the admin list, alphabetical by slug. */
export async function listCustomPages(db: AppDb): Promise<CustomPageListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id AS id, p.slug AS slug, p.published AS published, p.updated_at AS updated_at,
              COALESCE(en.title, '') AS title_en, COALESCE(zh.title, '') AS title_zh
       FROM custom_pages p
       LEFT JOIN custom_page_i18n en ON en.page_id = p.id AND en.locale = 'en'
       LEFT JOIN custom_page_i18n zh ON zh.page_id = p.id AND zh.locale = 'zh'
       ORDER BY p.slug`,
    )
    .all<{ id: string; slug: string; published: number; updated_at: string; title_en: string; title_zh: string }>();
  return results.map((r) => ({ ...r, published: r.published === 1 }));
}

async function loadI18n(db: AppDb, pageId: string): Promise<CustomPageDetail['i18n']> {
  const { results } = await db
    .prepare(`SELECT locale, title, body_md FROM custom_page_i18n WHERE page_id = ?1`)
    .bind(pageId)
    .all<{ locale: string; title: string; body_md: string }>();
  const byLocale = Object.fromEntries(results.map((r) => [r.locale, { title: r.title, body_md: r.body_md }]));
  return {
    en: byLocale.en ?? { title: '', body_md: '' },
    zh: byLocale.zh ?? { title: '', body_md: '' },
  };
}

function toDetail(page: { id: string; slug: string; published: number }, i18n: CustomPageDetail['i18n']): CustomPageDetail {
  return { id: page.id, slug: page.slug, published: page.published === 1, i18n };
}

export async function getCustomPage(db: AppDb, id: string): Promise<CustomPageDetail | null> {
  const page = await db
    .prepare(`SELECT id, slug, published FROM custom_pages WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; slug: string; published: number }>();
  if (!page) return null;
  return toDetail(page, await loadI18n(db, page.id));
}

export async function getCustomPageBySlug(db: AppDb, slug: string): Promise<CustomPageDetail | null> {
  const page = await db
    .prepare(`SELECT id, slug, published FROM custom_pages WHERE slug = ?1`)
    .bind(slug)
    .first<{ id: string; slug: string; published: number }>();
  if (!page) return null;
  return toDetail(page, await loadI18n(db, page.id));
}

/** Create or update a custom page in ONE transaction (upsert + i18n rewrite +
 *  revision snapshot), guarded by a slug-uniqueness pre-check. */
export async function saveCustomPage(
  db: AppDb,
  input: SaveCustomPageInput,
): Promise<{ ok: true; id: string } | { ok: false; error: 'slug_taken' }> {
  const id = input.id ?? crypto.randomUUID();

  const taken = await db
    .prepare(`SELECT id FROM custom_pages WHERE slug = ?1 AND id <> ?2`)
    .bind(input.slug, id)
    .first<{ id: string }>();
  if (taken) return { ok: false, error: 'slug_taken' };

  const published = input.published ? 1 : 0;
  const { id: _id, updatedBy, ...content } = input;
  const snapshotJson = JSON.stringify({ v: 1, input: content });

  await db.batch([
    // Upsert by id: a normal edit UPDATEs the live row; a create INSERTs under
    // the id minted above. Runs first so the i18n rewrite below always has a
    // parent row to reference.
    db
      .prepare(
        `INSERT INTO custom_pages (id, slug, published, updated_at) VALUES (?3, ?1, ?2, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET slug = ?1, published = ?2, updated_at = datetime('now')`,
      )
      .bind(input.slug, published, id),
    db.prepare(`DELETE FROM custom_page_i18n WHERE page_id = ?1`).bind(id),
    db.prepare(`INSERT INTO custom_page_i18n (page_id, locale, title, body_md) VALUES (?1, 'en', ?2, ?3)`).bind(id, input.title_en, input.body_en),
    db.prepare(`INSERT INTO custom_page_i18n (page_id, locale, title, body_md) VALUES (?1, 'zh', ?2, ?3)`).bind(id, input.title_zh, input.body_zh),
    db
      .prepare(`INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('custom_page', ?1, ?2, ?3)`)
      .bind(id, snapshotJson, updatedBy),
  ]);
  return { ok: true, id };
}

/** Flip a page's published flag (quick list action, no snapshot). Atomic
 *  single-statement UPDATE — never a read-modify-write, so a concurrent
 *  content edit can't be reverted by a toggle. Mirrors toggleEventActive;
 *  updated_at uses the same expression as the save path. */
export async function toggleCustomPagePublished(db: AppDb, id: string): Promise<void> {
  await db
    .prepare(`UPDATE custom_pages SET published = 1 - published, updated_at = datetime('now') WHERE id = ?1`)
    .bind(id)
    .run();
}

/** Hard-delete a page and its i18n rows. A missing id is a harmless no-op. */
export async function deleteCustomPage(db: AppDb, id: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM custom_page_i18n WHERE page_id = ?1`).bind(id),
    db.prepare(`DELETE FROM custom_pages WHERE id = ?1`).bind(id),
  ]);
}

/** Localized titles for a set of slugs (site footer/nav links), published pages
 *  only. zh falls back to the en title when the zh title is empty; a slug with
 *  no published page is simply absent from the map. */
export async function listPublishedPageTitles(db: AppDb, slugs: string[], locale: Locale): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const placeholders = slugs.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT p.slug AS slug, COALESCE(NULLIF(l.title, ''), NULLIF(en.title, ''), '') AS title
       FROM custom_pages p
       LEFT JOIN custom_page_i18n l ON l.page_id = p.id AND l.locale = ?${slugs.length + 1}
       LEFT JOIN custom_page_i18n en ON en.page_id = p.id AND en.locale = 'en'
       WHERE p.published = 1 AND p.slug IN (${placeholders})`,
    )
    .bind(...slugs, locale)
    .all<{ slug: string; title: string }>();
  return new Map(results.map((r) => [r.slug, r.title]));
}
