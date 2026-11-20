// Registration party flow, data side: validating a whole submission (contact +
// people + answers) into field-path errors, the one summary builder behind the
// manage page, the member's event page and the emails, finding a registration by
// its private manage token or by its signed-in owner, and the self-service edits
// and cancellations (with waitlist promotion on free events).
//
// Runs on D1 and Postgres through the AppDb seam; every shared statement is
// dialect-neutral SQL. The manage token itself is created in regDb.ts
// (generateManageToken); only its SHA-256 is stored.
import type { AppDb, AppStatement } from './appDb';
import { i18nJoin, type Locale } from './db';
import { toUtcSql } from './dates';
import { getRuntimeDefaultLocale } from './locales';
import { getLiveHouseholdForPerson } from './householdDb';
import {
  cancelRegistrationPromoting,
  checkAnswer,
  generateManageToken,
  hashManageToken,
  isManageTokenShape,
  listQuestions,
  promoteWaitlist,
  type RegQuestion,
  type RegStatus,
} from './regDb';
import { eventPhase, type RegPhase } from './regPhase';

// ── Submission validation ────────────────────────────────────────────────────

export const MAX_NAME_LENGTH = 120;
export const MAX_PHONE_LENGTH = 40;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_ANSWER_LENGTH = 2000;
/** The hard ceiling for events.max_party_size (matches the column CHECK). */
export const MAX_PARTY_SIZE_LIMIT = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// Digits, spaces and the punctuation people type in phone numbers, extensions included.
const PHONE_RE = /^[0-9+()\-.\s#*/xX]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

export interface SubmissionError {
  /** `contact.name`, `contact.email`, `contact.phone`, `attendees`, `attendees.<i>.name`, `q.<questionId>` or '' (whole request). */
  path: string;
  code: string;
}

export interface SubmissionInput {
  contact: { name?: unknown; email?: unknown; phone?: unknown };
  /** People covered, in form order. Row 0 is the contact: a blank name there means the contact's own name.
   *  Blank later rows are ignored (extra rows rendered but not filled in). */
  attendees?: Array<{ name?: unknown; personId?: unknown }>;
  /** Raw answer form values keyed by question id (a checkbox arrives as string[]). */
  answers?: Record<string, string | string[]>;
}

export interface ValidSubmission {
  contact: { name: string; email: string; phone: string | null };
  attendees: Array<{ name: string; personId: number | null }>;
  answers: Array<[number, string]>;
}

export type SubmissionResult = { ok: true; value: ValidSubmission } | { ok: false; errors: SubmissionError[] };

const clean = (value: unknown): string => (typeof value === 'string' ? value.normalize('NFC').trim() : '');
const codePoints = (value: string): number => Array.from(value).length;

function nameError(value: string, required: boolean): string | null {
  if (value === '') return required ? 'required' : null;
  if (codePoints(value) > MAX_NAME_LENGTH) return 'too_long';
  if (CONTROL_RE.test(value)) return 'invalid';
  return null;
}

function phoneError(value: string): string | null {
  if (value === '') return null;
  if (value.length > MAX_PHONE_LENGTH) return 'too_long';
  if (!PHONE_RE.test(value) || !/[0-9]/u.test(value)) return 'invalid';
  return null;
}

/**
 * Validate a whole registration submission without writing anything: contact,
 * people and answers, collecting EVERY problem as a field path + code (the review
 * step shows them inline). Names are NFC-normalized and trimmed (<= 120 chars),
 * email is trimmed and lower-cased, phone is optional (<= 40 chars of digits and
 * the usual punctuation), blank extra people are dropped, and the party may not
 * exceed the event's max_party_size ('attendees' / 'too_many'). Questions are
 * asked once per registration; their checks are exactly validateAnswers'.
 * The result's `personId`s are only what the form claimed - a caller that took
 * them from a form must pass them through restrictAttendeePersons.
 */
export function validateSubmission(
  event: { max_party_size: number },
  questions: RegQuestion[],
  input: SubmissionInput,
): SubmissionResult {
  const errors: SubmissionError[] = [];

  const name = clean(input.contact?.name);
  const email = clean(input.contact?.email).toLowerCase();
  const phone = clean(input.contact?.phone);
  const nameProblem = nameError(name, true);
  if (nameProblem) errors.push({ path: 'contact.name', code: nameProblem });
  if (email === '') errors.push({ path: 'contact.email', code: 'required' });
  else if (email.length > MAX_EMAIL_LENGTH) errors.push({ path: 'contact.email', code: 'too_long' });
  else if (!EMAIL_RE.test(email) || CONTROL_RE.test(email)) errors.push({ path: 'contact.email', code: 'invalid' });
  const phoneProblem = phoneError(phone);
  if (phoneProblem) errors.push({ path: 'contact.phone', code: phoneProblem });

  const rows = input.attendees && input.attendees.length > 0 ? input.attendees : [{ name: '' }];
  const attendees: ValidSubmission['attendees'] = [];
  rows.forEach((row, index) => {
    let attendeeName = clean(row?.name);
    if (index === 0 && attendeeName === '') {
      if (nameProblem) return; // the contact's own name is already reported as contact.name
      attendeeName = name;
    }
    if (attendeeName === '') return; // a blank extra row
    const problem = nameError(attendeeName, true);
    if (problem) {
      errors.push({ path: `attendees.${index}.name`, code: problem });
      return;
    }
    const personId = Number.isSafeInteger(row?.personId) && (row.personId as number) > 0 ? (row.personId as number) : null;
    attendees.push({ name: attendeeName, personId });
  });
  const limit = Math.min(Math.max(1, Math.trunc(event.max_party_size) || 1), MAX_PARTY_SIZE_LIMIT);
  if (attendees.length > limit) errors.push({ path: 'attendees', code: 'too_many' });

  const answers: Array<[number, string]> = [];
  const form = input.answers ?? {};
  for (const question of questions) {
    const checked = checkAnswer(question, form[String(question.id)]);
    if ('code' in checked) {
      errors.push({ path: `q.${question.id}`, code: checked.code });
    } else if (checked.value !== null) {
      if (checked.value.length > MAX_ANSWER_LENGTH) errors.push({ path: `q.${question.id}`, code: 'too_long' });
      else answers.push([question.id, checked.value]);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { contact: { name, email, phone: phone || null }, attendees, answers } };
}

/**
 * Keep an attendee's personId only when that person is the signed-in contact or a
 * live member of the contact's household; any other id (a forged form field) is
 * dropped. The contact's own row (index 0) is always linked to the contact.
 */
export async function restrictAttendeePersons(
  db: AppDb,
  contactPersonId: number | null,
  attendees: ValidSubmission['attendees'],
): Promise<ValidSubmission['attendees']> {
  const allowed = new Set<number>();
  if (contactPersonId !== null) {
    allowed.add(contactPersonId);
    const household = await getLiveHouseholdForPerson(db, contactPersonId);
    for (const member of household?.members ?? []) if (member.person_id !== null) allowed.add(member.person_id);
  }
  return attendees.map((attendee, index) => ({
    name: attendee.name,
    personId: index === 0 && contactPersonId !== null
      ? contactPersonId
      : attendee.personId !== null && allowed.has(attendee.personId) ? attendee.personId : null,
  }));
}

// ── Lookup ──────────────────────────────────────────────────────────────────

export interface RegistrationRef {
  id: number;
  event_id: number;
  locale: string | null;
}

/** The registration a manage token belongs to, or null (wrong, garbled, or never
 *  issued). Only the token's SHA-256 is compared, in SQL; a malformed token never
 *  reaches the database. */
export async function findRegistrationByToken(db: AppDb, token: unknown): Promise<RegistrationRef | null> {
  if (!isManageTokenShape(token)) return null;
  const hash = await hashManageToken(token);
  const row = await db
    .prepare(`SELECT id, event_id, locale FROM registrations WHERE manage_token_hash = ?1`)
    .bind(hash)
    .first<RegistrationRef>();
  return row ?? null;
}

/** The registration `id` when it belongs to the signed-in person - the same rule as
 *  listRegistrationsForPerson (person_id, or the account email case-insensitively) -
 *  in any status (a cancelled one stays viewable), else null. */
export async function findRegistrationForPerson(
  db: AppDb,
  id: number,
  personId: number,
  email: string,
): Promise<RegistrationRef | null> {
  const row = await db
    .prepare(
      `SELECT id, event_id, locale FROM registrations
       WHERE id = ?1 AND (person_id = ?2 OR LOWER(email) = LOWER(?3))`,
    )
    .bind(id, personId, email)
    .first<RegistrationRef>();
  return row ?? null;
}

/**
 * Replace a registration's manage token and return the new plaintext (the old link
 * stops working). Only the hash is stored, so a later email cannot repeat the token
 * handed out at creation; a caller that must put a working link in a later email
 * (a paid registration confirmed by webhook, a waitlist promotion) rotates here and
 * sends the new one. Null when the registration does not exist.
 */
export async function issueManageToken(db: AppDb, registrationId: number): Promise<string | null> {
  const { token, hash } = await generateManageToken();
  const result = await db
    .prepare(`UPDATE registrations SET manage_token_hash = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(hash, registrationId)
    .run();
  return result.meta.changes > 0 ? token : null;
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface RegistrationSummary {
  event: {
    id: number;
    title: string;
    starts_at: string;
    ends_at: string | null;
    location: string | null;
    notes: string | null;
    phase: RegPhase;
    price_cents: number | null;
    currency: string;
    max_party_size: number;
    allow_self_edit: number;
  };
  registration: {
    id: number;
    confirmation_no: string | null;
    status: RegStatus;
    name: string;
    email: string;
    phone: string | null;
    locale: string | null;
    party_size: number;
    amount_cents: number;
    currency: string;
    created_at: string;
    cancelled_at: string | null;
  };
  /** Every attendee row in order, cancelled ones included (filter on status). */
  attendees: Array<{ id: number; name: string; status: 'active' | 'cancelled'; person_id: number | null }>;
  /** Answers in question order; `value` is display text (a checkbox's choices joined by ", "). */
  answers: Array<{ question_id: number; label: string; value: string }>;
  /** The registrant may edit contact name, phone, people's names and answers. */
  canEdit: boolean;
  /** The registrant may cancel one person or the whole registration. */
  canCancel: boolean;
}

interface SummaryRow {
  event_id: number;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
  active: number;
  visible_from: string | null;
  opens_at: string | null;
  closes_at: string | null;
  price_cents: number | null;
  event_currency: string;
  max_party_size: number;
  allow_self_edit: number;
  id: number;
  confirmation_no: string | null;
  status: RegStatus;
  name: string;
  email: string;
  phone: string | null;
  locale: string | null;
  party_size: number;
  amount_cents: number;
  currency: string;
  created_at: string;
  cancelled_at: string | null;
}

const CLOSED_STATUSES: RegStatus[] = ['cancelled', 'declined'];

/** What self-service may do right now (the rule the summary flags, and the write
 *  paths enforce): the event phase is open or preview, the event allows
 *  self-service, and the registration is not cancelled/declined. Cancelling also
 *  refuses a 'pending' (paid, awaiting payment) registration, whose Checkout
 *  session may still complete. */
export function selfServiceFlags(
  event: { phase: RegPhase; allow_self_edit: number },
  status: RegStatus,
): { canEdit: boolean; canCancel: boolean } {
  const live = (event.phase === 'open' || event.phase === 'preview') && event.allow_self_edit === 1
    && !CLOSED_STATUSES.includes(status);
  return { canEdit: live, canCancel: live && status !== 'pending' };
}

/**
 * Everything the manage page, the member's event page and the emails show for one
 * registration, in `locale` (requested -> installation default -> en for the
 * event title/notes and question labels). Null when the registration is unknown.
 * `now` (UTC 'YYYY-MM-DD HH:MM:SS') drives the phase and so canEdit/canCancel.
 */
export async function registrationSummary(
  db: AppDb,
  id: number,
  locale: Locale,
  now: string = toUtcSql(),
): Promise<RegistrationSummary | null> {
  const { select, joins } = i18nJoin('reg_event_i18n', 'e', 'event_id', ['title', 'notes'], locale);
  const row = await db
    .prepare(
      `SELECT r.id AS id, r.event_id AS event_id, ${select},
              e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
              e.active AS active, e.visible_from AS visible_from, e.opens_at AS opens_at, e.closes_at AS closes_at,
              e.price_cents AS price_cents, e.currency AS event_currency,
              e.max_party_size AS max_party_size, e.allow_self_edit AS allow_self_edit,
              r.confirmation_no AS confirmation_no, r.status AS status, r.name AS name, r.email AS email,
              r.phone AS phone, r.locale AS locale, r.party_size AS party_size,
              r.amount_cents AS amount_cents, r.currency AS currency,
              r.created_at AS created_at, r.cancelled_at AS cancelled_at
       FROM registrations r
       JOIN reg_events e ON e.id = r.event_id
       ${joins}
       WHERE r.id = ?1`,
    )
    .bind(id)
    .first<SummaryRow>();
  if (!row) return null;

  const { results: attendees } = await db
    .prepare(`SELECT id, name, status, person_id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`)
    .bind(id)
    .all<RegistrationSummary['attendees'][number]>();

  const q = i18nJoin('reg_question_i18n', 'q', 'question_id', ['label'], locale);
  const { results: answerRows } = await db
    .prepare(
      `SELECT a.question_id AS question_id, ${q.select}, a.value AS value, q.type AS type
       FROM reg_answers a
       JOIN reg_questions q ON q.id = a.question_id
       ${q.joins}
       WHERE a.registration_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(id)
    .all<{ question_id: number; label: string | null; value: string; type: string }>();

  const event = {
    id: row.event_id,
    title: row.title ?? '',
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    location: row.location,
    notes: row.notes,
    phase: eventPhase(row, now),
    price_cents: row.price_cents,
    currency: row.event_currency,
    max_party_size: row.max_party_size,
    allow_self_edit: row.allow_self_edit,
  };
  return {
    event,
    registration: {
      id: row.id,
      confirmation_no: row.confirmation_no,
      status: row.status,
      name: row.name,
      email: row.email,
      phone: row.phone,
      locale: row.locale,
      party_size: row.party_size,
      amount_cents: row.amount_cents,
      currency: row.currency,
      created_at: row.created_at,
      cancelled_at: row.cancelled_at,
    },
    attendees,
    answers: answerRows.map((a) => ({
      question_id: a.question_id,
      label: a.label ?? '',
      value: a.type === 'checkbox' ? decodeChoices(a.value) : a.value,
    })),
    ...selfServiceFlags(event, row.status),
  };
}

function decodeChoices(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed.join(', ');
  } catch {
    // fall through: show the stored text
  }
  return raw;
}

// ── Self-service writes ─────────────────────────────────────────────────────

interface SelfRow {
  event_id: number;
  status: RegStatus;
  locale: string | null;
  active: number;
  visible_from: string | null;
  opens_at: string | null;
  closes_at: string | null;
  starts_at: string;
  allow_self_edit: number;
}

async function loadSelfRow(db: AppDb, id: number): Promise<SelfRow | null> {
  return db
    .prepare(
      `SELECT r.event_id AS event_id, r.status AS status, r.locale AS locale,
              e.active AS active, e.visible_from AS visible_from, e.opens_at AS opens_at,
              e.closes_at AS closes_at, e.starts_at AS starts_at, e.allow_self_edit AS allow_self_edit
       FROM registrations r JOIN reg_events e ON e.id = r.event_id WHERE r.id = ?1`,
    )
    .bind(id)
    .first<SelfRow>();
}

const flagsFor = (row: SelfRow, now: string) =>
  selfServiceFlags({ phase: eventPhase(row, now), allow_self_edit: row.allow_self_edit }, row.status);

export interface SelfEditInput {
  name?: string;
  phone?: string | null;
  /** New names for existing people, by attendee id. People cannot be added here. */
  attendees?: Array<{ id: number; name: string }>;
  /** The FULL answer set (validated against every question, replacing the stored answers). */
  answers?: Record<string, string | string[]>;
}

export type SelfEditResult = { ok: true } | { ok: false; errors: SubmissionError[] };

/**
 * A registrant's own edit, re-validated on the server: contact name, phone, the
 * names of people already on the registration, and the answers. Email, party size
 * and status never change here. Refused (`not_found` / `not_allowed`, path '')
 * unless the canEdit rule holds at `now`. One batch.
 */
export async function updateRegistrationSelf(
  db: AppDb,
  id: number,
  input: SelfEditInput,
  now: string = toUtcSql(),
): Promise<SelfEditResult> {
  const row = await loadSelfRow(db, id);
  if (!row) return { ok: false, errors: [{ path: '', code: 'not_found' }] };
  if (!flagsFor(row, now).canEdit) return { ok: false, errors: [{ path: '', code: 'not_allowed' }] };

  const errors: SubmissionError[] = [];
  let name: string | null = null;
  if (input.name !== undefined) {
    name = clean(input.name);
    const problem = nameError(name, true);
    if (problem) errors.push({ path: 'contact.name', code: problem });
  }
  let phone: string | null | undefined;
  if (input.phone !== undefined) {
    const value = clean(input.phone);
    const problem = phoneError(value);
    if (problem) errors.push({ path: 'contact.phone', code: problem });
    phone = value || null;
  }

  const attendeeEdits: Array<{ id: number; name: string }> = [];
  if (input.attendees) {
    const { results } = await db
      .prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 AND status = 'active'`)
      .bind(id)
      .all<{ id: number }>();
    const known = new Set(results.map((a) => a.id));
    input.attendees.forEach((attendee, index) => {
      if (!known.has(attendee.id)) {
        errors.push({ path: `attendees.${index}.id`, code: 'not_found' });
        return;
      }
      const value = clean(attendee.name);
      const problem = nameError(value, true);
      if (problem) errors.push({ path: `attendees.${index}.name`, code: problem });
      else attendeeEdits.push({ id: attendee.id, name: value });
    });
  }

  let answers: Array<[number, string]> | null = null;
  if (input.answers) {
    const questions = await listQuestions(db, (row.locale as Locale | null) ?? getRuntimeDefaultLocale(), row.event_id);
    answers = [];
    for (const question of questions) {
      const checked = checkAnswer(question, input.answers[String(question.id)]);
      if ('code' in checked) errors.push({ path: `q.${question.id}`, code: checked.code });
      else if (checked.value !== null) {
        if (checked.value.length > MAX_ANSWER_LENGTH) errors.push({ path: `q.${question.id}`, code: 'too_long' });
        else answers.push([question.id, checked.value]);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const open = `status NOT IN ('cancelled','declined')`;
  const stmts: AppStatement[] = [];
  if (name !== null) {
    stmts.push(db.prepare(`UPDATE registrations SET name = ?1, updated_at = datetime('now') WHERE id = ?2 AND ${open}`).bind(name, id));
  }
  if (phone !== undefined) {
    stmts.push(db.prepare(`UPDATE registrations SET phone = ?1, updated_at = datetime('now') WHERE id = ?2 AND ${open}`).bind(phone, id));
  }
  for (const edit of attendeeEdits) {
    stmts.push(
      db
        .prepare(
          `UPDATE reg_attendees SET name = ?1, updated_at = datetime('now')
           WHERE id = ?2 AND registration_id = ?3 AND status = 'active'
             AND EXISTS (SELECT 1 FROM registrations r WHERE r.id = ?3 AND r.${open})`,
        )
        .bind(edit.name, edit.id, id),
    );
  }
  if (answers) {
    stmts.push(db.prepare(`DELETE FROM reg_answers WHERE registration_id = ?1 AND EXISTS (SELECT 1 FROM registrations r WHERE r.id = ?1 AND r.${open})`).bind(id));
    for (const [questionId, value] of answers) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_answers (registration_id, question_id, value)
             SELECT r.id, CAST(?2 AS INTEGER), CAST(?3 AS TEXT) FROM registrations r WHERE r.id = ?1 AND r.${open}
             ON CONFLICT DO NOTHING`,
          )
          .bind(id, questionId, value),
      );
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { ok: true };
}

export type SelfCancelResult =
  | { ok: true; registrationCancelled: boolean; promoted: number[] }
  | { ok: false; reason: 'not_found' | 'not_allowed' };

/**
 * Cancel one person from a registration (party_size - 1). Cancelling the last
 * active person cancels the registration. Refused unless canCancel holds at `now`.
 * The event row is locked first, so concurrent cancels on one registration
 * recount correctly. On a free event the freed seats go to the waitlist and the
 * promoted registration ids are returned (for the caller to email).
 */
export async function cancelAttendee(
  db: AppDb,
  registrationId: number,
  attendeeId: number,
  now: string = toUtcSql(),
): Promise<SelfCancelResult> {
  const row = await loadSelfRow(db, registrationId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!flagsFor(row, now).canCancel) return { ok: false, reason: 'not_allowed' };

  // The subqueries stay in WHERE clauses (never in SET): the campus SQL scoper adds its
  // predicate to the first WHERE after SET.
  const activeCount = `(SELECT COUNT(*) FROM reg_attendees a WHERE a.registration_id = ?1 AND a.status = 'active')`;
  const results = await db.batch([
    // Serializes with every other seat-changing batch on this event.
    db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(row.event_id),
    db
      .prepare(
        `UPDATE reg_attendees SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ?1 AND registration_id = ?2 AND status = 'active'
           AND EXISTS (SELECT 1 FROM registrations r WHERE r.id = ?2 AND r.status NOT IN ('cancelled','declined'))`,
      )
      .bind(attendeeId, registrationId),
    // party_size follows the active count (idempotent: it only moves while it is above it)...
    db
      .prepare(
        `UPDATE registrations SET party_size = party_size - 1, updated_at = datetime('now')
         WHERE id = ?1 AND status NOT IN ('cancelled','declined')
           AND ${activeCount} >= 1 AND party_size > ${activeCount}`,
      )
      .bind(registrationId),
    // ...and the last person leaving cancels the registration (party_size stays 1, the column minimum).
    db
      .prepare(
        `UPDATE registrations SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?1 AND status NOT IN ('cancelled','declined') AND ${activeCount} = 0
         RETURNING id`,
      )
      .bind(registrationId),
  ]);
  if (results[1].meta.changes === 0) return { ok: false, reason: 'not_found' };
  return {
    ok: true,
    registrationCancelled: (results[3].results?.length ?? 0) > 0,
    promoted: await promoteWaitlist(db, row.event_id),
  };
}

/**
 * Cancel the whole registration (and every person on it). Refused unless
 * canCancel holds at `now`. On a free event the freed seats go to the waitlist and
 * the promoted registration ids are returned. Paid registrations are NOT
 * refunded here.
 */
export async function cancelRegistrationSelf(
  db: AppDb,
  registrationId: number,
  now: string = toUtcSql(),
): Promise<SelfCancelResult> {
  const row = await loadSelfRow(db, registrationId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!flagsFor(row, now).canCancel) return { ok: false, reason: 'not_allowed' };
  const { cancelled, promoted } = await cancelRegistrationPromoting(db, registrationId);
  return cancelled ? { ok: true, registrationCancelled: true, promoted } : { ok: false, reason: 'not_allowed' };
}
