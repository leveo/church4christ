// Workers project (live, migrated D1). Covers publicDb.ts visibility rules:
// announcement/event windowing by active + starts_at/ends_at against a fixed
// `today`, i18n localized-then-en fallback, and latestPublishedSermon skipping
// drafts/soft-deletes while picking the newest sermon_date.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveAnnouncements, listActiveEvents, latestPublishedSermon } from '../src/lib/publicDb';

const TODAY = '2026-07-05';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM announcement_i18n'),
    env.DB.prepare('DELETE FROM announcements'),
    env.DB.prepare('DELETE FROM event_i18n'),
    env.DB.prepare('DELETE FROM events'),
    env.DB.prepare('DELETE FROM sermons'),
    env.DB.prepare('DELETE FROM service_types'),
  ]);
});

describe('listActiveAnnouncements', () => {
  it('applies the active + start/end window and orders by sort', async () => {
    const db = env.DB;
    // A: null bounds, active → shown (sort 2)
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (1, 1, 2, NULL, NULL)").run();
    // B: starts in the future → hidden
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (2, 1, 1, '2999-01-01', NULL)").run();
    // C: ended in the past → hidden
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (3, 1, 3, NULL, '2000-01-01')").run();
    // D: inactive though in-window → hidden
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (4, 0, 4, NULL, NULL)").run();
    // E: window spans today → shown (sort 1, first)
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (5, 1, 1, '2026-06-01', '2026-08-31 23:59:00')").run();
    for (const [id, loc, title] of [
      [1, 'en', 'Null bounds'],
      [2, 'en', 'Future'],
      [3, 'en', 'Past'],
      [4, 'en', 'Inactive'],
      [5, 'en', 'In window'],
    ] as const) {
      await db.prepare('INSERT INTO announcement_i18n (announcement_id, locale, title) VALUES (?, ?, ?)').bind(id, loc, title).run();
    }

    const rows = await listActiveAnnouncements(db, 'en', TODAY);
    expect(rows.map((r) => r.title)).toEqual(['In window', 'Null bounds']);
  });

  it('keeps an item visible on its exact end date and falls back to en when zh is missing', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO announcements (id, active, sort, starts_at, ends_at) VALUES (1, 1, 1, NULL, '2026-07-05 23:59:00')").run();
    await db.prepare("INSERT INTO announcement_i18n (announcement_id, locale, title) VALUES (1, 'en', 'Camp EN')").run();
    // no zh row → COALESCE falls back to en
    const zh = await listActiveAnnouncements(db, 'zh', TODAY);
    expect(zh.map((r) => r.title)).toEqual(['Camp EN']);
  });

  it('prefers the localized title when present', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO announcements (id, active, sort) VALUES (1, 1, 1)").run();
    await db.prepare("INSERT INTO announcement_i18n (announcement_id, locale, title) VALUES (1, 'en', 'Picnic'), (1, 'zh', '野餐')").run();
    const zh = await listActiveAnnouncements(db, 'zh', TODAY);
    expect(zh[0].title).toBe('野餐');
  });
});

describe('listActiveEvents', () => {
  it('windows by active + dates, localizes title/blurb, and honors the limit', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO events (id, active, sort, image_key, url, starts_at, ends_at) VALUES (1, 1, 2, 'k1', 'https://x/1', NULL, NULL)").run();
    await db.prepare("INSERT INTO events (id, active, sort, starts_at, ends_at) VALUES (2, 1, 1, '2026-06-01', '2026-08-01')").run();
    await db.prepare("INSERT INTO events (id, active, sort, starts_at, ends_at) VALUES (3, 0, 3, NULL, NULL)").run(); // inactive
    await db.prepare("INSERT INTO events (id, active, sort, ends_at) VALUES (4, 1, 0, '2000-01-01')").run(); // expired
    await db.prepare("INSERT INTO event_i18n (event_id, locale, title, blurb) VALUES (1, 'en', 'Camp', 'Camp blurb'), (1, 'zh', '圣经营', '圣经营简介')").run();
    await db.prepare("INSERT INTO event_i18n (event_id, locale, title, blurb) VALUES (2, 'en', 'Baptism', 'Baptism blurb')").run();

    const all = await listActiveEvents(db, 'zh', TODAY);
    expect(all.map((r) => r.title)).toEqual(['Baptism', '圣经营']); // sort 1 then 2; inactive/expired dropped
    const camp = all.find((r) => r.title === '圣经营')!;
    expect(camp.blurb).toBe('圣经营简介'); // localized
    expect(camp.imageKey).toBe('k1');
    expect(camp.url).toBe('https://x/1');
    expect(all.find((r) => r.title === 'Baptism')!.blurb).toBe('Baptism blurb'); // en fallback

    const limited = await listActiveEvents(db, 'zh', TODAY, 1);
    expect(limited.map((r) => r.title)).toEqual(['Baptism']);
  });
});

describe('latestPublishedSermon', () => {
  it('returns the newest published, non-deleted sermon and ignores drafts/deletes', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await db
      .prepare(
        `INSERT INTO sermons (id, service_type_id, sermon_date, title, speaker, scripture, youtube_id, series, status, deleted_at) VALUES
          (1, 1, '2026-06-21', 'Older',  'A', 'John 1', 'y1', 'S', 'published', NULL),
          (2, 1, '2026-06-28', 'Newest', 'B', 'John 2', 'y2', 'S', 'published', NULL),
          (3, 1, '2026-07-05', 'Draft',  'C', NULL,     'y3', 'S', 'draft',     NULL),
          (4, 1, '2026-07-12', 'Deleted','D', NULL,     'y4', 'S', 'published', datetime('now'))`,
      )
      .run();
    const s = await latestPublishedSermon(db);
    expect(s?.title).toBe('Newest');
    expect(s?.speaker).toBe('B');
    expect(s?.scripture).toBe('John 2');
  });

  it('returns null when nothing is published', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await db
      .prepare("INSERT INTO sermons (id, service_type_id, sermon_date, title, status) VALUES (1, 1, '2026-06-28', 'Draft only', 'draft')")
      .run();
    expect(await latestPublishedSermon(db)).toBeNull();
  });
});
