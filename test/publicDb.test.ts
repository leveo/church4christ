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
    const s = await latestPublishedSermon(db, 'en');
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
    expect(await latestPublishedSermon(db, 'en')).toBeNull();
  });
});

describe('listSermonYears / listSermonsByYear', () => {
  it('filters English sermon years and rows by editorial content while preserving speaker names', async () => {
    await env.DB.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await env.DB.prepare("INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Sunday Worship')").run();
    await env.DB.prepare(`INSERT INTO sermons (id, service_type_id, sermon_date, title, speaker, scripture, series, status) VALUES
      (1, 1, '2025-12-14', 'Grace and peace', '陈大卫 David Chen', 'John 1', 'Good news', 'published'),
      (2, 1, '2026-01-04', '主的恩典', 'David Chen', 'John 1', NULL, 'published'),
      (3, 1, '2026-01-11', 'Psalm reading', 'David Chen', '诗篇 121', NULL, 'published'),
      (4, 1, '2026-01-18', 'A new beginning', 'David Chen', NULL, '上行之诗', 'published'),
      (5, 1, '2026-01-25', 'Peace', 'David Chen', NULL, NULL, 'draft')`).run();

    expect(await listSermonYears(env.DB, 'en')).toEqual([2025]);
    expect(await listSermonsByYear(env.DB, 2026, 'en')).toEqual([]);
    expect(await listSermonsByYear(env.DB, 2025, 'en')).toEqual([
      expect.objectContaining({ id: 1, title: 'Grace and peace', speaker: '陈大卫 David Chen' }),
    ]);
    expect((await latestPublishedSermon(env.DB, 'en'))?.id).toBe(1);
    expect(await listSermonYears(env.DB, 'zh')).toEqual([2026, 2025]);
    expect((await listSermonsByYear(env.DB, 2026, 'zh')).map(({ id }) => id)).toEqual([4, 3, 2]);
    expect((await listSermonsByYear(env.DB, 2025, 'zh')).map(({ id }) => id)).toEqual([1]);
    expect((await latestPublishedSermon(env.DB, 'zh'))?.id).toBe(4);
  });

  it('finds the latest English sermon beyond a full page of newer Chinese content', async () => {
    await env.DB.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await env.DB.prepare(`INSERT INTO sermons (id, service_type_id, sermon_date, title, status)
      VALUES (1, 1, '2025-12-14', 'Earlier English message', 'published')`).run();
    await env.DB.prepare(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n < 105)
      INSERT INTO sermons (id, service_type_id, sermon_date, title, status)
      SELECT n+1, 1, date('2026-01-01', '+' || n || ' days'), '中文信息', 'published' FROM entries`).run();

    expect((await latestPublishedSermon(env.DB, 'en'))?.id).toBe(1);
    expect((await latestPublishedSermon(env.DB, 'zh'))?.id).toBe(106);
  });

  it('returns empty English sermon results when only Chinese content is published', async () => {
    await env.DB.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await env.DB.prepare("INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Sunday Worship')").run();
    await env.DB.prepare(`INSERT INTO sermons (id, service_type_id, sermon_date, title, status)
      VALUES (1, 1, '2026-01-04', '中文信息', 'published')`).run();

    expect(await latestPublishedSermon(env.DB, 'en')).toBeNull();
    expect(await listSermonYears(env.DB, 'en')).toEqual([]);
    expect(await listSermonsByYear(env.DB, 2026, 'en')).toEqual([]);
    expect((await latestPublishedSermon(env.DB, 'zh'))?.id).toBe(1);
    expect(await listSermonYears(env.DB, 'zh')).toEqual([2026]);
  });

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

    expect(await listSermonYears(db, 'zh')).toEqual([2026, 2025]); // draft counts under existing 2026; deleted 2024 excluded

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

  it.each([
    ['service_time_label', '上午 9:30'],
    ['program_json', '[{"item":"读经","content":"John 1","person":"Reader"}]'],
    ['program_json', '[{"item":"Reading","content":"约翰福音","person":"Reader"}]'],
    ['offering_json', '[{"label":"奉献","amount":10}]'],
    ['offering_json', '[{"label":"Offering","amount":"十元"}]'],
    ['attendance_json', '[{"label":"出席","count":10}]'],
    ['attendance_json', '[{"label":"Attendance","count":"十人"}]'],
    ['memory_verse', '你们要彼此相爱。'],
    ['flowers', '为感恩摆上。'],
  ])('selects English bulletin sources using editorial %s without changing stored content', async (field, value) => {
    await seedBulletins(env.DB);
    // Column names are the fixed cases above, never request input.
    await env.DB.prepare(`UPDATE bulletins SET ${field} = ? WHERE id = 2`).bind(value).run();
    expect(await getBulletin(env.DB, 1, '2026-06-28', 'en')).toBeNull();
    expect((await latestBulletins(env.DB, 'en')).map((b) => b.id)).toEqual([1]);
    expect((await listBulletinDates(env.DB, 'en')).map((b) => b.bulletin_date)).toEqual(['2026-06-21']);
    expect(await listBulletinServicesForDate(env.DB, '2026-06-28', 'en')).toEqual([]);
    const chinese = await getBulletin(env.DB, 1, '2026-06-28', 'zh');
    expect(chinese).toMatchObject({ [field]: value });
    expect((await latestBulletins(env.DB, 'zh')).map((b) => b.id)).toEqual([2]);
  });

  it.each(['title', 'body', 'link_label'])('includes announcement %s in whole-bulletin source selection', async (field) => {
    await seedBulletins(env.DB);
    await env.DB.prepare(`INSERT INTO bulletin_announcements (bulletin_id, title, body, link_url, link_label)
      VALUES (2, 'Welcome', 'Join us this week.', '/en/visit', 'Details')`).run();
    await env.DB.prepare(`UPDATE bulletin_announcements SET ${field} = ? WHERE bulletin_id = 2`).bind('本周聚会').run();
    expect(await getBulletin(env.DB, 1, '2026-06-28', 'en')).toBeNull();
    expect((await latestBulletins(env.DB, 'en')).map((b) => b.id)).toEqual([1]);
    expect((await listBulletinDates(env.DB, 'en')).map((b) => b.bulletin_date)).toEqual(['2026-06-21']);
    expect(await listBulletinServicesForDate(env.DB, '2026-06-28', 'en')).toEqual([]);
    expect((await getBulletin(env.DB, 1, '2026-06-28', 'zh'))?.id).toBe(2);
    expect((await getBulletinAnnouncements(env.DB, 2))[0][field as 'title' | 'body' | 'link_label']).toBe('本周聚会');
  });

  it('retains Han person names in an English program and ignores fields that are not rendered', async () => {
    await seedBulletins(env.DB);
    const program = '[{"item":"Reading","content":"John 1","person":"王明","internalNote":"编者备注"}]';
    await env.DB.prepare('UPDATE bulletins SET program_json = ? WHERE id = 2').bind(program).run();
    expect((await getBulletin(env.DB, 1, '2026-06-28', 'en'))?.program_json).toBe(program);
    expect((await latestBulletins(env.DB, 'en')).map((b) => b.id)).toEqual([2]);
  });

  it('finds older eligible content beyond a candidate page and applies the archive cap after eligibility', async () => {
    await seedBulletins(env.DB);
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 105)
      INSERT INTO bulletins (service_type_id, bulletin_date, memory_verse, status)
      SELECT 1, date('2027-01-01', '+' || i || ' days'), 'Love one another.', 'published' FROM n`).run();
    await env.DB.prepare(`INSERT INTO bulletin_announcements (bulletin_id, body)
      SELECT id, '本周聚会' FROM bulletins WHERE bulletin_date >= '2027-01-01'`).run();
    expect((await latestBulletins(env.DB, 'en')).map((b) => b.id)).toEqual([2]);
    expect((await listBulletinDates(env.DB, 'en')).map((b) => b.bulletin_date)).toEqual(['2026-06-28', '2026-06-21']);
    expect((await listBulletinDates(env.DB, 'zh'))).toHaveLength(52);
    expect((await latestBulletins(env.DB, 'zh'))[0].bulletin_date).toBe('2027-04-16');
  });

  it('keeps per-service latest ordering and omits services with no English source', async () => {
    await seedBulletins(env.DB);
    await env.DB.prepare('INSERT INTO service_types (id, sort) VALUES (2, 0), (3, 2)').run();
    await env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name)
      VALUES (2, 'en', 'Morning'), (3, 'en', 'Evening')`).run();
    await env.DB.prepare(`INSERT INTO bulletins (id, service_type_id, bulletin_date, memory_verse, status) VALUES
      (5, 2, '2026-06-21', 'Love one another.', 'published'),
      (6, 2, '2026-06-28', '彼此相爱', 'published'),
      (7, 3, '2026-06-28', '彼此相爱', 'published')`).run();
    expect((await latestBulletins(env.DB, 'en')).map((b) => b.id)).toEqual([5, 2]);
    expect((await latestBulletins(env.DB, 'zh')).map((b) => b.id)).toEqual([6, 2, 7]);
    expect((await listBulletinServicesForDate(env.DB, '2026-06-28', 'en')).map((b) => b.service_type_id)).toEqual([1]);
    await env.DB.prepare("UPDATE bulletins SET memory_verse = '彼此相爱'").run();
    expect(await latestBulletins(env.DB, 'en')).toEqual([]);
    expect(await listBulletinDates(env.DB, 'en')).toEqual([]);
    expect((await listBulletinServicesForDate(env.DB, '2026-06-28', 'zh')).map((b) => b.service_type_id)).toEqual([2, 1, 3]);
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
    await db.prepare("UPDATE people SET display_name = '王明' WHERE id = 4").run();
    expect((await bulletinRoster(db, 1, '2026-06-28', 'en')).find((r) => r.position === 'Sound')!.people).toEqual(['王明']);
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
  it('keeps English prayer lists, latest, and dated reads within explicitly English content', async () => {
    await env.DB.prepare(`INSERT INTO prayer_sheets (id, sheet_date, locale, sections_json, status, publish_at, deleted_at) VALUES
      (1, '2026-06-01', 'en', '[{"heading":"Prayer","items":["Our community"]}]', 'published', NULL, NULL),
      (2, '2026-06-08', 'zh', '[{"heading":"祷告","items":["社区"]}]', 'published', NULL, NULL),
      (3, '2026-06-15', NULL, '[]', 'published', NULL, NULL),
      (4, '2026-06-22', 'en', '[]', 'draft', NULL, NULL),
      (5, '2026-06-29', 'en', '[]', 'published', '2999-01-01 00:00:00', NULL),
      (6, '2026-07-06', 'en', '[]', 'published', NULL, datetime('now'))`).run();

    expect((await latestPrayerSheet(env.DB, 'en'))?.id).toBe(1);
    expect(await listPrayerSheetDates(env.DB, 'en')).toEqual(['2026-06-01']);
    expect((await getPrayerSheet(env.DB, '2026-06-01', 'en'))?.id).toBe(1);
    expect(await getPrayerSheet(env.DB, '2026-06-08', 'en')).toBeNull();
    expect(await getPrayerSheet(env.DB, '2026-06-15', 'en')).toBeNull();

    expect((await latestPrayerSheet(env.DB, 'zh'))?.id).toBe(3);
    expect(await listPrayerSheetDates(env.DB, 'zh')).toEqual(['2026-06-15', '2026-06-08', '2026-06-01']);
    expect((await getPrayerSheet(env.DB, '2026-06-08', 'zh'))?.id).toBe(2);
    expect((await getPrayerSheet(env.DB, '2026-06-01', 'zh'))?.id).toBe(1);
  });

  it('returns an empty English prayer archive when there are only Chinese or unlabelled sheets', async () => {
    await env.DB.prepare(`INSERT INTO prayer_sheets (id, sheet_date, locale, sections_json, status) VALUES
      (1, '2026-06-01', 'zh', '[]', 'published'),
      (2, '2026-06-08', NULL, '[]', 'published')`).run();

    expect(await latestPrayerSheet(env.DB, 'en')).toBeNull();
    expect(await listPrayerSheetDates(env.DB, 'en')).toEqual([]);
    expect(await getPrayerSheet(env.DB, '2026-06-01', 'en')).toBeNull();
    expect((await latestPrayerSheet(env.DB, 'zh'))?.id).toBe(2);
  });

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
    expect((await latestPrayerSheet(db, 'zh'))?.sheet_date).toBe('2026-06-28');
    expect(await getPrayerSheet(db, '2026-07-05', 'zh')).toBeNull(); // future publish
    expect(await getPrayerSheet(db, '2026-07-12', 'zh')).toBeNull(); // draft
    expect(await listPrayerSheetDates(db, 'zh')).toEqual(['2026-06-28', '2026-06-21']);
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
