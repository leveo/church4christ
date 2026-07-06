// Public-site read queries that are DB-driven but not content-collection backed:
// the announcement ticker, the upcoming-events strip, and the latest sermon. Each
// applies the visibility rules from the spec — announcements/events are windowed
// by their active flag + optional starts_at/ends_at bounds; sermons follow the
// draft/publish rule (published + not soft-deleted; sermons carry no publish_at).
// Localized text (title/blurb) comes through the shared i18nJoin builder so a
// missing translation transparently falls back to English.
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
  db: D1Database,
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
  db: D1Database,
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
export async function latestPublishedSermon(db: D1Database): Promise<LatestSermonRow | null> {
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
