// Registration data access: public event browsing (open-window filtered, with
// localized title/description and live seat counts), the answer validator the
// registration form runs before it writes, the atomic registration+answers
// writer with its capacity backstop, the Checkout-session lifecycle transitions a
// Stripe handler drives (attach → confirm/cancel), and the admin surface (event +
// question editors, roster, CSV export). Supabase-only module (schema in
// migrations-supabase/0003_registration.sql); tests run against real Postgres in
// test/pg/. Money is integer cents everywhere — no floats cross this seam.
//
// Localized reads use manual `_l`/`_d` joins bound to the requested locale with an
// 'en' fallback (the givingDb style), not i18nJoin — reg_event_i18n/reg_question_i18n
// key on title/description/label, not `name`.
//
// A pending registration HOLDS a seat until a guarded Stripe or operator action
// confirms/cancels it. Local age never frees a possibly valid Checkout session.
// See createRegistration for the capacity-race backstop and its documented
// non-serializable window.
import type { AppDb, AppStatement } from './appDb';
import type { Locale } from './db';
import { csvCell } from './csv';

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
  confirmed_count: number;
  taken_count: number;
}

// Pending seats are durable: an ambiguous Checkout create can remain recoverable
// for almost 24 hours, so only a guarded terminal transition may release one.
// Assumes the row is aliased `r`.
const HOLDS_SEAT = `r.status IN ('pending','confirmed')`;

// The localized event projection shared by every event reader. Locale binds as
// ?1; a confirmed OR pending registration counts toward taken_count (it
// holds a seat — see HOLDS_SEAT), confirmed_count is the settled subset. Callers
// append their own WHERE / ORDER BY (numbered from ?2) and bind the locale first.
const EVENT_SELECT = `
  SELECT e.id AS id,
         COALESCE(el.title, ed.title, '') AS title,
         COALESCE(el.description, ed.description) AS description,
         e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
         e.capacity AS capacity, e.price_cents AS price_cents, e.currency AS currency,
         e.opens_at AS opens_at, e.closes_at AS closes_at, e.active AS active,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_count,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND ${HOLDS_SEAT}) AS taken_count
  FROM reg_events e
  LEFT JOIN reg_event_i18n el ON el.event_id = e.id AND el.locale = ?1
  LEFT JOIN reg_event_i18n ed ON ed.event_id = e.id AND ed.locale = 'en'`;

// A registration is OPEN when it is active, its sign-up window has opened
// (opens_at NULL = immediately), and it has not closed (closes_at NULL = open
// until the event starts). All timestamps are the app's UTC 'YYYY-MM-DD HH:MM:SS'
// text, so lexical comparison against datetime('now') is chronological.
const OPEN_WHERE = `e.active = 1
  AND (e.opens_at IS NULL OR e.opens_at <= datetime('now'))
  AND (COALESCE(e.closes_at, e.starts_at) > datetime('now'))`;

/** Public list of currently-open events, soonest first, localized (en fallback). */
export async function listOpenEvents(db: AppDb, locale: Locale): Promise<RegEvent[]> {
  const { results } = await db
    .prepare(`${EVENT_SELECT} WHERE ${OPEN_WHERE} ORDER BY e.starts_at, e.id`)
    .bind(locale)
    .all<RegEvent>();
  return results;
}

/** A single open event by id (null when unknown OR outside its sign-up window). */
export async function getOpenEvent(db: AppDb, locale: Locale, id: number): Promise<RegEvent | null> {
  return db
    .prepare(`${EVENT_SELECT} WHERE e.id = ?2 AND ${OPEN_WHERE}`)
    .bind(locale, id)
    .first<RegEvent>();
}

export interface MyRegistration {
  id: number;
  event_id: number;
  event_title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  status: 'pending' | 'confirmed';
  amount_cents: number;
  currency: string;
  created_at: string;
}

/**
 * A signed-in member's own registrations for the portal "My registrations"
 * view: matched by person_id OR a case-insensitive email match (covers a
 * registration made anonymously, before signup, with the same email), newest
 * event first. Cancelled rows are excluded. Localized event title (en
 * fallback), mirroring EVENT_SELECT's i18n join.
 */
export async function listRegistrationsForPerson(
  db: AppDb,
  locale: Locale,
  personId: number,
  email: string,
): Promise<MyRegistration[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, r.event_id AS event_id,
              COALESCE(el.title, ed.title, '') AS event_title,
              e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
              r.status AS status, r.amount_cents AS amount_cents, r.currency AS currency,
              r.created_at AS created_at
       FROM registrations r
       JOIN reg_events e ON e.id = r.event_id
       LEFT JOIN reg_event_i18n el ON el.event_id = e.id AND el.locale = ?1
       LEFT JOIN reg_event_i18n ed ON ed.event_id = e.id AND ed.locale = 'en'
       WHERE (r.person_id = ?2 OR LOWER(r.email) = LOWER(?3))
         AND r.status != 'cancelled'
       ORDER BY e.starts_at DESC`,
    )
    .bind(locale, personId, email)
    .all<MyRegistration>();
  return results;
}

/** An event's questions in sort order, localized label (en fallback); options
 *  JSON-decoded to a string[] (null for non-select/checkbox or unparseable). */
export async function listQuestions(db: AppDb, locale: Locale, eventId: number): Promise<RegQuestion[]> {
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options,
              COALESCE(ql.label, qd.label, '') AS label
       FROM reg_questions q
       LEFT JOIN reg_question_i18n ql ON ql.question_id = q.id AND ql.locale = ?1
       LEFT JOIN reg_question_i18n qd ON qd.question_id = q.id AND qd.locale = 'en'
       WHERE q.event_id = ?2
       ORDER BY q.sort, q.id`,
    )
    .bind(locale, eventId)
    .all<{ id: number; sort: number; type: RegQuestion['type']; required: number; options: string | null; label: string }>();
  return results.map((r) => ({ ...r, options: parseOptions(r.options) }));
}

/** An event's questions with BOTH locale labels raw (no cross-fallback — the
 *  editor prefills each language, so an absent zh label reads null, NOT the en
 *  label). Sort order; options JSON-decoded like listQuestions. */
export interface RegQuestionAdmin {
  id: number;
  sort: number;
  type: RegQuestion['type'];
  required: number;
  options: string[] | null;
  label_en: string;
  label_zh: string | null;
}

/** The question set for the admin builder: raw en + zh labels, sort order. */
export async function listQuestionsAdmin(db: AppDb, eventId: number): Promise<RegQuestionAdmin[]> {
  const { results } = await db
    .prepare(
      `SELECT q.id AS id, q.sort AS sort, q.type AS type, q.required AS required, q.options AS options,
              COALESCE(qen.label, '') AS label_en, qzh.label AS label_zh
       FROM reg_questions q
       LEFT JOIN reg_question_i18n qen ON qen.question_id = q.id AND qen.locale = 'en'
       LEFT JOIN reg_question_i18n qzh ON qzh.question_id = q.id AND qzh.locale = 'zh'
       WHERE q.event_id = ?1
       ORDER BY q.sort, q.id`,
    )
    .bind(eventId)
    .all<{ id: number; sort: number; type: RegQuestion['type']; required: number; options: string | null; label_en: string; label_zh: string | null }>();
  return results.map((r) => ({ ...r, options: parseOptions(r.options) }));
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
    const raw = form[String(q.id)];
    const options = q.options ?? [];

    if (q.type === 'checkbox') {
      const values = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).filter((v) => v !== '');
      if (q.required && values.length === 0) throw new Error('missing_required');
      for (const v of values) if (!options.includes(v)) throw new Error('bad_answer');
      if (values.length > 0) out.push([q.id, JSON.stringify(values)]);
      continue;
    }

    const value = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).trim();
    if (value === '') {
      if (q.required) throw new Error('missing_required');
      continue;
    }
    if (q.type === 'select') {
      if (!options.includes(value)) throw new Error('bad_answer');
      out.push([q.id, value]);
    } else if (q.type === 'yesno') {
      const v = value.toLowerCase();
      const norm = ['yes', 'y', 'true', '1', 'on'].includes(v)
        ? 'yes'
        : ['no', 'n', 'false', '0', 'off'].includes(v)
          ? 'no'
          : null;
      if (norm === null) throw new Error('bad_answer');
      out.push([q.id, norm]);
    } else {
      // text / textarea — the trimmed value, non-empty by the guard above.
      out.push([q.id, value]);
    }
  }
  return out;
}

/**
 * Create a registration and its answers atomically, returning the new id. The
 * insert + every answer + a post-insert recount run in one batch() (a single
 * transaction); the answers reference the just-inserted registration via
 * currval() on the same connection, since the batch seam can't thread a RETURNING
 * id from one statement into a later statement's binds.
 *
 * Capacity-race backstop: batch() is one transaction but READ COMMITTED, not
 * SERIALIZABLE. So we re-count seats held (status IN pending/confirmed) AFTER the
 * insert, inside the same transaction, and if THIS row pushed the event past its
 * capacity we compensate — cancel the row we just wrote (freeing the seat) and
 * throw 'event_full'. This closes the common race (a registration landing on an
 * already-full event) but NOT the simultaneous-commit window: two transactions
 * committing at once can each miss the other's still-uncommitted row and both
 * survive, briefly overselling by one. Acceptable at church scale — documented,
 * not eliminated (a SERIALIZABLE retry loop is the fix if it ever matters).
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
  },
): Promise<number> {
  const stmts: AppStatement[] = [
    db
      .prepare(
        `INSERT INTO registrations (event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
      )
      .bind(input.eventId, input.personId, input.name, input.email, input.status, input.amountCents, input.currency),
  ];
  for (const [questionId, value] of input.answers) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_answers (registration_id, question_id, value)
           VALUES (currval(pg_get_serial_sequence('registrations','id')), ?1, ?2)`,
        )
        .bind(questionId, value),
    );
  }
  // Last statement: recount held seats + read capacity in the same transaction.
  // Every pending/confirmed row is a durable held seat (HOLDS_SEAT).
  stmts.push(
    db
      .prepare(
        `SELECT (SELECT capacity FROM reg_events WHERE id = ?1) AS cap,
                count(*) AS taken
         FROM registrations r WHERE r.event_id = ?1 AND ${HOLDS_SEAT}`,
      )
      .bind(input.eventId),
  );

  const results = await db.batch(stmts);
  const id = (results[0].results[0] as { id: number }).id;
  const recount = results[results.length - 1].results[0] as { cap: number | null; taken: number };
  if (recount.cap !== null && recount.taken > recount.cap) {
    await cancelRegistration(db, id);
    throw new Error('event_full');
  }
  return id;
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
 * already-cancelled row does not move and returns false.
 */
export async function cancelRegistration(db: AppDb, id: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE registrations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?1 AND status != 'cancelled'`)
    .bind(id)
    .run();
  return r.meta.changes > 0;
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Every event (active AND inactive) with live counts, newest first — the admin
 *  events table. Localized title/description (en fallback). */
export async function listAllEvents(db: AppDb, locale: Locale): Promise<RegEvent[]> {
  const { results } = await db
    .prepare(`${EVENT_SELECT} ORDER BY e.starts_at DESC, e.id DESC`)
    .bind(locale)
    .all<RegEvent>();
  return results;
}

/** An admin event carrying BOTH locale titles/descriptions (not a single
 *  localized projection) so the editor form can prefill each language and the
 *  list can show both. title_en is '' when the en row is missing; title_zh /
 *  descriptions are null when that locale row is absent. */
export interface RegEventAdmin {
  id: number;
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
  confirmed_count: number;
  taken_count: number;
}

// Both-locale event projection for the admin editor: the en and zh i18n rows join
// side by side (no COALESCE — the form needs each language raw) plus the same
// seat counts as EVENT_SELECT. Callers append their own WHERE / ORDER BY.
const ADMIN_EVENT_SELECT = `
  SELECT e.id AS id,
         COALESCE(een.title, '') AS title_en, ezh.title AS title_zh,
         een.description AS description_en, ezh.description AS description_zh,
         e.starts_at AS starts_at, e.ends_at AS ends_at, e.location AS location,
         e.capacity AS capacity, e.price_cents AS price_cents, e.currency AS currency,
         e.opens_at AS opens_at, e.closes_at AS closes_at, e.active AS active,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS confirmed_count,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND ${HOLDS_SEAT}) AS taken_count
  FROM reg_events e
  LEFT JOIN reg_event_i18n een ON een.event_id = e.id AND een.locale = 'en'
  LEFT JOIN reg_event_i18n ezh ON ezh.event_id = e.id AND ezh.locale = 'zh'`;

/** Every event with both-locale title/description + counts, newest first — the
 *  admin list, which doubles as the ?edit=<id> prefill source. */
export async function listEventsAdmin(db: AppDb): Promise<RegEventAdmin[]> {
  const { results } = await db.prepare(`${ADMIN_EVENT_SELECT} ORDER BY e.starts_at DESC, e.id DESC`).all<RegEventAdmin>();
  return results;
}

/** A single event with both-locale fields + counts (the questions/roster page's
 *  header + amount currency), or null when unknown. */
export async function getEventAdmin(db: AppDb, id: number): Promise<RegEventAdmin | null> {
  return db.prepare(`${ADMIN_EVENT_SELECT} WHERE e.id = ?1`).bind(id).first<RegEventAdmin>();
}

/**
 * Insert (id absent) or update (id present) an event plus its locale title +
 * description in one pass. The en i18n row is always written; a blank/whitespace
 * zh title DELETES the zh row rather than storing '' (the en-fallback COALESCE
 * only fires on a missing row, never on ''), mirroring saveFund. Currency is left
 * at its column default. Returns the event id.
 */
export async function saveEvent(
  db: AppDb,
  input: {
    id?: number;
    title_en: string;
    title_zh: string;
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
  },
): Promise<number> {
  let eventId: number;
  if (input.id != null) {
    await db
      .prepare(
        `UPDATE reg_events SET starts_at = ?1, ends_at = ?2, location = ?3, capacity = ?4, price_cents = ?5,
                opens_at = ?6, closes_at = ?7, active = ?8, updated_at = datetime('now')
         WHERE id = ?9`,
      )
      .bind(
        input.starts_at,
        input.ends_at ?? null,
        input.location ?? null,
        input.capacity ?? null,
        input.price_cents ?? null,
        input.opens_at ?? null,
        input.closes_at ?? null,
        input.active,
        input.id,
      )
      .run();
    eventId = input.id;
  } else {
    const created = await db
      .prepare(
        `INSERT INTO reg_events (starts_at, ends_at, location, capacity, price_cents, opens_at, closes_at, active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
      )
      .bind(
        input.starts_at,
        input.ends_at ?? null,
        input.location ?? null,
        input.capacity ?? null,
        input.price_cents ?? null,
        input.opens_at ?? null,
        input.closes_at ?? null,
        input.active,
      )
      .first<{ id: number }>();
    eventId = created!.id;
  }
  const titleZh = input.title_zh.trim();
  await db.batch([
    db
      .prepare(
        `INSERT INTO reg_event_i18n (event_id, locale, title, description) VALUES (?1, 'en', ?2, ?3)
         ON CONFLICT (event_id, locale) DO UPDATE SET title = excluded.title, description = excluded.description`,
      )
      .bind(eventId, input.title_en, input.description_en ?? null),
    titleZh
      ? db
          .prepare(
            `INSERT INTO reg_event_i18n (event_id, locale, title, description) VALUES (?1, 'zh', ?2, ?3)
             ON CONFLICT (event_id, locale) DO UPDATE SET title = excluded.title, description = excluded.description`,
          )
          .bind(eventId, titleZh, input.description_zh ?? null)
      : db.prepare(`DELETE FROM reg_event_i18n WHERE event_id = ?1 AND locale = 'zh'`).bind(eventId),
  ]);
  return eventId;
}

/**
 * Replace an event's whole question set in one batch. Questions absent from the
 * incoming list are deleted (their reg_answers + i18n cascade away); questions
 * carrying an id are UPDATEd in place, so the answers already collected against
 * them SURVIVE; questions without an id are inserted, their i18n rows referencing
 * currval() right after each insert (see createRegistration for the currval
 * rationale). A blank zh label deletes the zh i18n row (en-fallback), like saveEvent.
 *
 * Cross-event safety: an incoming `id` that does NOT belong to `eventId` is
 * treated as a NEW question (its id is dropped), never as a survivor. The reg_row
 * UPDATE is already event-scoped (WHERE id = ? AND event_id = ?), but the
 * reg_question_i18n upsert keys on question_id ALONE — so without this guard a
 * tampered q[i][id] pointing at another event's question would overwrite that
 * event's labels. Scoping to the event's own ids closes that.
 */
export async function saveQuestions(
  db: AppDb,
  eventId: number,
  questions: Array<{
    id?: number;
    sort: number;
    type: RegQuestion['type'];
    required: number;
    options?: string[] | null;
    label_en: string;
    label_zh: string;
  }>,
): Promise<void> {
  // Strip any submitted id that this event does not own (treat it as a new
  // question) so a foreign id can never reach the question_id-keyed i18n upsert.
  const { results: owned } = await db.prepare(`SELECT id FROM reg_questions WHERE event_id = ?1`).bind(eventId).all<{ id: number }>();
  const ownedIds = new Set(owned.map((r) => r.id));
  const scoped = questions.map((q) => (q.id != null && !ownedIds.has(q.id) ? { ...q, id: undefined } : q));

  const survivingIds = scoped.filter((q) => q.id != null).map((q) => q.id as number);
  const stmts: AppStatement[] = [];

  // Prune the removed questions first (surviving ids are UPDATEd below, never
  // deleted, so their reg_answers are preserved).
  if (survivingIds.length > 0) {
    const placeholders = survivingIds.map((_, i) => `?${i + 2}`).join(', ');
    stmts.push(
      db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1 AND id NOT IN (${placeholders})`).bind(eventId, ...survivingIds),
    );
  } else {
    stmts.push(db.prepare(`DELETE FROM reg_questions WHERE event_id = ?1`).bind(eventId));
  }

  for (const q of scoped) {
    const opts = q.options != null ? JSON.stringify(q.options) : null;
    const labelZh = q.label_zh.trim();
    if (q.id != null) {
      stmts.push(
        db
          .prepare(`UPDATE reg_questions SET sort = ?2, type = ?3, required = ?4, options = ?5 WHERE id = ?1 AND event_id = ?6`)
          .bind(q.id, q.sort, q.type, q.required, opts, eventId),
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_question_i18n (question_id, locale, label) VALUES (?1, 'en', ?2)
             ON CONFLICT (question_id, locale) DO UPDATE SET label = excluded.label`,
          )
          .bind(q.id, q.label_en),
      );
      stmts.push(
        labelZh
          ? db
              .prepare(
                `INSERT INTO reg_question_i18n (question_id, locale, label) VALUES (?1, 'zh', ?2)
                 ON CONFLICT (question_id, locale) DO UPDATE SET label = excluded.label`,
              )
              .bind(q.id, labelZh)
          : db.prepare(`DELETE FROM reg_question_i18n WHERE question_id = ?1 AND locale = 'zh'`).bind(q.id),
      );
    } else {
      // New question: insert, then its i18n rows via currval on the same
      // connection (the insert immediately precedes them, nothing between
      // advances the reg_questions sequence).
      stmts.push(
        db
          .prepare(`INSERT INTO reg_questions (event_id, sort, type, required, options) VALUES (?1, ?2, ?3, ?4, ?5)`)
          .bind(eventId, q.sort, q.type, q.required, opts),
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_question_i18n (question_id, locale, label)
             VALUES (currval(pg_get_serial_sequence('reg_questions','id')), 'en', ?1)`,
          )
          .bind(q.label_en),
      );
      if (labelZh) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO reg_question_i18n (question_id, locale, label)
               VALUES (currval(pg_get_serial_sequence('reg_questions','id')), 'zh', ?1)`,
            )
            .bind(labelZh),
        );
      }
    }
  }
  await db.batch(stmts);
}

/** The registration roster for an event, newest first, each row carrying its
 *  answers as localized { label, value } pairs (question sort order). */
export async function listRegistrations(
  db: AppDb,
  locale: Locale,
  eventId: number,
): Promise<
  Array<{ id: number; name: string; email: string; status: string; amount_cents: number; created_at: string; answers: Array<{ label: string; value: string }> }>
> {
  const { results: regs } = await db
    .prepare(
      `SELECT id, name, email, status, amount_cents, created_at
       FROM registrations WHERE event_id = ?1
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(eventId)
    .all<{ id: number; name: string; email: string; status: string; amount_cents: number; created_at: string }>();

  const { results: answers } = await db
    .prepare(
      `SELECT a.registration_id AS registration_id, COALESCE(ql.label, qd.label, '') AS label, a.value AS value
       FROM reg_answers a
       JOIN registrations r ON r.id = a.registration_id
       JOIN reg_questions q ON q.id = a.question_id
       LEFT JOIN reg_question_i18n ql ON ql.question_id = q.id AND ql.locale = ?1
       LEFT JOIN reg_question_i18n qd ON qd.question_id = q.id AND qd.locale = 'en'
       WHERE r.event_id = ?2
       ORDER BY q.sort, q.id`,
    )
    .bind(locale, eventId)
    .all<{ registration_id: number; label: string; value: string }>();

  const byReg = new Map<number, Array<{ label: string; value: string }>>();
  for (const a of answers) {
    const list = byReg.get(a.registration_id) ?? [];
    list.push({ label: a.label, value: a.value });
    byReg.set(a.registration_id, list);
  }
  return regs.map((r) => ({ ...r, answers: byReg.get(r.id) ?? [] }));
}

/**
 * The event roster as RFC4180 CSV: header Name,Email,Status,Amount,Registered
 * followed by one column per question (localized label, question sort order),
 * rows newest first. Amount is a plain dollars string — cents are integers, so
 * (amount_cents/100).toFixed(2) is exact. Each field goes through the shared
 * csvCell: spreadsheet formula injection is neutralized (a leading = + - @ / tab /
 * CR — reachable via the anonymous /api/register/submit name/email/answer fields —
 * is quote-prefixed) THEN the value is RFC4180-quoted when it contains a comma,
 * quote, CR, or LF, with embedded quotes doubled; rows are CRLF-joined.
 */
export async function registrationsCsv(db: AppDb, locale: Locale, eventId: number): Promise<string> {
  const questions = await listQuestions(db, locale, eventId);
  const { results: regs } = await db
    .prepare(
      `SELECT id, name, email, status, amount_cents, created_at
       FROM registrations WHERE event_id = ?1
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(eventId)
    .all<{ id: number; name: string; email: string; status: string; amount_cents: number; created_at: string }>();
  const { results: answers } = await db
    .prepare(
      `SELECT a.registration_id AS registration_id, a.question_id AS question_id, a.value AS value
       FROM reg_answers a
       JOIN registrations r ON r.id = a.registration_id
       WHERE r.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ registration_id: number; question_id: number; value: string }>();

  // Answers keyed by (registration id → question id) so each lands in its column
  // even when two questions share a label.
  const byReg = new Map<number, Map<number, string>>();
  for (const a of answers) {
    const m = byReg.get(a.registration_id) ?? new Map<number, string>();
    m.set(a.question_id, a.value);
    byReg.set(a.registration_id, m);
  }

  const header = ['Name', 'Email', 'Status', 'Amount', 'Registered', ...questions.map((q) => q.label)];
  const lines = [header.map(csvCell).join(',')];
  for (const r of regs) {
    const m = byReg.get(r.id) ?? new Map<number, string>();
    const cells = [
      r.name,
      r.email,
      r.status,
      (r.amount_cents / 100).toFixed(2),
      r.created_at,
      ...questions.map((q) => m.get(q.id) ?? ''),
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
