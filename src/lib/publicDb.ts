// Public-site read queries that are DB-driven but not content-collection backed:
// the announcement ticker, the upcoming-events strip, and the latest sermon. Each
// applies the visibility rules from the spec — announcements/events are windowed
// by their active flag + optional starts_at/ends_at bounds; sermons follow the
// draft/publish rule (published + not soft-deleted; sermons carry no publish_at).
// Localized text (title/blurb) comes through the shared i18nJoin builder so a
// missing translation transparently falls back to English.
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';
import { isEnglishEditorialText } from './editorialLocale';
import { parseJsonArray } from './json';

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
    `SELECT ${select}, e.image_key AS "imageKey", e.url AS url
     FROM events e
     ${joins}
     WHERE ${WINDOW}
     ORDER BY e.sort, e.id` + (limit !== undefined ? ` LIMIT ?2` : '');
  const stmt = limit !== undefined ? db.prepare(sql).bind(today, limit) : db.prepare(sql).bind(today);
  const { results } = await stmt.all<EventCardRow>();
  return results;
}

type SermonContent = Pick<LatestSermonRow, 'title' | 'scripture' | 'series'>;

// Legacy sermons have no source-language column. This display-only rule checks
// editorial content, never speaker names, and does not rewrite stored text.
// Explicit source-language metadata can replace this heuristic in a future schema.
function sermonMatchesLocale(sermon: SermonContent, locale: Locale): boolean {
  return locale === 'zh' || isEnglishEditorialText(sermon.title, sermon.scripture, sermon.series);
}

/** The most recent visible sermon. Search beyond newer Chinese rows for en. */
export async function latestPublishedSermon(db: AppDb, locale: Locale): Promise<LatestSermonRow | null> {
  const pageSize = locale === 'en' ? 100 : 1;
  for (let offset = 0; ; offset += pageSize) {
    const { results } = await db
      .prepare(
        `SELECT id, sermon_date, title, speaker, scripture, series, youtube_id
         FROM sermons
         WHERE status = 'published' AND deleted_at IS NULL
         ORDER BY sermon_date DESC, id DESC
         LIMIT ?1 OFFSET ?2`,
      )
      .bind(pageSize, offset)
      .all<LatestSermonRow>();
    const visible = results.find((sermon) => sermonMatchesLocale(sermon, locale));
    if (visible) return visible;
    if (results.length < pageSize) return null;
  }
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

/** Distinct years containing a visible published sermon, newest first. */
export async function listSermonYears(db: AppDb, locale: Locale): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT CAST(substr(sermon_date, 1, 4) AS INTEGER) AS year, title, scripture, series
       FROM sermons
       WHERE status = 'published' AND deleted_at IS NULL
       ORDER BY year DESC`,
    )
    .all<SermonContent & { year: number }>();
  return [...new Set(results.filter((sermon) => sermonMatchesLocale(sermon, locale)).map((r) => r.year))];
}

/** Published sermons in `year`, newest first, with the localized service-type name. */
export async function listSermonsByYear(db: AppDb, year: number, locale: Locale): Promise<SermonRow[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.sermon_date AS sermon_date, s.title AS title, s.speaker AS speaker,
              s.scripture AS scripture, s.series AS series, s.youtube_id AS youtube_id,
              COALESCE(st_l.name, st_d.name) AS "serviceTypeName"
       FROM sermons s
       JOIN service_types st ON st.id = s.service_type_id
       ${joins}
       WHERE s.status = 'published' AND s.deleted_at IS NULL
         AND substr(s.sermon_date, 1, 4) = ?1
       ORDER BY s.sermon_date DESC, s.id DESC`,
    )
    .bind(String(year))
    .all<SermonRow>();
  return results.filter((sermon) => sermonMatchesLocale(sermon, locale));
}

const BULLETIN_COLS = `b.id AS id, b.service_type_id AS service_type_id, b.bulletin_date AS bulletin_date,
  b.service_time_label AS service_time_label, b.program_json AS program_json,
  b.offering_json AS offering_json, b.attendance_json AS attendance_json,
  b.memory_verse AS memory_verse, b.flowers AS flowers,
  COALESCE(st_l.name, st_d.name) AS "serviceTypeName"`;

type BulletinCandidate = BulletinRow & { service_type_sort: number };

function bulletinEditorialIsEnglish(bulletin: BulletinRow): boolean {
  const englishRows = (json: string | null, fields: string[]) =>
    parseJsonArray<Record<string, unknown> | null>(json)
      .every((row) => isEnglishEditorialText(...fields.map((field) => row?.[field])));
  return isEnglishEditorialText(bulletin.service_time_label, bulletin.memory_verse, bulletin.flowers)
    // The program's dedicated person field is intentionally excluded.
    && englishRows(bulletin.program_json, ['item', 'content'])
    && englishRows(bulletin.offering_json, ['label', 'amount'])
    && englishRows(bulletin.attendance_json, ['label', 'count']);
}

/**
 * Read published candidates in bounded pages, newest first. A bulletin is one
 * editorial publication: English eligibility includes all its announcements,
 * so dated reads and archive links never expose a partly filtered sheet.
 * Announcement reads are batched per page, not one query per bulletin.
 */
async function* eligibleBulletinPages(
  db: AppDb,
  locale: Locale,
  scope: { serviceTypeId?: number; date?: string } = {},
): AsyncGenerator<BulletinCandidate[]> {
  const { joins } = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const params: (number | string)[] = [];
  const filters = [published('b')];
  if (scope.serviceTypeId !== undefined) {
    params.push(scope.serviceTypeId);
    filters.push(`b.service_type_id = ?${params.length}`);
  }
  if (scope.date !== undefined) {
    params.push(scope.date);
    filters.push(`b.bulletin_date = ?${params.length}`);
  }
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { results } = await db.prepare(
      `SELECT ${BULLETIN_COLS}, st.sort AS service_type_sort
       FROM bulletins b
       JOIN service_types st ON st.id = b.service_type_id
       ${joins}
       WHERE ${filters.join(' AND ')}
       ORDER BY b.bulletin_date DESC, st.sort, st.id
       LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    ).bind(...params, pageSize, offset).all<BulletinCandidate>();

    if (locale === 'zh') {
      yield results;
    } else {
      const candidates = results.filter(bulletinEditorialIsEnglish);
      const excluded = new Set<number>();
      if (candidates.length > 0) {
        const { results: announcements } = await db.prepare(
          `SELECT bulletin_id, title, body, link_label
           FROM bulletin_announcements
           WHERE bulletin_id IN (${candidates.map(() => '?').join(',')})`,
        ).bind(...candidates.map((bulletin) => bulletin.id))
          .all<{ bulletin_id: number; title: string; body: string; link_label: string | null }>();
        for (const announcement of announcements) {
          if (!isEnglishEditorialText(announcement.title, announcement.body, announcement.link_label)) {
            excluded.add(announcement.bulletin_id);
          }
        }
      }
      yield candidates.filter((bulletin) => !excluded.has(bulletin.id));
    }
    if (results.length < pageSize) return;
  }
}

function bulletinRow({ service_type_sort: _sort, ...bulletin }: BulletinCandidate): BulletinRow {
  return bulletin;
}

/** Latest eligible published bulletin per service type, ordered by type sort. */
export async function latestBulletins(db: AppDb, locale: Locale): Promise<BulletinRow[]> {
  if (locale === 'en') {
    const { results: services } = await db.prepare(
      `SELECT DISTINCT b.service_type_id FROM bulletins b WHERE ${published('b')}`,
    ).all<{ service_type_id: number }>();
    if (services.length === 0) return [];
    const latest = new Map<number, BulletinCandidate>();
    for await (const page of eligibleBulletinPages(db, locale)) {
      for (const bulletin of page) {
        if (!latest.has(bulletin.service_type_id)) latest.set(bulletin.service_type_id, bulletin);
      }
      if (latest.size === services.length) break;
    }
    return [...latest.values()]
      .sort((a, b) => a.service_type_sort - b.service_type_sort || a.service_type_id - b.service_type_id)
      .map(bulletinRow);
  }
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

/** A single eligible published bulletin for a service type on a date, or null. */
export async function getBulletin(
  db: AppDb,
  serviceTypeId: number,
  date: string,
  locale: Locale,
): Promise<BulletinRow | null> {
  for await (const page of eligibleBulletinPages(db, locale, { serviceTypeId, date })) {
    if (page.length > 0) return bulletinRow(page[0]);
  }
  return null;
}

/** Service types with an eligible published bulletin on `date`, by type sort. */
export async function listBulletinServicesForDate(
  db: AppDb,
  date: string,
  locale: Locale,
): Promise<{ service_type_id: number; serviceTypeName: string }[]> {
  const services: { service_type_id: number; serviceTypeName: string }[] = [];
  for await (const page of eligibleBulletinPages(db, locale, { date })) {
    services.push(...page.map(({ service_type_id, serviceTypeName }) => ({ service_type_id, serviceTypeName })));
  }
  return services;
}

/** Eligible archive dates, newest first; the cap applies after source selection. */
export async function listBulletinDates(db: AppDb, locale: Locale): Promise<BulletinDateRow[]> {
  const dates: BulletinDateRow[] = [];
  for await (const page of eligibleBulletinPages(db, locale)) {
    dates.push(...page.map(({ bulletin_date, service_type_id, serviceTypeName }) => ({ bulletin_date, service_type_id, serviceTypeName })));
    if (dates.length >= 52) break;
  }
  return dates.slice(0, 52);
}

/** Announcements in display order; public readers first obtain a locale-eligible bulletin. */
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

/** The most recent published prayer sheet visible in the requested locale. */
export async function latestPrayerSheet(db: AppDb, locale: Locale): Promise<PrayerSheetRow | null> {
  return db
    .prepare(
      `SELECT ps.id AS id, ps.sheet_date AS sheet_date, ps.sections_json AS sections_json
       FROM prayer_sheets ps
       WHERE ${published('ps')} ${locale === 'en' ? "AND ps.locale = 'en'" : ''}
       ORDER BY ps.sheet_date DESC, ps.id DESC
       LIMIT 1`,
    )
    .first<PrayerSheetRow>();
}

/** A published prayer sheet by date, excluding non-English sheets for en. */
export async function getPrayerSheet(db: AppDb, date: string, locale: Locale): Promise<PrayerSheetRow | null> {
  return db
    .prepare(
      `SELECT ps.id AS id, ps.sheet_date AS sheet_date, ps.sections_json AS sections_json
       FROM prayer_sheets ps WHERE ps.sheet_date = ?1 AND ${published('ps')}
         ${locale === 'en' ? "AND ps.locale = 'en'" : ''}`,
    )
    .bind(date)
    .first<PrayerSheetRow>();
}

/** Archive of published prayer-sheet dates, newest first, capped at 52. */
export async function listPrayerSheetDates(db: AppDb, locale: Locale): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT ps.sheet_date AS sheet_date FROM prayer_sheets ps WHERE ${published('ps')}
       ${locale === 'en' ? "AND ps.locale = 'en'" : ''} ORDER BY ps.sheet_date DESC LIMIT 52`,
    )
    .all<{ sheet_date: string }>();
  return results.map((r) => r.sheet_date);
}
