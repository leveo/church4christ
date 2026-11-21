// Missions data layer (module `missions`, migrations 0056 / PG 0048). Staff
// author mission trips with localized text (mission_trip_i18n, fallback
// requested -> default -> English). Public reads only ever select published
// trips, so a draft's text and photos never reach a public page.
import type { AppDb, AppStatement } from './appDb';
import { i18nJoin } from './db';
import { SUPPORTED_LOCALES, isSupportedLocale, type Locale, type SupportedLocale } from './locales';

export const TRIP_STATUSES = ['draft', 'published'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export const TRIP_TEXT_FIELDS = ['title', 'location', 'summary', 'story_md', 'team_note'] as const;
export type TripTextField = (typeof TRIP_TEXT_FIELDS)[number];
export type TripText = Record<TripTextField, string>;

export interface TripInput {
  slug: string;
  status: TripStatus;
  year: number;
  startDate: string | null;
  endDate: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  teamSize: number | null;
  videoUrl: string | null;
  /** Giving fund link: a number or null to set it, undefined to keep the stored value. */
  fundId?: number | null;
  text: Partial<Record<SupportedLocale, TripText>>;
}

export interface TripRow {
  id: number;
  slug: string;
  status: TripStatus;
  year: number;
  start_date: string | null;
  end_date: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  team_size: number | null;
  cover_media_key: string | null;
  video_url: string | null;
  fund_id: number | null;
  updated_at: string;
  title: string;
  location: string;
  summary: string;
  story_md: string;
  team_note: string;
}

const COLS =
  't.id, t.slug, t.status, t.year, t.start_date, t.end_date, t.country_code, t.latitude, t.longitude, t.team_size, t.cover_media_key, t.video_url, t.fund_id, t.updated_at';
const ORDER = 'ORDER BY t.year DESC, COALESCE(t.start_date, \'\') DESC, t.id DESC';

function textJoin(locale: Locale) {
  return i18nJoin('mission_trip_i18n', 't', 'trip_id', [...TRIP_TEXT_FIELDS], locale);
}

function numberish(row: TripRow): TripRow {
  return {
    ...row,
    year: Number(row.year),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    team_size: row.team_size === null ? null : Number(row.team_size),
    fund_id: row.fund_id === null ? null : Number(row.fund_id),
  };
}

function textStatements(db: AppDb, id: number, text: TripInput['text']): AppStatement[] {
  return SUPPORTED_LOCALES.filter((code) => text[code] !== undefined).map((code) => {
    const x = text[code]!;
    return db
      .prepare(
        `INSERT INTO mission_trip_i18n (trip_id, locale, title, location, summary, story_md, team_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (trip_id, locale) DO UPDATE SET title = excluded.title, location = excluded.location, summary = excluded.summary,
           story_md = excluded.story_md, team_note = excluded.team_note`,
      )
      .bind(id, code, x.title, x.location, x.summary, x.story_md, x.team_note);
  });
}

export async function createTrip(db: AppDb, input: TripInput): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO mission_trips (slug, status, year, start_date, end_date, country_code, latitude, longitude, team_size, video_url, fund_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
    )
    .bind(input.slug, input.status, input.year, input.startDate, input.endDate, input.countryCode, input.latitude, input.longitude, input.teamSize, input.videoUrl, input.fundId ?? null)
    .first<{ id: number }>();
  const id = row!.id;
  const stmts = textStatements(db, id, input.text);
  if (stmts.length) await db.batch(stmts);
  return id;
}

export async function updateTrip(db: AppDb, id: number, input: TripInput): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE mission_trips SET slug = ?2, status = ?3, year = ?4, start_date = ?5, end_date = ?6, country_code = ?7,
           latitude = ?8, longitude = ?9, team_size = ?10, video_url = ?11, updated_at = datetime('now') WHERE id = ?1`,
      )
      .bind(id, input.slug, input.status, input.year, input.startDate, input.endDate, input.countryCode, input.latitude, input.longitude, input.teamSize, input.videoUrl),
    ...(input.fundId === undefined ? [] : [db.prepare('UPDATE mission_trips SET fund_id = ?2 WHERE id = ?1').bind(id, input.fundId)]),
    ...textStatements(db, id, input.text),
  ]);
}

export async function deleteTrip(db: AppDb, id: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM mission_trip_photos WHERE trip_id = ?1').bind(id),
    db.prepare('DELETE FROM mission_trip_i18n WHERE trip_id = ?1').bind(id),
    db.prepare('DELETE FROM mission_trips WHERE id = ?1').bind(id),
  ]);
}

export async function setTripCover(db: AppDb, id: number, mediaKey: string | null): Promise<void> {
  await db.prepare(`UPDATE mission_trips SET cover_media_key = ?2, updated_at = datetime('now') WHERE id = ?1`).bind(id, mediaKey).run();
}

export async function tripSlugTaken(db: AppDb, slug: string, exceptId: number | null): Promise<boolean> {
  return !!(await db.prepare('SELECT id FROM mission_trips WHERE slug = ?1 AND id != ?2').bind(slug, exceptId ?? 0).first());
}

/** Any status, for the editor. */
export async function getTrip(db: AppDb, id: number, locale: Locale): Promise<TripRow | null> {
  const j = textJoin(locale);
  const row = await db.prepare(`SELECT ${COLS}, ${j.select} FROM mission_trips t ${j.joins} WHERE t.id = ?1`).bind(id).first<TripRow>();
  return row ? numberish(row) : null;
}

export async function getTripTexts(db: AppDb, id: number): Promise<Partial<Record<SupportedLocale, TripText>>> {
  const { results } = await db
    .prepare(`SELECT locale, ${TRIP_TEXT_FIELDS.join(', ')} FROM mission_trip_i18n WHERE trip_id = ?1`)
    .bind(id)
    .all<TripText & { locale: string }>();
  const out: Partial<Record<SupportedLocale, TripText>> = {};
  for (const { locale, ...text } of results) if (isSupportedLocale(locale)) out[locale] = text;
  return out;
}

/** Every trip for the admin list. */
export async function listTrips(db: AppDb, locale: Locale): Promise<TripRow[]> {
  const j = textJoin(locale);
  const { results } = await db.prepare(`SELECT ${COLS}, ${j.select} FROM mission_trips t ${j.joins} ${ORDER}`).all<TripRow>();
  return results.map(numberish);
}

/** Published trips only, newest first. */
export async function listPublishedTrips(db: AppDb, locale: Locale): Promise<TripRow[]> {
  const j = textJoin(locale);
  const { results } = await db
    .prepare(`SELECT ${COLS}, ${j.select} FROM mission_trips t ${j.joins} WHERE t.status = 'published' ${ORDER}`)
    .all<TripRow>();
  return results.map(numberish);
}

export async function getPublishedTrip(db: AppDb, slug: string, locale: Locale): Promise<TripRow | null> {
  const j = textJoin(locale);
  const row = await db
    .prepare(`SELECT ${COLS}, ${j.select} FROM mission_trips t ${j.joins} WHERE t.slug = ?1 AND t.status = 'published'`)
    .bind(slug)
    .first<TripRow>();
  return row ? numberish(row) : null;
}

export interface TripPhoto {
  id: number;
  media_key: string;
  sort: number;
}

export async function listTripPhotos(db: AppDb, tripId: number): Promise<TripPhoto[]> {
  const { results } = await db
    .prepare('SELECT id, media_key, sort FROM mission_trip_photos WHERE trip_id = ?1 ORDER BY sort, id')
    .bind(tripId)
    .all<TripPhoto>();
  return results;
}

/** Photos on the public page: only for a published trip. */
export async function listPublishedTripPhotos(db: AppDb, tripId: number): Promise<TripPhoto[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.media_key, p.sort FROM mission_trip_photos p JOIN mission_trips t ON t.id = p.trip_id
       WHERE p.trip_id = ?1 AND t.status = 'published' ORDER BY p.sort, p.id`,
    )
    .bind(tripId)
    .all<TripPhoto>();
  return results;
}

export const MAX_TRIP_PHOTOS = 24;

export async function addTripPhoto(db: AppDb, tripId: number, mediaKey: string): Promise<boolean> {
  const count = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS top FROM mission_trip_photos WHERE trip_id = ?1').bind(tripId).first<{ n: number; top: number }>();
  if (Number(count?.n ?? 0) >= MAX_TRIP_PHOTOS) return false;
  await db.prepare('INSERT INTO mission_trip_photos (trip_id, media_key, sort) VALUES (?1, ?2, ?3)').bind(tripId, mediaKey, Number(count?.top ?? 0) + 1).run();
  return true;
}

export async function removeTripPhoto(db: AppDb, tripId: number, photoId: number): Promise<void> {
  await db.prepare('DELETE FROM mission_trip_photos WHERE id = ?1 AND trip_id = ?2').bind(photoId, tripId).run();
}
