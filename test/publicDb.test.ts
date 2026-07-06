// Workers project (live, migrated D1). Covers publicDb.ts visibility rules:
// announcement/event windowing by active + starts_at/ends_at against a fixed
// `today`, i18n localized-then-en fallback, and latestPublishedSermon skipping
// drafts/soft-deletes while picking the newest sermon_date.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  listActiveAnnouncements,
  listActiveEvents,
  latestPublishedSermon,
  listSermonYears,
  listSermonsByYear,
  latestBulletins,
  getBulletin,
  listBulletinDates,
  listBulletinServicesForDate,
  getBulletinAnnouncements,
  bulletinRoster,
  latestPrayerSheet,
  getPrayerSheet,
  listPrayerSheetDates,
} from '../src/lib/publicDb';
import { parseJsonArray } from '../src/lib/json';

const TODAY = '2026-07-05';

beforeEach(async () => {
  // Child rows before parents so FK-enforced deletes stay clean.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM bulletin_announcements'),
    env.DB.prepare('DELETE FROM bulletins'),
    env.DB.prepare('DELETE FROM sermons'),
    env.DB.prepare('DELETE FROM position_i18n'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM team_i18n'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM prayer_sheets'),
    env.DB.prepare('DELETE FROM service_type_i18n'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM announcement_i18n'),
    env.DB.prepare('DELETE FROM announcements'),
    env.DB.prepare('DELETE FROM event_i18n'),
    env.DB.prepare('DELETE FROM events'),
    env.DB.prepare('DELETE FROM people'),
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

describe('listSermonYears / listSermonsByYear', () => {
  it('lists distinct published years desc and groups a year newest-first with localized service type', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id, sort) VALUES (1, 1), (2, 2)').run();
    await db
      .prepare(
        "INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1,'en','English Service'),(1,'zh','英文堂'),(2,'en','Chinese Service')",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO sermons (id, service_type_id, sermon_date, title, speaker, scripture, youtube_id, series, status, deleted_at) VALUES
          (1, 1, '2026-06-28', 'Newest 2026', 'A', 'John 1', 'zzDEMO00001', 'S', 'published', NULL),
          (2, 1, '2026-05-31', 'Older 2026',  'B', NULL,     'zzDEMO00002', 'S', 'published', NULL),
          (3, 2, '2025-12-14', 'Year 2025',   'C', NULL,     'zzDEMO00003', 'S', 'published', NULL),
          (4, 1, '2026-07-05', 'Draft',       'D', NULL,     'zzDEMO00004', 'S', 'draft',     NULL),
          (5, 1, '2024-01-07', 'Deleted',     'E', NULL,     'zzDEMO00005', 'S', 'published', datetime('now'))`,
      )
      .run();

    expect(await listSermonYears(db)).toEqual([2026, 2025]); // draft counts under existing 2026; deleted 2024 excluded

    const y2026 = await listSermonsByYear(db, 2026, 'zh');
    expect(y2026.map((s) => s.title)).toEqual(['Newest 2026', 'Older 2026']); // newest first, draft excluded
    expect(y2026[0].serviceTypeName).toBe('英文堂'); // localized

    const y2025 = await listSermonsByYear(db, 2025, 'zh');
    expect(y2025[0].serviceTypeName).toBe('Chinese Service'); // en fallback (no zh row)
  });
});

describe('latestBulletins / getBulletin / listBulletinDates', () => {
  async function seedBulletins(db: D1Database) {
    await db.prepare('INSERT INTO service_types (id, sort) VALUES (1, 1)').run();
    await db
      .prepare("INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1,'en','English Service'),(1,'zh','英文堂')")
      .run();
    await db
      .prepare(
        `INSERT INTO bulletins (id, service_type_id, bulletin_date, service_time_label, program_json, status, publish_at, deleted_at) VALUES
          (1, 1, '2026-06-21', '9:30', '[]', 'published', '2026-06-19 12:00:00', NULL),
          (2, 1, '2026-06-28', '9:30', '[]', 'published', NULL, NULL),
          (3, 1, '2026-07-05', '9:30', '[]', 'published', '2999-01-01 00:00:00', NULL),
          (4, 1, '2026-07-12', '9:30', '[]', 'draft', NULL, NULL)`,
      )
      .run();
  }

  it('picks the latest published bulletin per service type, hiding future-publish and draft', async () => {
    const db = env.DB;
    await seedBulletins(db);
    const latest = await latestBulletins(db, 'zh');
    expect(latest.map((b) => b.bulletin_date)).toEqual(['2026-06-28']); // 07-05 not yet published, 07-12 draft
    expect(latest[0].serviceTypeName).toBe('英文堂');
  });

  it('getBulletin enforces the publish rule and listBulletinDates lists only visible dates', async () => {
    const db = env.DB;
    await seedBulletins(db);
    expect(await getBulletin(db, 1, '2026-07-05', 'en')).toBeNull(); // publish_at in the future
    expect((await getBulletin(db, 1, '2026-06-21', 'en'))?.bulletin_date).toBe('2026-06-21');
    expect((await listBulletinDates(db, 'en')).map((d) => d.bulletin_date)).toEqual(['2026-06-28', '2026-06-21']);
    expect((await listBulletinServicesForDate(db, '2026-06-28', 'en')).map((s) => s.service_type_id)).toEqual([1]);
  });
});

describe('bulletinRoster', () => {
  it('groups confirmed + unconfirmed by position (sort order); excludes declined and every soft-delete', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await db.prepare('INSERT INTO teams (id) VALUES (1)').run();
    await db.prepare("INSERT INTO plans (id, service_type_id, plan_date) VALUES (1, 1, '2026-06-28')").run();
    // position 3 is soft-deleted: any assignment on it must not surface.
    await db
      .prepare(
        "INSERT INTO positions (id, team_id, sort, deleted_at) VALUES (1, 1, 2, NULL), (2, 1, 1, NULL), (3, 1, 3, datetime('now'))",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO position_i18n (position_id, locale, name) VALUES (1,'en','Vocalist'),(1,'zh','歌手'),(2,'en','Sound'),(3,'en','Ghost')",
      )
      .run();
    // person 5 is soft-deleted: their confirmed assignment must not surface.
    await db
      .prepare(
        `INSERT INTO people (id, display_name, email, deleted_at) VALUES
          (1, 'Amy', 'amy@example.com', NULL), (2, 'Mark', 'mark@example.com', NULL),
          (3, 'Dan', 'dan@example.com', NULL), (4, 'Sam', 'sam@example.com', NULL),
          (5, 'Del', 'del@example.com', datetime('now'))`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO roster_assignments (id, plan_id, position_id, person_id, status, deleted_at) VALUES
          (1, 1, 1, 1, 'C', NULL),
          (2, 1, 1, 2, 'U', NULL),
          (3, 1, 1, 3, 'D', NULL),
          (4, 1, 2, 4, 'C', NULL),
          (5, 1, 2, 1, 'U', datetime('now')),
          (6, 1, 2, 5, 'C', NULL),
          (7, 1, 3, 1, 'C', NULL)`,
      )
      .run();

    const roster = await bulletinRoster(db, 1, '2026-06-28', 'zh');
    // position 2 (sort 1) then position 1 (sort 2); pos2 en-fallback, pos1 zh.
    // 'Ghost' (soft-deleted position) must not appear at all.
    expect(roster.map((r) => r.position)).toEqual(['Sound', '歌手']);
    expect(roster.find((r) => r.position === '歌手')!.people).toEqual(['Amy', 'Mark']); // declined Dan excluded
    // deleted assignment (Amy) + soft-deleted person (Del) both excluded
    expect(roster.find((r) => r.position === 'Sound')!.people).toEqual(['Sam']);
  });

  it('returns [] when no plan matches the service type + date', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    expect(await bulletinRoster(db, 1, '2026-06-28', 'en')).toEqual([]);
  });
});

describe('bulletin announcements', () => {
  it('returns a bulletin\'s announcements in seq order', async () => {
    const db = env.DB;
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await db
      .prepare("INSERT INTO bulletins (id, service_type_id, bulletin_date, status) VALUES (1, 1, '2026-06-28', 'published')")
      .run();
    await db
      .prepare(
        `INSERT INTO bulletin_announcements (bulletin_id, seq, title, body, link_url, link_label) VALUES
          (1, 2, 'Second', 'b2', NULL, NULL),
          (1, 1, 'First',  'b1', 'https://x/1', 'Go')`,
      )
      .run();
    const rows = await getBulletinAnnouncements(db, 1);
    expect(rows.map((r) => r.title)).toEqual(['First', 'Second']);
    expect(rows[0].link_label).toBe('Go');
  });
});

describe('prayer sheets', () => {
  it('latestPrayerSheet + getPrayerSheet enforce the publish rule; listPrayerSheetDates lists visible dates', async () => {
    const db = env.DB;
    await db
      .prepare(
        `INSERT INTO prayer_sheets (id, sheet_date, locale, sections_json, status, publish_at, deleted_at) VALUES
          (1, '2026-06-21', 'zh', '[]', 'published', '2026-06-19 08:00:00', NULL),
          (2, '2026-06-28', 'zh', '[]', 'published', NULL, NULL),
          (3, '2026-07-05', 'zh', '[]', 'published', '2999-01-01 00:00:00', NULL),
          (4, '2026-07-12', 'zh', '[]', 'draft', NULL, NULL)`,
      )
      .run();
    expect((await latestPrayerSheet(db))?.sheet_date).toBe('2026-06-28');
    expect(await getPrayerSheet(db, '2026-07-05')).toBeNull(); // future publish
    expect(await getPrayerSheet(db, '2026-07-12')).toBeNull(); // draft
    expect(await listPrayerSheetDates(db)).toEqual(['2026-06-28', '2026-06-21']);
  });
});

describe('parseJsonArray', () => {
  it('returns [] for null/empty/invalid/non-array and parses real arrays', () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]); // object, not array
    expect(parseJsonArray('[{"x":1},{"y":2}]')).toEqual([{ x: 1 }, { y: 2 }]);
  });
});
