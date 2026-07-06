// News admin data-access (workers project, live D1): announcements + events
// hard-delete model. Covers create (i18n companion rows + versioned revision),
// update (i18n DELETE+INSERT rewrite + appended revision), the both-locale admin
// list, active toggle, hard delete writing a {v:1,deleted} revision snapshot, and
// the public windowed queries picking up an active in-window row.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  listAnnouncements,
  saveAnnouncement,
  deleteAnnouncement,
  toggleAnnouncementActive,
  listEvents,
  saveEvent,
  deleteEvent,
  toggleEventActive,
  type SaveAnnouncementInput,
  type SaveEventInput,
} from '../src/lib/adminDb';
import { listActiveAnnouncements, listActiveEvents } from '../src/lib/publicDb';

beforeEach(async () => {
  await env.DB.batch(
    ['DELETE FROM revisions', 'DELETE FROM announcement_i18n', 'DELETE FROM announcements', 'DELETE FROM event_i18n', 'DELETE FROM events'].map((s) =>
      env.DB.prepare(s),
    ),
  );
});

async function revCount(entity: string, entityId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE entity = ? AND entity_id = ?`).bind(entity, entityId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function i18nTitles(table: string, fk: string, id: number): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(`SELECT locale, title FROM ${table} WHERE ${fk} = ?`).bind(id).all<{ locale: string; title: string }>();
  return Object.fromEntries(results.map((r) => [r.locale, r.title]));
}

// ── Announcements ────────────────────────────────────────────────────────────

function aInput(overrides: Partial<SaveAnnouncementInput> = {}): SaveAnnouncementInput {
  return {
    id: null,
    titles: { en: 'Camp is open', zh: '圣经营开始报名' },
    url: 'https://church.example/en/events',
    sort: 3,
    active: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe('saveAnnouncement — create', () => {
  it('inserts the row, both i18n titles, and a versioned {v:1,input} revision', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput(), 'ed@example.com');
    expect(await i18nTitles('announcement_i18n', 'announcement_id', id)).toEqual({ en: 'Camp is open', zh: '圣经营开始报名' });
    expect(await revCount('announcement', id)).toBe(1);

    const rev = await env.DB.prepare(`SELECT snapshot_json, edited_by FROM revisions WHERE entity='announcement' AND entity_id=?`).bind(id).first<{ snapshot_json: string; edited_by: string }>();
    expect(rev!.edited_by).toBe('ed@example.com');
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.input.titles).toEqual({ en: 'Camp is open', zh: '圣经营开始报名' });
    expect('id' in snap.input).toBe(false);
  });

  it('lists every announcement with both-locale titles in sort order', async () => {
    await saveAnnouncement(env.DB, aInput({ titles: { en: 'B' }, sort: 2 }), 'ed');
    await saveAnnouncement(env.DB, aInput({ titles: { zh: '甲' }, sort: 1 }), 'ed');
    const rows = await listAnnouncements(env.DB);
    expect(rows.map((r) => r.sort)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ title_en: '', title_zh: '甲' });
    expect(rows[1]).toMatchObject({ title_en: 'B', title_zh: '' });
  });

  it('accepts a single-locale title (companion table holds only that row)', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput({ titles: { en: 'English only' } }), 'ed');
    expect(await i18nTitles('announcement_i18n', 'announcement_id', id)).toEqual({ en: 'English only' });
  });
});

describe('saveAnnouncement — update', () => {
  it('rewrites i18n rows (a dropped locale is removed) and appends a revision', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput(), 'ed');
    await saveAnnouncement(env.DB, aInput({ id, titles: { en: 'Renamed' }, sort: 9 }), 'ed');
    expect(await i18nTitles('announcement_i18n', 'announcement_id', id)).toEqual({ en: 'Renamed' }); // zh dropped
    const row = (await listAnnouncements(env.DB)).find((r) => r.id === id)!;
    expect(row).toMatchObject({ title_en: 'Renamed', title_zh: '', sort: 9 });
    expect(await revCount('announcement', id)).toBe(2);
  });
});

describe('announcement toggle + hard delete', () => {
  it('flips the active flag', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput({ active: true }), 'ed');
    await toggleAnnouncementActive(env.DB, id);
    expect((await listAnnouncements(env.DB)).find((r) => r.id === id)!.active).toBe(0);
    await toggleAnnouncementActive(env.DB, id);
    expect((await listAnnouncements(env.DB)).find((r) => r.id === id)!.active).toBe(1);
  });

  it('hard-deletes the row + children and records a {v:1,deleted} snapshot', async () => {
    const { id } = await saveAnnouncement(env.DB, aInput(), 'ed');
    await deleteAnnouncement(env.DB, id, 'ed@example.com');
    expect((await listAnnouncements(env.DB)).some((r) => r.id === id)).toBe(false);
    expect(Object.keys(await i18nTitles('announcement_i18n', 'announcement_id', id))).toHaveLength(0);
    const rev = await env.DB.prepare(`SELECT snapshot_json FROM revisions WHERE entity='announcement' AND entity_id=? ORDER BY id DESC`).bind(id).first<{ snapshot_json: string }>();
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.deleted.titles).toEqual({ en: 'Camp is open', zh: '圣经营开始报名' });
    expect(snap.deleted.url).toBe('https://church.example/en/events');
  });
});

describe('announcement public visibility', () => {
  it('an active, in-window announcement shows in the public ticker; a hidden one does not', async () => {
    await saveAnnouncement(env.DB, aInput({ titles: { en: 'Live one' }, active: true }), 'ed');
    const { id: hidden } = await saveAnnouncement(env.DB, aInput({ titles: { en: 'Hidden one' }, active: false }), 'ed');
    const titles = (await listActiveAnnouncements(env.DB, 'en', '2026-07-05')).map((a) => a.title);
    expect(titles).toContain('Live one');
    expect(titles).not.toContain('Hidden one');
    await toggleAnnouncementActive(env.DB, hidden); // now active
    expect((await listActiveAnnouncements(env.DB, 'en', '2026-07-05')).map((a) => a.title)).toContain('Hidden one');
  });
});

// ── Events ───────────────────────────────────────────────────────────────────

function eInput(overrides: Partial<SaveEventInput> = {}): SaveEventInput {
  return {
    id: null,
    titles: { en: 'Baptism Sunday', zh: '受洗主日' },
    blurbs: { en: 'Celebrate with us.', zh: '一同欢喜。' },
    imageKey: 'uploads/abc123def4567890-pic.png',
    url: 'https://church.example/en/events',
    sort: 2,
    active: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

describe('saveEvent — create + update', () => {
  it('inserts title+blurb i18n rows, the image key, and a versioned revision', async () => {
    const { id } = await saveEvent(env.DB, eInput(), 'ed');
    const row = (await listEvents(env.DB)).find((r) => r.id === id)!;
    expect(row).toMatchObject({
      title_en: 'Baptism Sunday', title_zh: '受洗主日',
      blurb_en: 'Celebrate with us.', blurb_zh: '一同欢喜。',
      image_key: 'uploads/abc123def4567890-pic.png',
    });
    const snap = JSON.parse((await env.DB.prepare(`SELECT snapshot_json FROM revisions WHERE entity='event' AND entity_id=?`).bind(id).first<{ snapshot_json: string }>())!.snapshot_json);
    expect(snap.v).toBe(1);
    expect(snap.input.imageKey).toBe('uploads/abc123def4567890-pic.png');
    expect('id' in snap.input).toBe(false);
  });

  it('update rewrites i18n, changes the image key, and appends a revision', async () => {
    const { id } = await saveEvent(env.DB, eInput(), 'ed');
    await saveEvent(env.DB, eInput({ id, titles: { en: 'Renamed' }, blurbs: {}, imageKey: null }), 'ed');
    const row = (await listEvents(env.DB)).find((r) => r.id === id)!;
    expect(row).toMatchObject({ title_en: 'Renamed', title_zh: '', blurb_en: '', image_key: null });
    expect(await revCount('event', id)).toBe(2);
  });

  it('stores a blurb only where a title exists in the same locale', async () => {
    // parseEventForm only supplies blurbs for titled locales; saveEvent trusts that,
    // but confirm the companion row count matches the titled-locale count.
    const { id } = await saveEvent(env.DB, eInput({ titles: { en: 'Only EN' }, blurbs: { en: 'hi' } }), 'ed');
    const { results } = await env.DB.prepare(`SELECT locale FROM event_i18n WHERE event_id=?`).bind(id).all<{ locale: string }>();
    expect(results.map((r) => r.locale)).toEqual(['en']);
  });
});

describe('event toggle + hard delete', () => {
  it('flips the active flag', async () => {
    const { id } = await saveEvent(env.DB, eInput({ active: true }), 'ed');
    await toggleEventActive(env.DB, id);
    expect((await listEvents(env.DB)).find((r) => r.id === id)!.active).toBe(0);
  });

  it('hard-deletes the row + children and snapshots {v:1,deleted} incl. image key', async () => {
    const { id } = await saveEvent(env.DB, eInput(), 'ed');
    await deleteEvent(env.DB, id, 'ed');
    expect((await listEvents(env.DB)).some((r) => r.id === id)).toBe(false);
    const rev = await env.DB.prepare(`SELECT snapshot_json FROM revisions WHERE entity='event' AND entity_id=? ORDER BY id DESC`).bind(id).first<{ snapshot_json: string }>();
    const snap = JSON.parse(rev!.snapshot_json);
    expect(snap.deleted.imageKey).toBe('uploads/abc123def4567890-pic.png');
    expect(snap.deleted.titles).toEqual({ en: 'Baptism Sunday', zh: '受洗主日' });
  });
});

describe('event public visibility', () => {
  it('an active, in-window event shows in the public strip with its image key', async () => {
    await saveEvent(env.DB, eInput({ titles: { en: 'Shown' }, imageKey: 'uploads/aaaa1111bbbb2222-x.png' }), 'ed');
    const cards = await listActiveEvents(env.DB, 'en', '2026-07-05');
    const card = cards.find((c) => c.title === 'Shown');
    expect(card).toBeDefined();
    expect(card!.imageKey).toBe('uploads/aaaa1111bbbb2222-x.png');
  });
});
