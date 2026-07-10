// Custom pages parity (Postgres): pagesDb runs unchanged against pg via
// PgAdapter, migrations-supabase/0004 applies through the real runner, the
// revisions widening (entity CHECK + entity_id TEXT) accepts custom_page UUID
// snapshots, and the revisions readers' entity_id normalization returns the
// SAME JS types as D1 (numbers for integer entities, strings for UUIDs).
// Self-skips (like every test/pg suite) when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import {
  deleteCustomPage,
  getCustomPage,
  getCustomPageBySlug,
  listCustomPages,
  listPublishedPageTitles,
  saveCustomPage,
  savePageLayout,
} from '../../src/lib/pagesDb';
import { saveEvent, getRevision, listRecentRevisions } from '../../src/lib/adminDb';

describe.skipIf(!hasPg)('custom pages parity (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
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

  it('CRUD round-trip via pagesDb (create → read → slug guard → update → delete)', async () => {
    const res = await saveCustomPage(db, input());
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;

    const rows = await listCustomPages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, slug: 'about', published: true, title_en: 'About Us', title_zh: '关于我们' });

    expect(await getCustomPageBySlug(db, 'about')).toEqual({
      id,
      slug: 'about',
      published: true,
      format: 'markdown',
      layout_json: null,
      i18n: {
        en: { title: 'About Us', body_md: 'We are a **church**.' },
        zh: { title: '关于我们', body_md: '我们是一间**教会**。' },
      },
    });
    expect(await getCustomPage(db, id)).toEqual(await getCustomPageBySlug(db, 'about'));

    // Duplicate slug on a different id → rejected, nothing written.
    expect(await saveCustomPage(db, input({ title_en: 'Impostor' }))).toEqual({ ok: false, error: 'slug_taken' });
    expect(await listCustomPages(db)).toHaveLength(1);

    // Update the same id (own slug allowed), i18n rewritten.
    expect(await saveCustomPage(db, input({ id, published: false, title_en: 'Updated' }))).toEqual({ ok: true, id });
    const updated = await getCustomPage(db, id);
    expect(updated!.published).toBe(false);
    expect(updated!.i18n.en.title).toBe('Updated');

    await deleteCustomPage(db, id);
    expect(await getCustomPage(db, id)).toBeNull();
    const left = await sql.unsafe('SELECT count(*)::int AS n FROM custom_page_i18n WHERE page_id = $1', [id]);
    expect(left[0].n).toBe(0);
  });

  it('listPublishedPageTitles: published-only, zh falls back to the en title', async () => {
    await saveCustomPage(db, input({ slug: 'give', title_en: 'Give', title_zh: '' }));
    await saveCustomPage(db, input({ slug: 'draft-only', published: false, title_en: 'Draft' }));
    const zh = await listPublishedPageTitles(db, ['give', 'draft-only'], 'zh');
    expect(zh.get('give')).toBe('Give');
    expect(zh.has('draft-only')).toBe(false);
  });

  it('saveCustomPage writes a custom_page revision whose UUID entity_id survives the readers', async () => {
    const { id } = (await saveCustomPage(db, input({ slug: 'history' }))) as { ok: true; id: string };
    const revs = await sql.unsafe(
      "SELECT id, entity, entity_id, edited_by, snapshot_json FROM revisions WHERE entity = 'custom_page' AND entity_id = $1",
      [id],
    );
    expect(revs).toHaveLength(1);
    expect(revs[0].edited_by).toBe('ed@example.com');
    const snap = JSON.parse(revs[0].snapshot_json as string);
    expect(snap.v).toBe(1);
    expect(snap.input.slug).toBe('history');

    // Through the reader: the UUID is NOT number-coerced by normalization.
    const rev = await getRevision(db, Number(revs[0].id));
    expect(rev!.entity_id).toBe(id);
  });

  it('entity_id read-back typing matches D1 for a numeric-id entity (normalization)', async () => {
    // The pg column is TEXT (0004), so the raw driver row is a string — the
    // exact regression that broke the restore guard's strict !== comparison.
    const { id: eventId } = await saveEvent(
      db,
      { id: null, titles: { en: 'Parity' }, blurbs: { en: '' }, imageKey: null, url: null, sort: 0, active: false, startsAt: null, endsAt: null },
      'ed@example.com',
    );
    const raw = await sql.unsafe("SELECT id, entity_id FROM revisions WHERE entity = 'event'");
    expect(raw).toHaveLength(1);
    expect(typeof raw[0].entity_id).toBe('string'); // driver reality on pg

    const rev = await getRevision(db, Number(raw[0].id));
    expect(rev!.entity_id).toBe(eventId); // strict equality with the D1-typed number
    expect(typeof rev!.entity_id).toBe('number');

    const recent = await listRecentRevisions(db, 10);
    const eventRow = recent.find((r) => r.entity === 'event')!;
    expect(eventRow.entity_id).toBe(eventId);
    expect(typeof eventRow.entity_id).toBe('number');
    // …while custom_page rows keep their UUID strings side by side.
    const pageRow = recent.find((r) => r.entity === 'custom_page')!;
    expect(typeof pageRow.entity_id).toBe('string');
  });

  it('savePageLayout create → update round-trip, preserving body_md from a prior saveCustomPage', async () => {
    const LAYOUT = JSON.stringify({ v: 1, blocks: [] });

    const created = await savePageLayout(db, {
      id: null, slug: 'built', published: false,
      title_en: 'Built', title_zh: '构建', layoutJson: LAYOUT, updatedBy: 'e@x',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const page = await getCustomPage(db, created.id);
    expect(page?.format).toBe('builder');
    expect(page?.layout_json).toBe(LAYOUT);
    expect(page?.i18n.en.title).toBe('Built');
    expect(page?.i18n.zh.title).toBe('构建');

    // Now seed a markdown page's body via saveCustomPage on the SAME row, then
    // update it through savePageLayout with a new title + layout — the classic
    // body_md must survive the flip back to (and within) builder format.
    const seeded = await saveCustomPage(db, {
      id: created.id, slug: 'built', published: false,
      title_en: 'Built', title_zh: '构建', body_en: 'keep me', body_zh: '保留', updatedBy: 'e@x',
    });
    expect(seeded).toEqual({ ok: true, id: created.id });

    const NEW_LAYOUT = JSON.stringify({ v: 1, blocks: [{ id: 's1', type: 'section', props: {}, children: [] }] });
    const updated = await savePageLayout(db, {
      id: created.id, slug: 'built', published: true,
      title_en: 'Built 2', title_zh: '构建 2', layoutJson: NEW_LAYOUT, updatedBy: 'e@x',
    });
    expect(updated).toEqual({ ok: true, id: created.id });

    const final = await getCustomPage(db, created.id);
    expect(final?.format).toBe('builder');
    expect(final?.published).toBe(true);
    expect(final?.layout_json).toBe(NEW_LAYOUT);
    expect(final?.i18n.en.title).toBe('Built 2');
    expect(final?.i18n.zh.title).toBe('构建 2');
    expect(final?.i18n.en.body_md).toBe('keep me');
    expect(final?.i18n.zh.body_md).toBe('保留');
  });
});
