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
import { fallbackChain, getRuntimeDefaultLocale, isSupportedLocale } from './locales';
import type { DbBackend } from './dbProvider';
import { eventPhase, type RegPhase } from './regPhase';
import { parseCondition, validateConditions, type Condition, type ConditionScope, type DraftConditionQuestion } from './regConditions';

export type { RegPhase } from './regPhase';

export type RegStatus = 'pending' | 'review' | 'confirmed' | 'waitlist' | 'declined' | 'cancelled';

/** Every question type the application accepts (the DB CHECK allows exactly these). */
export const QUESTION_TYPES = ['text', 'textarea', 'select', 'checkbox', 'yesno', 'section', 'number', 'date', 'email', 'phone', 'terms'] as const;
export type RegQuestionType = (typeof QUESTION_TYPES)[number];
export type RegQuestionScope = ConditionScope;

/** A question as the public form and the validators see it (localized). */
export interface RegQuestion {
  id: number;
  sort: number;
  type: RegQuestionType;
  required: number;
  /** The option KEYS (select / checkbox); answers store keys. */
  options: string[] | null;
  /** Localized label (requested -> installation default -> en); the heading text of a section. */
  label: string;
  /** Asked once per registration, or once per person. */
  scope: RegQuestionScope;
  /** Show-if condition (null = always shown). */
  condition: Condition | null;
  /** Maximum answer length for text / textarea (null = the global 2000). */
  max_length: number | null;
  /** The ⓘ help text (the terms text for `terms`), localized; null when none. */
  help: string | null;
  placeholder: string | null;
  /** Option key -> localized label (per key: requested -> default -> en); a key without a label shows as itself. */
  option_labels: Record<string, string>;
}

/** The label to show for an option key. */
export const optionLabel = (question: Pick<RegQuestion, 'option_labels'>, key: string): string => question.option_labels[key] ?? key;

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
const OPEN_WHERE = `e.active = 1 AND e.is_template = 0
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
const VISIBLE_WHERE = `e.active = 1 AND e.is_template = 0 AND (e.visible_from IS NULL OR e.visible_from <= ?1)`;

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
         AND e.is_template = 0
       ORDER BY e.starts_at DESC`,
    )
    .bind(personId, email)
    .all<Omit<MyRegistration, 'event_title'> & { event_title: string | null }>();
  return results.map((r) => ({ ...r, event_title: r.event_title ?? '' }));
}

/** An event's questions in sort order, localized (requested -> default -> en): label, help, placeholder
 *  and per-key option labels; options JSON-decoded to a string[] of keys (null for non-option types or
 *  unparseable) and the condition parsed (null when absent or malformed). */
export async function listQuestions(db: AppDb, locale: Locale, eventId: number): Promise<RegQuestion[]> {
  const { select, joins } = i18nJoin('reg_question_i18n', 'q', 'question_id', ['label', 'help', 'placeholder'], locale);
  const chain = fallbackChain(locale);
  const aliases = ['q_l', 'q_d', 'q_e'].slice(0, chain.length === 1 ? 2 : Math.min(3, chain.length));
  const optionColumns = aliases.map((alias, i) => `${alias}.option_labels AS ol_${i}`).join(', ');
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options,
              q.scope AS scope, q.condition AS condition, q.max_length AS max_length,
              ${select}, ${optionColumns}
       FROM reg_questions q
       ${joins}
       WHERE q.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{
      id: number; sort: number; type: RegQuestionType; required: number; options: string | null; scope: RegQuestionScope;
      condition: string | null; max_length: number | null; label: string | null; help: string | null; placeholder: string | null;
      ol_0: string | null; ol_1: string | null; ol_2?: string | null;
    }>();
  return results.map((r) => {
    const options = parseOptions(r.options);
    // Per key, the first language in the chain that names it wins.
    const option_labels: Record<string, string> = {};
    for (const raw of [r.ol_0, r.ol_1, r.ol_2]) {
      for (const [key, value] of Object.entries(parseLabelMap(raw))) if (!(key in option_labels)) option_labels[key] = value;
    }
    return {
      id: r.id, sort: r.sort, type: r.type, required: r.required, options,
      label: r.label ?? '', scope: r.scope, condition: parseCondition(r.condition), max_length: r.max_length ?? null,
      help: r.help ?? null, placeholder: r.placeholder ?? null, option_labels,
    };
  });
}

/** Decode a reg_question_i18n.option_labels TEXT (a JSON object of strings); anything else is {}. */
function parseLabelMap(raw: string | null | undefined): Record<string, string> {
  if (raw == null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && value !== '') out[key] = value;
    return out;
  } catch {
    return {};
  }
}

/** An event's questions with EVERY language's texts raw (no cross-fallback - the editor prefills each
 *  language, so an absent label is simply missing from `labels`). label_en / label_zh are conveniences
 *  for the two original columns. `option_labels` is language -> (option key -> label). */
export interface RegQuestionAdmin {
  id: number;
  sort: number;
  type: RegQuestionType;
  required: number;
  /** The option keys (select / checkbox). */
  options: string[] | null;
  scope: RegQuestionScope;
  condition: Condition | null;
  max_length: number | null;
  labels: Partial<Record<Locale, string>>;
  help: Partial<Record<Locale, string>>;
  placeholder: Partial<Record<Locale, string>>;
  option_labels: Partial<Record<Locale, Record<string, string>>>;
  label_en: string;
  label_zh: string | null;
}

/** The question set for the admin builder: raw texts in every language, sort order. */
export async function listQuestionsAdmin(db: AppDb, eventId: number): Promise<RegQuestionAdmin[]> {
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options,
              q.scope AS scope, q.condition AS condition, q.max_length AS max_length
       FROM reg_questions q
       WHERE q.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; type: RegQuestionType; required: number; options: string | null; scope: RegQuestionScope; condition: string | null; max_length: number | null }>();
  const { results: textRows } = await db
    .prepare(
      `SELECT l.question_id AS question_id, l.locale AS locale, l.label AS label, l.help AS help,
              l.placeholder AS placeholder, l.option_labels AS option_labels
       FROM reg_question_i18n l JOIN reg_questions q ON q.id = l.question_id
       WHERE q.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ question_id: number; locale: string; label: string; help: string | null; placeholder: string | null; option_labels: string | null }>();
  const byQuestion = new Map<number, { labels: Partial<Record<Locale, string>>; help: Partial<Record<Locale, string>>; placeholder: Partial<Record<Locale, string>>; option_labels: Partial<Record<Locale, Record<string, string>>> }>();
  for (const l of textRows) {
    if (!isSupportedLocale(l.locale)) continue;
    const m = byQuestion.get(l.question_id) ?? { labels: {}, help: {}, placeholder: {}, option_labels: {} };
    m.labels[l.locale] = l.label;
    if (l.help) m.help[l.locale] = l.help;
    if (l.placeholder) m.placeholder[l.locale] = l.placeholder;
    const labels = parseLabelMap(l.option_labels);
    if (Object.keys(labels).length > 0) m.option_labels[l.locale] = labels;
    byQuestion.set(l.question_id, m);
  }
  return results.map((r) => {
    const texts = byQuestion.get(r.id) ?? { labels: {}, help: {}, placeholder: {}, option_labels: {} };
    return {
      id: r.id, sort: r.sort, type: r.type, required: r.required, options: parseOptions(r.options),
      scope: r.scope, condition: parseCondition(r.condition), max_length: r.max_length ?? null,
      labels: texts.labels, help: texts.help, placeholder: texts.placeholder, option_labels: texts.option_labels,
      label_en: texts.labels.en ?? '', label_zh: texts.labels.zh ?? null,
    };
  });
}

// ── Ticket types ─────────────────────────────────────────────────────────────

/** People holding a seat on ticket type `typeRef` (a column reference such as `t.id`): active
 *  attendees of seat-holding registrations. */
export const ticketTakenSql = (typeRef: string): string =>
  `(SELECT COUNT(*) FROM reg_attendees ta JOIN registrations r ON r.id = ta.registration_id
    WHERE ta.ticket_type_id = ${typeRef} AND ta.status = 'active' AND ${HOLDS_SEAT})`;

/** A ticket type as the public form sees it (localized). An event with no ACTIVE ticket type
 *  behaves exactly as before: one implicit type at the event price. */
export interface RegTicketType {
  id: number;
  sort: number;
  price_cents: number;
  /** NULL = unlimited. */
  capacity: number | null;
  active: number;
  label: string;
  description: string | null;
  /** Seats held on this type right now. */
  taken: number;
  /** Seats still free on this type (null = unlimited). */
  seats_left: number | null;
}

/** An event's ticket types in sort order, localized (requested -> default -> en). `activeOnly` hides
 *  deactivated types (what the public form offers). */
export async function listTicketTypes(
  db: AppDb,
  locale: Locale,
  eventId: number,
  opts: { activeOnly?: boolean } = {},
): Promise<RegTicketType[]> {
  const { select, joins } = i18nJoin('reg_ticket_type_i18n', 't', 'ticket_type_id', ['label', 'description'], locale);
  const { results } = await db
    .prepare(
      `SELECT t.id AS id, t.sort AS sort, t.price_cents AS price_cents, t.capacity AS capacity, t.active AS active,
              ${select}, ${ticketTakenSql('t.id')} AS taken
       FROM reg_ticket_types t
       ${joins}
       WHERE t.event_id = ?1${opts.activeOnly ? ' AND t.active = 1' : ''}
       ORDER BY t.sort, t.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; price_cents: number; capacity: number | null; active: number; label: string | null; description: string | null; taken: number }>();
  return results.map((r) => ({
    ...r,
    label: r.label ?? '',
    taken: Number(r.taken),
    seats_left: r.capacity === null ? null : Math.max(0, r.capacity - Number(r.taken)),
  }));
}

/** A ticket type with every language's raw label / description, for the editor. */
export interface RegTicketTypeAdmin {
  id: number;
  sort: number;
  price_cents: number;
  capacity: number | null;
  active: number;
  labels: Partial<Record<Locale, string>>;
  descriptions: Partial<Record<Locale, string>>;
  taken: number;
}

export async function listTicketTypesAdmin(db: AppDb, eventId: number): Promise<RegTicketTypeAdmin[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id AS id, t.sort AS sort, t.price_cents AS price_cents, t.capacity AS capacity, t.active AS active,
              ${ticketTakenSql('t.id')} AS taken
       FROM reg_ticket_types t WHERE t.event_id = ?1 ORDER BY t.sort, t.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; price_cents: number; capacity: number | null; active: number; taken: number }>();
  const { results: texts } = await db
    .prepare(
      `SELECT l.ticket_type_id AS ticket_type_id, l.locale AS locale, l.label AS label, l.description AS description
       FROM reg_ticket_type_i18n l JOIN reg_ticket_types t ON t.id = l.ticket_type_id WHERE t.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ ticket_type_id: number; locale: string; label: string; description: string | null }>();
  const byType = new Map<number, { labels: Partial<Record<Locale, string>>; descriptions: Partial<Record<Locale, string>> }>();
  for (const l of texts) {
    if (!isSupportedLocale(l.locale)) continue;
    const m = byType.get(l.ticket_type_id) ?? { labels: {}, descriptions: {} };
    m.labels[l.locale] = l.label;
    if (l.description) m.descriptions[l.locale] = l.description;
    byType.set(l.ticket_type_id, m);
  }
  return results.map((r) => ({ ...r, taken: Number(r.taken), labels: byType.get(r.id)?.labels ?? {}, descriptions: byType.get(r.id)?.descriptions ?? {} }));
}

/** What a party costs and how it is billed: one line per ticket type used (quantity = people), or a
 *  single implicit line at the event price when the event has no active ticket types. */
export interface RegistrationPricing {
  amountCents: number;
  lines: Array<{ ticketTypeId: number | null; label: string | null; unitAmountCents: number; quantity: number }>;
}

/**
 * The amount rule, in one place: with active ticket types the registration costs the SUM of its people's
 * type prices (the event price is ignored); without them it is the event price times the party. Types
 * are the event's ticket types (any language), attendees carry the chosen type id.
 */
export function registrationPricing(
  event: { price_cents: number | null },
  ticketTypes: ReadonlyArray<Pick<RegTicketType, 'id' | 'active' | 'price_cents' | 'label'>>,
  attendees: ReadonlyArray<{ ticketTypeId?: number | null }>,
): RegistrationPricing {
  const typed = ticketTypes.some((t) => t.active === 1);
  if (!typed) {
    const unit = event.price_cents ?? 0;
    return { amountCents: unit * attendees.length, lines: [{ ticketTypeId: null, label: null, unitAmountCents: unit, quantity: attendees.length }] };
  }
  const counts = new Map<number, number>();
  for (const a of attendees) if (a.ticketTypeId != null) counts.set(a.ticketTypeId, (counts.get(a.ticketTypeId) ?? 0) + 1);
  const lines: RegistrationPricing['lines'] = [];
  let amountCents = 0;
  for (const type of ticketTypes) {
    const quantity = counts.get(type.id);
    if (!quantity) continue;
    lines.push({ ticketTypeId: type.id, label: type.label, unitAmountCents: type.price_cents, quantity });
    amountCents += type.price_cents * quantity;
  }
  return { amountCents, lines };
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

/** Shared value rules (also the contact fields' rules, see regManage.validateSubmission). */
export const MAX_EMAIL_LENGTH = 320;
export const MAX_PHONE_LENGTH = 40;
export const MAX_ANSWER_LENGTH = 2000;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// Digits, spaces and the punctuation people type in phone numbers, extensions included.
export const PHONE_RE = /^[0-9+()\-.\s#*/xX]+$/u;
// eslint-disable-next-line no-control-regex
export const CONTROL_RE = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

/** What a checked `terms` answer holds until a writer stamps the acceptance time (UTC
 *  'YYYY-MM-DD HH:MM:SS') in SQL. A constant keeps validation deterministic, so a retried
 *  submission digests identically; every writer and the self-service edit replace it. */
export const TERMS_ACCEPTED = '@accepted';
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const NUMBER_RE = /^-?\d{1,30}(\.\d{1,15})?$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** SQL that turns a bound answer value into what is stored: the acceptance time for TERMS_ACCEPTED. */
export const storedAnswerSql = (param: string): string =>
  `CASE WHEN CAST(${param} AS TEXT) = '${TERMS_ACCEPTED}' THEN datetime('now') ELSE CAST(${param} AS TEXT) END`;

const codePoints = (value: string): number => Array.from(value).length;

/**
 * Validate a submitted answer form against an event's questions, returning the
 * normalized [questionId, value] pairs ready for createRegistration, or throwing
 * 'missing_required' (a required question left blank) / 'bad_answer' (a value not
 * among a select/checkbox's options, or an unrecognized yes/no). Form keys are
 * the question id as a string; a checkbox arrives as string | string[]. Text and
 * textarea are trimmed; a blank OPTIONAL answer is dropped (no pair emitted).
 * Checkbox values are stored JSON-encoded so the multi-select round-trips.
 * Conditions are NOT evaluated here (validateSubmission does); sections are skipped.
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

export type AnswerErrorCode = 'missing_required' | 'bad_answer' | 'too_long';

/** Check ONE question's raw form value: the normalized value to store (null =
 *  nothing to store), or the error code. Shared by validateAnswers (throws the
 *  first error) and validateSubmission (collects every error). A section never
 *  has an answer. */
export function checkAnswer(
  q: Pick<RegQuestion, 'type' | 'required' | 'options' | 'max_length'>,
  raw: string | string[] | undefined,
): { value: string | null } | { code: AnswerErrorCode } {
  const options = q.options ?? [];
  if (q.type === 'section') return { value: null };

  if (q.type === 'checkbox') {
    const values = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).filter((v) => v !== '');
    if (q.required && values.length === 0) return { code: 'missing_required' };
    for (const v of values) if (!options.includes(v)) return { code: 'bad_answer' };
    return { value: values.length > 0 ? JSON.stringify(values) : null };
  }

  const value = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim();
  if (q.type === 'terms') {
    // Checked = any of the usual "on" values, or an acceptance time already stamped (a re-saved answer).
    const lower = value.toLowerCase();
    if (value === '' || ['no', 'n', 'false', '0', 'off'].includes(lower)) return q.required ? { code: 'missing_required' } : { value: null };
    if (value === TERMS_ACCEPTED || TIMESTAMP_RE.test(value)) return { value };
    return ['yes', 'y', 'true', '1', 'on'].includes(lower) ? { value: TERMS_ACCEPTED } : { code: 'bad_answer' };
  }
  if (value === '') return q.required ? { code: 'missing_required' } : { value: null };
  if (q.type === 'select') return options.includes(value) ? { value } : { code: 'bad_answer' };
  if (q.type === 'yesno') {
    const v = value.toLowerCase();
    if (['yes', 'y', 'true', '1', 'on'].includes(v)) return { value: 'yes' };
    if (['no', 'n', 'false', '0', 'off'].includes(v)) return { value: 'no' };
    return { code: 'bad_answer' };
  }
  if (q.type === 'number') return NUMBER_RE.test(value) ? { value } : { code: 'bad_answer' };
  if (q.type === 'date') {
    const m = DATE_RE.exec(value);
    if (!m) return { code: 'bad_answer' };
    const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const real = probe.getUTCFullYear() === Number(m[1]) && probe.getUTCMonth() === Number(m[2]) - 1 && probe.getUTCDate() === Number(m[3]);
    return real ? { value } : { code: 'bad_answer' };
  }
  if (q.type === 'email') {
    const email = value.toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH) return { code: 'too_long' };
    return EMAIL_RE.test(email) && !CONTROL_RE.test(email) ? { value: email } : { code: 'bad_answer' };
  }
  if (q.type === 'phone') {
    if (value.length > MAX_PHONE_LENGTH) return { code: 'too_long' };
    return PHONE_RE.test(value) && /[0-9]/u.test(value) ? { value } : { code: 'bad_answer' };
  }
  // text / textarea - the trimmed value, non-empty by the guard above.
  if (q.max_length !== null && q.max_length !== undefined && codePoints(value) > q.max_length) return { code: 'too_long' };
  return { value };
}

// ── Registration writer ──────────────────────────────────────────────────────

export interface RegAttendeeInput {
  name: string;
  personId?: number | null;
  /** The ticket type this person holds (events with active ticket types: required, validated in SQL). */
  ticketTypeId?: number | null;
  /** This person's answers to the per-person questions ([questionId, value]); TERMS_ACCEPTED is stamped in SQL. */
  answers?: Array<[number, string]>;
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

  // Ticket types, per distinct type in the party. Hard (nothing is inserted when it fails): every type
  // is an active type of THIS event and the types' prices add up to the registration's amount. Soft
  // (like the event capacity: a free party that does not fit goes to the waitlist, a paid one is
  // refused): each type's limit holds the whole party's people of that type.
  const typeCounts = new Map<number, number>();
  for (const a of attendees) if (a.ticketTypeId != null) typeCounts.set(a.ticketTypeId, (typeCounts.get(a.ticketTypeId) ?? 0) + 1);
  const hasTypes = typeCounts.size > 0;
  const valid: string[] = [];
  const fits: string[] = [];
  const prices: string[] = [];
  for (const [typeId, count] of typeCounts) {
    const ref = `CAST(${bindNext(typeId)} AS INTEGER)`;
    valid.push(`EXISTS (SELECT 1 FROM reg_ticket_types tv WHERE tv.id = ${ref} AND tv.event_id = e.id AND tv.active = 1)`);
    fits.push(
      `COALESCE((SELECT CASE WHEN tt.capacity IS NULL THEN 1
                 WHEN (SELECT COUNT(*) FROM reg_attendees ta JOIN registrations r2 ON r2.id = ta.registration_id
                       WHERE ta.ticket_type_id = tt.id AND ta.status = 'active' AND r2.status IN (${SEAT_STATUS_LIST})) + ${count} <= tt.capacity
                 THEN 1 ELSE 0 END
                FROM reg_ticket_types tt WHERE tt.id = ${ref}), 0) = 1`,
    );
    prices.push(`${count} * COALESCE((SELECT tp.price_cents FROM reg_ticket_types tp WHERE tp.id = ${ref}), 0)`);
  }
  const typesHard = hasTypes ? `${valid.join(' AND ')} AND (${prices.join(' + ')}) = CAST(?6 AS INTEGER)` : '1 = 1';
  const typesFit = hasTypes ? fits.join(' AND ') : '1 = 1';

  // A typed event ignores the event price, so the continuation's "still free" guard is the amount check above.
  let guard = '';
  if (input.guard) {
    const now = bindNext(input.guard.now);
    const currency = bindNext(input.guard.currency);
    guard = ` AND e.active = 1 AND COALESCE(e.closes_at, e.starts_at) > CAST(${now} AS TEXT)
           ${hasTypes ? '' : 'AND COALESCE(e.price_cents, 0) = 0'} AND lower(e.currency) = lower(CAST(${currency} AS TEXT))`;
  }
  const seatsFit = `(e.capacity IS NULL OR h.taken + CAST(?9 AS INTEGER) <= e.capacity) AND ${typesFit}`;

  const stmts: AppStatement[] = [
    db.prepare(EVENT_LOCK_AND_NUMBER_SQL).bind(input.eventId),
    db
      .prepare(
        `INSERT INTO registrations
           (${idColumn}event_id, person_id, name, email, status, amount_cents, currency, submission_key, confirmation_no, party_size,
            locale, phone, manage_token_hash)
         SELECT ${idValue}e.id, CAST(?2 AS INTEGER), CAST(?3 AS TEXT), CAST(?4 AS TEXT),
                CASE WHEN ${seatsFit} THEN CAST(?5 AS TEXT) ELSE 'waitlist' END,
                CAST(?6 AS INTEGER), CAST(?7 AS TEXT), CAST(?8 AS TEXT), ${confirmationNoSql('e')}, CAST(?9 AS INTEGER),
                CAST(?11 AS TEXT), CAST(?12 AS TEXT), CAST(?13 AS TEXT)
         FROM reg_events e
         CROSS JOIN (
           SELECT COALESCE(SUM(r.party_size), 0) AS taken
           FROM registrations r WHERE r.event_id = ?1 AND ${HOLDS_SEAT}
         ) h
         WHERE e.id = ?1 AND e.is_template = 0 AND ${typesHard}
           AND (${seatsFit}
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
          `INSERT INTO reg_attendees (registration_id, sort, name, person_id, ticket_type_id)
           SELECT r.id, CAST(?3 AS INTEGER), CAST(?4 AS TEXT), CAST(?5 AS INTEGER), CAST(?6 AS INTEGER) FROM registrations r
           WHERE r.event_id = ?1 AND r.submission_key = ?2
             AND NOT EXISTS (SELECT 1 FROM reg_attendees a WHERE a.registration_id = r.id AND a.sort = CAST(?3 AS INTEGER))`,
        )
        .bind(input.eventId, input.submissionKey, index, attendee.name, personId, attendee.ticketTypeId ?? null),
    );
  });
  for (const [questionId, value] of input.answers) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_answers (registration_id, question_id, value)
           SELECT r.id, CAST(?3 AS INTEGER), ${storedAnswerSql('?4')} FROM registrations r
           WHERE r.event_id = ?1 AND r.submission_key = ?2
           ON CONFLICT DO NOTHING`,
        )
        .bind(input.eventId, input.submissionKey, questionId, value),
    );
  }
  attendees.forEach((attendee, index) => {
    for (const [questionId, value] of attendee.answers ?? []) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_attendee_answers (attendee_id, question_id, value)
             SELECT a.id, CAST(?4 AS INTEGER), ${storedAnswerSql('?5')}
             FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
             WHERE r.event_id = ?1 AND r.submission_key = ?2 AND a.sort = CAST(?3 AS INTEGER)
             ON CONFLICT DO NOTHING`,
          )
          .bind(input.eventId, input.submissionKey, index, questionId, value),
      );
    }
  });
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
 * Ticket types: an event with ACTIVE ticket types requires every attendee to carry one of
 * them (`ticket_type_required` / `ticket_type_invalid` otherwise), the registration's amount is the
 * sum of their prices (the passed `amountCents` is ignored), and each type's limit is part of the
 * same locked capacity decision (a free party over any limit waitlists whole, a paid one throws
 * 'event_full'). An event without active types rejects a ticketTypeId. A template is never
 * registerable ('event_not_found').
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

  const priced = await priceTicketSelection(db, input.eventId, input.attendees);
  const amountCents = priced ?? input.amountCents;

  const manage = await generateManageToken();
  const stmts = registrationInsertStatements(db, {
    eventId: input.eventId,
    personId: input.personId,
    name: input.name,
    email: input.email,
    status: input.status,
    amountCents,
    currency: input.currency,
    submissionKey,
    partySize: input.partySize,
    attendees: input.attendees,
    locale: input.locale ?? null,
    phone: input.phone ?? null,
    manageTokenHash: manage.hash,
    allowWaitlist: amountCents === 0 && input.allowWaitlist !== false,
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
  // Nothing was inserted: a template, a ticket type deactivated or repriced since the form was read, or a full event.
  const event = await db.prepare(`SELECT is_template FROM reg_events WHERE id = ?1`).bind(input.eventId).first<{ is_template: number }>();
  if (!event || event.is_template === 1) throw new Error('event_not_found');
  if (priced !== null && (await priceTicketSelection(db, input.eventId, input.attendees)) !== amountCents) throw new Error('ticket_type_invalid');
  throw new Error('event_full');
}

/**
 * The ticket rule shared by every writer: with active ticket types each attendee needs one of them
 * and the amount is the sum of their prices (returned); without them no attendee may carry a type
 * (null returned: the caller's amount stands). Throws 'ticket_type_required' / 'ticket_type_invalid'.
 */
export async function priceTicketSelection(
  db: AppDb,
  eventId: number,
  attendees: ReadonlyArray<{ ticketTypeId?: number | null }> | undefined,
): Promise<number | null> {
  const { results } = await db
    .prepare(`SELECT id, price_cents FROM reg_ticket_types WHERE event_id = ?1 AND active = 1
              AND EXISTS (SELECT 1 FROM reg_events e WHERE e.id = ?1 AND e.is_template = 0)`)
    .bind(eventId)
    .all<{ id: number; price_cents: number }>();
  const list = attendees && attendees.length > 0 ? attendees : [{ ticketTypeId: null }];
  if (results.length === 0) {
    if (list.some((a) => a.ticketTypeId != null)) throw new Error('ticket_type_invalid');
    return null;
  }
  const price = new Map(results.map((r) => [r.id, r.price_cents]));
  let total = 0;
  for (const a of list) {
    if (a.ticketTypeId == null) throw new Error('ticket_type_required');
    const unit = price.get(a.ticketTypeId);
    if (unit === undefined) throw new Error('ticket_type_invalid');
    total += unit;
  }
  return total;
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
 * Move waitlisted registrations onto freed seats, FREE registrations only (amount 0: a paid
 * registration never waitlists, and its seat is released by Stripe session expiry instead).
 * "Free" is the registration's own amount, not the event price, so it holds for ticket-typed
 * events too. A party is promoted only when the event capacity AND every ticket type's limit
 * hold its people. Runs after any seat is released. Candidates are read first (oldest first:
 * created_at, id), then ONE batch runs: a row lock on the event (so two
 * concurrent releases serialize and each candidate is promoted once), then one
 * guarded UPDATE per candidate - still waitlisted AND the whole party fits in the
 * seats left. Later statements in the batch see earlier promotions, so a party
 * that does not fit is skipped and a smaller later one may take the seats; a
 * skipped party stays first in line for the next release. Returns the promoted
 * registration ids in promotion order.
 */
export async function promoteWaitlist(db: AppDb, eventId: number): Promise<number[]> {
  const event = await db.prepare(`SELECT id FROM reg_events WHERE id = ?1`).bind(eventId).first<{ id: number }>();
  if (!event) return [];
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
           WHERE id = ?1 AND event_id = ?2 AND status = 'waitlist' AND amount_cents = 0
             AND EXISTS (
               SELECT 1 FROM reg_events e
               WHERE e.id = ?2
                 AND (e.capacity IS NULL
                      OR ${seatsTakenSql('e.id')} + registrations.party_size <= e.capacity)
             )
             AND NOT EXISTS (
               SELECT 1 FROM reg_attendees w
               JOIN reg_ticket_types tt ON tt.id = w.ticket_type_id
               WHERE w.registration_id = registrations.id AND w.status = 'active' AND tt.capacity IS NOT NULL
                 AND (SELECT COUNT(*) FROM reg_attendees ta JOIN registrations r2 ON r2.id = ta.registration_id
                      WHERE ta.ticket_type_id = tt.id AND ta.status = 'active' AND r2.status IN (${SEAT_STATUS_LIST}))
                     + (SELECT COUNT(*) FROM reg_attendees mine
                        WHERE mine.registration_id = registrations.id AND mine.status = 'active' AND mine.ticket_type_id = tt.id)
                     > tt.capacity
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
    .prepare(`${eventSelect(locale)} WHERE e.is_template = 0 ORDER BY e.starts_at DESC, e.id DESC`)
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
  /** 1 = a reusable template: never public, never registerable. */
  is_template: number;
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
         e.is_template AS is_template,
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
  const { results } = await db.prepare(`${ADMIN_EVENT_SELECT} WHERE e.is_template = 0 ORDER BY e.starts_at DESC, e.id DESC`).all<AdminEventRow>();
  return withEventTexts(db, results, now);
}

/** The templates only, newest first, with all-language titles (the admin "Templates" section). */
export async function listTemplatesAdmin(db: AppDb, now: string = toUtcSql()): Promise<RegEventAdmin[]> {
  const { results } = await db.prepare(`${ADMIN_EVENT_SELECT} WHERE e.is_template = 1 ORDER BY e.id DESC`).all<AdminEventRow>();
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
    .prepare(`SELECT starts_at, closes_at, is_template FROM reg_events WHERE id = ?1`)
    .bind(id)
    .first<{ starts_at: string; closes_at: string | null; is_template: number }>();
  if (!event) throw new Error('event_not_found');
  // A template is never opened, shown or closed: it only exists to be copied.
  if (event.is_template === 1) throw new Error('template_not_allowed');

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
 * counter reset, dates kept), every language's title/description/notes, the ticket
 * types (price, limit, labels) and the whole question model (scope, conditions, help,
 * placeholders, option labels). Registrations, attendees and answers are never
 * copied. Returns the new event id. The copy is two steps (the new id is needed
 * first) so a failure in the second deletes the half-made copy. The copy is a regular
 * event even when the source is a template (see createFromTemplate).
 */
export async function cloneEvent(db: AppDb, id: number): Promise<number> {
  return copyEvent(db, id, { template: false });
}

/** Save an event (its questions, ticket types and texts) as a reusable template: an inactive copy that
 *  never appears publicly. Returns the template's event id. */
export async function saveAsTemplate(db: AppDb, id: number): Promise<number> {
  return copyEvent(db, id, { template: true, source: 'event' });
}

/** A new regular (inactive) event from a template. Throws 'template_not_found' for anything else. */
export async function createFromTemplate(db: AppDb, templateId: number): Promise<number> {
  return copyEvent(db, templateId, { template: false, source: 'template' });
}

/** Delete a TEMPLATE (never a regular event). True when one was deleted. */
export async function deleteTemplate(db: AppDb, id: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM reg_events WHERE id = ?1 AND is_template = 1`).bind(id).run();
  return result.meta.changes > 0;
}

async function copyEvent(
  db: AppDb,
  id: number,
  mode: { template: boolean; source?: 'event' | 'template' },
): Promise<number> {
  const source = await db.prepare(`SELECT is_template FROM reg_events WHERE id = ?1`).bind(id).first<{ is_template: number }>();
  if (!source) throw new Error(mode.source === 'template' ? 'template_not_found' : 'event_not_found');
  if (mode.source === 'template' && source.is_template !== 1) throw new Error('template_not_found');
  if (mode.source === 'event' && source.is_template === 1) throw new Error('event_not_found');
  const created = await db
    .prepare(
      `INSERT INTO reg_events (starts_at, ends_at, location, capacity, price_cents, currency, opens_at, closes_at,
                               active, visible_from, waitlist_enabled, confirmation_prefix, next_confirmation, poster,
                               max_party_size, allow_self_edit, is_template)
       SELECT starts_at, ends_at, location, capacity, price_cents, currency, opens_at, closes_at,
              0, visible_from, waitlist_enabled, confirmation_prefix, 1, poster,
              max_party_size, allow_self_edit, CAST(?2 AS INTEGER)
       FROM reg_events WHERE id = ?1
       RETURNING id`,
    )
    .bind(id, mode.template ? 1 : 0)
    .first<{ id: number }>();
  if (!created) throw new Error('event_not_found');
  const newId = created.id;

  const { results: questions } = await db
    .prepare(`SELECT id, condition FROM reg_questions WHERE event_id = ?1 ORDER BY sort, id`)
    .bind(id)
    .all<{ id: number; condition: string | null }>();
  const { results: types } = await db
    .prepare(`SELECT id FROM reg_ticket_types WHERE event_id = ?1 ORDER BY sort, id`)
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
  // Sorts are renumbered 0..n-1 so a condition's target can be found by position in the copy.
  const positionOf = new Map<number, number>();
  questions.forEach((q, position) => positionOf.set(q.id, position));
  questions.forEach((q, position) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_questions (event_id, sort, type, required, options, scope, max_length)
           SELECT CAST(?1 AS INTEGER), CAST(?3 AS INTEGER), type, required, options, scope, max_length FROM reg_questions WHERE id = ?2`,
        )
        .bind(newId, q.id, position),
      db
        .prepare(
          `INSERT INTO reg_question_i18n (question_id, locale, label, help, placeholder, option_labels)
           SELECT (SELECT max(id) FROM reg_questions WHERE event_id = ?1), locale, label, help, placeholder, option_labels
           FROM reg_question_i18n WHERE question_id = ?2`,
        )
        .bind(newId, q.id),
    );
  });
  questions.forEach((q, position) => {
    const condition = parseCondition(q.condition);
    const target = condition ? positionOf.get(condition.q) : undefined;
    if (!condition || target === undefined) return;
    const operand = condition.op === 'eq' || condition.op === 'neq' || condition.op === 'in' ? JSON.stringify(condition.value) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_questions (id, event_id, type, condition)
           SELECT s.id, s.event_id, s.type,
                  '{"q":' || CAST(t.id AS TEXT) || ',"op":' || CAST(?3 AS TEXT) ||
                  CASE WHEN CAST(?4 AS TEXT) IS NULL THEN '' ELSE ',"value":' || CAST(?4 AS TEXT) END || '}'
           FROM reg_questions s
           JOIN reg_questions t ON t.event_id = s.event_id AND t.sort = ?5
           WHERE s.event_id = ?1 AND s.sort = ?2
           ON CONFLICT (id) DO UPDATE SET condition = excluded.condition`,
        )
        .bind(newId, position, JSON.stringify(condition.op), operand, target),
    );
  });
  types.forEach((t, position) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_ticket_types (event_id, sort, price_cents, capacity, active)
           SELECT CAST(?1 AS INTEGER), CAST(?3 AS INTEGER), price_cents, capacity, active FROM reg_ticket_types WHERE id = ?2`,
        )
        .bind(newId, t.id, position),
      db
        .prepare(
          `INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label, description)
           SELECT (SELECT max(id) FROM reg_ticket_types WHERE event_id = ?1), locale, label, description
           FROM reg_ticket_type_i18n WHERE ticket_type_id = ?2`,
        )
        .bind(newId, t.id),
    );
  });
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
  const { results: owned } = await db.prepare(`SELECT id, condition FROM reg_questions WHERE event_id = ?1`).bind(eventId).all<{ id: number; condition: string | null }>();
  const ownedIds = new Set(owned.map((r) => r.id));
  const scoped = prepared.map((p) => (p.q.id != null && !ownedIds.has(p.q.id) ? { ...p, q: { ...p.q, id: undefined } } : p));

  const survivingIds = scoped.filter((p) => p.q.id != null).map((p) => p.q.id as number);
  // A question another surviving question's show-if condition points at cannot be deleted.
  const surviving = new Set(survivingIds);
  for (const row of owned) {
    const target = surviving.has(row.id) ? parseCondition(row.condition)?.q : undefined;
    if (target !== undefined && !surviving.has(target)) throw new Error('question_referenced');
  }
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

// ── Event form builder (questions + ticket types) ────────────────────────────

export interface FormError {
  /** `questions.<i>.<field>` / `tickets.<i>.<field>` (nested: `labels.<locale>`, `options.<j>.key`, `condition.op` ...) or `questions` / `tickets` / ''. */
  path: string;
  code: string;
}

export interface EventFormQuestionInput {
  /** The question's id when it already exists (its answers survive); omit for a new question. */
  id?: number;
  /** A client-chosen handle other questions' conditions may point at (for a question that has no id yet). */
  key?: string;
  type: string;
  scope?: string;
  required?: boolean | number;
  max_length?: number | null;
  /** Per language. A language that is absent is left untouched; a blank label removes that language. */
  labels?: Partial<Record<Locale, string>>;
  help?: Partial<Record<Locale, string | null>>;
  placeholder?: Partial<Record<Locale, string | null>>;
  /** Select / checkbox options in order. `key` is stable; omit it for a new option and one is generated. */
  options?: Array<{ key?: string; labels?: Partial<Record<Locale, string>> }> | null;
  /** `q` = the target's id, or its `key` handle. */
  condition?: { q: number | string; op: string; value?: unknown } | null;
}

export interface EventFormTicketInput {
  id?: number;
  price_cents?: number;
  capacity?: number | null;
  active?: boolean | number;
  labels?: Partial<Record<Locale, string>>;
  descriptions?: Partial<Record<Locale, string | null>>;
}

/** `questions` / `tickets` undefined = leave that part alone; an array replaces it (absent ids are deleted). */
export interface EventFormPayload {
  questions?: EventFormQuestionInput[];
  tickets?: EventFormTicketInput[];
}

export type SaveEventFormResult = { ok: true } | { ok: false; errors: FormError[] };

/** Generated option keys: 'o' + 6 random chars; user-visible keys never matter. */
export const OPTION_KEY_RE = /^[a-z0-9_-]{1,40}$/u;
export const MAX_FORM_QUESTIONS = 200;
export const MAX_QUESTION_OPTIONS = 50;
export const MAX_TICKET_TYPES = 50;
const MAX_LABEL = 500;
const MAX_HELP = 2000;
const MAX_PLACEHOLDER = 200;
const MAX_OPTION_LABEL = 200;
const MAX_PRICE_CENTS = 99_999_999;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function newOptionKey(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const key = 'o' + Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!taken.has(key)) return key;
  }
}

interface QuestionDraft {
  id: number | null;
  key: string | null;
  type: RegQuestionType;
  scope: RegQuestionScope;
  required: number;
  max_length: number | null;
  options: string[] | null;
  /** Locales touched for this question, each with the four text columns to store (null label = delete the row). */
  texts: Map<Locale, { label: string; help: string | null; placeholder: string | null; option_labels: Record<string, string> }>;
  condition: { q: number | string; op: string; value?: unknown } | null;
}

/** Read a `{ locale: text }` map: supported locales only, trimmed, length-checked. */
function readTextMap(
  raw: unknown,
  path: string,
  max: number,
  errors: FormError[],
): Map<Locale, string> {
  const out = new Map<Locale, string>();
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    errors.push({ path, code: 'invalid' });
    return out;
  }
  for (const [locale, value] of Object.entries(raw)) {
    if (!isSupportedLocale(locale)) {
      errors.push({ path: `${path}.${locale}`, code: 'locale_unsupported' });
      continue;
    }
    if (value === null || value === undefined) {
      out.set(locale, '');
      continue;
    }
    if (typeof value !== 'string') {
      errors.push({ path: `${path}.${locale}`, code: 'invalid' });
      continue;
    }
    const text = value.normalize('NFC').trim();
    if (codePoints(text) > max) errors.push({ path: `${path}.${locale}`, code: 'too_long' });
    out.set(locale, text);
  }
  return out;
}

/**
 * Validate and save an event's whole form in one batch: questions (types, scope, required, max length,
 * per-language label / help / placeholder, options with stable keys and per-language labels, show-if
 * conditions) and ticket types (price, limit, active, per-language label / description). Everything is
 * validated first; the problems come back as field paths (`questions.<i>.<field>`, `tickets.<i>.<field>`)
 * with a code and NOTHING is written. The batch locks the event row first, so concurrent saves and
 * registrations serialize; questions and ticket types that carry their id are UPDATEd in place (their
 * answers and attendees survive), absent ones are deleted, new ones inserted - their i18n rows reference
 * the just-inserted id as (SELECT max(id) ... WHERE event_id = ?), valid on both backends under that lock.
 *
 * Rules: the default language's label is required on every question, option and ticket type; a select /
 * checkbox needs 1-50 options; conditions follow regConditions.validateConditions (earlier question, no
 * section / terms target, no per-person target from a registration question, option keys exist); an
 * option key must be new-style ([a-z0-9_-]{1,40}) unless the question already stores it (legacy option
 * strings stay valid); a condition pointing at a deleted question says 'condition_target_deleted'; a ticket
 * type that people already hold cannot be deleted (deactivate it); on D1 a ticket price above 0 is refused
 * ('paid_unavailable', like the event price). `payload` is untrusted JSON.
 */
export async function saveEventForm(
  db: AppDb,
  eventId: number,
  payload: unknown,
  opts: { backend?: DbBackend; defaultLocale?: Locale } = {},
): Promise<SaveEventFormResult> {
  const defaultLocale = opts.defaultLocale ?? getRuntimeDefaultLocale();
  const errors: FormError[] = [];
  const event = await db.prepare(`SELECT id FROM reg_events WHERE id = ?1`).bind(eventId).first<{ id: number }>();
  if (!event) return { ok: false, errors: [{ path: '', code: 'event_not_found' }] };
  if (!isRecord(payload)) return { ok: false, errors: [{ path: '', code: 'invalid' }] };

  // ── Questions
  let drafts: QuestionDraft[] | null = null;
  const ownedQuestions = new Map<number, string[] | null>();
  {
    const { results } = await db.prepare(`SELECT id, options FROM reg_questions WHERE event_id = ?1`).bind(eventId).all<{ id: number; options: string | null }>();
    for (const row of results) ownedQuestions.set(row.id, parseOptions(row.options));
  }
  if (payload.questions !== undefined) {
    if (!Array.isArray(payload.questions)) return { ok: false, errors: [{ path: 'questions', code: 'invalid' }] };
    if (payload.questions.length > MAX_FORM_QUESTIONS) return { ok: false, errors: [{ path: 'questions', code: 'too_many' }] };
    drafts = [];
    const seenIds = new Set<number>();
    const seenKeys = new Set<string>();
    payload.questions.forEach((raw, i) => {
      const at = (field: string) => `questions.${i}${field ? `.${field}` : ''}`;
      if (!isRecord(raw)) {
        errors.push({ path: at(''), code: 'invalid' });
        drafts!.push(emptyDraft());
        return;
      }
      const draft = emptyDraft();
      // A foreign or unknown id is a NEW question: it can never reach another event's rows.
      if (raw.id !== undefined && raw.id !== null) {
        if (!Number.isSafeInteger(raw.id)) errors.push({ path: at('id'), code: 'invalid' });
        else if (seenIds.has(raw.id as number)) errors.push({ path: at('id'), code: 'duplicate' });
        else if (ownedQuestions.has(raw.id as number)) {
          draft.id = raw.id as number;
          seenIds.add(draft.id);
        }
      }
      if (raw.key !== undefined && raw.key !== null) {
        if (typeof raw.key !== 'string' || raw.key === '' || raw.key.length > 64) errors.push({ path: at('key'), code: 'invalid' });
        else if (seenKeys.has(raw.key)) errors.push({ path: at('key'), code: 'duplicate' });
        else {
          draft.key = raw.key;
          seenKeys.add(raw.key);
        }
      }
      if (!(QUESTION_TYPES as readonly string[]).includes(raw.type as string)) errors.push({ path: at('type'), code: 'unknown_type' });
      else draft.type = raw.type as RegQuestionType;
      const scope = raw.scope === undefined || raw.scope === null ? 'registration' : raw.scope;
      if (scope !== 'registration' && scope !== 'attendee') errors.push({ path: at('scope'), code: 'invalid' });
      else draft.scope = scope;
      draft.required = draft.type === 'section' ? 0 : raw.required === true || raw.required === 1 ? 1 : 0;

      if (raw.max_length !== undefined && raw.max_length !== null && (draft.type === 'text' || draft.type === 'textarea')) {
        const n = raw.max_length;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5000) errors.push({ path: at('max_length'), code: 'invalid' });
        else draft.max_length = n;
      }

      // Texts: label / help / placeholder per language.
      const labels = readTextMap(raw.labels, at('labels'), MAX_LABEL, errors);
      const help = readTextMap(raw.help, at('help'), MAX_HELP, errors);
      const placeholder = readTextMap(raw.placeholder, at('placeholder'), MAX_PLACEHOLDER, errors);
      if (!labels.get(defaultLocale)) errors.push({ path: at(`labels.${defaultLocale}`), code: 'required' });

      // Options with stable keys; each carries its own per-language labels.
      const optionLabels = new Map<Locale, Record<string, string>>();
      if (draft.type === 'select' || draft.type === 'checkbox') {
        const rawOptions = raw.options;
        if (!Array.isArray(rawOptions) || rawOptions.length === 0) errors.push({ path: at('options'), code: 'required' });
        else if (rawOptions.length > MAX_QUESTION_OPTIONS) errors.push({ path: at('options'), code: 'too_many' });
        else {
          const existingKeys = new Set(draft.id !== null ? (ownedQuestions.get(draft.id) ?? []) : []);
          const keys: string[] = [];
          const used = new Set<string>();
          rawOptions.forEach((opt, j) => {
            const optAt = (field: string) => at(`options.${j}${field ? `.${field}` : ''}`);
            if (!isRecord(opt)) {
              errors.push({ path: optAt(''), code: 'invalid' });
              return;
            }
            let key: string;
            if (opt.key !== undefined && opt.key !== null && opt.key !== '') {
              if (typeof opt.key !== 'string' || opt.key.length > 200 || (!OPTION_KEY_RE.test(opt.key) && !existingKeys.has(opt.key))) {
                errors.push({ path: optAt('key'), code: 'invalid' });
                return;
              }
              key = opt.key;
            } else {
              key = newOptionKey(used);
            }
            if (used.has(key)) {
              errors.push({ path: optAt('key'), code: 'duplicate' });
              return;
            }
            used.add(key);
            keys.push(key);
            const texts = readTextMap(opt.labels, optAt('labels'), MAX_OPTION_LABEL, errors);
            if (!texts.get(defaultLocale)) errors.push({ path: optAt(`labels.${defaultLocale}`), code: 'required' });
            for (const [locale, text] of texts) {
              if (text === '') continue;
              const map = optionLabels.get(locale) ?? {};
              map[key] = text;
              optionLabels.set(locale, map);
            }
          });
          draft.options = keys;
        }
      }

      // One row per touched language: its label is the row's anchor (a blank label deletes the row).
      const touched = new Set<Locale>([...labels.keys(), ...help.keys(), ...placeholder.keys(), ...optionLabels.keys()]);
      for (const locale of touched) {
        const label = labels.get(locale) ?? '';
        if (label === '' && labels.has(locale) === false && (help.get(locale) || placeholder.get(locale) || optionLabels.has(locale))) {
          errors.push({ path: at(`labels.${locale}`), code: 'required' });
        }
        draft.texts.set(locale, {
          label,
          help: help.get(locale) || null,
          placeholder: placeholder.get(locale) || null,
          option_labels: optionLabels.get(locale) ?? {},
        });
      }

      if (raw.condition !== undefined && raw.condition !== null) {
        const c = raw.condition;
        if (!isRecord(c) || (typeof c.q !== 'number' && typeof c.q !== 'string') || typeof c.op !== 'string') {
          errors.push({ path: at('condition'), code: 'invalid' });
        } else draft.condition = { q: c.q as number | string, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) };
      }
      drafts!.push(draft);
    });

    // Conditions: resolve each target (id or key) to a draft index, then run the shared validator.
    const indexById = new Map<number, number>();
    const indexByKey = new Map<string, number>();
    drafts.forEach((d, i) => {
      if (d.id !== null) indexById.set(d.id, i);
      if (d.key !== null) indexByKey.set(d.key, i);
    });
    const resolved: DraftConditionQuestion[] = drafts.map((d, i) => {
      let condition: DraftConditionQuestion['condition'] = null;
      if (d.condition) {
        const target = typeof d.condition.q === 'number' ? indexById.get(d.condition.q) : indexByKey.get(d.condition.q);
        if (target === undefined) {
          const deleted = typeof d.condition.q === 'number' && ownedQuestions.has(d.condition.q);
          errors.push({ path: `questions.${i}.condition.q`, code: deleted ? 'condition_target_deleted' : 'condition_target_unknown' });
        } else condition = { target, op: d.condition.op, ...(d.condition.value !== undefined ? { value: d.condition.value } : {}) };
      }
      return { type: d.type, scope: d.scope, options: d.options, condition };
    });
    for (const e of validateConditions(resolved)) {
      const field = e.code === 'condition_op_invalid' ? 'condition.op' : e.code === 'condition_value_invalid' ? 'condition.value' : 'condition.q';
      errors.push({ path: `questions.${e.index}.${field}`, code: e.code });
    }
  }

  // ── Ticket types
  interface TicketDraft {
    id: number | null;
    price_cents: number;
    capacity: number | null;
    active: number;
    texts: Map<Locale, { label: string; description: string | null }>;
  }
  let tickets: TicketDraft[] | null = null;
  if (payload.tickets !== undefined) {
    if (!Array.isArray(payload.tickets)) return { ok: false, errors: [{ path: 'tickets', code: 'invalid' }] };
    if (payload.tickets.length > MAX_TICKET_TYPES) return { ok: false, errors: [{ path: 'tickets', code: 'too_many' }] };
    const { results } = await db.prepare(`SELECT id FROM reg_ticket_types WHERE event_id = ?1`).bind(eventId).all<{ id: number }>();
    const owned = new Set(results.map((r) => r.id));
    const seen = new Set<number>();
    tickets = [];
    payload.tickets.forEach((raw, i) => {
      const at = (field: string) => `tickets.${i}${field ? `.${field}` : ''}`;
      const draft: TicketDraft = { id: null, price_cents: 0, capacity: null, active: 1, texts: new Map() };
      tickets!.push(draft);
      if (!isRecord(raw)) {
        errors.push({ path: at(''), code: 'invalid' });
        return;
      }
      if (raw.id !== undefined && raw.id !== null) {
        if (!Number.isSafeInteger(raw.id)) errors.push({ path: at('id'), code: 'invalid' });
        else if (seen.has(raw.id as number)) errors.push({ path: at('id'), code: 'duplicate' });
        else if (owned.has(raw.id as number)) {
          draft.id = raw.id as number;
          seen.add(draft.id);
        }
      }
      const price = raw.price_cents === undefined || raw.price_cents === null ? 0 : raw.price_cents;
      if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > MAX_PRICE_CENTS) errors.push({ path: at('price_cents'), code: 'invalid' });
      else if (price > 0 && opts.backend === 'd1') errors.push({ path: at('price_cents'), code: 'paid_unavailable' });
      else draft.price_cents = price;
      if (raw.capacity !== undefined && raw.capacity !== null) {
        const c = raw.capacity;
        if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 1_000_000) errors.push({ path: at('capacity'), code: 'invalid' });
        else draft.capacity = c;
      }
      draft.active = raw.active === false || raw.active === 0 ? 0 : 1;
      const labels = readTextMap(raw.labels, at('labels'), MAX_LABEL, errors);
      const descriptions = readTextMap(raw.descriptions, at('descriptions'), 500, errors);
      if (!labels.get(defaultLocale)) errors.push({ path: at(`labels.${defaultLocale}`), code: 'required' });
      for (const locale of new Set<Locale>([...labels.keys(), ...descriptions.keys()])) {
        const label = labels.get(locale) ?? '';
        if (!labels.has(locale) && descriptions.get(locale)) errors.push({ path: at(`labels.${locale}`), code: 'required' });
        draft.texts.set(locale, { label, description: descriptions.get(locale) || null });
      }
    });
    // A type people already hold cannot disappear (deactivate it instead).
    const dropped = [...owned].filter((id) => !seen.has(id));
    if (dropped.length > 0) {
      const holders = await db
        .prepare(`SELECT DISTINCT ticket_type_id AS id FROM reg_attendees WHERE ticket_type_id IN (${dropped.map((_, k) => `?${k + 1}`).join(', ')})`)
        .bind(...dropped)
        .all<{ id: number }>();
      if (holders.results.length > 0) errors.push({ path: 'tickets', code: 'delete_in_use' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // ── Write: one batch, event row locked first.
  const stmts: AppStatement[] = [db.prepare(`UPDATE reg_events SET updated_at = updated_at WHERE id = ?1`).bind(eventId)];

  if (drafts) {
    const survivingIds = drafts.filter((d) => d.id !== null).map((d) => d.id as number);
    if (survivingIds.length > 0) {
      stmts.push(db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1 AND id NOT IN (${survivingIds.map((_, k) => `?${k + 2}`).join(', ')})`).bind(eventId, ...survivingIds));
    } else {
      stmts.push(db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1`).bind(eventId));
    }
    const upsertTexts = (questionId: number | null, d: QuestionDraft) => {
      for (const [locale, text] of d.texts) {
        if (!text.label) {
          if (questionId !== null) stmts.push(db.prepare(`DELETE FROM reg_question_i18n WHERE question_id = ?1 AND locale = ?2`).bind(questionId, locale));
          continue;
        }
        const optionLabels = Object.keys(text.option_labels).length > 0 ? JSON.stringify(text.option_labels) : null;
        if (questionId !== null) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_question_i18n (question_id, locale, label, help, placeholder, option_labels) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (question_id, locale) DO UPDATE SET label = excluded.label, help = excluded.help,
                   placeholder = excluded.placeholder, option_labels = excluded.option_labels`,
              )
              .bind(questionId, locale, text.label, text.help, text.placeholder, optionLabels),
          );
        } else {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_question_i18n (question_id, locale, label, help, placeholder, option_labels)
                 VALUES ((SELECT max(id) FROM reg_questions WHERE event_id = ?1), ?2, ?3, ?4, ?5, ?6)`,
              )
              .bind(eventId, locale, text.label, text.help, text.placeholder, optionLabels),
          );
        }
      }
    };
    // Survivors first (every final sort is then in place), then new questions in order.
    drafts.forEach((d, position) => {
      if (d.id === null) return;
      stmts.push(
        db
          .prepare(
            `UPDATE reg_questions SET sort = ?2, type = ?3, required = ?4, options = ?5, scope = ?6, max_length = ?7, condition = NULL
             WHERE id = ?1 AND event_id = ?8`,
          )
          .bind(d.id, position, d.type, d.required, d.options ? JSON.stringify(d.options) : null, d.scope, d.max_length, eventId),
      );
      upsertTexts(d.id, d);
    });
    drafts.forEach((d, position) => {
      if (d.id !== null) return;
      stmts.push(
        db
          .prepare(`INSERT INTO reg_questions (event_id, sort, type, required, options, scope, max_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
          .bind(eventId, position, d.type, d.required, d.options ? JSON.stringify(d.options) : null, d.scope, d.max_length),
      );
      upsertTexts(null, d);
    });
    // Conditions last, once every question holds its final sort: the target and the question itself are
    // both found by sort (unique inside the event now). An upsert keyed by id sets the column without a
    // subquery in SET (the campus scoper only guards WHERE clauses it can see).
    const indexById = new Map<number, number>();
    const indexByKey = new Map<string, number>();
    drafts.forEach((d, i) => {
      if (d.id !== null) indexById.set(d.id, i);
      if (d.key !== null) indexByKey.set(d.key, i);
    });
    drafts.forEach((d, position) => {
      if (!d.condition) return;
      const target = typeof d.condition.q === 'number' ? indexById.get(d.condition.q)! : indexByKey.get(d.condition.q)!;
      const operand = d.condition.op === 'eq' || d.condition.op === 'neq' || d.condition.op === 'in' ? JSON.stringify(d.condition.value) : null;
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_questions (id, event_id, type, condition)
             SELECT s.id, s.event_id, s.type,
                    '{"q":' || CAST(t.id AS TEXT) || ',"op":' || CAST(?3 AS TEXT) ||
                    CASE WHEN CAST(?4 AS TEXT) IS NULL THEN '' ELSE ',"value":' || CAST(?4 AS TEXT) END || '}'
             FROM reg_questions s
             JOIN reg_questions t ON t.event_id = s.event_id AND t.sort = ?5
             WHERE s.event_id = ?1 AND s.sort = ?2
             ON CONFLICT (id) DO UPDATE SET condition = excluded.condition`,
          )
          .bind(eventId, position, JSON.stringify(d.condition.op), operand, target),
      );
    });
  }

  if (tickets) {
    const surviving = tickets.filter((t) => t.id !== null).map((t) => t.id as number);
    const inUse = `AND NOT EXISTS (SELECT 1 FROM reg_attendees a WHERE a.ticket_type_id = reg_ticket_types.id)`;
    if (surviving.length > 0) {
      stmts.push(db.prepare(`DELETE FROM reg_ticket_types WHERE event_id = ?1 AND id NOT IN (${surviving.map((_, k) => `?${k + 2}`).join(', ')}) ${inUse}`).bind(eventId, ...surviving));
    } else {
      stmts.push(db.prepare(`DELETE FROM reg_ticket_types WHERE event_id = ?1 ${inUse}`).bind(eventId));
    }
    const upsertTexts = (typeId: number | null, t: TicketDraft) => {
      for (const [locale, text] of t.texts) {
        if (!text.label) {
          if (typeId !== null) stmts.push(db.prepare(`DELETE FROM reg_ticket_type_i18n WHERE ticket_type_id = ?1 AND locale = ?2`).bind(typeId, locale));
          continue;
        }
        if (typeId !== null) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label, description) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (ticket_type_id, locale) DO UPDATE SET label = excluded.label, description = excluded.description`,
              )
              .bind(typeId, locale, text.label, text.description),
          );
        } else {
          stmts.push(
            db
              .prepare(
                `INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label, description)
                 VALUES ((SELECT max(id) FROM reg_ticket_types WHERE event_id = ?1), ?2, ?3, ?4)`,
              )
              .bind(eventId, locale, text.label, text.description),
          );
        }
      }
    };
    tickets.forEach((t, position) => {
      if (t.id !== null) {
        stmts.push(
          db
            .prepare(`UPDATE reg_ticket_types SET sort = ?2, price_cents = ?3, capacity = ?4, active = ?5 WHERE id = ?1 AND event_id = ?6`)
            .bind(t.id, position, t.price_cents, t.capacity, t.active, eventId),
        );
        upsertTexts(t.id, t);
      } else {
        stmts.push(
          db
            .prepare(`INSERT INTO reg_ticket_types (event_id, sort, price_cents, capacity, active) VALUES (?1, ?2, ?3, ?4, ?5)`)
            .bind(eventId, position, t.price_cents, t.capacity, t.active),
        );
        upsertTexts(null, t);
      }
    });
  }

  await db.batch(stmts);
  return { ok: true };
}

function emptyDraft(): QuestionDraft {
  return { id: null, key: null, type: 'text', scope: 'registration', required: 0, max_length: null, options: null, texts: new Map(), condition: null };
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
