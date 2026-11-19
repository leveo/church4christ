// Registration data access: public event browsing (lifecycle phase, localized
// title/description, live seat counts), the answer validator the registration
// form runs before it writes, the atomic registration writer (event lock,
// confirmation number, capacity or waitlist decision, one attendee, answers), the
// Checkout-session lifecycle transitions a Stripe handler drives (attach ->
// confirm/cancel), and the admin surface (event + question editors in every site
// language, lifecycle actions, duplicate, roster, CSV export). Runs on D1 and on
// Postgres through the AppDb seam, so every shared statement is dialect-neutral
// SQL. Paid (Stripe) registration is Postgres-only. Money is integer cents
// everywhere; no floats cross this seam.
//
// Localized reads use i18nJoin (requested -> installation default -> en).
//
// Seats: a registration holds SUM(party_size) seats while its status is pending,
// review or confirmed (SEAT_STATUSES). A waitlist row holds nothing.
import type { AppDb, AppDbResult, AppStatement } from './appDb';
import { i18nJoin, type Locale } from './db';
import { csvCell } from './csv';
import { toUtcSql } from './dates';
import { getRuntimeDefaultLocale, isSupportedLocale } from './locales';
import { eventPhase, type RegPhase } from './regPhase';

export type { RegPhase } from './regPhase';

export type RegStatus = 'pending' | 'review' | 'confirmed' | 'waitlist' | 'declined' | 'cancelled';

export interface RegQuestion {
  id: number;
  sort: number;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'yesno';
  required: number;
  options: string[] | null;
  label: string;
}

export interface RegEvent {
  id: number;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  capacity: number | null;
  price_cents: number | null;
  currency: string;
  opens_at: string | null;
  closes_at: string | null;
  active: number;
  visible_from: string | null;
  waitlist_enabled: number;
  confirmation_prefix: string | null;
  poster: string | null;
  /** Localized event notes shown to registrants (requested -> default -> en). */
  notes: string | null;
  /** The most people one registration may cover (1-20). */
  max_party_size: number;
  /** 1 = registrants may edit/cancel through their manage link while the event is open or in preview. */
  allow_self_edit: number;
  /** Seats held by confirmed registrations (SUM(party_size)). */
  confirmed_count: number;
  /** Seats held by pending + review + confirmed registrations (SUM(party_size)). */
  taken_count: number;
  /** People on the waitlist (SUM(party_size)). */
  waitlist_count: number;
}

/** A public event with its lifecycle phase at the time it was read. */
export interface RegPublicEvent extends RegEvent {
  phase: RegPhase;
}

/** The statuses that hold a seat. Pending seats are durable: an ambiguous Checkout
 *  create can remain recoverable for almost 24 hours, so only a guarded terminal
 *  transition may release one. */
export const SEAT_STATUSES = ['pending', 'review', 'confirmed'] as const;
const SEAT_STATUS_LIST = SEAT_STATUSES.map((s) => `'${s}'`).join(',');

// Assumes the registrations row is aliased `r`.
const HOLDS_SEAT = `r.status IN (${SEAT_STATUS_LIST})`;

/** Seats held for the event row `eventRef` (a column reference such as `e.id`). */
export const seatsTakenSql = (eventRef: string): string =>
  `(SELECT COALESCE(SUM(r.party_size), 0) FROM registrations r WHERE r.event_id = ${eventRef} AND ${HOLDS_SEAT})`;

/**
 * SQL expression for the confirmation number of the registration being inserted,
 * valid on SQLite and Postgres: `<prefix>-<NNNN>`, prefix = the event's
 * confirmation_prefix or 'R' + the two-digit year of starts_at, number = the
 * counter value taken by the lock statement (next_confirmation - 1), zero-padded
 * to four digits by a portable CASE (no printf / lpad). `alias` is the
 * reg_events row alias; the statement must run AFTER the counter increment.
 */
export const confirmationNoSql = (alias = 'e'): string => {
  const n = `(${alias}.next_confirmation - 1)`;
  return `COALESCE(${alias}.confirmation_prefix, 'R' || substr(${alias}.starts_at, 3, 2)) || '-' || `
    + `CASE WHEN ${n} < 10 THEN '000' WHEN ${n} < 100 THEN '00' WHEN ${n} < 1000 THEN '0' ELSE '' END || CAST(${n} AS TEXT)`;
};

/** The per-event lock + confirmation counter: the FIRST statement of every
 *  registration-creating batch. It row-locks the event on Postgres and runs inside
 *  D1's serialized write transaction, so the capacity predicate that follows sees
 *  every committed registration. */
export const EVENT_LOCK_AND_NUMBER_SQL =
  `UPDATE reg_events SET next_confirmation = next_confirmation + 1, updated_at = updated_at WHERE id = ?1`;

// The localized event projection shared by every public event reader. The locale
// is baked into the joins by i18nJoin (the fallback chain follows the installation
// default), so callers bind their own parameters from ?1. Seat counts sum
// party_size (see SEAT_STATUSES).
function eventSelect(locale: Locale): string {
  const { select, joins } = i18nJoin('reg_event_i18n', 'e', 'event_id', ['title', 'description', 'notes'], locale);
  return `
  SELECT e.id AS id,
         ${select},
         e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
         e.capacity AS capacity, e.price_cents AS price_cents, e.currency AS currency,
         e.opens_at AS opens_at, e.closes_at AS closes_at, e.active AS active,
         e.visible_from AS visible_from, e.waitlist_enabled AS waitlist_enabled,
         e.confirmation_prefix AS confirmation_prefix, e.poster AS poster,
         e.max_party_size AS max_party_size, e.allow_self_edit AS allow_self_edit,
         (SELECT COALESCE(SUM(r.party_size), 0) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_count,
         ${seatsTakenSql('e.id')} AS taken_count,
         (SELECT COALESCE(SUM(r.party_size), 0) FROM registrations r WHERE r.event_id = e.id AND r.status = 'waitlist') AS waitlist_count
  FROM reg_events e
  ${joins}`;
}

type EventRow = Omit<RegEvent, 'title' | 'notes'> & { title: string | null; notes: string | null };
const toEvent = (row: EventRow): RegEvent => ({ ...row, title: row.title ?? '' });

// A registration is OPEN when it is active, visible, its sign-up window has
// opened (opens_at NULL = immediately), and it has not closed (closes_at NULL =
// open until the event starts). This is exactly eventPhase() === 'open'. All
// timestamps are the app's UTC 'YYYY-MM-DD HH:MM:SS' text, so lexical comparison
// against datetime('now') is chronological.
const OPEN_WHERE = `e.active = 1
  AND (e.visible_from IS NULL OR e.visible_from <= datetime('now'))
  AND (e.opens_at IS NULL OR e.opens_at <= datetime('now'))
  AND (COALESCE(e.closes_at, e.starts_at) > datetime('now'))`;

/** Public list of currently-open events, soonest first, localized. */
export async function listOpenEvents(db: AppDb, locale: Locale): Promise<RegEvent[]> {
  const { results } = await db
    .prepare(`${eventSelect(locale)} WHERE ${OPEN_WHERE} ORDER BY e.starts_at, e.id`)
    .all<EventRow>();
  return results.map(toEvent);
}

/** A single open event by id (null when unknown OR outside its sign-up window). */
export async function getOpenEvent(db: AppDb, locale: Locale, id: number): Promise<RegEvent | null> {
  const row = await db
    .prepare(`${eventSelect(locale)} WHERE e.id = ?1 AND ${OPEN_WHERE}`)
    .bind(id)
    .first<EventRow>();
  return row ? toEvent(row) : null;
}

// Visible = active and past its visible_from time. A visible event is either
// preview, open or (for the detail page only) closed.
const VISIBLE_WHERE = `e.active = 1 AND (e.visible_from IS NULL OR e.visible_from <= ?1)`;

/**
 * The public list: visible events that are in preview or open, soonest first,
 * each with its phase. `now` (UTC 'YYYY-MM-DD HH:MM:SS') defaults to the current
 * time and is bound, so the SQL window and eventPhase() always agree.
 */
export async function listPublicEvents(db: AppDb, locale: Locale, now: string = toUtcSql()): Promise<RegPublicEvent[]> {
  const { results } = await db
    .prepare(`${eventSelect(locale)} WHERE ${VISIBLE_WHERE} AND COALESCE(e.closes_at, e.starts_at) > ?1 ORDER BY e.starts_at, e.id`)
    .bind(now)
    .all<EventRow>();
  return results.map((row) => ({ ...toEvent(row), phase: eventPhase(row, now) }));
}

/** One visible event (preview, open or closed; null when unknown or hidden), with its phase. */
export async function getPublicEvent(
  db: AppDb,
  locale: Locale,
  id: number,
  now: string = toUtcSql(),
): Promise<RegPublicEvent | null> {
  const row = await db
    .prepare(`${eventSelect(locale)} WHERE e.id = ?2 AND ${VISIBLE_WHERE}`)
    .bind(now, id)
    .first<EventRow>();
  return row ? { ...toEvent(row), phase: eventPhase(row, now) } : null;
}

// A signed-in member's own registrations, for the /my portal (events page +
// dashboard card). Matched by person_id OR the account's email (case-insensitive
// - a registration made before the account was linked, or under a typo'd email,
// still surfaces), seat-holding and waitlist rows only (cancelled / declined are
// hidden), newest event first. This is the portal-facing sibling of
// groupRegDb.listRegistrationActivityForPerson, which serves the profile/admin
// activity feed (person_id only, includes cancelled, created_at order); the two
// are kept distinct because their shapes and filtering differ materially.
export interface MyRegistration {
  id: number;
  event_id: number;
  event_title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  status: 'pending' | 'review' | 'confirmed' | 'waitlist';
  amount_cents: number;
  currency: string;
  confirmation_no: string | null;
  party_size: number;
  created_at: string;
}

export async function listRegistrationsForPerson(
  db: AppDb,
  locale: Locale,
  personId: number,
  email: string,
): Promise<MyRegistration[]> {
  const { select, joins } = i18nJoin('reg_event_i18n', 'e', 'event_id', ['title'], locale);
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, r.event_id AS event_id,
              ${select.replace(/ AS title$/, ' AS event_title')},
              e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
              r.status AS status, r.amount_cents AS amount_cents, r.currency AS currency,
              r.confirmation_no AS confirmation_no, r.party_size AS party_size,
              r.created_at AS created_at
       FROM registrations r
       JOIN reg_events e ON e.id = r.event_id
       ${joins}
       WHERE (r.person_id = ?1 OR LOWER(r.email) = LOWER(?2))
         AND r.status IN ('pending','review','confirmed','waitlist')
       ORDER BY e.starts_at DESC`,
    )
    .bind(personId, email)
    .all<Omit<MyRegistration, 'event_title'> & { event_title: string | null }>();
  return results.map((r) => ({ ...r, event_title: r.event_title ?? '' }));
}

/** An event's questions in sort order, localized label (requested -> default -> en);
 *  options JSON-decoded to a string[] (null for non-select/checkbox or unparseable). */
export async function listQuestions(db: AppDb, locale: Locale, eventId: number): Promise<RegQuestion[]> {
  const { select, joins } = i18nJoin('reg_question_i18n', 'q', 'question_id', ['label'], locale);
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options,
              ${select}
       FROM reg_questions q
       ${joins}
       WHERE q.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; type: RegQuestion['type']; required: number; options: string | null; label: string | null }>();
  return results.map((r) => ({ ...r, label: r.label ?? '', options: parseOptions(r.options) }));
}

/** An event's questions with EVERY language's label raw (no cross-fallback - the
 *  editor prefills each language, so an absent label is simply missing from
 *  `labels`). label_en / label_zh are conveniences for the two original columns. */
export interface RegQuestionAdmin {
  id: number;
  sort: number;
  type: RegQuestion['type'];
  required: number;
  options: string[] | null;
  labels: Partial<Record<Locale, string>>;
  label_en: string;
  label_zh: string | null;
}

/** The question set for the admin builder: raw labels in every language, sort order. */
export async function listQuestionsAdmin(db: AppDb, eventId: number): Promise<RegQuestionAdmin[]> {
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options
       FROM reg_questions q
       WHERE q.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; type: RegQuestion['type']; required: number; options: string | null }>();
  const { results: labelRows } = await db
    .prepare(
      `SELECT l.question_id AS question_id, l.locale AS locale, l.label AS label
       FROM reg_question_i18n l JOIN reg_questions q ON q.id = l.question_id
       WHERE q.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ question_id: number; locale: string; label: string }>();
  const byQuestion = new Map<number, Partial<Record<Locale, string>>>();
  for (const l of labelRows) {
    if (!isSupportedLocale(l.locale)) continue;
    const m = byQuestion.get(l.question_id) ?? {};
    m[l.locale] = l.label;
    byQuestion.set(l.question_id, m);
  }
  return results.map((r) => {
    const labels = byQuestion.get(r.id) ?? {};
    return { ...r, options: parseOptions(r.options), labels, label_en: labels.en ?? '', label_zh: labels.zh ?? null };
  });
}

/** Decode a reg_questions.options TEXT (a JSON array of strings) to string[].
 *  NULL, a non-array, a non-string element, or malformed JSON all yield null. */
function parseOptions(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((o) => typeof o === 'string')) return parsed as string[];
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate a submitted answer form against an event's questions, returning the
 * normalized [questionId, value] pairs ready for createRegistration, or throwing
 * 'missing_required' (a required question left blank) / 'bad_answer' (a value not
 * among a select/checkbox's options, or an unrecognized yes/no). Form keys are
 * the question id as a string; a checkbox arrives as string | string[]. Text and
 * textarea are trimmed; a blank OPTIONAL answer is dropped (no pair emitted).
 * Checkbox values are stored JSON-encoded so the multi-select round-trips.
 */
export function validateAnswers(
  questions: RegQuestion[],
  form: Record<string, string | string[]>,
): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const q of questions) {
    const checked = checkAnswer(q, form[String(q.id)]);
    if ('code' in checked) throw new Error(checked.code);
    if (checked.value !== null) out.push([q.id, checked.value]);
  }
  return out;
}

export type AnswerErrorCode = 'missing_required' | 'bad_answer';

/** Check ONE question's raw form value: the normalized value to store (null =
 *  nothing to store), or the error code. Shared by validateAnswers (throws the
 *  first error) and validateSubmission (collects every error). */
export function checkAnswer(
  q: RegQuestion,
  raw: string | string[] | undefined,
): { value: string | null } | { code: AnswerErrorCode } {
  const options = q.options ?? [];

  if (q.type === 'checkbox') {
    const values = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).filter((v) => v !== '');
    if (q.required && values.length === 0) return { code: 'missing_required' };
    for (const v of values) if (!options.includes(v)) return { code: 'bad_answer' };
    return { value: values.length > 0 ? JSON.stringify(values) : null };
  }

  const value = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim();
  if (value === '') return q.required ? { code: 'missing_required' } : { value: null };
  if (q.type === 'select') return options.includes(value) ? { value } : { code: 'bad_answer' };
  if (q.type === 'yesno') {
    const v = value.toLowerCase();
    if (['yes', 'y', 'true', '1', 'on'].includes(v)) return { value: 'yes' };
    if (['no', 'n', 'false', '0', 'off'].includes(v)) return { value: 'no' };
    return { code: 'bad_answer' };
  }
  // text / textarea — the trimmed value, non-empty by the guard above.
  return { value };
}

// ── Registration writer ──────────────────────────────────────────────────────

export interface RegAttendeeInput {
  name: string;
  personId?: number | null;
}

export interface RegistrationInsertInput {
  /** Pre-allocated registration id (the guest continuation path); omit to auto-assign. */
  id?: number;
  eventId: number;
  personId: number | null;
  name: string;
  email: string;
  /** Status when a seat is available: 'confirmed' (free) or 'pending' (awaiting payment). */
  status: 'pending' | 'confirmed';
  amountCents: number;
  currency: string;
  /** Idempotency key, unique per event. */
  submissionKey: string;
  /** Seats the registration takes. Ignored when `attendees` is given (then it is attendees.length). */
  partySize?: number;
  /** The people covered, in order (1..max_party_size, validated by the caller through
   *  validateSubmission). Omitted: one attendee, the contact. For the first row an
   *  undefined personId inherits `personId`; every other row's undefined means no person. */
  attendees?: RegAttendeeInput[];
  /** The registrant's language, for later emails (null = unknown). */
  locale?: string | null;
  phone?: string | null;
  /** SHA-256 hex of the manage-link token (see generateManageToken). */
  manageTokenHash?: string | null;
  /** When the event is full: true + waitlist_enabled inserts a 'waitlist' row; otherwise nothing is inserted. */
  allowWaitlist: boolean;
  answers: Array<[number, string]>;
  /** Extra conditions for the guest continuation: still active, not closed at `now`, free, same currency. */
  guard?: { now: string; currency: string };
}

/** Index of the INSERT ... RETURNING result inside registrationInsertStatements. */
export const REGISTRATION_INSERT_INDEX = 1;

/**
 * The statements that create one registration, for ONE batch (one transaction):
 *   [0] lock + number allocation: UPDATE reg_events SET next_confirmation = next_confirmation + 1
 *       (the portable per-event mutex - a row lock on Postgres, serialized on D1);
 *   [1] INSERT ... SELECT ... RETURNING id, status, confirmation_no: the capacity /
 *       waitlist decision is made in SQL against the committed seat count (SUM of
 *       party_size over SEAT_STATUSES), so a full event with no waitlist inserts
 *       NOTHING (no row returned) and never an oversold or compensating row;
 *   [2..] one reg_attendees row per person (sort 0..N-1), then the reg_answers rows, all selected back
 *       through (event_id, submission_key) - no currval, nothing to thread.
 * Read the outcome with readRegistrationInsert(results).
 */
export function registrationInsertStatements(db: AppDb, input: RegistrationInsertInput): AppStatement[] {
  const attendees: RegAttendeeInput[] = input.attendees?.length
    ? input.attendees
    : [{ name: input.name, personId: input.personId }];
  const partySize = input.attendees?.length ? input.attendees.length : (input.partySize ?? 1);
  const binds: unknown[] = [
    input.eventId, input.personId, input.name, input.email, input.status, input.amountCents,
    input.currency, input.submissionKey, partySize, input.allowWaitlist ? 1 : 0,
    input.locale ?? null, input.phone ?? null, input.manageTokenHash ?? null,
  ];
  // Optional pieces take the next free placeholder number, so every placeholder a
  // statement mentions is bound and nothing else is (Postgres rejects both gaps
  // and surplus parameters).
  const bindNext = (value: unknown): string => {
    binds.push(value);
    return `?${binds.length}`;
  };
  const idColumn = input.id !== undefined ? 'id, ' : '';
  const idValue = input.id !== undefined ? `CAST(${bindNext(input.id)} AS INTEGER), ` : '';
  let guard = '';
  if (input.guard) {
    const now = bindNext(input.guard.now);
    const currency = bindNext(input.guard.currency);
    guard = ` AND e.active = 1 AND COALESCE(e.closes_at, e.starts_at) > CAST(${now} AS TEXT)
           AND COALESCE(e.price_cents, 0) = 0 AND lower(e.currency) = lower(CAST(${currency} AS TEXT))`;
  }

  const stmts: AppStatement[] = [
    db.prepare(EVENT_LOCK_AND_NUMBER_SQL).bind(input.eventId),
    db
      .prepare(
        `INSERT INTO registrations
           (${idColumn}event_id, person_id, name, email, status, amount_cents, currency, submission_key, confirmation_no, party_size,
            locale, phone, manage_token_hash)
         SELECT ${idValue}e.id, CAST(?2 AS INTEGER), CAST(?3 AS TEXT), CAST(?4 AS TEXT),
                CASE WHEN e.capacity IS NULL OR h.taken + CAST(?9 AS INTEGER) <= e.capacity THEN CAST(?5 AS TEXT) ELSE 'waitlist' END,
                CAST(?6 AS INTEGER), CAST(?7 AS TEXT), CAST(?8 AS TEXT), ${confirmationNoSql('e')}, CAST(?9 AS INTEGER),
                CAST(?11 AS TEXT), CAST(?12 AS TEXT), CAST(?13 AS TEXT)
         FROM reg_events e
         CROSS JOIN (
           SELECT COALESCE(SUM(r.party_size), 0) AS taken
           FROM registrations r WHERE r.event_id = ?1 AND ${HOLDS_SEAT}
         ) h
         WHERE e.id = ?1
           AND (e.capacity IS NULL OR h.taken + CAST(?9 AS INTEGER) <= e.capacity
                OR (CAST(?10 AS INTEGER) = 1 AND e.waitlist_enabled = 1))${guard}
         RETURNING id, status, confirmation_no`,
      )
      .bind(...binds),
  ];
  attendees.forEach((attendee, index) => {
    const personId = attendee.personId === undefined ? (index === 0 ? input.personId : null) : attendee.personId;
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_attendees (registration_id, sort, name, person_id)
           SELECT r.id, CAST(?3 AS INTEGER), CAST(?4 AS TEXT), CAST(?5 AS INTEGER) FROM registrations r
           WHERE r.event_id = ?1 AND r.submission_key = ?2
             AND NOT EXISTS (SELECT 1 FROM reg_attendees a WHERE a.registration_id = r.id AND a.sort = CAST(?3 AS INTEGER))`,
        )
        .bind(input.eventId, input.submissionKey, index, attendee.name, personId),
    );
  });
  for (const [questionId, value] of input.answers) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_answers (registration_id, question_id, value)
           SELECT r.id, CAST(?3 AS INTEGER), CAST(?4 AS TEXT) FROM registrations r
           WHERE r.event_id = ?1 AND r.submission_key = ?2
           ON CONFLICT DO NOTHING`,
        )
        .bind(input.eventId, input.submissionKey, questionId, value),
    );
  }
  return stmts;
}

export interface CreatedRegistration {
  id: number;
  status: RegStatus;
  confirmationNo: string | null;
  /** The plaintext manage-link token, present ONLY on the call that created the row
   *  (only its SHA-256 is stored, so a repeat or re-read returns null). */
  manageToken?: string | null;
}

// ── Manage-link token ───────────────────────────────────────────────────────

const MANAGE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** SHA-256 of a manage token as lowercase hex (what registrations.manage_token_hash stores). */
export async function hashManageToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh manage token (32 random bytes, base64url, 43 characters) and its stored hash. */
export async function generateManageToken(): Promise<{ token: string; hash: string }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await hashManageToken(token) };
}

/** True for a string shaped like a manage token (checked before any database read). */
export const isManageTokenShape = (value: unknown): value is string => typeof value === 'string' && MANAGE_TOKEN_RE.test(value);

/** The registration a registrationInsertStatements batch created, or null when the
 *  capacity predicate excluded it (event full and no waitlist). `manageToken` is the
 *  plaintext the caller generated for this batch; it is echoed back on success. */
export function readRegistrationInsert(results: AppDbResult[], manageToken: string | null = null): CreatedRegistration | null {
  const row = results[REGISTRATION_INSERT_INDEX]?.results?.[0] as
    | { id: number; status: RegStatus; confirmation_no: string | null }
    | undefined;
  return row ? { id: row.id, status: row.status, confirmationNo: row.confirmation_no, manageToken } : null;
}

/** A unique-constraint violation on either backend (Postgres 23505, SQLite message). */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === '23505') return true;
  if (typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)) return true;
  return e.cause !== undefined && isUniqueViolation(e.cause);
}

async function findBySubmissionKey(db: AppDb, eventId: number, submissionKey: string): Promise<CreatedRegistration | null> {
  const row = await db
    .prepare(`SELECT id, status, confirmation_no FROM registrations WHERE event_id = ?1 AND submission_key = ?2`)
    .bind(eventId, submissionKey)
    .first<{ id: number; status: RegStatus; confirmation_no: string | null }>();
  return row ? { id: row.id, status: row.status, confirmationNo: row.confirmation_no } : null;
}

/** A server-generated idempotency key. The ':' keeps it outside the client key alphabet. */
export const newSubmissionKey = (): string => `srv:${crypto.randomUUID()}`;

/**
 * Create a registration, its attendee and its answers atomically, returning
 * { id, status, confirmationNo }. status is the INSERT's own decision: the
 * requested status while seats remain, 'waitlist' when the event is full and the
 * caller allows it (free events with waitlist_enabled only - a paid registration
 * never waitlists). A full event with no waitlist throws 'event_full' and
 * inserts nothing; an unknown event throws 'event_not_found'.
 *
 * Idempotent per (event, submissionKey): a repeat returns the original row
 * without a second attendee, and a unique-violation race (two requests with the
 * same key committing together) re-reads the winner.
 */
export async function createRegistration(
  db: AppDb,
  input: {
    eventId: number;
    personId: number | null;
    name: string;
    email: string;
    status: 'pending' | 'confirmed';
    amountCents: number;
    currency: string;
    answers: Array<[number, string]>;
    submissionKey?: string;
    partySize?: number;
    /** The people covered (see RegistrationInsertInput.attendees); party_size = its length. */
    attendees?: RegAttendeeInput[];
    locale?: string | null;
    phone?: string | null;
    allowWaitlist?: boolean;
  },
): Promise<CreatedRegistration> {
  const submissionKey = input.submissionKey ?? newSubmissionKey();
  const existing = await findBySubmissionKey(db, input.eventId, submissionKey);
  if (existing) return { ...existing, manageToken: null };

  const manage = await generateManageToken();
  const stmts = registrationInsertStatements(db, {
    eventId: input.eventId,
    personId: input.personId,
    name: input.name,
    email: input.email,
    status: input.status,
    amountCents: input.amountCents,
    currency: input.currency,
    submissionKey,
    partySize: input.partySize,
    attendees: input.attendees,
    locale: input.locale ?? null,
    phone: input.phone ?? null,
    manageTokenHash: manage.hash,
    allowWaitlist: input.amountCents === 0 && input.allowWaitlist !== false,
    answers: input.answers,
  });
  let results: AppDbResult[];
  try {
    results = await db.batch(stmts);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findBySubmissionKey(db, input.eventId, submissionKey);
      if (winner) return { ...winner, manageToken: null };
    }
    throw error;
  }
  const created = readRegistrationInsert(results, manage.token);
  if (created) return created;
  if (results[0].meta.changes === 0) throw new Error('event_not_found');
  throw new Error('event_full');
}

/** Attach the Stripe Checkout session id to a pending registration (paid flow). */
export async function attachCheckoutSession(db: AppDb, registrationId: number, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE registrations SET stripe_checkout_session_id = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(sessionId, registrationId)
    .run();
}

/**
 * Confirm the pending registration for a Checkout session (payment succeeded).
 * Idempotent: only a still-pending row moves, so a redelivered webhook returns
 * false. Returns true when a row was confirmed.
 */
export async function confirmBySession(db: AppDb, sessionId: string, paymentIntentId: string | null): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE registrations SET status = 'confirmed', stripe_payment_intent_id = ?2, updated_at = datetime('now')
       WHERE stripe_checkout_session_id = ?1 AND status = 'pending'`,
    )
    .bind(sessionId, paymentIntentId)
    .run();
  return r.meta.changes > 0;
}

/**
 * Cancel the pending registration for a Checkout session (session expired),
 * freeing its held seat. Idempotent: only a still-pending row moves. Returns true
 * when a row was cancelled.
 */
export async function cancelBySession(db: AppDb, sessionId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE registrations SET status = 'cancelled', updated_at = datetime('now')
       WHERE stripe_checkout_session_id = ?1 AND status = 'pending'`,
    )
    .bind(sessionId)
    .run();
  return r.meta.changes > 0;
}

export type RegistrationCheckoutAction = 'confirm' | 'cancel' | 'attach_waiting' | 'attach_open';
export type RegistrationCheckoutTransition = 'applied' | 'converged' | 'deferred' | 'mismatch';

/**
 * Resolve a Stripe Checkout session against one registration without trusting
 * metadata alone. An unattached row may self-heal only through its exact private
 * request; an already-attached legacy row converges by exact session ID.
 */
export async function applyRegistrationCheckoutSession(
  db: AppDb,
  input: {
    registrationId: number;
    requestId: string | null;
    sessionId: string;
    paymentIntentId: string | null;
    amountCents: number;
    currency: string;
    action: RegistrationCheckoutAction;
  },
  checkpoint?: () => Promise<void>,
): Promise<RegistrationCheckoutTransition> {
  const terminalStatus = input.action === 'confirm'
    ? 'confirmed'
    : input.action === 'cancel'
      ? 'cancelled'
      : 'pending';
  await checkpoint?.();
  const result = await db
    .prepare(
      `UPDATE registrations
       SET status = ?1,
           stripe_checkout_session_id = ?2,
           stripe_payment_intent_id = CASE WHEN ?1 = 'confirmed' THEN ?3 ELSE stripe_payment_intent_id END,
           updated_at = datetime('now')
       WHERE id = ?4
         AND (
           status = 'pending'
           OR (
             ?1 = 'confirmed' AND status = 'cancelled'
             AND EXISTS (
               SELECT 1 FROM church_private.stripe_checkout_requests manual_q
               WHERE manual_q.request_id = CAST(?7 AS TEXT)
                 AND manual_q.registration_id = ?4
                 AND manual_q.state = 'resolved'
                 AND manual_q.last_error = 'manual_cancel'
             )
           )
         )
         AND amount_cents = ?5
         AND currency = ?6
         AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?2)
         AND (
           stripe_checkout_session_id = ?2
           OR (
             CAST(?7 AS TEXT) IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM church_private.stripe_checkout_requests q
               WHERE q.request_id = CAST(?7 AS TEXT) AND q.registration_id = ?4
             )
           )
         )`,
    )
    .bind(
      terminalStatus,
      input.sessionId,
      input.paymentIntentId,
      input.registrationId,
      input.amountCents,
      input.currency,
      input.requestId,
    )
    .run();

  let transition: RegistrationCheckoutTransition;
  if (result.meta.changes > 0) {
    transition = 'applied';
  } else {
    const evidence = await db
      .prepare(
        `SELECT r.status AS status,
                r.amount_cents AS amount_cents,
                r.currency AS currency,
                r.stripe_checkout_session_id AS stripe_checkout_session_id,
                EXISTS (
                  SELECT 1 FROM church_private.stripe_checkout_requests q
                  WHERE CAST(?2 AS TEXT) IS NOT NULL
                    AND q.request_id = CAST(?2 AS TEXT)
                    AND q.registration_id = ?1
                ) AS request_matches
         FROM (SELECT 1) seed
         LEFT JOIN registrations r ON r.id = ?1
         LIMIT 1`,
      )
      .bind(input.registrationId, input.requestId)
      .first<{
        status: 'pending' | 'confirmed' | 'cancelled' | null;
        amount_cents: number | null;
        currency: string | null;
        stripe_checkout_session_id: string | null;
        request_matches: boolean | number;
      }>();
    if (!evidence?.status) {
      transition = evidence?.request_matches === true || evidence?.request_matches === 1
        ? 'deferred'
        : 'mismatch';
    } else {
      const exact = evidence.amount_cents === input.amountCents
        && evidence.currency === input.currency
        && evidence.stripe_checkout_session_id === input.sessionId;
      const expectedTerminal = input.action === 'confirm'
        ? evidence.status === 'confirmed'
        : input.action === 'cancel'
          ? evidence.status === 'cancelled'
          : evidence.status === 'pending';
      transition = exact && expectedTerminal ? 'converged' : 'mismatch';
    }
  }

  if ((transition === 'applied' || transition === 'converged') && input.requestId !== null) {
    const terminal = input.action === 'confirm' || input.action === 'cancel';
    await checkpoint?.();
    await db.batch([
      db
        .prepare(
          `UPDATE church_private.stripe_checkout_requests
           SET state = ?1,
               request_json = CASE WHEN ?1 = 'resolved' THEN NULL ELSE request_json END,
               session_url = CASE WHEN ?1 = 'resolved' THEN NULL ELSE session_url END,
               next_reconcile_at = NULL,
               last_error = CASE
                 WHEN last_error = 'manual_cancel' AND ?4 = 'cancel' THEN last_error
                 ELSE NULL
               END,
               updated_at = datetime('now')
           WHERE registration_id = ?2
             AND request_id = CAST(?3 AS TEXT)`,
        )
        .bind(terminal ? 'resolved' : 'attached', input.registrationId, input.requestId, input.action),
    ]);
  }
  return transition;
}

/** Apply a recovery result only while the exact Checkout claim version is current. */
export async function applyClaimedRegistrationCheckoutSession(
  db: AppDb,
  input: {
    requestId: string;
    registrationId: number;
    claimedState: 'creating' | 'attached' | 'manual_review';
    claimVersion: string;
    sessionId: string;
    paymentIntentId: string | null;
    amountCents: number;
    currency: string;
    action: RegistrationCheckoutAction;
    sessionUrl: string | null;
    nextReconcileAt: string | null;
    actorId: number | null;
    updatedAt: string;
  },
): Promise<boolean> {
  const terminal = input.action === 'confirm' || input.action === 'cancel';
  const status = input.action === 'confirm'
    ? 'confirmed'
    : input.action === 'cancel'
      ? 'cancelled'
      : 'pending';
  const state = terminal ? 'resolved' : 'attached';
  try {
    await db.batch([
      db.prepare(
        `UPDATE registrations r
         SET status=?1,stripe_checkout_session_id=?2,
             stripe_payment_intent_id=CASE WHEN ?1='confirmed' THEN ?3 ELSE stripe_payment_intent_id END,
             updated_at=datetime('now')
         WHERE r.id=?4 AND r.status='pending' AND r.amount_cents=?5 AND r.currency=?6
           AND (r.stripe_checkout_session_id IS NULL OR r.stripe_checkout_session_id=?2)
           AND EXISTS (
             SELECT 1 FROM church_private.stripe_checkout_requests q
             WHERE q.request_id=?7 AND q.registration_id=r.id AND q.state=?8 AND q.updated_at=?9
           )`,
      ).bind(
        status,
        input.sessionId,
        input.paymentIntentId,
        input.registrationId,
        input.amountCents,
        input.currency,
        input.requestId,
        input.claimedState,
        input.claimVersion,
      ),
      db.prepare(
        `UPDATE church_private.stripe_checkout_requests q
         SET state=?1,request_json=NULL,session_url=?2,next_reconcile_at=?3,last_error=NULL,
             last_action_by=COALESCE(?4,last_action_by),updated_at=?5
         WHERE q.request_id=?6 AND q.registration_id=?7 AND q.state=?8 AND q.updated_at=?9
           AND EXISTS (
             SELECT 1 FROM registrations r
             WHERE r.id=q.registration_id AND r.status=?10
               AND r.stripe_checkout_session_id=?11 AND r.amount_cents=?12 AND r.currency=?13
           )`,
      ).bind(
        state,
        terminal ? null : input.sessionUrl,
        terminal ? null : input.nextReconcileAt,
        input.actorId,
        input.updatedAt,
        input.requestId,
        input.registrationId,
        input.claimedState,
        input.claimVersion,
        status,
        input.sessionId,
        input.amountCents,
        input.currency,
      ),
      db.prepare(
        `SELECT 1 / CASE WHEN EXISTS (
           SELECT 1 FROM registrations r
           JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
           WHERE r.id=?1 AND r.status=?2 AND r.stripe_checkout_session_id=?3
             AND q.request_id=?4 AND q.state=?5 AND q.updated_at=?6
             AND q.request_json IS NULL
             AND (?7=0 OR (q.session_url IS NULL AND q.next_reconcile_at IS NULL))
         ) THEN 1 ELSE 0 END AS recovery_guard`,
      ).bind(
        input.registrationId,
        status,
        input.sessionId,
        input.requestId,
        state,
        input.updatedAt,
        terminal ? 1 : 0,
      ),
    ]);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === '22012') return false;
    throw error;
  }
}

/** Persist a strictly verified create response before any follow-up Stripe read. */
export async function attachClaimedRegistrationCheckoutSessionId(
  db: AppDb,
  input: {
    requestId: string;
    registrationId: number;
    claimVersion: string;
    sessionId: string;
    amountCents: number;
    currency: string;
    nextReconcileAt: string;
    updatedAt: string;
  },
): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(
        `UPDATE registrations r
         SET stripe_checkout_session_id=?1,updated_at=datetime('now')
         WHERE r.id=?2 AND r.status='pending' AND r.amount_cents=?3 AND r.currency=?4
           AND (r.stripe_checkout_session_id IS NULL OR r.stripe_checkout_session_id=?1)
           AND EXISTS (
             SELECT 1 FROM church_private.stripe_checkout_requests q
             WHERE q.request_id=?5 AND q.registration_id=r.id
               AND q.state='creating' AND q.updated_at=?6
           )`,
      ).bind(
        input.sessionId,
        input.registrationId,
        input.amountCents,
        input.currency,
        input.requestId,
        input.claimVersion,
      ),
      db.prepare(
        `UPDATE church_private.stripe_checkout_requests q
         SET state='attached',request_json=NULL,session_url=NULL,next_reconcile_at=?1,
             last_error=NULL,updated_at=?2
         WHERE q.request_id=?3 AND q.registration_id=?4
           AND q.state='creating' AND q.updated_at=?5
           AND EXISTS (
             SELECT 1 FROM registrations r
             WHERE r.id=q.registration_id AND r.status='pending'
               AND r.stripe_checkout_session_id=?6 AND r.amount_cents=?7 AND r.currency=?8
           )`,
      ).bind(
        input.nextReconcileAt,
        input.updatedAt,
        input.requestId,
        input.registrationId,
        input.claimVersion,
        input.sessionId,
        input.amountCents,
        input.currency,
      ),
      db.prepare(
        `SELECT 1 / CASE WHEN EXISTS (
           SELECT 1 FROM registrations r
           JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
           WHERE r.id=?1 AND r.status='pending' AND r.stripe_checkout_session_id=?2
             AND q.request_id=?3 AND q.state='attached' AND q.updated_at=?4
             AND q.request_json IS NULL AND q.next_reconcile_at=?5
         ) THEN 1 ELSE 0 END AS attach_created_guard`,
      ).bind(
        input.registrationId,
        input.sessionId,
        input.requestId,
        input.updatedAt,
        input.nextReconcileAt,
      ),
    ]);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === '22012') return false;
    throw error;
  }
}

/** Explicit operator cancellation guarded by the same request claim version. */
export async function cancelClaimedRegistrationCheckoutRequest(
  db: AppDb,
  input: {
    requestId: string;
    registrationId: number;
    claimedState: 'creating' | 'attached' | 'manual_review';
    claimVersion: string;
    actorId: number;
    updatedAt: string;
  },
): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(
        `UPDATE registrations r SET status='cancelled',updated_at=datetime('now')
         WHERE r.id=?1 AND r.status='pending'
           AND EXISTS (
             SELECT 1 FROM church_private.stripe_checkout_requests q
             WHERE q.request_id=?2 AND q.registration_id=r.id AND q.state=?3 AND q.updated_at=?4
           )`,
      ).bind(input.registrationId, input.requestId, input.claimedState, input.claimVersion),
      db.prepare(
        `UPDATE church_private.stripe_checkout_requests q
         SET state='resolved',request_json=NULL,session_url=NULL,next_reconcile_at=NULL,
             last_error='manual_cancel',last_action_by=?1,updated_at=?2
         WHERE q.request_id=?3 AND q.registration_id=?4 AND q.state=?5 AND q.updated_at=?6
           AND EXISTS (
             SELECT 1 FROM registrations r WHERE r.id=q.registration_id AND r.status='cancelled'
           )`,
      ).bind(
        input.actorId,
        input.updatedAt,
        input.requestId,
        input.registrationId,
        input.claimedState,
        input.claimVersion,
      ),
      db.prepare(
        `SELECT 1 / CASE WHEN EXISTS (
           SELECT 1 FROM registrations r
           JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
           WHERE r.id=?1 AND r.status='cancelled' AND q.request_id=?2 AND q.state='resolved'
             AND q.request_json IS NULL AND q.session_url IS NULL AND q.next_reconcile_at IS NULL
             AND q.last_action_by=?3 AND q.last_error='manual_cancel' AND q.updated_at=?4
         ) THEN 1 ELSE 0 END AS manual_cancel_guard`,
      ).bind(input.registrationId, input.requestId, input.actorId, input.updatedAt),
    ]);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === '22012') return false;
    throw error;
  }
}

/**
 * Cancel a registration by id (admin action, or the createRegistration backstop's
 * compensating undo) — any status becomes 'cancelled'. Idempotent: an
 * already-cancelled row does not move and returns false. On a FREE event the
 * released seats go to the waitlist (promoteWaitlist); the promoted registration
 * ids are in `promoted` for the caller to email.
 */
export async function cancelRegistration(db: AppDb, id: number): Promise<boolean> {
  return (await cancelRegistrationPromoting(db, id)).cancelled;
}

/** cancelRegistration plus the waitlist registrations it promoted. */
export async function cancelRegistrationPromoting(
  db: AppDb,
  id: number,
): Promise<{ cancelled: boolean; promoted: number[] }> {
  const event = await db.prepare(`SELECT event_id FROM registrations WHERE id = ?1`).bind(id).first<{ event_id: number }>();
  if (!event) return { cancelled: false, promoted: [] };
  const results = await db.batch([
    // Serializes with every other seat-changing batch on this event.
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(event.event_id),
    db
      .prepare(
        `UPDATE registrations SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?1 AND status != 'cancelled'`,
      )
      .bind(id),
    // Everyone on a cancelled registration is cancelled too.
    db
      .prepare(
        `UPDATE reg_attendees SET status = 'cancelled', updated_at = datetime('now')
         WHERE registration_id = ?1 AND status = 'active'
           AND EXISTS (SELECT 1 FROM registrations r WHERE r.id = ?1 AND r.status = 'cancelled')`,
      )
      .bind(id),
  ]);
  if (results[1].meta.changes === 0) return { cancelled: false, promoted: [] };
  return { cancelled: true, promoted: await promoteWaitlist(db, event.event_id) };
}

/**
 * Move waitlisted registrations onto freed seats, FREE events only (a paid event
 * never waitlists, and its seats are released by Stripe session expiry instead).
 * Runs after any seat is released. Candidates are read first (oldest first:
 * created_at, id), then ONE batch runs: a row lock on the event (so two
 * concurrent releases serialize and each candidate is promoted once), then one
 * guarded UPDATE per candidate - still waitlisted AND the whole party fits in the
 * seats left. Later statements in the batch see earlier promotions, so a party
 * that does not fit is skipped and a smaller later one may take the seats; a
 * skipped party stays first in line for the next release. Returns the promoted
 * registration ids in promotion order.
 */
export async function promoteWaitlist(db: AppDb, eventId: number): Promise<number[]> {
  const event = await db
    .prepare(`SELECT price_cents FROM reg_events WHERE id = ?1`)
    .bind(eventId)
    .first<{ price_cents: number | null }>();
  if (!event || (event.price_cents ?? 0) > 0) return [];
  const { results: candidates } = await db
    .prepare(`SELECT id FROM registrations WHERE event_id = ?1 AND status = 'waitlist' ORDER BY created_at, id`)
    .bind(eventId)
    .all<{ id: number }>();
  if (candidates.length === 0) return [];
  const stmts: AppStatement[] = [
    // The lock only; it must not take a confirmation number.
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(eventId),
  ];
  for (const candidate of candidates) {
    stmts.push(
      db
        .prepare(
          `UPDATE registrations SET status = 'confirmed', updated_at = datetime('now')
           WHERE id = ?1 AND event_id = ?2 AND status = 'waitlist'
             AND EXISTS (
               SELECT 1 FROM reg_events e
               WHERE e.id = ?2 AND COALESCE(e.price_cents, 0) = 0
                 AND (e.capacity IS NULL
                      OR ${seatsTakenSql('e.id')} + registrations.party_size <= e.capacity)
             )
           RETURNING id`,
        )
        .bind(candidate.id, eventId),
    );
  }
  const results = await db.batch(stmts);
  const promoted: number[] = [];
  for (let i = 1; i < results.length; i++) {
    const row = results[i].results?.[0] as { id: number } | undefined;
    if (row) promoted.push(row.id);
  }
  return promoted;
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Every event (active AND inactive) with live counts, newest first - the admin
 *  events table. Localized title/description (requested -> default -> en). */
export async function listAllEvents(db: AppDb, locale: Locale): Promise<RegEvent[]> {
  const { results } = await db
    .prepare(`${eventSelect(locale)} ORDER BY e.starts_at DESC, e.id DESC`)
    .all<EventRow>();
  return results.map(toEvent);
}

/** An admin event carrying EVERY language's raw title/description (not a single
 *  localized projection) so the editor can prefill each language. `titles` /
 *  `descriptions` hold only the locales that have a row; title_en is '' when the en
 *  row is missing, the other three conveniences are null when absent. */
export interface RegEventAdmin {
  id: number;
  titles: Partial<Record<Locale, string>>;
  descriptions: Partial<Record<Locale, string | null>>;
  title_en: string;
  title_zh: string | null;
  description_en: string | null;
  description_zh: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  capacity: number | null;
  price_cents: number | null;
  currency: string;
  opens_at: string | null;
  closes_at: string | null;
  active: number;
  visible_from: string | null;
  waitlist_enabled: number;
  confirmation_prefix: string | null;
  next_confirmation: number;
  poster: string | null;
  max_party_size: number;
  allow_self_edit: number;
  /** Per-language notes shown to registrants (only languages that have a row/notes). */
  notes: Partial<Record<Locale, string | null>>;
  confirmed_count: number;
  taken_count: number;
  waitlist_count: number;
  phase: RegPhase;
}

const ADMIN_EVENT_SELECT = `
  SELECT e.id AS id,
         e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
         e.capacity AS capacity, e.price_cents AS price_cents, e.currency AS currency,
         e.opens_at AS opens_at, e.closes_at AS closes_at, e.active AS active,
         e.visible_from AS visible_from, e.waitlist_enabled AS waitlist_enabled,
         e.confirmation_prefix AS confirmation_prefix, e.next_confirmation AS next_confirmation,
         e.poster AS poster, e.max_party_size AS max_party_size, e.allow_self_edit AS allow_self_edit,
         (SELECT COALESCE(SUM(r.party_size), 0) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_count,
         ${seatsTakenSql('e.id')} AS taken_count,
         (SELECT COALESCE(SUM(r.party_size), 0) FROM registrations r WHERE r.event_id = e.id AND r.status = 'waitlist') AS waitlist_count
  FROM reg_events e`;

type AdminEventRow = Omit<RegEventAdmin, 'titles' | 'descriptions' | 'notes' | 'title_en' | 'title_zh' | 'description_en' | 'description_zh' | 'phase'>;

async function withEventTexts(db: AppDb, rows: AdminEventRow[], now: string): Promise<RegEventAdmin[]> {
  if (rows.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT event_id, locale, title, description, notes FROM reg_event_i18n`)
    .all<{ event_id: number; locale: string; title: string; description: string | null; notes: string | null }>();
  const ids = new Set(rows.map((r) => r.id));
  const titles = new Map<number, Partial<Record<Locale, string>>>();
  const descriptions = new Map<number, Partial<Record<Locale, string | null>>>();
  const notes = new Map<number, Partial<Record<Locale, string | null>>>();
  for (const t of results) {
    if (!ids.has(t.event_id) || !isSupportedLocale(t.locale)) continue;
    (titles.get(t.event_id) ?? titles.set(t.event_id, {}).get(t.event_id)!)[t.locale] = t.title;
    (descriptions.get(t.event_id) ?? descriptions.set(t.event_id, {}).get(t.event_id)!)[t.locale] = t.description;
    (notes.get(t.event_id) ?? notes.set(t.event_id, {}).get(t.event_id)!)[t.locale] = t.notes;
  }
  return rows.map((r) => {
    const tt = titles.get(r.id) ?? {};
    const dd = descriptions.get(r.id) ?? {};
    return {
      ...r,
      titles: tt,
      descriptions: dd,
      notes: notes.get(r.id) ?? {},
      title_en: tt.en ?? '',
      title_zh: tt.zh ?? null,
      description_en: dd.en ?? null,
      description_zh: dd.zh ?? null,
      phase: eventPhase(r, now),
    };
  });
}

/** Every event with all-language title/description + counts + phase, newest first -
 *  the admin list, which doubles as the ?edit=<id> prefill source. */
export async function listEventsAdmin(db: AppDb, now: string = toUtcSql()): Promise<RegEventAdmin[]> {
  const { results } = await db.prepare(`${ADMIN_EVENT_SELECT} ORDER BY e.starts_at DESC, e.id DESC`).all<AdminEventRow>();
  return withEventTexts(db, results, now);
}

/** A single event with all-language fields + counts (the questions/roster page's
 *  header + amount currency), or null when unknown. */
export async function getEventAdmin(db: AppDb, id: number, now: string = toUtcSql()): Promise<RegEventAdmin | null> {
  const row = await db.prepare(`${ADMIN_EVENT_SELECT} WHERE e.id = ?1`).bind(id).first<AdminEventRow>();
  return row ? (await withEventTexts(db, [row], now))[0] : null;
}

/** A confirmation prefix is 1-6 characters of A-Z / 0-9 (matches the column CHECK). */
export const CONFIRMATION_PREFIX_RE = /^[A-Z0-9]{1,6}$/;

/** `notes` undefined leaves the stored notes untouched; null or blank clears them. */
export type LocalizedEventTexts = Partial<Record<Locale, { title: string; description?: string | null; notes?: string | null }>>;

export interface RegEventSaveInput {
  id?: number;
  /** Per-language title/description. A locale that is absent is left untouched; a
   *  present locale with a blank title deletes that language's row. The default
   *  language's title is required. */
  titles?: LocalizedEventTexts;
  /** Legacy en/zh columns; folded into `titles` (an explicit `titles` entry wins). */
  title_en?: string;
  title_zh?: string;
  description_en?: string;
  description_zh?: string;
  starts_at: string;
  ends_at?: string | null;
  location?: string | null;
  capacity?: number | null;
  price_cents?: number | null;
  opens_at?: string | null;
  closes_at?: string | null;
  active: number;
  /** On update, an undefined value leaves the column unchanged. */
  visible_from?: string | null;
  waitlist_enabled?: number;
  confirmation_prefix?: string | null;
  poster?: string | null;
  /** 1-20 people per registration (default 1 on insert; undefined leaves it unchanged on update). */
  max_party_size?: number;
  /** 1/0: registrants may edit or cancel through their manage link (default 1). */
  allow_self_edit?: number;
  /** The installation's default language (default: the runtime default). */
  defaultLocale?: Locale;
}

function collectEventTexts(input: RegEventSaveInput): Map<Locale, { title: string; description: string | null; notes: string | null | undefined }> {
  const merged: LocalizedEventTexts = {};
  if (input.title_en !== undefined) merged.en = { title: input.title_en, description: input.description_en };
  if (input.title_zh !== undefined) merged.zh = { title: input.title_zh, description: input.description_zh };
  Object.assign(merged, input.titles ?? {});
  const out = new Map<Locale, { title: string; description: string | null; notes: string | null | undefined }>();
  for (const [locale, text] of Object.entries(merged)) {
    if (!isSupportedLocale(locale)) throw new Error('locale_unsupported');
    if (!text) continue;
    out.set(locale, {
      title: text.title.trim(),
      description: (text.description ?? '').trim() || null,
      notes: text.notes === undefined ? undefined : (text.notes ?? '').trim() || null,
    });
  }
  return out;
}

/**
 * Insert (id absent) or update (id present) an event plus its per-language
 * title + description. The default language's title is required (throws
 * 'title_required'); every other supported language is optional, and a present
 * language with a blank title DELETES its row rather than storing '' (the
 * fallback join only fires on a missing row, never on ''). An unsupported
 * language throws 'locale_unsupported'. Languages not mentioned are never
 * touched, so disabling a site language never loses content. Currency is left at
 * its column default. Returns the event id.
 */
export async function saveEvent(db: AppDb, input: RegEventSaveInput): Promise<number> {
  const texts = collectEventTexts(input);
  const defaultLocale = input.defaultLocale ?? getRuntimeDefaultLocale();
  if (!texts.get(defaultLocale)?.title) throw new Error('title_required');
  if (input.confirmation_prefix != null && !CONFIRMATION_PREFIX_RE.test(input.confirmation_prefix)) {
    throw new Error('confirmation_prefix_invalid');
  }
  if (input.waitlist_enabled !== undefined && input.waitlist_enabled !== 0 && input.waitlist_enabled !== 1) {
    throw new Error('waitlist_enabled_invalid');
  }
  if (input.max_party_size !== undefined && !(Number.isInteger(input.max_party_size) && input.max_party_size >= 1 && input.max_party_size <= 20)) {
    throw new Error('max_party_size_invalid');
  }
  if (input.allow_self_edit !== undefined && input.allow_self_edit !== 0 && input.allow_self_edit !== 1) {
    throw new Error('allow_self_edit_invalid');
  }

  let eventId: number;
  if (input.id != null) {
    const sets = [
      'starts_at = ?1', 'ends_at = ?2', 'location = ?3', 'capacity = ?4', 'price_cents = ?5',
      'opens_at = ?6', 'closes_at = ?7', 'active = ?8',
    ];
    const binds: unknown[] = [
      input.starts_at, input.ends_at ?? null, input.location ?? null, input.capacity ?? null,
      input.price_cents ?? null, input.opens_at ?? null, input.closes_at ?? null, input.active,
    ];
    const optional: Array<[string, unknown]> = [
      ['visible_from', input.visible_from],
      ['waitlist_enabled', input.waitlist_enabled],
      ['confirmation_prefix', input.confirmation_prefix],
      ['poster', input.poster],
      ['max_party_size', input.max_party_size],
      ['allow_self_edit', input.allow_self_edit],
    ];
    for (const [column, value] of optional) {
      if (value === undefined) continue;
      binds.push(value);
      sets.push(`${column} = ?${binds.length}`);
    }
    binds.push(input.id);
    const result = await db
      .prepare(`UPDATE reg_events SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run();
    if (result.meta.changes === 0) throw new Error('event_not_found');
    eventId = input.id;
  } else {
    const created = await db
      .prepare(
        `INSERT INTO reg_events (starts_at, ends_at, location, capacity, price_cents, opens_at, closes_at, active,
                                 visible_from, waitlist_enabled, confirmation_prefix, poster, max_party_size, allow_self_edit)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING id`,
      )
      .bind(
        input.starts_at, input.ends_at ?? null, input.location ?? null, input.capacity ?? null,
        input.price_cents ?? null, input.opens_at ?? null, input.closes_at ?? null, input.active,
        input.visible_from ?? null, input.waitlist_enabled ?? 1, input.confirmation_prefix ?? null, input.poster ?? null,
        input.max_party_size ?? 1, input.allow_self_edit ?? 1,
      )
      .first<{ id: number }>();
    eventId = created!.id;
  }

  const stmts: AppStatement[] = [];
  for (const [locale, text] of texts) {
    stmts.push(
      text.title
        ? db
            .prepare(
              text.notes === undefined
                ? `INSERT INTO reg_event_i18n (event_id, locale, title, description) VALUES (?1, ?2, ?3, ?4)
                   ON CONFLICT (event_id, locale) DO UPDATE SET title = excluded.title, description = excluded.description`
                : `INSERT INTO reg_event_i18n (event_id, locale, title, description, notes) VALUES (?1, ?2, ?3, ?4, ?5)
                   ON CONFLICT (event_id, locale) DO UPDATE SET title = excluded.title, description = excluded.description, notes = excluded.notes`,
            )
            .bind(...(text.notes === undefined ? [eventId, locale, text.title, text.description] : [eventId, locale, text.title, text.description, text.notes]))
        : db.prepare(`DELETE FROM reg_event_i18n WHERE event_id = ?1 AND locale = ?2`).bind(eventId, locale),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return eventId;
}

export type RegLifecycleAction = 'open_now' | 'close_now' | 'hide' | 'show';

/**
 * Admin lifecycle buttons. They only rewrite opens_at / closes_at / active (plus
 * clearing a visible_from that would keep an opened event hidden):
 *  - open_now: opens_at = now. When the event's effective close time
 *    (COALESCE(closes_at, starts_at)) has already passed, a new close time in the
 *    future is required in `opts.closesAt`, else throws 'close_required'.
 *  - close_now: closes_at = now (an opens_at still in the future is pulled back to
 *    now so the event reads as closed, not as a preview).
 *  - hide / show: active = 0 / 1.
 * Throws 'event_not_found' for an unknown id.
 */
export async function setEventLifecycle(
  db: AppDb,
  id: number,
  action: RegLifecycleAction,
  opts: { now?: string; closesAt?: string | null } = {},
): Promise<void> {
  const now = opts.now ?? toUtcSql();
  const event = await db
    .prepare(`SELECT starts_at, closes_at FROM reg_events WHERE id = ?1`)
    .bind(id)
    .first<{ starts_at: string; closes_at: string | null }>();
  if (!event) throw new Error('event_not_found');

  if (action === 'hide' || action === 'show') {
    await db
      .prepare(`UPDATE reg_events SET active = ?1, updated_at = datetime('now') WHERE id = ?2`)
      .bind(action === 'show' ? 1 : 0, id)
      .run();
  } else if (action === 'close_now') {
    await db
      .prepare(
        `UPDATE reg_events SET closes_at = ?1,
                opens_at = CASE WHEN opens_at IS NOT NULL AND opens_at > ?1 THEN ?1 ELSE opens_at END,
                updated_at = datetime('now')
         WHERE id = ?2`,
      )
      .bind(now, id)
      .run();
  } else {
    let closesAt = event.closes_at;
    const newClose = opts.closesAt ?? null;
    if ((event.closes_at ?? event.starts_at) <= now) {
      if (newClose === null || newClose <= now) throw new Error('close_required');
      closesAt = newClose;
    } else if (newClose !== null && newClose > now) {
      closesAt = newClose;
    }
    await db
      .prepare(
        `UPDATE reg_events SET opens_at = ?1, closes_at = ?2,
                visible_from = CASE WHEN visible_from IS NOT NULL AND visible_from > ?1 THEN NULL ELSE visible_from END,
                updated_at = datetime('now')
         WHERE id = ?3`,
      )
      .bind(now, closesAt, id)
      .run();
  }
}

/**
 * Duplicate an event for the next edition: the event row (inactive, confirmation
 * counter reset, dates kept), every language's title/description, and the
 * questions with their labels. Registrations, attendees and answers are never
 * copied. Returns the new event id. The copy is two steps (the new id is needed
 * first) so a failure in the second deletes the half-made copy.
 */
export async function cloneEvent(db: AppDb, id: number): Promise<number> {
  const created = await db
    .prepare(
      `INSERT INTO reg_events (starts_at, ends_at, location, capacity, price_cents, currency, opens_at, closes_at,
                               active, visible_from, waitlist_enabled, confirmation_prefix, next_confirmation, poster,
                               max_party_size, allow_self_edit)
       SELECT starts_at, ends_at, location, capacity, price_cents, currency, opens_at, closes_at,
              0, visible_from, waitlist_enabled, confirmation_prefix, 1, poster,
              max_party_size, allow_self_edit
       FROM reg_events WHERE id = ?1
       RETURNING id`,
    )
    .bind(id)
    .first<{ id: number }>();
  if (!created) throw new Error('event_not_found');
  const newId = created.id;

  const { results: questions } = await db
    .prepare(`SELECT id FROM reg_questions WHERE event_id = ?1 ORDER BY sort, id`)
    .bind(id)
    .all<{ id: number }>();
  const stmts: AppStatement[] = [
    // Serializes with any concurrent write to the new (still private) event row.
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(newId),
    db
      .prepare(
        `INSERT INTO reg_event_i18n (event_id, locale, title, description, notes)
         SELECT CAST(?1 AS INTEGER), locale, title, description, notes FROM reg_event_i18n WHERE event_id = ?2`,
      )
      .bind(newId, id),
  ];
  for (const q of questions) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_questions (event_id, sort, type, required, options)
           SELECT CAST(?1 AS INTEGER), sort, type, required, options FROM reg_questions WHERE id = ?2`,
        )
        .bind(newId, q.id),
      db
        .prepare(
          `INSERT INTO reg_question_i18n (question_id, locale, label)
           SELECT (SELECT max(id) FROM reg_questions WHERE event_id = ?1), locale, label
           FROM reg_question_i18n WHERE question_id = ?2`,
        )
        .bind(newId, q.id),
    );
  }
  try {
    await db.batch(stmts);
  } catch (error) {
    await db.prepare(`DELETE FROM reg_events WHERE id = ?1`).bind(newId).run().catch(() => {});
    throw error;
  }
  return newId;
}

export interface RegQuestionSaveInput {
  id?: number;
  sort: number;
  type: RegQuestion['type'];
  required: number;
  options?: string[] | null;
  /** Per-language label. Absent locale = untouched; present + blank = delete that
   *  language's row; the default language's label is required. */
  labels?: Partial<Record<Locale, string>>;
  /** Legacy en/zh labels; folded into `labels` (an explicit `labels` entry wins). */
  label_en?: string;
  label_zh?: string;
}

/**
 * Replace an event's whole question set in one batch. Questions absent from the
 * incoming list are deleted (their reg_answers + i18n cascade away); questions
 * carrying an id are UPDATEd in place, so the answers already collected against
 * them SURVIVE; questions without an id are inserted, their i18n rows referencing
 * the just-inserted id as (SELECT max(id) ... WHERE event_id = ?) - the batch
 * starts by locking the event row, so no other writer can add a question to the
 * same event in between (no sequence function, valid on both backends). Labels
 * follow saveEvent's rules per language: absent = untouched, blank = delete,
 * default language required (throws 'label_required'), unsupported language throws
 * 'locale_unsupported'.
 *
 * Cross-event safety: an incoming `id` that does NOT belong to `eventId` is
 * treated as a NEW question (its id is dropped), never as a survivor. The
 * reg_questions UPDATE is already event-scoped (WHERE id = ? AND event_id = ?), but
 * the reg_question_i18n upsert keys on question_id ALONE - so without this guard a
 * tampered q[i][id] pointing at another event's question would overwrite that
 * event's labels. Scoping to the event's own ids closes that.
 */
export async function saveQuestions(
  db: AppDb,
  eventId: number,
  questions: RegQuestionSaveInput[],
  opts: { defaultLocale?: Locale } = {},
): Promise<void> {
  const defaultLocale = opts.defaultLocale ?? getRuntimeDefaultLocale();
  const labelsOf = (q: RegQuestionSaveInput): Map<Locale, string> => {
    const merged: Partial<Record<Locale, string>> = {};
    if (q.label_en !== undefined) merged.en = q.label_en;
    if (q.label_zh !== undefined) merged.zh = q.label_zh;
    Object.assign(merged, q.labels ?? {});
    const out = new Map<Locale, string>();
    for (const [locale, label] of Object.entries(merged)) {
      if (!isSupportedLocale(locale)) throw new Error('locale_unsupported');
      out.set(locale, (label ?? '').trim());
    }
    if (!out.get(defaultLocale)) throw new Error('label_required');
    return out;
  };
  const prepared = questions.map((q) => ({ q, labels: labelsOf(q) }));

  // Strip any submitted id that this event does not own (treat it as a new
  // question) so a foreign id can never reach the question_id-keyed i18n upsert.
  const { results: owned } = await db.prepare(`SELECT id FROM reg_questions WHERE event_id = ?1`).bind(eventId).all<{ id: number }>();
  const ownedIds = new Set(owned.map((r) => r.id));
  const scoped = prepared.map((p) => (p.q.id != null && !ownedIds.has(p.q.id) ? { ...p, q: { ...p.q, id: undefined } } : p));

  const survivingIds = scoped.filter((p) => p.q.id != null).map((p) => p.q.id as number);
  // Lock the event row first (see above), then prune the removed questions
  // (surviving ids are UPDATEd below, never deleted, so their reg_answers are preserved).
  const stmts: AppStatement[] = [db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(eventId)];
  if (survivingIds.length > 0) {
    const placeholders = survivingIds.map((_, i) => `?${i + 2}`).join(', ');
    stmts.push(
      db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1 AND id NOT IN (${placeholders})`).bind(eventId, ...survivingIds),
    );
  } else {
    stmts.push(db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1`).bind(eventId));
  }

  const labelStatement = (questionId: number, locale: Locale, label: string): AppStatement =>
    label
      ? db
          .prepare(
            `INSERT INTO reg_question_i18n (question_id, locale, label) VALUES (?1, ?2, ?3)
             ON CONFLICT (question_id, locale) DO UPDATE SET label = excluded.label`,
          )
          .bind(questionId, locale, label)
      : db.prepare(`DELETE FROM reg_question_i18n WHERE question_id = ?1 AND locale = ?2`).bind(questionId, locale);

  for (const { q, labels } of scoped) {
    const optionsJson = q.options != null ? JSON.stringify(q.options) : null;
    if (q.id != null) {
      stmts.push(
        db
          .prepare(`UPDATE reg_questions SET sort = ?2, type = ?3, required = ?4, options = ?5 WHERE id = ?1 AND event_id = ?6`)
          .bind(q.id, q.sort, q.type, q.required, optionsJson, eventId),
      );
      for (const [locale, label] of labels) stmts.push(labelStatement(q.id, locale, label));
    } else {
      stmts.push(
        db
          .prepare(`INSERT INTO reg_questions (event_id, sort, type, required, options) VALUES (?1, ?2, ?3, ?4, ?5)`)
          .bind(eventId, q.sort, q.type, q.required, optionsJson),
      );
      for (const [locale, label] of labels) {
        if (label) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_question_i18n (question_id, locale, label)
                 VALUES ((SELECT max(id) FROM reg_questions WHERE event_id = ?1), ?2, ?3)`,
              )
              .bind(eventId, locale, label),
          );
        }
      }
    }
  }
  await db.batch(stmts);
}

interface RosterRow {
  id: number;
  name: string;
  email: string;
  status: string;
  amount_cents: number;
  confirmation_no: string | null;
  party_size: number;
  phone: string | null;
  created_at: string;
}

const ROSTER_SELECT = `SELECT id, name, email, status, amount_cents, confirmation_no, party_size, phone, created_at
       FROM registrations WHERE event_id = ?1
       ORDER BY created_at DESC, id DESC`;

/** The names of the people still on each of an event's registrations (registration id -> names in
 *  form order). Joined in code, not SQL, so the same statement serves D1 and Postgres. */
async function activePeopleByRegistration(db: AppDb, eventId: number): Promise<Map<number, string[]>> {
  const { results } = await db
    .prepare(
      `SELECT a.registration_id AS registration_id, a.name AS name
       FROM reg_attendees a
       JOIN registrations r ON r.id = a.registration_id
       WHERE r.event_id = ?1 AND a.status = 'active'
       ORDER BY a.registration_id, a.sort, a.id`,
    )
    .bind(eventId)
    .all<{ registration_id: number; name: string }>();
  const byReg = new Map<number, string[]>();
  for (const row of results) (byReg.get(row.registration_id) ?? byReg.set(row.registration_id, []).get(row.registration_id)!).push(row.name);
  return byReg;
}

/** The registration roster for an event, newest first (every status, waitlist
 *  included), each row carrying its confirmation number, party size, phone, the
 *  names of its people and its answers as localized { label, value } pairs
 *  (question sort order). */
export async function listRegistrations(
  db: AppDb,
  locale: Locale,
  eventId: number,
): Promise<Array<RosterRow & { people: string[]; answers: Array<{ label: string; value: string }> }>> {
  const { results: regs } = await db.prepare(ROSTER_SELECT).bind(eventId).all<RosterRow>();

  const { select, joins } = i18nJoin('reg_question_i18n', 'q', 'question_id', ['label'], locale);
  const { results: answers } = await db
    .prepare(
      `SELECT a.registration_id AS registration_id, ${select}, a.value AS value
       FROM reg_answers a
       JOIN registrations r ON r.id = a.registration_id
       JOIN reg_questions q ON q.id = a.question_id
       ${joins}
       WHERE r.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{ registration_id: number; label: string | null; value: string }>();

  const byReg = new Map<number, Array<{ label: string; value: string }>>();
  for (const a of answers) {
    const list = byReg.get(a.registration_id) ?? [];
    list.push({ label: a.label ?? '', value: a.value });
    byReg.set(a.registration_id, list);
  }
  const people = await activePeopleByRegistration(db, eventId);
  return regs.map((r) => ({ ...r, people: people.get(r.id) ?? [], answers: byReg.get(r.id) ?? [] }));
}

/**
 * The event roster as RFC4180 CSV: header Confirmation,Name,Email,Status,Party
 * size,Amount,Registered followed by one column per question (localized label,
 * question sort order), rows newest first (every status, waitlist included).
 * People (the names still on the registration, joined with "; ") and Phone follow
 * the question columns, so existing exports keep their column order.
 * Amount is a plain dollars string - cents are integers, so
 * (amount_cents/100).toFixed(2) is exact. Each field goes through the shared
 * csvCell: spreadsheet formula injection is neutralized (a leading = + - @ / tab /
 * CR - reachable via the anonymous /api/register/submit name/email/answer fields -
 * is quote-prefixed) THEN the value is RFC4180-quoted when it contains a comma,
 * quote, CR, or LF, with embedded quotes doubled; rows are CRLF-joined.
 */
export async function registrationsCsv(db: AppDb, locale: Locale, eventId: number): Promise<string> {
  const questions = await listQuestions(db, locale, eventId);
  const { results: regs } = await db.prepare(ROSTER_SELECT).bind(eventId).all<RosterRow>();
  const { results: answers } = await db
    .prepare(
      `SELECT a.registration_id AS registration_id, a.question_id AS question_id, a.value AS value
       FROM reg_answers a
       JOIN registrations r ON r.id = a.registration_id
       WHERE r.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ registration_id: number; question_id: number; value: string }>();

  // Answers keyed by (registration id -> question id) so each lands in its column
  // even when two questions share a label.
  const byReg = new Map<number, Map<number, string>>();
  for (const a of answers) {
    const m = byReg.get(a.registration_id) ?? new Map<number, string>();
    m.set(a.question_id, a.value);
    byReg.set(a.registration_id, m);
  }

  const people = await activePeopleByRegistration(db, eventId);
  const header = ['Confirmation', 'Name', 'Email', 'Status', 'Party size', 'Amount', 'Registered', ...questions.map((q) => q.label), 'People', 'Phone'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of regs) {
    const m = byReg.get(r.id) ?? new Map<number, string>();
    const cells = [
      r.confirmation_no ?? '',
      r.name,
      r.email,
      r.status,
      String(r.party_size),
      (r.amount_cents / 100).toFixed(2),
      r.created_at,
      ...questions.map((q) => m.get(q.id) ?? ''),
      (people.get(r.id) ?? []).join('; '),
      r.phone ?? '',
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
