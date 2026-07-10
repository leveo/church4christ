// Custom pages data layer (workers project, live D1). migrations/0005 auto-
// applies via test/setup.ts. Covers the create/update/slug-conflict/delete
// round trip through saveCustomPage's upsert + i18n rewrite + revision
// snapshot, plus the public-facing listPublishedPageTitles lookup (zh → en
// title fallback, published-only).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCustomPage,
  getCustomPage,
  getCustomPageBySlug,
  listCustomPages,
  listPublishedPageTitles,
  saveCustomPage,
  toggleCustomPagePublished,
} from '../src/lib/pagesDb';

beforeEach(async () => {
  await env.DB.batch(
    ["DELETE FROM revisions WHERE entity = 'custom_page'", 'DELETE FROM custom_page_i18n', 'DELETE FROM custom_pages'].map((s) =>
      env.DB.prepare(s),
    ),
  );
});

function input(overrides: Partial<Parameters<typeof saveCustomPage>[1]> = {}) {
  return {
    id: null,
    slug: 'about',
    published: true,
    title_en: 'About Us',
    title_zh: '关于我们',
    body_en: 'We are a **church**.',
    body_zh: '我们是一间**教会**。',
    updatedBy: 'ed@example.com',
    ...overrides,
  };
}

describe('saveCustomPage — create', () => {
  it('inserts the page + both i18n rows, and it shows up in listCustomPages', async () => {
    const res = await saveCustomPage(env.DB, input());
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const rows = await listCustomPages(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      slug: 'about',
      published: true,
      title_en: 'About Us',
      title_zh: '关于我们',
    });
    expect(typeof rows[0].updated_at).toBe('string');
  });

  it('writes a custom_page revision snapshot', async () => {
    const res = await saveCustomPage(env.DB, input());
    const id = (res as { ok: true; id: string }).id;
    const rev = await env.DB
      .prepare(`SELECT entity, entity_id, edited_by, snapshot_json FROM revisions WHERE entity = 'custom_page' AND entity_id = ?1`)
      .bind(id)
      .first<{ entity: string; entity_id: string; edited_by: string; snapshot_json: string }>();
    expect(rev).not.toBeNull();
    expect(rev!.edited_by).toBe('ed@example.com');
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.input.slug).toBe('about');
  });
});

describe('getCustomPage / getCustomPageBySlug', () => {
  it('getCustomPageBySlug returns the full bilingual detail', async () => {
    const { id } = (await saveCustomPage(env.DB, input())) as { ok: true; id: string };
    const detail = await getCustomPageBySlug(env.DB, 'about');
    expect(detail).toEqual({
      id,
      slug: 'about',
      published: true,
      i18n: {
        en: { title: 'About Us', body_md: 'We are a **church**.' },
        zh: { title: '关于我们', body_md: '我们是一间**教会**。' },
      },
    });
  });

  it('getCustomPage(id) matches getCustomPageBySlug(slug) for the same page', async () => {
    const { id } = (await saveCustomPage(env.DB, input())) as { ok: true; id: string };
    expect(await getCustomPage(env.DB, id)).toEqual(await getCustomPageBySlug(env.DB, 'about'));
  });

  it('returns null for a missing id or slug', async () => {
    expect(await getCustomPage(env.DB, 'nope')).toBeNull();
    expect(await getCustomPageBySlug(env.DB, 'nope')).toBeNull();
  });
});

describe('saveCustomPage — slug uniqueness', () => {
  it('a duplicate slug on a DIFFERENT id is rejected with slug_taken', async () => {
    await saveCustomPage(env.DB, input({ slug: 'about' }));
    const res = await saveCustomPage(env.DB, input({ slug: 'about', title_en: 'Second Page' }));
    expect(res).toEqual({ ok: false, error: 'slug_taken' });
    // The rejected save touched nothing.
    expect(await listCustomPages(env.DB)).toHaveLength(1);
  });

  it('updating the SAME id with its own slug is allowed (not a self-conflict)', async () => {
    const { id } = (await saveCustomPage(env.DB, input({ slug: 'about' }))) as { ok: true; id: string };
    const res = await saveCustomPage(env.DB, input({ id, slug: 'about', title_en: 'Renamed' }));
    expect(res).toEqual({ ok: true, id });
    expect(await listCustomPages(env.DB)).toHaveLength(1);
  });
});

describe('saveCustomPage — update', () => {
  it('update by id keeps the slug and rewrites i18n content + a second revision', async () => {
    const { id } = (await saveCustomPage(env.DB, input())) as { ok: true; id: string };
    const res = await saveCustomPage(
      env.DB,
      input({ id, title_en: 'About Us (updated)', body_en: 'New body.', published: false }),
    );
    expect(res).toEqual({ ok: true, id });

    const detail = await getCustomPage(env.DB, id);
    expect(detail).toEqual({
      id,
      slug: 'about',
      published: false,
      i18n: {
        en: { title: 'About Us (updated)', body_md: 'New body.' },
        zh: { title: '关于我们', body_md: '我们是一间**教会**。' },
      },
    });

    const { results: revs } = await env.DB
      .prepare(`SELECT id FROM revisions WHERE entity = 'custom_page' AND entity_id = ?1`)
      .bind(id)
      .all();
    expect(revs).toHaveLength(2);

    expect(await listCustomPages(env.DB)).toHaveLength(1); // update, not a second row
  });
});

describe('toggleCustomPagePublished', () => {
  it('flips published both ways WITHOUT touching slug or i18n content', async () => {
    const { id } = (await saveCustomPage(env.DB, input({ published: true }))) as { ok: true; id: string };

    await toggleCustomPagePublished(env.DB, id);
    let detail = await getCustomPage(env.DB, id);
    expect(detail!.published).toBe(false);

    await toggleCustomPagePublished(env.DB, id);
    detail = await getCustomPage(env.DB, id);
    expect(detail!.published).toBe(true);

    // The atomic flip must not read-modify-write content: slug + both i18n
    // rows stay byte-identical to what saveCustomPage wrote.
    expect(detail).toEqual({
      id,
      slug: 'about',
      published: true,
      i18n: {
        en: { title: 'About Us', body_md: 'We are a **church**.' },
        zh: { title: '关于我们', body_md: '我们是一间**教会**。' },
      },
    });
  });

  it('writes no revision snapshot (quick list action, mirrors toggleEventActive)', async () => {
    const { id } = (await saveCustomPage(env.DB, input())) as { ok: true; id: string };
    await toggleCustomPagePublished(env.DB, id);
    const { results } = await env.DB
      .prepare(`SELECT id FROM revisions WHERE entity = 'custom_page' AND entity_id = ?1`)
      .bind(id)
      .all();
    expect(results).toHaveLength(1); // only the save's snapshot, none from the toggle
  });

  it('an unknown id is a harmless no-op', async () => {
    await expect(toggleCustomPagePublished(env.DB, 'does-not-exist')).resolves.toBeUndefined();
  });
});

describe('deleteCustomPage', () => {
  it('removes the page row and its i18n rows', async () => {
    const { id } = (await saveCustomPage(env.DB, input())) as { ok: true; id: string };
    await deleteCustomPage(env.DB, id);

    expect(await getCustomPage(env.DB, id)).toBeNull();
    expect(await listCustomPages(env.DB)).toHaveLength(0);
    const { results } = await env.DB.prepare(`SELECT * FROM custom_page_i18n WHERE page_id = ?1`).bind(id).all();
    expect(results).toHaveLength(0);
  });

  it('deleting an unknown id is a harmless no-op', async () => {
    await expect(deleteCustomPage(env.DB, 'does-not-exist')).resolves.toBeUndefined();
  });
});

describe('listPublishedPageTitles', () => {
  it('returns only published pages, and zh falls back to the en title when the zh title is empty', async () => {
    const { id: publishedId } = (await saveCustomPage(
      env.DB,
      input({ slug: 'give', published: true, title_en: 'Give', title_zh: '' }),
    )) as { ok: true; id: string };
    await saveCustomPage(env.DB, input({ slug: 'draft-only', published: false, title_en: 'Draft Page' }));
    await saveCustomPage(env.DB, input({ slug: 'bilingual', published: true, title_en: 'Bilingual', title_zh: '双语' }));

    const zh = await listPublishedPageTitles(env.DB, ['give', 'draft-only', 'bilingual', 'missing'], 'zh');
    expect(zh.get('give')).toBe('Give'); // zh title empty -> en fallback
    expect(zh.has('draft-only')).toBe(false); // unpublished, excluded
    expect(zh.get('bilingual')).toBe('双语'); // zh title present -> used as-is
    expect(zh.has('missing')).toBe(false);

    const en = await listPublishedPageTitles(env.DB, ['give'], 'en');
    expect(en.get('give')).toBe('Give');

    expect(publishedId).not.toBe('');
  });

  it('an empty slugs list returns an empty map', async () => {
    expect(await listPublishedPageTitles(env.DB, [], 'en')).toEqual(new Map());
  });
});
