// Registration back office, data layer: the server-side roster (search, filters, paging, per-status counts),
// the registration drawer (everything about one registration plus its activity history), every staff change
// to a registration (edit, ticket type, add / remove a person, move waitlist <-> confirmed, approval
// decisions, cancel, note), the manual add for walk-ins and phone sign-ups, the duplicates finder and the event
// overview. Runs on D1 and Postgres through the AppDb seam; all shared SQL is dialect-neutral.
//
// Conventions every write follows:
//   * `version` optimistic concurrency: the caller passes the version it read; a stale one answers
//     { ok: false, code: 'version_conflict' } and changes nothing (regAdminCore.guardedWrite).
//   * Soft confirm: anything that can put an event or ticket type over its limit answers
//     { ok: false, code: 'NEEDS_CONFIRM', reason } until the caller resends with confirm: true. The limit is
//     enforced in the guarded SQL as well, so a race cannot slip past the pre-check.
//   * Every write adds a reg_activity row (action + small JSON detail, never a token or link).
//   * Writers return what the messaging layer needs (promoted ids, the decision); they send nothing.
import type { AppDb, AppStatement } from './appDb';
import { type Locale } from './db';
import { getRuntimeDefaultLocale } from './locales';
import {
  activityStatement, claimFailure, demandOf, fitSql, guardedWrite, intLit, likeSql, likeTerm, shortfall,
  type NeedsConfirm, type OpFailure,
} from './regAdminCore';
import {
  decodeChoices, listQuestions, listTicketTypes, newSubmissionKey, promoteWaitlist, readRegistrationInsert,
  registrationInsertStatements, registrationPricing, SEAT_STATUSES, storedAnswerSql, TERMS_ACCEPTED, generateManageToken,
  EMAIL_RE, MAX_EMAIL_LENGTH, CONTROL_RE,
  type RegQuestion, type RegStatus,
} from './regDb';
import { visibleQuestionIds } from './regConditions';
import {
  checkScopeAnswers, clean, nameError, phoneError, registrationSummary, toConditionQuestion, validateSubmission,
  type RegistrationSummary, type SubmissionError, type SubmissionInput,
} from './regManage';

export { type NeedsConfirm, type OpFailure } from './regAdminCore';

const isSeat = (status: string): boolean => (SEAT_STATUSES as readonly string[]).includes(status);
const LIVE = ['pending', 'review', 'confirmed', 'waitlist'] as const;
const ALL_STATUSES: readonly RegStatus[] = ['pending', 'review', 'confirmed', 'waitlist', 'declined', 'cancelled'];
const defaultLocale = (): Locale => getRuntimeDefaultLocale();

interface RegRow {
  id: number;
  event_id: number;
  status: RegStatus;
  version: number;
  party_size: number;
  amount_cents: number;
  currency: string;
  name: string;
  email: string;
  phone: string | null;
  locale: string | null;
  payment_method: string | null;
  refunded_cents: number;
  capacity: number | null;
  requires_approval: number;
  is_template: number;
}
interface AttRow { id: number; sort: number; name: string; ticket_type_id: number | null; person_id: number | null; status: 'active' | 'cancelled' }

async function loadReg(db: AppDb, id: number): Promise<RegRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return db
    .prepare(
      `SELECT r.id AS id, r.event_id AS event_id, r.status AS status, r.version AS version, r.party_size AS party_size,
              r.amount_cents AS amount_cents, r.currency AS currency, r.name AS name, r.email AS email, r.phone AS phone,
              r.locale AS locale, r.payment_method AS payment_method, r.refunded_cents AS refunded_cents,
              e.capacity AS capacity, e.requires_approval AS requires_approval, e.is_template AS is_template
       FROM registrations r JOIN reg_events e ON e.id = r.event_id WHERE r.id = ?1`,
    )
    .bind(id)
    .first<RegRow>();
}

async function loadAttendees(db: AppDb, registrationId: number): Promise<AttRow[]> {
  const { results } = await db
    .prepare(`SELECT id, sort, name, ticket_type_id, person_id, status FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`)
    .bind(registrationId)
    .all<AttRow>();
  return results;
}

const badVersion = (version: unknown): boolean => !Number.isSafeInteger(version) || (version as number) < 1;
const activeOf = (attendees: AttRow[]): AttRow[] => attendees.filter((a) => a.status === 'active');
const closed = (status: RegStatus): boolean => status === 'cancelled' || status === 'declined';

export type OkVersion = { ok: true; version: number };

// ── Drawer data ──────────────────────────────────────────────────────────────

export interface ActivityEntry {
  id: number;
  action: string;
  detail: Record<string, unknown> | null;
  actor_person_id: number | null;
  actor_name: string | null;
  created_at: string;
}

/** A registration's history, newest first. */
export async function listActivity(db: AppDb, registrationId: number, limit = 100): Promise<ActivityEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id AS id, a.action AS action, a.detail_json AS detail_json, a.actor_person_id AS actor_person_id,
              p.display_name AS actor_name, a.created_at AS created_at
       FROM reg_activity a LEFT JOIN people p ON p.id = a.actor_person_id
       WHERE a.registration_id = ?1
       ORDER BY a.id DESC
       LIMIT ${intLit(Math.min(Math.max(1, Math.trunc(limit)), 500))}`,
    )
    .bind(registrationId)
    .all<{ id: number; action: string; detail_json: string | null; actor_person_id: number | null; actor_name: string | null; created_at: string }>();
  return results.map((r) => {
    let detail: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = r.detail_json ? JSON.parse(r.detail_json) : null;
      detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    return { id: r.id, action: r.action, detail, actor_person_id: r.actor_person_id, actor_name: r.actor_name, created_at: r.created_at };
  });
}

export interface RegistrationAdminDetail {
  summary: RegistrationSummary;
  /** Pass back with every change (optimistic concurrency). */
  version: number;
  adminNote: string | null;
  paymentMethod: 'stripe' | 'offline' | 'comp' | null;
  refundedCents: number;
  decidedAt: string | null;
  decidedBy: { personId: number; name: string } | null;
  confirmationSentAt: string | null;
  reminderSentAt: string | null;
  /** Each active person's door state. */
  checkins: Array<{ attendeeId: number; checkedInAt: string; checkedOutAt: string | null }>;
  /** Raw stored answers (option keys, JSON for checkboxes), for the edit form. */
  rawAnswers: Record<number, string>;
  rawAttendeeAnswers: Record<number, Record<number, string>>;
  activity: ActivityEntry[];
}

/** Everything the drawer shows for one registration (null when unknown). */
export async function getRegistrationAdmin(db: AppDb, id: number, locale: Locale): Promise<RegistrationAdminDetail | null> {
  const summary = await registrationSummary(db, id, locale);
  if (!summary) return null;
  const row = await db
    .prepare(
      `SELECT r.version AS version, r.admin_note AS admin_note, r.payment_method AS payment_method, r.refunded_cents AS refunded_cents,
              r.decided_at AS decided_at, r.decided_by AS decided_by, d.display_name AS decided_name,
              r.confirmation_sent_at AS confirmation_sent_at, r.reminder_sent_at AS reminder_sent_at
       FROM registrations r LEFT JOIN people d ON d.id = r.decided_by WHERE r.id = ?1`,
    )
    .bind(id)
    .first<{
      version: number; admin_note: string | null; payment_method: 'stripe' | 'offline' | 'comp' | null; refunded_cents: number;
      decided_at: string | null; decided_by: number | null; decided_name: string | null;
      confirmation_sent_at: string | null; reminder_sent_at: string | null;
    }>();
  if (!row) return null;
  const { results: checkins } = await db
    .prepare(
      `SELECT c.attendee_id AS attendee_id, c.checked_in_at AS checked_in_at, c.checked_out_at AS checked_out_at
       FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id WHERE a.registration_id = ?1 ORDER BY a.sort, a.id`,
    )
    .bind(id)
    .all<{ attendee_id: number; checked_in_at: string; checked_out_at: string | null }>();
  const { results: answers } = await db.prepare(`SELECT question_id, value FROM reg_answers WHERE registration_id = ?1`).bind(id).all<{ question_id: number; value: string }>();
  const { results: personAnswers } = await db
    .prepare(
      `SELECT aa.attendee_id AS attendee_id, aa.question_id AS question_id, aa.value AS value
       FROM reg_attendee_answers aa JOIN reg_attendees a ON a.id = aa.attendee_id WHERE a.registration_id = ?1`,
    )
    .bind(id)
    .all<{ attendee_id: number; question_id: number; value: string }>();
  const rawAttendeeAnswers: Record<number, Record<number, string>> = {};
  for (const a of personAnswers) (rawAttendeeAnswers[a.attendee_id] ??= {})[a.question_id] = a.value;
  return {
    summary,
    version: row.version,
    adminNote: row.admin_note,
    paymentMethod: row.payment_method,
    refundedCents: row.refunded_cents,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by === null ? null : { personId: row.decided_by, name: row.decided_name ?? '' },
    confirmationSentAt: row.confirmation_sent_at,
    reminderSentAt: row.reminder_sent_at,
    checkins: checkins.map((c) => ({ attendeeId: c.attendee_id, checkedInAt: c.checked_in_at, checkedOutAt: c.checked_out_at })),
    rawAnswers: Object.fromEntries(answers.map((a) => [a.question_id, a.value])),
    rawAttendeeAnswers,
    activity: await listActivity(db, id),
  };
}

// ── Roster ───────────────────────────────────────────────────────────────────

export type RosterSort = 'newest' | 'oldest' | 'name' | 'status' | 'confirmation';

export interface RosterOptions {
  /** Matches the registration's name, email, phone and confirmation number and any person's name. */
  q?: string;
  status?: RegStatus | RegStatus[];
  ticketTypeId?: number;
  /** true = at least one person is checked in (view 'person': this person is); false = nobody is. */
  checkedIn?: boolean;
  /** A choice answer: the question's option key (yesno: 'yes' / 'no'). */
  answer?: { questionId: number; option: string };
  sort?: RosterSort;
  /** 1-based. */
  page?: number;
  pageSize?: number;
  /** 'registration' (default): one row per registration. 'person': one row per active person. */
  view?: 'registration' | 'person';
  locale?: Locale;
}

export interface RosterPerson {
  id: number;
  name: string;
  ticketTypeId: number | null;
  ticketLabel: string | null;
  checkedIn: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

export interface RosterRegistration {
  id: number;
  confirmation_no: string | null;
  name: string;
  email: string;
  phone: string | null;
  status: RegStatus;
  party_size: number;
  amount_cents: number;
  currency: string;
  payment_method: 'stripe' | 'offline' | 'comp' | null;
  refunded_cents: number;
  admin_note: string | null;
  created_at: string;
  version: number;
}

export interface RosterRow {
  registration: RosterRegistration;
  /** The active people on the registration (view 'registration'), or just this person (view 'person'). */
  people: RosterPerson[];
}

export interface RosterPage {
  view: 'registration' | 'person';
  rows: RosterRow[];
  /** Rows matching every filter (status included). */
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Rows per registration status under every filter EXCEPT status (the filter chips). */
  counts: Record<RegStatus, number>;
}

export const ROSTER_PAGE_SIZE = 50;

const SORTS: Record<RosterSort, string> = {
  newest: 'r.created_at DESC, r.id DESC',
  oldest: 'r.created_at ASC, r.id ASC',
  name: 'LOWER(r.name) ASC, r.id ASC',
  status: 'r.status ASC, r.created_at DESC, r.id DESC',
  confirmation: 'r.confirmation_no ASC, r.id ASC',
};

/**
 * One page of an event's roster, server side. Filters AND together. Search is case-insensitive LIKE on both
 * backends (see likeTerm for the ASCII caveat on D1). `answer` filters on a select / checkbox / yesno answer
 * of either scope. Counts per status ignore the status filter so every chip shows what it would give.
 */
export async function listRoster(db: AppDb, eventId: number, opts: RosterOptions = {}): Promise<RosterPage> {
  const view = opts.view === 'person' ? 'person' : 'registration';
  const pageSize = Math.min(Math.max(1, Math.trunc(opts.pageSize ?? ROSTER_PAGE_SIZE) || ROSTER_PAGE_SIZE), 200);
  const requested = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const locale = opts.locale ?? defaultLocale();

  const binds: unknown[] = [eventId];
  const bind = (value: unknown): string => {
    binds.push(value);
    return `?${binds.length}`;
  };
  const from = view === 'person'
    ? `FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id`
    : `FROM registrations r`;
  const where: string[] = [`r.event_id = ?1`];
  if (view === 'person') where.push(`a.status = 'active'`);

  const term = (opts.q ?? '').trim();
  if (term !== '') {
    const p = bind(likeTerm(term));
    const personMatch = view === 'person'
      ? likeSql('a.name', p)
      : `EXISTS (SELECT 1 FROM reg_attendees sa WHERE sa.registration_id = r.id AND ${likeSql('sa.name', p)})`;
    where.push(
      `(${likeSql('r.name', p)} OR ${likeSql('r.email', p)} OR ${likeSql(`COALESCE(r.phone, '')`, p)}
        OR ${likeSql(`COALESCE(r.confirmation_no, '')`, p)} OR ${personMatch})`,
    );
  }
  if (opts.ticketTypeId !== undefined) {
    const p = bind(opts.ticketTypeId);
    where.push(view === 'person'
      ? `a.ticket_type_id = CAST(${p} AS INTEGER)`
      : `EXISTS (SELECT 1 FROM reg_attendees ta WHERE ta.registration_id = r.id AND ta.status = 'active' AND ta.ticket_type_id = CAST(${p} AS INTEGER))`);
  }
  if (opts.checkedIn !== undefined) {
    const present = view === 'person'
      ? `EXISTS (SELECT 1 FROM reg_checkins c WHERE c.attendee_id = a.id AND c.checked_out_at IS NULL)`
      : `EXISTS (SELECT 1 FROM reg_attendees ca JOIN reg_checkins c ON c.attendee_id = ca.id
                 WHERE ca.registration_id = r.id AND ca.status = 'active' AND c.checked_out_at IS NULL)`;
    where.push(opts.checkedIn ? present : `NOT ${present}`);
  }
  if (opts.answer) {
    const question = await db
      .prepare(`SELECT type, scope FROM reg_questions WHERE id = ?1 AND event_id = ?2`)
      .bind(opts.answer.questionId, eventId)
      .first<{ type: string; scope: 'registration' | 'attendee' }>();
    if (!question || !['select', 'checkbox', 'yesno'].includes(question.type)) {
      where.push('1 = 0');
    } else {
      const q = bind(opts.answer.questionId);
      const valueOf = (column: string): string => {
        if (question.type === 'checkbox') {
          const pattern = bind(`%${JSON.stringify(opts.answer!.option).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          return `${column} LIKE CAST(${pattern} AS TEXT) ESCAPE '\\'`;
        }
        return `${column} = CAST(${bind(opts.answer!.option)} AS TEXT)`;
      };
      if (question.scope === 'registration') {
        where.push(`EXISTS (SELECT 1 FROM reg_answers ra WHERE ra.registration_id = r.id AND ra.question_id = CAST(${q} AS INTEGER) AND ${valueOf('ra.value')})`);
      } else if (view === 'person') {
        where.push(`EXISTS (SELECT 1 FROM reg_attendee_answers aa WHERE aa.attendee_id = a.id AND aa.question_id = CAST(${q} AS INTEGER) AND ${valueOf('aa.value')})`);
      } else {
        where.push(`EXISTS (SELECT 1 FROM reg_attendees xa JOIN reg_attendee_answers aa ON aa.attendee_id = xa.id
                           WHERE xa.registration_id = r.id AND xa.status = 'active' AND aa.question_id = CAST(${q} AS INTEGER) AND ${valueOf('aa.value')})`);
      }
    }
  }

  const statuses = (Array.isArray(opts.status) ? opts.status : opts.status ? [opts.status] : []).filter((s) => ALL_STATUSES.includes(s));
  const filtered = [...where];
  if (statuses.length > 0) filtered.push(`r.status IN (${statuses.map((s) => `'${s}'`).join(',')})`);

  const countsSql = `SELECT r.status AS status, COUNT(*) AS n ${from} WHERE ${where.join(' AND ')} GROUP BY r.status`;
  const countResult = await db.prepare(countsSql).bind(...binds).all<{ status: RegStatus; n: number }>();
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<RegStatus, number>;
  for (const row of countResult.results) counts[row.status] = Number(row.n);
  const total = statuses.length > 0 ? statuses.reduce((sum, s) => sum + counts[s], 0) : ALL_STATUSES.reduce((sum, s) => sum + counts[s], 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pages);

  const order = SORTS[opts.sort ?? 'newest'] ?? SORTS.newest;
  const orderBy = view === 'person' ? `${order}, a.sort, a.id` : order;
  const columns = view === 'person' ? 'a.id AS attendee_id, ' : '';
  const { results: regs } = await db
    .prepare(
      `SELECT ${columns}r.id AS id, r.confirmation_no AS confirmation_no, r.name AS name, r.email AS email, r.phone AS phone,
              r.status AS status, r.party_size AS party_size, r.amount_cents AS amount_cents, r.currency AS currency,
              r.payment_method AS payment_method, r.refunded_cents AS refunded_cents, r.admin_note AS admin_note,
              r.created_at AS created_at, r.version AS version
       ${from} WHERE ${filtered.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ${intLit(pageSize)} OFFSET ${intLit((page - 1) * pageSize)}`,
    )
    .bind(...binds)
    .all<RosterRegistration & { attendee_id?: number }>();

  const labels = new Map((await listTicketTypes(db, locale, eventId)).map((t) => [t.id, t.label]));
  const ids = [...new Set(regs.map((r) => r.id))];
  const people = new Map<number, RosterPerson[]>();
  if (ids.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT a.id AS id, a.registration_id AS registration_id, a.name AS name, a.ticket_type_id AS ticket_type_id,
                c.checked_in_at AS checked_in_at, c.checked_out_at AS checked_out_at
         FROM reg_attendees a LEFT JOIN reg_checkins c ON c.attendee_id = a.id
         WHERE a.status = 'active' AND a.registration_id IN (${ids.map((id) => intLit(id)).join(',')})
         ORDER BY a.registration_id, a.sort, a.id`,
      )
      .all<{ id: number; registration_id: number; name: string; ticket_type_id: number | null; checked_in_at: string | null; checked_out_at: string | null }>();
    for (const a of results) {
      (people.get(a.registration_id) ?? people.set(a.registration_id, []).get(a.registration_id)!).push({
        id: a.id,
        name: a.name,
        ticketTypeId: a.ticket_type_id,
        ticketLabel: a.ticket_type_id === null ? null : (labels.get(a.ticket_type_id) ?? null),
        checkedIn: a.checked_in_at !== null && a.checked_out_at === null,
        checkedInAt: a.checked_in_at,
        checkedOutAt: a.checked_out_at,
      });
    }
  }
  const rows: RosterRow[] = regs.map((r) => {
    const { attendee_id: attendeeId, ...registration } = r;
    const mine = people.get(r.id) ?? [];
    return { registration, people: view === 'person' ? mine.filter((p) => p.id === attendeeId) : mine };
  });
  return { view, rows, total, page, pageSize, pages, counts };
}

// ── Notes ────────────────────────────────────────────────────────────────────

export const MAX_NOTE_LENGTH = 2000;

/** Set (or clear, with a blank note) the staff-only note. */
export async function adminSetNote(
  db: AppDb,
  registrationId: number,
  input: { version: number; note: string },
  opts: { actor: number | null },
): Promise<OkVersion | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  const note = clean(input.note);
  if (Array.from(note).length > MAX_NOTE_LENGTH || CONTROL_RE.test(note)) return { ok: false, code: 'invalid', errors: [{ path: 'note', code: Array.from(note).length > MAX_NOTE_LENGTH ? 'too_long' : 'invalid' }] };
  const write = await guardedWrite(db, reg, input.version, (held) => [
    db.prepare(`UPDATE registrations SET admin_note = CAST(?2 AS TEXT) WHERE id = ?1 AND ${held}`).bind(registrationId, note === '' ? null : note),
    activityStatement(db, registrationId, opts.actor, 'note', { cleared: note === '' }, held),
  ]);
  return write.claimed ? { ok: true, version: input.version + 1 } : claimFailure(db, registrationId, input.version);
}

// ── Edit contact, people and answers ─────────────────────────────────────────

export interface AdminEditInput {
  version: number;
  contact?: { name?: unknown; email?: unknown; phone?: unknown };
  /** Existing active people by attendee id: a new name and/or the FULL set of that person's answers. */
  attendees?: Array<{ id: number; name?: unknown; answers?: Record<string, string | string[]> }>;
  /** The FULL once-per-registration answer set (replaces the stored answers). */
  answers?: Record<string, string | string[]>;
  /** Staff may leave required answers blank (default true). */
  skipRequired?: boolean;
}

/** Staff edit of a registration's contact (name, email, phone), its people's names and its answers. */
export async function adminUpdateRegistration(
  db: AppDb,
  registrationId: number,
  input: AdminEditInput,
  opts: { actor: number | null },
): Promise<OkVersion | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  const errors: SubmissionError[] = [];

  const sets: Array<[string, unknown]> = [];
  if (input.contact?.name !== undefined) {
    const name = clean(input.contact.name);
    const problem = nameError(name, true);
    if (problem) errors.push({ path: 'contact.name', code: problem });
    else sets.push(['name', name]);
  }
  if (input.contact?.email !== undefined) {
    const email = clean(input.contact.email).toLowerCase();
    if (email === '') errors.push({ path: 'contact.email', code: 'required' });
    else if (email.length > MAX_EMAIL_LENGTH) errors.push({ path: 'contact.email', code: 'too_long' });
    else if (!EMAIL_RE.test(email) || CONTROL_RE.test(email)) errors.push({ path: 'contact.email', code: 'invalid' });
    else sets.push(['email', email]);
  }
  if (input.contact?.phone !== undefined) {
    const phone = clean(input.contact.phone);
    const problem = phoneError(phone);
    if (problem) errors.push({ path: 'contact.phone', code: problem });
    else sets.push(['phone', phone || null]);
  }

  const attendees = await loadAttendees(db, registrationId);
  const known = new Set(activeOf(attendees).map((a) => a.id));
  const edits: Array<{ id: number; index: number; name: string | null; answers: Record<string, string | string[]> | null }> = [];
  (input.attendees ?? []).forEach((attendee, index) => {
    if (!known.has(attendee.id)) {
      errors.push({ path: `attendees.${index}.id`, code: 'not_found' });
      return;
    }
    let name: string | null = null;
    if (attendee.name !== undefined) {
      name = clean(attendee.name);
      const problem = nameError(name, true);
      if (problem) {
        errors.push({ path: `attendees.${index}.name`, code: problem });
        return;
      }
    }
    edits.push({ id: attendee.id, index, name, answers: attendee.answers ?? null });
  });

  let answers: Array<[number, string]> | null = null;
  const personAnswers = new Map<number, Array<[number, string]>>();
  if (input.answers || edits.some((e) => e.answers !== null)) {
    const all = await listQuestions(db, defaultLocale(), reg.event_id);
    const questions = input.skipRequired === false ? all : all.map((q) => ({ ...q, required: 0 }));
    const conditionQuestions = questions.map(toConditionQuestion);
    let registrationForm: Record<string, string | string[]> = input.answers ?? {};
    if (!input.answers) {
      const { results } = await db.prepare(`SELECT question_id, value FROM reg_answers WHERE registration_id = ?1`).bind(registrationId).all<{ question_id: number; value: string }>();
      const types = new Map(questions.map((q) => [q.id, q.type]));
      registrationForm = Object.fromEntries(results.map((r) => [String(r.question_id), types.get(r.question_id) === 'checkbox' ? decodeChoices(r.value) : r.value]));
    }
    if (input.answers) {
      answers = checkScopeAnswers(questions, visibleQuestionIds(conditionQuestions, registrationForm), 'registration', registrationForm, (q) => `q.${q}`, errors);
    }
    for (const edit of edits) {
      if (edit.answers === null) continue;
      personAnswers.set(
        edit.id,
        checkScopeAnswers(questions, visibleQuestionIds(conditionQuestions, registrationForm, edit.answers), 'attendee', edit.answers, (q) => `attendees.${edit.index}.q.${q}`, errors),
      );
    }
  }
  if (errors.length > 0) return { ok: false, code: 'invalid', errors };

  // A re-saved terms answer keeps the time it was first accepted.
  const keepAcceptance = async (pairs: Array<[number, string]>, owner: { table: 'reg_answers' | 'reg_attendee_answers'; id: number }) => {
    if (!pairs.some(([, value]) => value === TERMS_ACCEPTED)) return pairs;
    const { results } = await db
      .prepare(owner.table === 'reg_answers'
        ? `SELECT question_id, value FROM reg_answers WHERE registration_id = ?1`
        : `SELECT question_id, value FROM reg_attendee_answers WHERE attendee_id = ?1`)
      .bind(owner.id)
      .all<{ question_id: number; value: string }>();
    const previous = new Map(results.map((r) => [r.question_id, r.value]));
    return pairs.map(([questionId, value]): [number, string] => [questionId, value === TERMS_ACCEPTED ? (previous.get(questionId) ?? value) : value]);
  };
  if (answers) answers = await keepAcceptance(answers, { table: 'reg_answers', id: registrationId });
  for (const [attendeeId, pairs] of personAnswers) personAnswers.set(attendeeId, await keepAcceptance(pairs, { table: 'reg_attendee_answers', id: attendeeId }));

  const fields = [...sets.map(([column]) => column), ...(edits.some((e) => e.name !== null) ? ['people'] : []), ...(answers || personAnswers.size > 0 ? ['answers'] : [])];
  if (fields.length === 0) return { ok: true, version: input.version };

  const write = await guardedWrite(db, reg, input.version, (held) => {
    const stmts: AppStatement[] = [];
    if (sets.length > 0) {
      stmts.push(
        db
          .prepare(`UPDATE registrations SET ${sets.map(([column], i) => `${column} = CAST(?${i + 2} AS TEXT)`).join(', ')} WHERE id = ?1 AND ${held}`)
          .bind(registrationId, ...sets.map(([, value]) => value)),
      );
    }
    for (const edit of edits) {
      const own = `EXISTS (SELECT 1 FROM reg_attendees ga WHERE ga.id = ?1 AND ga.registration_id = ?2 AND ga.status = 'active') AND ${held}`;
      if (edit.name !== null) {
        stmts.push(db.prepare(`UPDATE reg_attendees SET name = ?3, updated_at = datetime('now') WHERE id = ?1 AND registration_id = ?2 AND status = 'active' AND ${held}`).bind(edit.id, registrationId, edit.name));
      }
      const pairs = personAnswers.get(edit.id);
      if (pairs) {
        stmts.push(db.prepare(`DELETE FROM reg_attendee_answers WHERE attendee_id = ?1 AND ${own}`).bind(edit.id, registrationId));
        for (const [questionId, value] of pairs) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_attendee_answers (attendee_id, question_id, value)
                 SELECT a.id, CAST(?3 AS INTEGER), ${storedAnswerSql('?4')} FROM reg_attendees a
                 WHERE a.id = ?1 AND a.registration_id = ?2 AND a.status = 'active' AND ${held}
                 ON CONFLICT DO NOTHING`,
              )
              .bind(edit.id, registrationId, questionId, value),
          );
        }
      }
    }
    if (answers) {
      stmts.push(db.prepare(`DELETE FROM reg_answers WHERE registration_id = ?1 AND ${held}`).bind(registrationId));
      for (const [questionId, value] of answers) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO reg_answers (registration_id, question_id, value)
               SELECT r.id, CAST(?2 AS INTEGER), ${storedAnswerSql('?3')} FROM registrations r WHERE r.id = ?1 AND ${held}
               ON CONFLICT DO NOTHING`,
            )
            .bind(registrationId, questionId, value),
        );
      }
    }
    stmts.push(activityStatement(db, registrationId, opts.actor, 'edit', { fields }, held));
    return stmts;
  });
  return write.claimed ? { ok: true, version: input.version + 1 } : claimFailure(db, registrationId, input.version);
}

// ── Ticket type, add / remove a person ───────────────────────────────────────

async function activeTicketTypeIds(db: AppDb, eventId: number): Promise<Set<number>> {
  const { results } = await db.prepare(`SELECT id FROM reg_ticket_types WHERE event_id = ?1 AND active = 1`).bind(eventId).all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

/** Move one person to another of the event's active ticket types. The registration's amount is NOT recomputed
 *  (money already collected stays as recorded); a registration awaiting payment cannot change. */
export async function adminChangeTicketType(
  db: AppDb,
  registrationId: number,
  input: { version: number; attendeeId: number; ticketTypeId: number },
  opts: { actor: number | null; confirm?: boolean },
): Promise<OkVersion | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  if (closed(reg.status) || reg.status === 'pending') return { ok: false, code: 'not_editable' };
  const attendee = activeOf(await loadAttendees(db, registrationId)).find((a) => a.id === input.attendeeId);
  if (!attendee) return { ok: false, code: 'not_found' };
  if (!(await activeTicketTypeIds(db, reg.event_id)).has(input.ticketTypeId)) return { ok: false, code: 'ticket_type_invalid' };
  if (attendee.ticket_type_id === input.ticketTypeId) return { ok: true, version: input.version };

  const demand = isSeat(reg.status) ? demandOf(0, [input.ticketTypeId]) : demandOf(0, []);
  if (!opts.confirm) {
    const reason = await shortfall(db, reg.event_id, demand);
    if (reason) return { ok: false, code: 'NEEDS_CONFIRM', reason };
  }
  const write = await guardedWrite(
    db,
    reg,
    input.version,
    (held) => [
      db
        .prepare(`UPDATE reg_attendees SET ticket_type_id = ?3, updated_at = datetime('now') WHERE id = ?1 AND registration_id = ?2 AND status = 'active' AND ${held}`)
        .bind(input.attendeeId, registrationId, input.ticketTypeId),
      activityStatement(db, registrationId, opts.actor, 'ticket_type', { attendeeId: input.attendeeId, from: attendee.ticket_type_id, to: input.ticketTypeId }, held),
    ],
    opts.confirm ? '1 = 1' : fitSql(reg.event_id, demand),
  );
  return write.claimed ? { ok: true, version: input.version + 1 } : claimFailure(db, registrationId, input.version);
}

/** Add a person to a registration (party_size + 1). Refused on a registration that was paid for (use a new
 *  manual registration) or is awaiting payment. */
export async function adminAddPerson(
  db: AppDb,
  registrationId: number,
  input: { version: number; name: string; ticketTypeId?: number | null; personId?: number | null },
  opts: { actor: number | null; confirm?: boolean },
): Promise<(OkVersion & { attendeeId: number | null }) | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  if (closed(reg.status) || reg.status === 'pending') return { ok: false, code: 'not_editable' };
  if (reg.amount_cents > 0) return { ok: false, code: 'paid_registration' };
  const name = clean(input.name);
  const problem = nameError(name, true);
  if (problem) return { ok: false, code: 'invalid', errors: [{ path: 'name', code: problem }] };
  const attendees = await loadAttendees(db, registrationId);
  if (activeOf(attendees).length >= 50) return { ok: false, code: 'party_too_large' };

  const activeTypes = await activeTicketTypeIds(db, reg.event_id);
  const typeId = input.ticketTypeId ?? null;
  if (activeTypes.size > 0 ? typeId === null || !activeTypes.has(typeId) : typeId !== null) return { ok: false, code: 'ticket_type_invalid' };
  let personId = input.personId ?? null;
  if (personId !== null) {
    const exists = await db.prepare(`SELECT 1 AS present FROM people WHERE id = ?1`).bind(personId).first();
    if (!exists) personId = null;
  }

  const demand = isSeat(reg.status) ? demandOf(1, [typeId]) : demandOf(0, []);
  if (!opts.confirm) {
    const reason = await shortfall(db, reg.event_id, demand);
    if (reason) return { ok: false, code: 'NEEDS_CONFIRM', reason };
  }
  const write = await guardedWrite(
    db,
    reg,
    input.version,
    (held) => [
      db
        .prepare(
          `INSERT INTO reg_attendees (campus_id, registration_id, sort, name, person_id, ticket_type_id)
           SELECT r.campus_id, r.id, COALESCE((SELECT MAX(x.sort) FROM reg_attendees x WHERE x.registration_id = r.id), -1) + 1,
                  CAST(?2 AS TEXT), CAST(?3 AS INTEGER), CAST(?4 AS INTEGER)
           FROM registrations r WHERE r.id = ?1 AND ${held}
           RETURNING id`,
        )
        .bind(registrationId, name, personId, typeId),
      db.prepare(`UPDATE registrations SET party_size = party_size + 1 WHERE id = ?1 AND ${held}`).bind(registrationId),
      activityStatement(db, registrationId, opts.actor, 'person_added', { ticketTypeId: typeId }, held),
    ],
    opts.confirm ? '1 = 1' : fitSql(reg.event_id, demand),
  );
  if (!write.claimed) return claimFailure(db, registrationId, input.version);
  const created = write.work[0].results?.[0] as { id: number } | undefined;
  return { ok: true, version: input.version + 1, attendeeId: created?.id ?? null };
}

export interface ReleaseResult { promoted: number[]; registrationCancelled: boolean }

/** Cancel one person (party_size - 1); the last active person cancels the registration. Freed seats go to the
 *  waitlist (promoted ids returned for the caller to email; on an approval event they move to review). */
export async function adminRemovePerson(
  db: AppDb,
  registrationId: number,
  input: { version: number; attendeeId: number },
  opts: { actor: number | null },
): Promise<(OkVersion & ReleaseResult) | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  if (closed(reg.status)) return { ok: false, code: 'not_editable' };
  if (!activeOf(await loadAttendees(db, registrationId)).some((a) => a.id === input.attendeeId)) return { ok: false, code: 'not_found' };

  const activeCount = `(SELECT COUNT(*) FROM reg_attendees ca WHERE ca.registration_id = ?1 AND ca.status = 'active')`;
  const write = await guardedWrite(db, reg, input.version, (held) => [
    db
      .prepare(`UPDATE reg_attendees SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?2 AND registration_id = ?1 AND status = 'active' AND ${held}`)
      .bind(registrationId, input.attendeeId),
    // party_size follows the active count; the last person leaving cancels the registration.
    db
      .prepare(`UPDATE registrations SET party_size = party_size - 1 WHERE id = ?1 AND ${activeCount} >= 1 AND party_size > ${activeCount} AND ${held}`)
      .bind(registrationId),
    db
      .prepare(`UPDATE registrations SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?1 AND ${activeCount} = 0 AND ${held} RETURNING id`)
      .bind(registrationId),
    activityStatement(db, registrationId, opts.actor, 'person_removed', { attendeeId: input.attendeeId }, held),
  ]);
  if (!write.claimed) return claimFailure(db, registrationId, input.version);
  const registrationCancelled = (write.work[2].results?.length ?? 0) > 0;
  const promoted = isSeat(reg.status) ? await promoteWaitlist(db, reg.event_id) : [];
  return { ok: true, version: input.version + 1, registrationCancelled, promoted };
}

/** Cancel a whole registration (and every person on it). Freed seats go to the waitlist. Refunds are separate. */
export async function adminCancelRegistration(
  db: AppDb,
  registrationId: number,
  input: { version?: number },
  opts: { actor: number | null },
): Promise<(OkVersion & ReleaseResult) | OpFailure> {
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  if (reg.status === 'cancelled') return { ok: false, code: 'not_editable' };
  if (input.version !== undefined && badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const expected = input.version ?? reg.version;
  const wasSeat = isSeat(reg.status);
  const write = await guardedWrite(db, reg, expected, (held) => [
    db.prepare(`UPDATE registrations SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?1 AND status != 'cancelled' AND ${held}`).bind(registrationId),
    db
      .prepare(`UPDATE reg_attendees SET status = 'cancelled', updated_at = datetime('now') WHERE registration_id = ?1 AND status = 'active' AND ${held}`)
      .bind(registrationId),
    activityStatement(db, registrationId, opts.actor, 'cancelled', { from: reg.status }, held),
  ]);
  if (!write.claimed) return claimFailure(db, registrationId, expected);
  return { ok: true, version: expected + 1, registrationCancelled: true, promoted: wasSeat ? await promoteWaitlist(db, reg.event_id) : [] };
}

// ── Status moves and approval ────────────────────────────────────────────────

/** Move a free registration between the waitlist and confirmed. Waitlist -> confirmed over a limit needs
 *  confirm; confirmed -> waitlist frees seats for others (the moved registration is not promoted straight back). */
export async function adminMoveStatus(
  db: AppDb,
  registrationId: number,
  input: { version: number; to: 'waitlist' | 'confirmed' },
  opts: { actor: number | null; confirm?: boolean },
): Promise<(OkVersion & { status: RegStatus; promoted: number[] }) | OpFailure> {
  if (badVersion(input.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  const from = reg.status;
  if (!((from === 'waitlist' && input.to === 'confirmed') || (from === 'confirmed' && input.to === 'waitlist'))) return { ok: false, code: 'not_editable' };
  if (reg.amount_cents > 0) return { ok: false, code: 'paid_registration' };

  const entering = input.to === 'confirmed';
  const demand = entering ? demandOf(reg.party_size, activeOf(await loadAttendees(db, registrationId)).map((a) => a.ticket_type_id)) : demandOf(0, []);
  if (entering && !opts.confirm) {
    const reason = await shortfall(db, reg.event_id, demand);
    if (reason) return { ok: false, code: 'NEEDS_CONFIRM', reason };
  }
  const write = await guardedWrite(
    db,
    reg,
    input.version,
    (held) => [
      db.prepare(`UPDATE registrations SET status = ?2 WHERE id = ?1 AND status = ?3 AND ${held}`).bind(registrationId, input.to, from),
      activityStatement(db, registrationId, opts.actor, 'moved', { from, to: input.to }, held),
    ],
    entering && !opts.confirm ? fitSql(reg.event_id, demand) : '1 = 1',
  );
  if (!write.claimed) return claimFailure(db, registrationId, input.version);
  const promoted = entering ? [] : await promoteWaitlist(db, reg.event_id, { exclude: [registrationId] });
  return { ok: true, version: input.version + 1, status: input.to, promoted };
}

export type Decision = 'accept' | 'waitlist' | 'decline';
const DECISION_STATUS: Record<Decision, RegStatus> = { accept: 'confirmed', waitlist: 'waitlist', decline: 'declined' };
const DECISION_ACTION: Record<Decision, string> = { accept: 'accepted', waitlist: 'waitlisted', decline: 'declined' };

export interface DecisionResult {
  ok: true;
  version: number;
  /** What the messaging layer needs: mail `registrationId` the `decision` (rotate the manage link; show the QR only when accepted). */
  decision: Decision;
  registrationId: number;
  status: RegStatus;
  /** Waitlisted registrations moved up by the seats this decision freed (to review on an approval event). */
  promoted: number[];
}

/**
 * Staff decision on a sign-up awaiting approval (or a waitlisted / previously declined one): accept ->
 * confirmed, waitlist -> waitlist, decline -> declined. Stamps decided_at / decided_by, writes the activity
 * row, and frees the seats of a review registration that is waitlisted or declined (promotion follows).
 * Accepting a registration that holds no seat yet (waitlist / declined) over a limit needs confirm.
 */
export async function decideRegistration(
  db: AppDb,
  registrationId: number,
  decision: Decision,
  actor: number | null,
  opts: { version?: number; confirm?: boolean } = {},
): Promise<DecisionResult | OpFailure> {
  const reg = await loadReg(db, registrationId);
  if (!reg || reg.is_template === 1) return { ok: false, code: 'not_found' };
  const target = DECISION_STATUS[decision];
  if (!['review', 'waitlist', 'declined'].includes(reg.status) || reg.status === target) return { ok: false, code: 'not_editable' };
  if (opts.version !== undefined && badVersion(opts.version)) return { ok: false, code: 'invalid', errors: [{ path: 'version', code: 'invalid' }] };
  const expected = opts.version ?? reg.version;
  const takesSeat = target === 'confirmed' && !isSeat(reg.status);
  const demand = takesSeat ? demandOf(reg.party_size, activeOf(await loadAttendees(db, registrationId)).map((a) => a.ticket_type_id)) : demandOf(0, []);
  if (takesSeat && !opts.confirm) {
    const reason = await shortfall(db, reg.event_id, demand);
    if (reason) return { ok: false, code: 'NEEDS_CONFIRM', reason };
  }
  const write = await guardedWrite(
    db,
    reg,
    expected,
    (held) => [
      db
        .prepare(
          `UPDATE registrations SET status = ?2, decided_at = datetime('now'), decided_by = CAST(?3 AS INTEGER)
           WHERE id = ?1 AND status IN ('review','waitlist','declined') AND ${held}`,
        )
        .bind(registrationId, target, actor),
      activityStatement(db, registrationId, actor, DECISION_ACTION[decision], { from: reg.status }, held),
    ],
    takesSeat && !opts.confirm ? fitSql(reg.event_id, demand) : '1 = 1',
  );
  if (!write.claimed) return claimFailure(db, registrationId, expected);
  const freed = isSeat(reg.status) && !isSeat(target);
  const promoted = freed ? await promoteWaitlist(db, reg.event_id, { exclude: [registrationId] }) : [];
  return { ok: true, version: expected + 1, decision, registrationId, status: target, promoted };
}

// ── Manual add ───────────────────────────────────────────────────────────────

export interface ManualRegistrationInput {
  eventId: number;
  contact: SubmissionInput['contact'];
  /** Row 0 is the contact (a blank name means the contact's own name). */
  attendees?: SubmissionInput['attendees'];
  answers?: SubmissionInput['answers'];
  /** A member to link as the registrant. */
  personId?: number | null;
  locale?: string | null;
  /** Required when the party costs money: 'offline' (cash / check, `amountCents` entered) or 'comp' (no charge). */
  paymentMethod?: 'offline' | 'comp';
  /** The amount actually collected for an 'offline' payment (default: the list price). */
  amountCents?: number;
  /** Staff may leave required answers blank (default true). */
  skipRequired?: boolean;
}

export interface ManualRegistrationResult {
  ok: true;
  registrationId: number;
  confirmationNo: string | null;
  status: 'confirmed';
  version: 1;
  /** The plaintext manage-link token (only here; later mail rotates it), for the optional confirmation email. */
  manageToken: string | null;
}

const MAX_AMOUNT_CENTS = 99_999_999;

/**
 * Walk-in / phone registration. Bypasses the registration phase; a party over the event or ticket limits
 * needs confirm. Paid events: payment_method 'offline' (amount entered) or 'comp' (0), never Stripe. The
 * registration is confirmed at once (staff created it), even on an event that requires approval.
 */
export async function adminCreateRegistration(
  db: AppDb,
  input: ManualRegistrationInput,
  opts: { actor: number | null; confirm?: boolean },
): Promise<ManualRegistrationResult | (OpFailure & { errors?: SubmissionError[] })> {
  const event = await db
    .prepare(`SELECT id, price_cents, currency, requires_approval, is_template FROM reg_events WHERE id = ?1`)
    .bind(input.eventId)
    .first<{ id: number; price_cents: number | null; currency: string; requires_approval: number; is_template: number }>();
  if (!event || event.is_template === 1) return { ok: false, code: 'event_not_found' };

  const all = await listQuestions(db, defaultLocale(), input.eventId);
  const questions = input.skipRequired === false ? all : all.map((q) => ({ ...q, required: 0 }));
  const ticketTypes = await listTicketTypes(db, defaultLocale(), input.eventId);
  const checked = validateSubmission({ max_party_size: 20 }, questions, { contact: input.contact, attendees: input.attendees, answers: input.answers }, { ticketTypes });
  if (!checked.ok) return { ok: false, code: 'invalid', errors: checked.errors };
  const value = checked.value;

  // Linked members must exist; anything else is dropped.
  const wanted = [...new Set([input.personId ?? null, ...value.attendees.map((a) => a.personId)].filter((id): id is number => id !== null))];
  const existing = new Set<number>();
  if (wanted.length > 0) {
    const { results } = await db.prepare(`SELECT id FROM people WHERE id IN (${wanted.map((id) => intLit(id)).join(',')})`).all<{ id: number }>();
    for (const r of results) existing.add(r.id);
  }
  const contactPerson = input.personId != null && existing.has(input.personId) ? input.personId : null;

  const listPrice = registrationPricing(event, ticketTypes, value.attendees).amountCents;
  let amountCents = 0;
  let paymentMethod: 'offline' | 'comp' | null = null;
  if (listPrice > 0) {
    if (input.paymentMethod !== 'offline' && input.paymentMethod !== 'comp') return { ok: false, code: 'payment_method_required' };
    paymentMethod = input.paymentMethod;
    if (paymentMethod === 'offline') {
      amountCents = input.amountCents ?? listPrice;
      if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > MAX_AMOUNT_CENTS) return { ok: false, code: 'invalid', errors: [{ path: 'amountCents', code: 'invalid' }] };
      if (amountCents === 0) paymentMethod = 'comp';
    }
  }
  if (amountCents > 0 && event.requires_approval === 1) return { ok: false, code: 'approval_requires_free' };

  const demand = demandOf(value.attendees.length, value.attendees.map((a) => a.ticketTypeId));
  const overCapacity = opts.confirm === true;
  if (!overCapacity) {
    const reason = await shortfall(db, input.eventId, demand);
    if (reason) return { ok: false, code: 'NEEDS_CONFIRM', reason };
  }

  const manage = await generateManageToken();
  const submissionKey = newSubmissionKey();
  const stmts = registrationInsertStatements(db, {
    eventId: input.eventId,
    personId: contactPerson,
    name: value.contact.name,
    email: value.contact.email,
    status: 'confirmed',
    amountCents,
    currency: event.currency,
    submissionKey,
    attendees: value.attendees.map((a, index) => ({
      name: a.name,
      personId: index === 0 ? (a.personId !== null && existing.has(a.personId) ? a.personId : undefined) : (a.personId !== null && existing.has(a.personId) ? a.personId : null),
      ticketTypeId: a.ticketTypeId,
      answers: a.answers,
    })),
    locale: input.locale ?? null,
    phone: value.contact.phone,
    manageTokenHash: manage.hash,
    allowWaitlist: false,
    answers: value.answers,
    staff: { paymentMethod, overCapacity },
  });
  stmts.push(
    db
      .prepare(
        `INSERT INTO reg_activity (campus_id, event_id, registration_id, actor_person_id, action, detail_json)
         SELECT r.campus_id, r.event_id, r.id, CAST(?3 AS INTEGER), 'created', CAST(?4 AS TEXT)
         FROM registrations r WHERE r.event_id = ?1 AND r.submission_key = ?2`,
      )
      .bind(input.eventId, submissionKey, opts.actor, JSON.stringify({ manual: true, paymentMethod, people: value.attendees.length })),
  );
  const results = await db.batch(stmts);
  const created = readRegistrationInsert(results, manage.token);
  if (!created) return { ok: false, code: 'NEEDS_CONFIRM', reason: 'capacity' };
  return { ok: true, registrationId: created.id, confirmationNo: created.confirmationNo, status: 'confirmed', version: 1, manageToken: created.manageToken ?? null };
}

// ── Duplicates ───────────────────────────────────────────────────────────────

export interface DuplicateMember {
  registrationId: number;
  attendeeId: number | null;
  name: string;
  email: string;
  status: RegStatus;
  confirmationNo: string | null;
  createdAt: string;
}

export interface DuplicateGroup {
  /** 'name': active people with the same name; 'email' / 'phone': registrations sharing the contact detail. */
  kind: 'name' | 'email' | 'phone';
  /** The normalized value the members share. */
  key: string;
  members: DuplicateMember[];
}

/** Case, accents and spacing folded: "  José  GARCÍA" and "jose garcia" are the same name. */
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const digitsOnly = (value: string): string => value.replace(/\D+/g, '');

/**
 * Likely double sign-ups of one event: live (not cancelled or declined) registrations whose people share a
 * normalized name, or whose contacts share an email or phone number. Only groups that span two or more
 * registrations are reported. Folded in code, because accent folding is not portable across the backends.
 */
export async function listDuplicates(db: AppDb, eventId: number): Promise<DuplicateGroup[]> {
  const live = `r.status IN (${LIVE.map((s) => `'${s}'`).join(',')})`;
  const { results: regs } = await db
    .prepare(`SELECT r.id AS id, r.name AS name, r.email AS email, r.phone AS phone, r.status AS status, r.confirmation_no AS confirmation_no, r.created_at AS created_at
              FROM registrations r WHERE r.event_id = ?1 AND ${live} ORDER BY r.created_at, r.id`)
    .bind(eventId)
    .all<{ id: number; name: string; email: string; phone: string | null; status: RegStatus; confirmation_no: string | null; created_at: string }>();
  const { results: people } = await db
    .prepare(`SELECT a.id AS id, a.registration_id AS registration_id, a.name AS name
              FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
              WHERE r.event_id = ?1 AND a.status = 'active' AND ${live} ORDER BY a.registration_id, a.sort, a.id`)
    .bind(eventId)
    .all<{ id: number; registration_id: number; name: string }>();
  const byId = new Map(regs.map((r) => [r.id, r]));
  const member = (registrationId: number, attendeeId: number | null, name: string): DuplicateMember => {
    const r = byId.get(registrationId)!;
    return { registrationId, attendeeId, name, email: r.email, status: r.status, confirmationNo: r.confirmation_no, createdAt: r.created_at };
  };
  const groups = new Map<string, DuplicateGroup>();
  const add = (kind: DuplicateGroup['kind'], key: string, m: DuplicateMember) => {
    if (key === '') return;
    const id = `${kind}\u0000${key}`;
    const group = groups.get(id) ?? groups.set(id, { kind, key, members: [] }).get(id)!;
    group.members.push(m);
  };
  for (const p of people) add('name', normalizeName(p.name), member(p.registration_id, p.id, p.name));
  for (const r of regs) {
    add('email', r.email.trim().toLowerCase(), member(r.id, null, r.name));
    const digits = digitsOnly(r.phone ?? '');
    if (digits.length >= 6) add('phone', digits, member(r.id, null, r.name));
  }
  return [...groups.values()]
    .filter((g) => new Set(g.members.map((m) => m.registrationId)).size >= 2)
    .sort((a, b) => b.members.length - a.members.length || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface OverviewTally {
  questionId: number;
  label: string;
  scope: 'registration' | 'attendee';
  type: 'select' | 'checkbox' | 'yesno';
  /** Every option in question order (a yes/no question: 'yes' and 'no'), with how many live registrations / people chose it. */
  options: Array<{ key: string; label: string; count: number }>;
}

export interface EventOverview {
  eventId: number;
  capacity: number | null;
  requiresApproval: boolean;
  /** Registrations and people per status. */
  statuses: Record<RegStatus, { registrations: number; people: number }>;
  /** People holding a seat (pending + review + confirmed). */
  seatsTaken: number;
  /** null = unlimited. */
  seatsLeft: number | null;
  waitlistPeople: number;
  /** People awaiting a decision. */
  reviewPeople: number;
  /** Active people on confirmed registrations, and how many of them are at the door now. */
  expectedPeople: number;
  checkedIn: number;
  /** Active people holding a seat per ticket type ('seats' counts pending, review and confirmed). */
  byType: Array<{ ticketTypeId: number | null; label: string | null; active: boolean; capacity: number | null; seats: number; seatsLeft: number | null; waitlist: number; priceCents: number }>;
  revenue: { currency: string; collectedCents: number; refundedCents: number; netCents: number };
  tallies: OverviewTally[];
}

/** Everything the event page's overview shows, from one batch of reads. */
export async function eventOverview(db: AppDb, eventId: number, locale: Locale = defaultLocale()): Promise<EventOverview | null> {
  const seat = SEAT_STATUSES.map((s) => `'${s}'`).join(',');
  const choice = `('select','checkbox','yesno')`;
  const [event, statusRows, typeRows, doorRows, moneyRows, regAnswerRows, personAnswerRows] = await db.batch([
    db.prepare(`SELECT capacity, currency, requires_approval FROM reg_events WHERE id = ?1 AND is_template = 0`).bind(eventId),
    db.prepare(`SELECT status, COUNT(*) AS registrations, COALESCE(SUM(party_size), 0) AS people FROM registrations WHERE event_id = ?1 GROUP BY status`).bind(eventId),
    db
      .prepare(
        `SELECT a.ticket_type_id AS type_id, r.status AS status, COUNT(*) AS n
         FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND a.status = 'active' AND r.status IN (${seat},'waitlist') GROUP BY a.ticket_type_id, r.status`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id JOIN registrations r ON r.id = a.registration_id
                 WHERE r.event_id = ?1 AND c.checked_out_at IS NULL) AS checked_in,
                (SELECT COUNT(*) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
                 WHERE r.event_id = ?1 AND a.status = 'active' AND r.status = 'confirmed') AS expected`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS collected, COALESCE(SUM(refunded_cents), 0) AS refunded FROM registrations
         WHERE event_id = ?1 AND status IN ('confirmed','cancelled') AND amount_cents > 0 AND COALESCE(payment_method, '') != 'comp'`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT a.question_id AS question_id, a.value AS value, COUNT(*) AS n
         FROM reg_answers a JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND r.status IN (${seat}) AND a.question_id IN (SELECT id FROM reg_questions WHERE event_id = ?1 AND type IN ${choice})
         GROUP BY a.question_id, a.value`,
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT aa.question_id AS question_id, aa.value AS value, COUNT(*) AS n
         FROM reg_attendee_answers aa JOIN reg_attendees a ON a.id = aa.attendee_id JOIN registrations r ON r.id = a.registration_id
         WHERE r.event_id = ?1 AND a.status = 'active' AND r.status IN (${seat})
           AND aa.question_id IN (SELECT id FROM reg_questions WHERE event_id = ?1 AND type IN ${choice})
         GROUP BY aa.question_id, aa.value`,
      )
      .bind(eventId),
  ]);
  const head = event.results[0] as { capacity: number | null; currency: string; requires_approval: number } | undefined;
  if (!head) return null;

  const statuses = Object.fromEntries(ALL_STATUSES.map((s) => [s, { registrations: 0, people: 0 }])) as EventOverview['statuses'];
  for (const r of statusRows.results as Array<{ status: RegStatus; registrations: number; people: number }>) {
    statuses[r.status] = { registrations: Number(r.registrations), people: Number(r.people) };
  }
  const seatsTaken = SEAT_STATUSES.reduce((sum, s) => sum + statuses[s].people, 0);

  const types = await listTicketTypes(db, locale, eventId);
  const seatsByType = new Map<number | null, number>();
  const waitByType = new Map<number | null, number>();
  for (const r of typeRows.results as Array<{ type_id: number | null; status: RegStatus; n: number }>) {
    const into = r.status === 'waitlist' ? waitByType : seatsByType;
    into.set(r.type_id, (into.get(r.type_id) ?? 0) + Number(r.n));
  }
  const byType: EventOverview['byType'] = types.map((t) => {
    const seats = seatsByType.get(t.id) ?? 0;
    return { ticketTypeId: t.id, label: t.label, active: t.active === 1, capacity: t.capacity, seats, seatsLeft: t.capacity === null ? null : Math.max(0, t.capacity - seats), waitlist: waitByType.get(t.id) ?? 0, priceCents: t.price_cents };
  });
  const untyped = { seats: seatsByType.get(null) ?? 0, waitlist: waitByType.get(null) ?? 0 };
  if (untyped.seats > 0 || untyped.waitlist > 0) byType.push({ ticketTypeId: null, label: null, active: true, capacity: null, seats: untyped.seats, seatsLeft: null, waitlist: untyped.waitlist, priceCents: 0 });

  const money = moneyRows.results[0] as { collected: number; refunded: number };
  const collected = Number(money.collected);
  const refunded = Number(money.refunded);

  const questions = (await listQuestions(db, locale, eventId)).filter((q) => q.type === 'select' || q.type === 'checkbox' || q.type === 'yesno');
  const counted = new Map<number, Map<string, number>>();
  const tallyValue = (question: RegQuestion, raw: string, n: number) => {
    const into = counted.get(question.id) ?? counted.set(question.id, new Map()).get(question.id)!;
    const keys = question.type === 'checkbox' ? decodeChoices(raw) : [raw];
    for (const key of keys) into.set(key, (into.get(key) ?? 0) + n);
  };
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const r of [...(regAnswerRows.results as Array<{ question_id: number; value: string; n: number }>), ...(personAnswerRows.results as Array<{ question_id: number; value: string; n: number }>)]) {
    const question = byId.get(r.question_id);
    if (question) tallyValue(question, r.value, Number(r.n));
  }
  const tallies: OverviewTally[] = questions.map((q) => {
    const counts = counted.get(q.id) ?? new Map<string, number>();
    const keys = q.type === 'yesno' ? ['yes', 'no'] : (q.options ?? []);
    const options = keys.map((key) => ({ key, label: q.type === 'yesno' ? key : (q.option_labels[key] ?? key), count: counts.get(key) ?? 0 }));
    for (const [key, count] of counts) if (!keys.includes(key)) options.push({ key, label: q.option_labels[key] ?? key, count });
    return { questionId: q.id, label: q.label, scope: q.scope, type: q.type as OverviewTally['type'], options };
  });

  const door = doorRows.results[0] as { checked_in: number; expected: number };
  return {
    eventId,
    capacity: head.capacity,
    requiresApproval: head.requires_approval === 1,
    statuses,
    seatsTaken,
    seatsLeft: head.capacity === null ? null : Math.max(0, head.capacity - seatsTaken),
    waitlistPeople: statuses.waitlist.people,
    reviewPeople: statuses.review.people,
    expectedPeople: Number(door.expected),
    checkedIn: Number(door.checked_in),
    byType,
    revenue: { currency: head.currency, collectedCents: collected, refundedCents: refunded, netCents: collected - refunded },
    tallies,
  };
}
