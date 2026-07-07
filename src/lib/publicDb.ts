// Public-site read queries that are DB-driven but not content-collection backed:
// the announcement ticker, the upcoming-events strip, and the latest sermon. Each
// applies the visibility rules from the spec — announcements/events are windowed
// by their active flag + optional starts_at/ends_at bounds; sermons follow the
// draft/publish rule (published + not soft-deleted; sermons carry no publish_at).
// Localized text (title/blurb) comes through the shared i18nJoin builder so a
// missing translation transparently falls back to English.
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';

export interface AnnouncementRow {
  title: string;
  url: string | null;
}

export interface EventCardRow {
  title: string;
  blurb: string;
  imageKey: string | null;
  url: string | null;
}

export interface LatestSermonRow {
  id: number;
  sermon_date: string;
  title: string;
  speaker: string;
  scripture: string | null;
  series: string | null;
  youtube_id: string | null;
}

// starts_at/ends_at may be date-only ('YYYY-MM-DD') or datetime strings; `today`
// is the 'YYYY-MM-DD' from todayInTz(). Lexical comparison keeps an item visible
// through its whole end date: a datetime end like '2026-07-05 23:59:00' sorts
// AFTER the bare date '2026-07-05', so `ends_at >= today` stays true that day.
const WINDOW = `active = 1 AND (starts_at IS NULL OR starts_at <= ?1) AND (ends_at IS NULL OR ends_at >= ?1)`;

/** Active announcements for the ticker, localized (en fallback), ordered by sort. */
export async function listActiveAnnouncements(
  db: AppDb,
  locale: Locale,
  today: string,
): Promise<AnnouncementRow[]> {
  const { select, joins } = i18nJoin('announcement_i18n', 'a', 'announcement_id', ['title'], locale);
  const { results } = await db
    .prepare(
      `SELECT ${select}, a.url AS url
       FROM announcements a
       ${joins}
       WHERE ${WINDOW}
       ORDER BY a.sort, a.id`,
    )
    .bind(today)
    .all<AnnouncementRow>();
  return results;
}

/**
 * Active events for the upcoming strip, localized (en fallback), ordered by sort.
 * `limit` caps the result (the home page shows 3); omit it to list them all.
 */
export async function listActiveEvents(
  db: AppDb,
  locale: Locale,
  today: string,
  limit?: number,
): Promise<EventCardRow[]> {
  const { select, joins } = i18nJoin('event_i18n', 'e', 'event_id', ['title', 'blurb'], locale);
  const sql =
    `SELECT ${select}, e.image_key AS imageKey, e.url AS url
     FROM events e
     ${joins}
     WHERE ${WINDOW}
     ORDER BY e.sort, e.id` + (limit !== undefined ? ` LIMIT ?2` : '');
  const stmt = limit !== undefined ? db.prepare(sql).bind(today, limit) : db.prepare(sql).bind(today);
  const { results } = await stmt.all<EventCardRow>();
  return results;
}

/** The most recent published, non-deleted sermon (sermons carry no publish_at). */
export async function latestPublishedSermon(db: AppDb): Promise<LatestSermonRow | null> {
  return db
    .prepare(
      `SELECT id, sermon_date, title, speaker, scripture, series, youtube_id
       FROM sermons
       WHERE status = 'published' AND deleted_at IS NULL
       ORDER BY sermon_date DESC, id DESC
       LIMIT 1`,
    )
    .first<LatestSermonRow>();
}

// ----------------------------------------------------------------------------
// Sermons archive, bulletins, prayer sheets (Task 3).
//
// Sermons follow the sermon rule (published + not soft-deleted; no publish_at).
// Bulletins and prayer sheets carry publish_at, so they follow the full
// draft/publish rule below. All localized names (service type, position) come
// through i18nJoin so a missing zh row falls back to English.
// ----------------------------------------------------------------------------

/**
 * Draft/publish rule for content that carries publish_at (bulletins, prayer
 * sheets), qualified to a table alias so it stays unambiguous when the query
 * joins another table that also has status/publish_at/deleted_at columns.
 */
function published(alias: string): string {
  return `${alias}.status = 'published' AND (${alias}.publish_at IS NULL OR ${alias}.publish_at <= datetime('now')) AND ${alias}.deleted_at IS NULL`;
}

export interface SermonRow {
  id: number;
  sermon_date: string;
  title: string;
  speaker: string;
  scripture: string | null;
  series: string | null;
  youtube_id: string | null;
  serviceTypeName: string;
}

export interface BulletinRow {
  id: number;
  service_type_id: number;
  bulletin_date: string;
  service_time_label: string | null;
  program_json: string | null;
  offering_json: string | null;
  attendance_json: string | null;
  memory_verse: string | null;
  flowers: string | null;
  serviceTypeName: string;
}

export interface BulletinAnnouncementRow {
  title: string;
  body: string;
  link_url: string | null;
  link_label: string | null;
}

export interface BulletinDateRow {
  bulletin_date: string;
  service_type_id: number;
  serviceTypeName: string;
}

export interface RosterGroup {
  position: string;
  people: string[];
}

export interface PrayerSheetRow {
  id: number;
  sheet_date: string;
  sections_json: string | null;
}

/** Distinct years that have at least one published sermon, newest first. */
export async function listSermonYears(db: AppDb): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT CAST(substr(sermon_date, 1, 4) AS INTEGER) AS year
       FROM sermons
       WHERE status = 'published' AND deleted_at IS NULL
       ORDER BY year DESC`,
    )
    .all<{ year: number }>();
  return results.map((r) => r.year);
}

/** Published sermons in `year`, newest first, with the localized service-type name. */
export async function listSermonsByYear(db: AppDb, year: number, locale: Locale): Promise<SermonRow[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.sermon_date AS sermon_date, s.title AS title, s.speaker AS speaker,
              s.scripture AS scripture, s.series AS series, s.youtube_id AS youtube_id,
              COALESCE(st_l.name, st_d.name) AS serviceTypeName
       FROM sermons s
       JOIN service_types st ON st.id = s.service_type_id
       ${joins}
       WHERE s.status = 'published' AND s.deleted_at IS NULL
         AND substr(s.sermon_date, 1, 4) = ?1
       ORDER BY s.sermon_date DESC, s.id DESC`,
    )
    .bind(String(year))
    .all<SermonRow>();
  return results;
}

const BULLETIN_COLS = `b.id AS id, b.service_type_id AS service_type_id, b.bulletin_date AS bulletin_date,
  b.service_time_label AS service_time_label, b.program_json AS program_json,
  b.offering_json AS offering_json, b.attendance_json AS attendance_json,
  b.memory_verse AS memory_verse, b.flowers AS flowers,
  COALESCE(st_l.name, st_d.name) AS serviceTypeName`;

/** The latest published bulletin for each service type (one row per type), ordered by type sort. */
export async function latestBulletins(db: AppDb, locale: Locale): Promise<BulletinRow[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT ${BULLETIN_COLS}
       FROM bulletins b
       JOIN service_types st ON st.id = b.service_type_id
       ${joins}
       WHERE ${published('b')}
         AND NOT EXISTS (
           SELECT 1 FROM bulletins b2
           WHERE b2.service_type_id = b.service_type_id AND ${published('b2')}
             AND b2.bulletin_date > b.bulletin_date
         )
       ORDER BY st.sort, st.id`,
    )
    .all<BulletinRow>();
  return results;
}

/** A single published bulletin for a service type on a date, or null. */
export async function getBulletin(
  db: AppDb,
  serviceTypeId: number,
  date: string,
  locale: Locale,
): Promise<BulletinRow | null> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  return db
    .prepare(
      `SELECT ${BULLETIN_COLS}
       FROM bulletins b
       JOIN service_types st ON st.id = b.service_type_id
       ${joins}
       WHERE b.service_type_id = ?1 AND b.bulletin_date = ?2 AND ${published('b')}`,
    )
    .bind(serviceTypeId, date)
    .first<BulletinRow>();
}

/** Service types (id + localized name) that have a published bulletin on `date`, by type sort. */
export async function listBulletinServicesForDate(
  db: AppDb,
  date: string,
  locale: Locale,
): Promise<{ service_type_id: number; serviceTypeName: string }[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT b.service_type_id AS service_type_id, COALESCE(st_l.name, st_d.name) AS serviceTypeName
       FROM bulletins b
       JOIN service_types st ON st.id = b.service_type_id
       ${joins}
       WHERE b.bulletin_date = ?1 AND ${published('b')}
       ORDER BY st.sort, st.id`,
    )
    .bind(date)
    .all<{ service_type_id: number; serviceTypeName: string }>();
  return results;
}

/** Archive of published-bulletin dates (date + service type), newest first, capped at 52. */
export async function listBulletinDates(db: AppDb, locale: Locale): Promise<BulletinDateRow[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT b.bulletin_date AS bulletin_date, b.service_type_id AS service_type_id,
              COALESCE(st_l.name, st_d.name) AS serviceTypeName
       FROM bulletins b
       JOIN service_types st ON st.id = b.service_type_id
       ${joins}
       WHERE ${published('b')}
       ORDER BY b.bulletin_date DESC, st.sort, st.id
       LIMIT 52`,
    )
    .all<BulletinDateRow>();
  return results;
}

/** A bulletin's announcements in display order. */
export async function getBulletinAnnouncements(
  db: AppDb,
  bulletinId: number,
): Promise<BulletinAnnouncementRow[]> {
  const { results } = await db
    .prepare(
      `SELECT title, body, link_url, link_label
       FROM bulletin_announcements
       WHERE bulletin_id = ?1
       ORDER BY seq, id`,
    )
    .bind(bulletinId)
    .all<BulletinAnnouncementRow>();
  return results;
}

/**
 * Serving roster for the plan matching a service type + date: confirmed and
 * unconfirmed assignments only (status != 'D'), non-deleted, grouped by
 * position in position sort order. Declined assignments and soft-deleted
 * assignments/positions/people are all excluded.
 */
export async function bulletinRoster(
  db: AppDb,
  serviceTypeId: number,
  date: string,
  locale: Locale,
): Promise<RosterGroup[]> {
  const { joins } = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT COALESCE(pos_l.name, pos_d.name) AS position, ppl.display_name AS person
       FROM plans pl
       JOIN roster_assignments ra ON ra.plan_id = pl.id AND ra.deleted_at IS NULL AND ra.status != 'D'
       JOIN positions pos ON pos.id = ra.position_id AND pos.deleted_at IS NULL
       ${joins}
       JOIN people ppl ON ppl.id = ra.person_id AND ppl.deleted_at IS NULL
       WHERE pl.service_type_id = ?1 AND pl.plan_date = ?2 AND pl.deleted_at IS NULL
       ORDER BY pos.sort, pos.id, ra.id`,
    )
    .bind(serviceTypeId, date)
    .all<{ position: string; person: string }>();

  const groups: RosterGroup[] = [];
  for (const row of results) {
    const last = groups[groups.length - 1];
    if (last && last.position === row.position) last.people.push(row.person);
    else groups.push({ position: row.position, people: [row.person] });
  }
  return groups;
}

/** The most recent published prayer sheet, or null. */
export async function latestPrayerSheet(db: AppDb): Promise<PrayerSheetRow | null> {
  return db
    .prepare(
      `SELECT ps.id AS id, ps.sheet_date AS sheet_date, ps.sections_json AS sections_json
       FROM prayer_sheets ps
       WHERE ${published('ps')}
       ORDER BY ps.sheet_date DESC, ps.id DESC
       LIMIT 1`,
    )
    .first<PrayerSheetRow>();
}

/** A published prayer sheet by date, or null. */
export async function getPrayerSheet(db: AppDb, date: string): Promise<PrayerSheetRow | null> {
  return db
    .prepare(
      `SELECT ps.id AS id, ps.sheet_date AS sheet_date, ps.sections_json AS sections_json
       FROM prayer_sheets ps WHERE ps.sheet_date = ?1 AND ${published('ps')}`,
    )
    .bind(date)
    .first<PrayerSheetRow>();
}

/** Archive of published prayer-sheet dates, newest first, capped at 52. */
export async function listPrayerSheetDates(db: AppDb): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT ps.sheet_date AS sheet_date FROM prayer_sheets ps WHERE ${published('ps')} ORDER BY ps.sheet_date DESC LIMIT 52`,
    )
    .all<{ sheet_date: string }>();
  return results.map((r) => r.sheet_date);
}
