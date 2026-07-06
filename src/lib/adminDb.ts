// Admin data-access layer. Admin queries apply NO publish filter (editors see
// drafts) but always exclude soft-deleted rows. This slice starts the people
// section only; content/roster writers land in later slices. People carry no
// updated_by column and no revisions (v1 simplification, per spec).
import type {
  PersonInput,
  BulletinInput,
  BulletinAnnouncementInput,
  ProgramRow,
  OfferingRow,
  AttendanceRow,
  SermonInput,
  PrayerSheetInput,
  PrayerSection,
} from './validate';
import type { Locale } from './locales';

type Role = PersonInput['role'];

/** Row shape for the people list table. `active` is D1's raw 0/1 integer. */
export interface PersonListRow {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  active: number;
}

/** Full row for the edit form. */
export interface AdminPersonRow extends PersonListRow {
  lang: 'en' | 'zh' | null;
}

/** savePerson input: the parsed form plus the target id (null = create). */
export interface SavePersonInput extends PersonInput {
  id: number | null;
}

export type SavePersonResult = { ok: true; id: number } | { ok: false; errors: { email: string } };

const LIST_COLS = 'id, first_name, last_name, display_name, email, phone, role, active';

/**
 * Non-deleted people ordered by display_name. With `q`, case-insensitively
 * (SQLite ASCII LIKE) matches display/first/last name or email; LIKE wildcards
 * in the query are escaped so a literal `%` or `_` searches for itself.
 */
export async function listPeople(db: D1Database, opts: { q?: string } = {}): Promise<PersonListRow[]> {
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const { results } = await db
      .prepare(
        `SELECT ${LIST_COLS} FROM people
         WHERE deleted_at IS NULL
           AND (display_name LIKE ?1 ESCAPE '\\' OR first_name LIKE ?1 ESCAPE '\\'
                OR last_name LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\')
         ORDER BY display_name`,
      )
      .bind(like)
      .all<PersonListRow>();
    return results;
  }
  const { results } = await db
    .prepare(`SELECT ${LIST_COLS} FROM people WHERE deleted_at IS NULL ORDER BY display_name`)
    .all<PersonListRow>();
  return results;
}

/** Count of non-deleted people (dashboard stat). */
export async function countPeople(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM people WHERE deleted_at IS NULL`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A single non-deleted person for the edit form. */
export async function getPerson(db: D1Database, id: number): Promise<AdminPersonRow | null> {
  return db
    .prepare(`SELECT ${LIST_COLS}, lang FROM people WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<AdminPersonRow>();
}

/**
 * Create or update a person, mapping an email collision to a field error
 * instead of a raw 500.
 *  - Create (id null): if the email is held only by a SOFT-DELETED person,
 *    revive that row (clear deleted_at, overwrite fields) rather than colliding
 *    with UNIQUE(email); a LIVE holder → { email: 'errors.emailTaken' }.
 *  - Update: block moving onto another LIVE person's email; a soft-deleted
 *    occupant still holds the UNIQUE index, so we surface that as taken too.
 * Every write is additionally guarded against a UNIQUE-constraint throw — a
 * double-submit can insert the email between the pre-check SELECT and the
 * write — and the race maps to the same field error, never a raw 500.
 * `editedBy` is accepted for API symmetry with the content writers; people
 * carry no updated_by column and no revisions in v1, so nothing records it.
 */
export async function savePerson(
  db: D1Database,
  input: SavePersonInput,
  editedBy: string,
): Promise<SavePersonResult> {
  void editedBy;
  const existing = await db
    .prepare(`SELECT id, deleted_at FROM people WHERE email = ?`)
    .bind(input.email)
    .first<{ id: number; deleted_at: string | null }>();

  const emailTaken: SavePersonResult = { ok: false, errors: { email: 'errors.emailTaken' } };

  if (input.id === null) {
    if (existing) {
      if (existing.deleted_at === null) return emailTaken;
      await writePerson(db, existing.id, input); // revive: clears deleted_at
      return { ok: true, id: existing.id };
    }
    try {
      const r = await db
        .prepare(
          `INSERT INTO people (first_name, last_name, display_name, email, phone, role, active, lang)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.firstName,
          input.lastName,
          input.displayName,
          input.email,
          input.phone,
          input.role,
          input.active ? 1 : 0,
          input.lang,
        )
        .run();
      return { ok: true, id: r.meta.last_row_id as number };
    } catch (e) {
      if (isUniqueViolation(e)) return emailTaken; // pre-check ↔ INSERT race
      throw e;
    }
  }

  if (existing && existing.id !== input.id && existing.deleted_at === null) {
    return emailTaken;
  }
  try {
    await writePerson(db, input.id, input);
  } catch (e) {
    // Soft-deleted occupant still holding UNIQUE(email), or the same race.
    if (isUniqueViolation(e)) return emailTaken;
    throw e;
  }
  return { ok: true, id: input.id };
}

function isUniqueViolation(e: unknown): boolean {
  return String(e).includes('UNIQUE constraint failed');
}

// One UPDATE serves both a normal edit and a revive: deleted_at = NULL is a
// harmless no-op for a live row and reclaims a soft-deleted one.
function writePerson(db: D1Database, id: number, input: PersonInput): Promise<unknown> {
  return db
    .prepare(
      `UPDATE people SET first_name = ?, last_name = ?, display_name = ?, email = ?, phone = ?,
         role = ?, active = ?, lang = ?, deleted_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(
      input.firstName,
      input.lastName,
      input.displayName,
      input.email,
      input.phone,
      input.role,
      input.active ? 1 : 0,
      input.lang,
      id,
    )
    .run();
}

/**
 * Update just the role and/or active flags. Deactivation (active = 0) takes
 * effect on the person's next request — the middleware reloads the row and its
 * `active = 1` check rejects an inactive session.
 */
export async function setPersonFlags(
  db: D1Database,
  id: number,
  flags: { role?: Role; active?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number)[] = [];
  if (flags.role !== undefined) {
    sets.push('role = ?');
    binds.push(flags.role);
  }
  if (flags.active !== undefined) {
    sets.push('active = ?');
    binds.push(flags.active ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

/** Soft-delete: hides the person from listPeople and revokes their session
 *  (middleware rejects a deleted_at row). Assignment history is preserved. */
export async function softDeletePerson(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(`UPDATE people SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

// ===========================================================================
// Content: bulletins / sermons / prayer sheets (editor ∪ admin). Every save is
// a single db.batch (upsert + child rows + a full-snapshot revisions row) so a
// partial write can never publish half a record. Admin reads apply NO publish
// filter (editors see drafts) but always exclude soft-deleted rows.
// ===========================================================================

/**
 * Raised by resolveDateSlot when the target date slot is already held by a LIVE
 * row (a real conflict). saveBulletin/saveSermon/savePrayerSheet catch it and
 * map it to a `{ <dateField>: 'errors.dateTaken' }` field error — never a 500.
 */
export class DuplicateDateError extends Error {
  constructor() {
    super('duplicate date');
    this.name = 'DuplicateDateError';
  }
}

/**
 * Resolve which row id a save may write for a UNIQUE date slot (bulletins/
 * sermons keyed on (service_type_id, date); prayer sheets on sheet_date),
 * clearing any soft-deleted occupant that would otherwise collide with the
 * UNIQUE index:
 *  - insert onto a soft-deleted slot → adopt that row's id, so the caller's
 *    upsert becomes an UPDATE that revives the original row (its revision
 *    history is preserved);
 *  - update moving onto a slot held only by a soft-deleted row → hard-delete
 *    that occupant (and its child rows) so the update can proceed; its
 *    snapshots stay in `revisions`;
 *  - a LIVE occupant is always a real conflict → DuplicateDateError.
 * `id IS NOT ?`: with a NULL id (insert) it matches every row in the slot; with
 * a numeric id (update) it excludes the row being updated. SQLite semantics,
 * ported from dcfc-website.
 */
async function resolveDateSlot(
  db: D1Database,
  table: string,
  matchCols: string[],
  matchVals: (string | number)[],
  id: number | null,
  childFk?: { table: string; col: string },
): Promise<number | null> {
  const where = matchCols.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
  const idParam = matchCols.length + 1;
  const row = await db
    .prepare(`SELECT id, deleted_at FROM ${table} WHERE ${where} AND id IS NOT ?${idParam}`)
    .bind(...matchVals, id)
    .first<{ id: number; deleted_at: string | null }>();
  if (!row) return id;
  if (row.deleted_at === null) throw new DuplicateDateError();
  if (id === null) return row.id; // revive: the upsert adopts this soft-deleted row's id
  const clears: D1PreparedStatement[] = [];
  if (childFk) clears.push(db.prepare(`DELETE FROM ${childFk.table} WHERE ${childFk.col} = ?1`).bind(row.id));
  clears.push(db.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(row.id));
  await db.batch(clears);
  return id;
}

/** Versioned revision snapshot: `{ v: 1, input }` so Task 4's restoreRevision
 *  can evolve the shape behind the version tag. `id` is dropped from the input
 *  (entity_id already records which row it belongs to). */
function snapshot<T extends { id: number | null }>(input: T): string {
  const { id: _id, ...content } = input;
  return JSON.stringify({ v: 1, input: content });
}

async function softDeleteContent(db: D1Database, table: string, id: number, editedBy: string): Promise<void> {
  await db
    .prepare(`UPDATE ${table} SET deleted_at = datetime('now'), updated_at = datetime('now'), updated_by = ?2 WHERE id = ?1`)
    .bind(id, editedBy)
    .run();
}

/** Service types (id + localized name, en fallback) for the form <select>s. */
export async function listServiceTypeOptions(db: D1Database, locale: Locale): Promise<{ id: number; name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT st.id AS id, COALESCE(l.name, d.name, '') AS name
       FROM service_types st
       LEFT JOIN service_type_i18n l ON l.service_type_id = st.id AND l.locale = ?1
       LEFT JOIN service_type_i18n d ON d.service_type_id = st.id AND d.locale = 'en'
       WHERE st.deleted_at IS NULL
       ORDER BY st.sort, st.id`,
    )
    .bind(locale)
    .all<{ id: number; name: string }>();
  return results;
}

// ── Bulletins ──────────────────────────────────────────────────────────────

export interface SaveBulletinInput extends BulletinInput {
  id: number | null;
}
export type SaveBulletinResult = { ok: true; id: number } | { ok: false; errors: { bulletin_date: string } };

export interface BulletinListRow {
  id: number;
  service_type_id: number;
  bulletin_date: string;
  status: 'draft' | 'published';
  publish_at: string | null;
  updated_by: string | null;
  updated_at: string;
  serviceTypeName: string;
}

/** All non-deleted bulletins (drafts included), newest date first, en service
 *  name, optionally scoped to one service type (the ?service= filter). */
export async function listBulletins(db: D1Database, opts: { serviceTypeId?: number } = {}): Promise<BulletinListRow[]> {
  const filtered = opts.serviceTypeId !== undefined;
  const { results } = await db
    .prepare(
      `SELECT b.id AS id, b.service_type_id AS service_type_id, b.bulletin_date AS bulletin_date,
              b.status AS status, b.publish_at AS publish_at, b.updated_by AS updated_by, b.updated_at AS updated_at,
              COALESCE(sti.name, '') AS serviceTypeName
       FROM bulletins b
       LEFT JOIN service_type_i18n sti ON sti.service_type_id = b.service_type_id AND sti.locale = 'en'
       WHERE b.deleted_at IS NULL ${filtered ? 'AND b.service_type_id = ?1' : ''}
       ORDER BY b.bulletin_date DESC, b.id DESC`,
    )
    .bind(...(filtered ? [opts.serviceTypeId as number] : []))
    .all<BulletinListRow>();
  return results;
}

export interface BulletinEditData {
  id: number;
  serviceTypeId: number;
  bulletinDate: string;
  serviceTimeLabel: string | null;
  program: ProgramRow[];
  offering: OfferingRow[];
  attendance: AttendanceRow[];
  memoryVerse: string | null;
  flowers: string | null;
  status: 'draft' | 'published';
  publishAt: string | null;
  announcements: BulletinAnnouncementInput[];
  updatedAt: string;
}

interface BulletinDbRow {
  id: number;
  service_type_id: number;
  bulletin_date: string;
  service_time_label: string | null;
  program_json: string | null;
  offering_json: string | null;
  attendance_json: string | null;
  memory_verse: string | null;
  flowers: string | null;
  status: 'draft' | 'published';
  publish_at: string | null;
  updated_at: string;
}

function parseArr<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** A single non-deleted bulletin plus its announcements, for the edit form. */
export async function getBulletinForEdit(db: D1Database, id: number): Promise<BulletinEditData | null> {
  const row = await db
    .prepare(
      `SELECT id, service_type_id, bulletin_date, service_time_label, program_json, offering_json,
              attendance_json, memory_verse, flowers, status, publish_at, updated_at
       FROM bulletins WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<BulletinDbRow>();
  if (!row) return null;
  const { results } = await db
    .prepare(`SELECT title, body, link_url, link_label FROM bulletin_announcements WHERE bulletin_id = ?1 ORDER BY seq, id`)
    .bind(id)
    .all<{ title: string; body: string; link_url: string | null; link_label: string | null }>();
  return {
    id: row.id,
    serviceTypeId: row.service_type_id,
    bulletinDate: row.bulletin_date,
    serviceTimeLabel: row.service_time_label,
    program: parseArr<ProgramRow>(row.program_json),
    offering: parseArr<OfferingRow>(row.offering_json),
    attendance: parseArr<AttendanceRow>(row.attendance_json),
    memoryVerse: row.memory_verse,
    flowers: row.flowers,
    status: row.status,
    publishAt: row.publish_at,
    announcements: results.map((a) => ({
      title: a.title,
      body: a.body,
      linkUrl: a.link_url,
      linkLabel: a.link_label,
    })),
    updatedAt: row.updated_at,
  };
}

/**
 * Create or update a bulletin in ONE transaction: upsert the row, rewrite its
 * announcements (DELETE + re-INSERT), and write a full-snapshot revision. The
 * (service_type_id, bulletin_date) slot is UNIQUE, so the announcement/revision
 * statements resolve the row id by that slot — identical for insert and update.
 * A duplicate LIVE date maps to `errors.dateTaken` (also on the pre-check ↔
 * INSERT race), never a raw 500.
 */
export async function saveBulletin(db: D1Database, input: SaveBulletinInput, editedBy: string): Promise<SaveBulletinResult> {
  let id: number | null;
  try {
    id = await resolveDateSlot(
      db,
      'bulletins',
      ['service_type_id', 'bulletin_date'],
      [input.serviceTypeId, input.bulletinDate],
      input.id,
      { table: 'bulletin_announcements', col: 'bulletin_id' },
    );
  } catch (e) {
    if (e instanceof DuplicateDateError) return { ok: false, errors: { bulletin_date: 'errors.dateTaken' } };
    throw e;
  }

  const programJson = JSON.stringify(input.program);
  const offeringJson = JSON.stringify(input.offering);
  const attendanceJson = JSON.stringify(input.attendance);
  const upsert =
    id === null
      ? db
          .prepare(
            `INSERT INTO bulletins (service_type_id, bulletin_date, service_time_label, program_json, offering_json,
                  attendance_json, memory_verse, flowers, status, publish_at, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))`,
          )
          .bind(
            input.serviceTypeId,
            input.bulletinDate,
            input.serviceTimeLabel,
            programJson,
            offeringJson,
            attendanceJson,
            input.memoryVerse,
            input.flowers,
            input.status,
            input.publishAt,
            editedBy,
          )
      : db
          .prepare(
            `UPDATE bulletins SET service_type_id = ?1, bulletin_date = ?2, service_time_label = ?3, program_json = ?4,
                  offering_json = ?5, attendance_json = ?6, memory_verse = ?7, flowers = ?8, status = ?9, publish_at = ?10,
                  deleted_at = NULL, updated_by = ?11, updated_at = datetime('now') WHERE id = ?12`,
          )
          .bind(
            input.serviceTypeId,
            input.bulletinDate,
            input.serviceTimeLabel,
            programJson,
            offeringJson,
            attendanceJson,
            input.memoryVerse,
            input.flowers,
            input.status,
            input.publishAt,
            editedBy,
            id,
          );

  try {
    const results = await db.batch([
      upsert,
      db
        .prepare(
          `DELETE FROM bulletin_announcements
           WHERE bulletin_id = (SELECT id FROM bulletins WHERE service_type_id = ?1 AND bulletin_date = ?2)`,
        )
        .bind(input.serviceTypeId, input.bulletinDate),
      ...input.announcements.map((a, i) =>
        db
          .prepare(
            `INSERT INTO bulletin_announcements (bulletin_id, seq, title, body, link_url, link_label)
             SELECT id, ?3, ?4, ?5, ?6, ?7 FROM bulletins WHERE service_type_id = ?1 AND bulletin_date = ?2`,
          )
          .bind(input.serviceTypeId, input.bulletinDate, i + 1, a.title, a.body, a.linkUrl, a.linkLabel),
      ),
      db
        .prepare(
          `INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by)
           SELECT 'bulletin', id, ?3, ?4 FROM bulletins WHERE service_type_id = ?1 AND bulletin_date = ?2`,
        )
        .bind(input.serviceTypeId, input.bulletinDate, snapshot(input), editedBy),
    ]);
    return { ok: true, id: id ?? (results[0].meta.last_row_id as number) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, errors: { bulletin_date: 'errors.dateTaken' } };
    throw e;
  }
}

export async function softDeleteBulletin(db: D1Database, id: number, editedBy: string): Promise<void> {
  await softDeleteContent(db, 'bulletins', id, editedBy);
}

// ── Sermons ────────────────────────────────────────────────────────────────

export interface SaveSermonInput extends SermonInput {
  id: number | null;
}
export type SaveSermonResult = { ok: true; id: number } | { ok: false; errors: { sermon_date: string } };

export interface SermonListRow {
  id: number;
  service_type_id: number;
  sermon_date: string;
  title: string;
  speaker: string;
  status: 'draft' | 'published';
  updated_by: string | null;
  updated_at: string;
  serviceTypeName: string;
}

/** All non-deleted sermons (drafts included), newest date first, en service
 *  name, optionally scoped to a year (the ?year= filter). */
export async function listSermons(db: D1Database, opts: { year?: number } = {}): Promise<SermonListRow[]> {
  const filtered = opts.year !== undefined;
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.service_type_id AS service_type_id, s.sermon_date AS sermon_date, s.title AS title,
              s.speaker AS speaker, s.status AS status, s.updated_by AS updated_by, s.updated_at AS updated_at,
              COALESCE(sti.name, '') AS serviceTypeName
       FROM sermons s
       LEFT JOIN service_type_i18n sti ON sti.service_type_id = s.service_type_id AND sti.locale = 'en'
       WHERE s.deleted_at IS NULL ${filtered ? "AND substr(s.sermon_date, 1, 4) = ?1" : ''}
       ORDER BY s.sermon_date DESC, s.id DESC`,
    )
    .bind(...(filtered ? [String(opts.year)] : []))
    .all<SermonListRow>();
  return results;
}

/** Distinct years with at least one non-deleted sermon, newest first. */
export async function listSermonYears(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT CAST(substr(sermon_date, 1, 4) AS INTEGER) AS year
       FROM sermons WHERE deleted_at IS NULL ORDER BY year DESC`,
    )
    .all<{ year: number }>();
  return results.map((r) => r.year);
}

export interface SermonEditData extends SermonInput {
  id: number;
  updatedAt: string;
}

export async function getSermonForEdit(db: D1Database, id: number): Promise<SermonEditData | null> {
  const row = await db
    .prepare(
      `SELECT id, service_type_id, sermon_date, title, speaker, scripture, youtube_id, series, status, updated_at
       FROM sermons WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<{
      id: number;
      service_type_id: number;
      sermon_date: string;
      title: string;
      speaker: string;
      scripture: string | null;
      youtube_id: string | null;
      series: string | null;
      status: 'draft' | 'published';
      updated_at: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    serviceTypeId: row.service_type_id,
    sermonDate: row.sermon_date,
    title: row.title,
    speaker: row.speaker,
    scripture: row.scripture,
    youtubeId: row.youtube_id,
    series: row.series,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

/** Create or update a sermon in ONE transaction (upsert + revision snapshot).
 *  Sermons have no child rows. Duplicate LIVE (service_type, date) → dateTaken. */
export async function saveSermon(db: D1Database, input: SaveSermonInput, editedBy: string): Promise<SaveSermonResult> {
  let id: number | null;
  try {
    id = await resolveDateSlot(db, 'sermons', ['service_type_id', 'sermon_date'], [input.serviceTypeId, input.sermonDate], input.id);
  } catch (e) {
    if (e instanceof DuplicateDateError) return { ok: false, errors: { sermon_date: 'errors.dateTaken' } };
    throw e;
  }
  const upsert =
    id === null
      ? db
          .prepare(
            `INSERT INTO sermons (service_type_id, sermon_date, title, speaker, scripture, youtube_id, series, status, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))`,
          )
          .bind(
            input.serviceTypeId,
            input.sermonDate,
            input.title,
            input.speaker,
            input.scripture,
            input.youtubeId,
            input.series,
            input.status,
            editedBy,
          )
      : db
          .prepare(
            `UPDATE sermons SET service_type_id = ?1, sermon_date = ?2, title = ?3, speaker = ?4, scripture = ?5,
                  youtube_id = ?6, series = ?7, status = ?8, deleted_at = NULL, updated_by = ?9, updated_at = datetime('now')
             WHERE id = ?10`,
          )
          .bind(
            input.serviceTypeId,
            input.sermonDate,
            input.title,
            input.speaker,
            input.scripture,
            input.youtubeId,
            input.series,
            input.status,
            editedBy,
            id,
          );
  try {
    const results = await db.batch([
      upsert,
      db
        .prepare(
          `INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by)
           SELECT 'sermon', id, ?3, ?4 FROM sermons WHERE service_type_id = ?1 AND sermon_date = ?2`,
        )
        .bind(input.serviceTypeId, input.sermonDate, snapshot(input), editedBy),
    ]);
    return { ok: true, id: id ?? (results[0].meta.last_row_id as number) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, errors: { sermon_date: 'errors.dateTaken' } };
    throw e;
  }
}

export async function softDeleteSermon(db: D1Database, id: number, editedBy: string): Promise<void> {
  await softDeleteContent(db, 'sermons', id, editedBy);
}

// ── Prayer sheets ────────────────────────────────────────────────────────────

export interface SavePrayerSheetInput extends PrayerSheetInput {
  id: number | null;
}
export type SavePrayerSheetResult = { ok: true; id: number } | { ok: false; errors: { sheet_date: string } };

export interface PrayerSheetListRow {
  id: number;
  sheet_date: string;
  locale: Locale | null;
  status: 'draft' | 'published';
  publish_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

export async function listPrayerSheets(db: D1Database): Promise<PrayerSheetListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, sheet_date, locale, status, publish_at, updated_by, updated_at
       FROM prayer_sheets WHERE deleted_at IS NULL ORDER BY sheet_date DESC, id DESC`,
    )
    .all<PrayerSheetListRow>();
  return results;
}

export interface PrayerSheetEditData extends PrayerSheetInput {
  id: number;
  updatedAt: string;
}

export async function getPrayerSheetForEdit(db: D1Database, id: number): Promise<PrayerSheetEditData | null> {
  const row = await db
    .prepare(
      `SELECT id, sheet_date, locale, sections_json, status, publish_at, updated_at
       FROM prayer_sheets WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(id)
    .first<{
      id: number;
      sheet_date: string;
      locale: Locale | null;
      sections_json: string | null;
      status: 'draft' | 'published';
      publish_at: string | null;
      updated_at: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    sheetDate: row.sheet_date,
    locale: row.locale,
    sections: parseArr<PrayerSection>(row.sections_json),
    status: row.status,
    publishAt: row.publish_at,
    updatedAt: row.updated_at,
  };
}

/** Create or update a prayer sheet in ONE transaction (upsert + revision
 *  snapshot). sheet_date is UNIQUE (single column). Duplicate LIVE date →
 *  dateTaken. */
export async function savePrayerSheet(db: D1Database, input: SavePrayerSheetInput, editedBy: string): Promise<SavePrayerSheetResult> {
  let id: number | null;
  try {
    id = await resolveDateSlot(db, 'prayer_sheets', ['sheet_date'], [input.sheetDate], input.id);
  } catch (e) {
    if (e instanceof DuplicateDateError) return { ok: false, errors: { sheet_date: 'errors.dateTaken' } };
    throw e;
  }
  const sectionsJson = JSON.stringify(input.sections);
  const upsert =
    id === null
      ? db
          .prepare(
            `INSERT INTO prayer_sheets (sheet_date, locale, sections_json, status, publish_at, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`,
          )
          .bind(input.sheetDate, input.locale, sectionsJson, input.status, input.publishAt, editedBy)
      : db
          .prepare(
            `UPDATE prayer_sheets SET sheet_date = ?1, locale = ?2, sections_json = ?3, status = ?4, publish_at = ?5,
                  deleted_at = NULL, updated_by = ?6, updated_at = datetime('now') WHERE id = ?7`,
          )
          .bind(input.sheetDate, input.locale, sectionsJson, input.status, input.publishAt, editedBy, id);
  try {
    const results = await db.batch([
      upsert,
      db
        .prepare(
          `INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by)
           SELECT 'prayer_sheet', id, ?2, ?3 FROM prayer_sheets WHERE sheet_date = ?1`,
        )
        .bind(input.sheetDate, snapshot(input), editedBy),
    ]);
    return { ok: true, id: id ?? (results[0].meta.last_row_id as number) };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, errors: { sheet_date: 'errors.dateTaken' } };
    throw e;
  }
}

export async function softDeletePrayerSheet(db: D1Database, id: number, editedBy: string): Promise<void> {
  await softDeleteContent(db, 'prayer_sheets', id, editedBy);
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface StatusCounts {
  published: number;
  draft: number;
}

/** Published / draft counts for a content table (soft-deleted rows excluded). */
export async function countContentByStatus(db: D1Database, table: 'bulletins' | 'sermons' | 'prayer_sheets'): Promise<StatusCounts> {
  const { results } = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL GROUP BY status`)
    .all<{ status: string; n: number }>();
  const counts: StatusCounts = { published: 0, draft: 0 };
  for (const r of results) {
    if (r.status === 'published') counts.published = r.n;
    else if (r.status === 'draft') counts.draft = r.n;
  }
  return counts;
}

export interface WeekPrepRow {
  service_type_id: number;
  name: string;
  bulletin_id: number | null;
  bulletin_status: string | null;
  sermon_id: number | null;
  sermon_status: string | null;
}

/** Per service type on `date`: is there a (non-deleted) bulletin and sermon?
 *  Powers the dashboard "this week prep" checklist. */
export async function listWeekPrep(db: D1Database, date: string, locale: Locale): Promise<WeekPrepRow[]> {
  const { results } = await db
    .prepare(
      `SELECT st.id AS service_type_id, COALESCE(l.name, d.name, '') AS name,
              b.id AS bulletin_id, b.status AS bulletin_status,
              s.id AS sermon_id, s.status AS sermon_status
       FROM service_types st
       LEFT JOIN service_type_i18n l ON l.service_type_id = st.id AND l.locale = ?2
       LEFT JOIN service_type_i18n d ON d.service_type_id = st.id AND d.locale = 'en'
       LEFT JOIN bulletins b ON b.service_type_id = st.id AND b.bulletin_date = ?1 AND b.deleted_at IS NULL
       LEFT JOIN sermons s ON s.service_type_id = st.id AND s.sermon_date = ?1 AND s.deleted_at IS NULL
       WHERE st.deleted_at IS NULL
       ORDER BY st.sort, st.id`,
    )
    .bind(date, locale)
    .all<WeekPrepRow>();
  return results;
}

export interface RecentRevisionRow {
  id: number;
  entity: string;
  entity_id: number;
  edited_by: string;
  edited_at: string;
}

/** The most recent revision rows across all entities (dashboard activity). */
export async function listRecentRevisions(db: D1Database, limit: number): Promise<RecentRevisionRow[]> {
  const { results } = await db
    .prepare(`SELECT id, entity, entity_id, edited_by, edited_at FROM revisions ORDER BY edited_at DESC, id DESC LIMIT ?1`)
    .bind(limit)
    .all<RecentRevisionRow>();
  return results;
}
