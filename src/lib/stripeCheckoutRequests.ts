import { isSupportedLocale, type SupportedLocale } from './locales';
import type { AppDb, AppStatement } from './appDb';
import { sha256Utf8 } from './stripeWebhookInbox';
import { EVENT_LOCK_AND_NUMBER_SQL, SEAT_STATUSES, confirmationNoSql, priceTicketSelection, seatsTakenSql, storedAnswerSql } from './regDb';

export interface StripeCheckoutParams {
  mode: 'payment';
  line_items: Array<{
    quantity: number;
    price_data: {
      currency: string;
      unit_amount: number;
      product_data: { name: string };
    };
  }>;
  success_url: string;
  cancel_url: string;
  customer_email: string;
  metadata: RegistrationCheckoutMetadata;
  payment_intent_data: { metadata: RegistrationCheckoutMetadata };
}

interface RegistrationCheckoutMetadata {
  kind: 'registration';
  registration_id: string;
  request_id: string;
}

/** The people a paid registration covers (one Checkout line item of quantity = attendees.length, or one
 *  per ticket type when the event sells ticket types). */
export interface RegistrationCheckoutParty {
  phone: string | null;
  attendees: Array<{
    name: string;
    personId: number | null;
    /** The ticket type this person holds (events with active ticket types). */
    ticketTypeId?: number | null;
    /** This person's answers to the per-person questions. */
    answers?: Array<[number, string]>;
  }>;
}

/** A ticket type the request bills: its price comes from the database (the caller read it), never from the form. */
export interface RegistrationCheckoutTicket {
  ticketTypeId: number;
  unitAmountCents: number;
  label: string;
}

export interface RegistrationCheckoutRequestInput {
  requestId: string;
  eventId: number;
  personId: number | null;
  name: string;
  email: string;
  /** The PER-PERSON price in cents (the event's price_cents). The registration's amount is
   *  this times the party size (1 when `party` is absent) and the Stripe line item is
   *  unit_amount = this, quantity = party size. Ignored when `tickets` is given (the amount is then
   *  the sum of the people's ticket prices). */
  amountCents: number;
  currency: string;
  answers: Array<[number, string]>;
  /** Party members and phone; omitted = a single person, exactly as before the party flow. */
  party?: RegistrationCheckoutParty;
  /** The event's active ticket types (id, price, label), when it sells them: every attendee in `party`
   *  must carry one of these ids; the amount is the sum of their prices and Checkout gets one line item
   *  per type. Omitted = a single implicit type at `amountCents`, digested exactly as before. */
  tickets?: RegistrationCheckoutTicket[];
  eventTitle: string;
  locale: SupportedLocale;
  appOrigin: string;
}

export type CheckoutRequestResolution =
  | { kind: 'create'; registrationId: number; requestId: string; requestJson: StripeCheckoutParams }
  | { kind: 'redirect'; registrationId: number; checkoutUrl: string }
  | { kind: 'waiting'; registrationId: number }
  | { kind: 'review'; registrationId: number; reason: string }
  | { kind: 'done'; registrationId: number }
  | { kind: 'expired' }
  | { kind: 'conflict' };

interface NormalizedRegistrationCheckoutInput {
  eventId: number;
  personId: number | null;
  name: string;
  email: string;
  amountCents: number;
  currency: string;
  answers: Array<[number, string]>;
  /** Present only when the caller passed a party, so a request without one digests exactly as it always did. */
  party?: RegistrationCheckoutParty;
  /** Present only for a ticket-typed event; `amountCents` is then the whole registration's total. */
  tickets?: RegistrationCheckoutTicket[];
}

interface CheckoutRequestRow {
  request_id: string;
  request_sha256: string;
  registration_id: number;
  request_json: string | null;
  session_url: string | null;
  state: 'creating' | 'attached' | 'manual_review' | 'resolved';
  status: 'pending' | 'confirmed' | 'cancelled';
  stripe_checkout_session_id: string | null;
  event_id: number;
  amount_cents: number;
  party_size: number;
  /** Truthy when any attendee holds a ticket type (the request then bills one line item per type). */
  typed: boolean | number;
  currency: string;
  email: string;
  reconcile_attempts: number;
  next_reconcile_at: string | null;
  last_error: string | null;
  last_action_by: number | null;
  created_at: string;
  updated_at: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCheckoutRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** Browser Checkout retries must carry the exact canonical UUID rendered by the server. */
export function parseCheckoutRequestId(value: unknown): string {
  if (!isCheckoutRequestId(value)) throw new Error('checkout_request_id_invalid');
  return value;
}

/** Generate the one browser identity that must survive every retry of a rendered form. */
export function newCheckoutRequestId(): string {
  return parseCheckoutRequestId(crypto.randomUUID());
}

/** Reuse only a canonical server UUID; malformed/untrusted query input is replaced. */
export function checkoutRequestIdForRender(value: unknown): string {
  return isCheckoutRequestId(value) ? value : newCheckoutRequestId();
}

/** Decide whether aggregate capacity blocks this render without consuming a second seat on a paid retry. */
export function registrationCheckoutRenderPolicy(input: {
  paid: boolean;
  capacity: number | null;
  takenCount: number;
  error: unknown;
  checkoutRequestId: unknown;
  ownsWaitingSeat: boolean;
}): { checkoutRequestId: string; isFull: boolean; reused: boolean } {
  const reusableId = input.error === 'waiting'
    && input.ownsWaitingSeat
    && isCheckoutRequestId(input.checkoutRequestId)
    ? input.checkoutRequestId
    : null;
  const reused = reusableId !== null;
  const aggregateFull = input.capacity !== null && input.takenCount >= input.capacity;
  return {
    checkoutRequestId: reusableId ?? newCheckoutRequestId(),
    isFull: aggregateFull && !reused,
    reused,
  };
}

/** Verify that this browser request owns a recoverable pending seat for this event. */
export async function ownsRecoverableRegistrationCheckoutRequest(
  db: AppDb,
  requestIdValue: unknown,
  eventId: number,
): Promise<boolean> {
  if (!isCheckoutRequestId(requestIdValue) || !Number.isSafeInteger(eventId) || eventId <= 0) return false;
  const row = await db
    .prepare(
      `SELECT EXISTS (
         SELECT 1
         FROM church_private.stripe_checkout_requests q
         JOIN registrations r ON r.id = q.registration_id
         WHERE q.request_id = ?1
           AND r.event_id = ?2
           AND r.status = 'pending'
           AND q.state IN ('creating','attached','manual_review')
       ) AS owns_waiting_seat`,
    )
    .bind(requestIdValue, eventId)
    .first<{ owns_waiting_seat: boolean | number }>();
  return row?.owns_waiting_seat === true || row?.owns_waiting_seat === 1;
}

export function registrationCheckoutIdempotencyKey(requestId: string): string {
  return `church4christ:registration:${parseCheckoutRequestId(requestId)}`;
}

function normalizeText(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function normalizeInput(input: RegistrationCheckoutRequestInput): NormalizedRegistrationCheckoutInput {
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0) throw new Error('checkout_event_invalid');
  if (!(input.personId === null || (Number.isSafeInteger(input.personId) && input.personId > 0))) {
    throw new Error('checkout_person_invalid');
  }
  const typed = input.tickets !== undefined;
  if (!typed && (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)) throw new Error('checkout_amount_invalid');
  const currency = normalizeText(input.currency, 'checkout_currency_invalid').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('checkout_currency_invalid');
  const normalizeAnswers = (list: Array<[number, string]>): Array<[number, string]> => {
    const answers = list.map(([questionId, value]) => {
      if (!Number.isSafeInteger(questionId) || questionId <= 0) throw new Error('checkout_answer_invalid');
      return [questionId, normalizeText(value, 'checkout_answer_invalid')] as [number, string];
    });
    answers.sort(([leftId, leftValue], [rightId, rightValue]) => leftId - rightId || leftValue.localeCompare(rightValue));
    if (answers.some(([questionId], index) => index > 0 && answers[index - 1][0] === questionId)) {
      throw new Error('checkout_answer_invalid');
    }
    return answers;
  };
  const answers = normalizeAnswers(input.answers);

  let tickets: RegistrationCheckoutTicket[] | undefined;
  if (typed) {
    tickets = input.tickets!.map((ticket) => {
      if (!Number.isSafeInteger(ticket.ticketTypeId) || ticket.ticketTypeId <= 0
        || !Number.isSafeInteger(ticket.unitAmountCents) || ticket.unitAmountCents < 0) throw new Error('checkout_ticket_invalid');
      return { ticketTypeId: ticket.ticketTypeId, unitAmountCents: ticket.unitAmountCents, label: normalizeText(ticket.label, 'checkout_ticket_invalid') };
    }).sort((a, b) => a.ticketTypeId - b.ticketTypeId);
    if (tickets.some((t, i) => i > 0 && tickets![i - 1].ticketTypeId === t.ticketTypeId)) throw new Error('checkout_ticket_invalid');
  }

  let party: RegistrationCheckoutParty | undefined;
  if (input.party !== undefined) {
    const attendees = input.party.attendees.map((attendee) => {
      const personId = attendee.personId ?? null;
      if (!(personId === null || (Number.isSafeInteger(personId) && personId > 0))) throw new Error('checkout_person_invalid');
      const ticketTypeId = attendee.ticketTypeId ?? null;
      if (ticketTypeId !== null && !tickets?.some((t) => t.ticketTypeId === ticketTypeId)) throw new Error('checkout_ticket_invalid');
      const personAnswers = attendee.answers && attendee.answers.length > 0 ? normalizeAnswers(attendee.answers) : null;
      // New keys appear only when used, so a plain party digests exactly as it always did.
      return {
        name: normalizeText(attendee.name, 'checkout_identity_invalid'),
        personId,
        ...(ticketTypeId !== null ? { ticketTypeId } : {}),
        ...(personAnswers ? { answers: personAnswers } : {}),
      };
    });
    if (attendees.length < 1 || attendees.length > 20) throw new Error('checkout_party_invalid');
    const phone = input.party.phone === null ? null : input.party.phone.normalize('NFC').trim() || null;
    party = { phone, attendees };
  }

  let amountCents = input.amountCents;
  if (tickets) {
    // The whole registration's total: every person needs a type of this event.
    const people = party?.attendees ?? [{ ticketTypeId: null as number | null }];
    amountCents = 0;
    for (const person of people) {
      const ticket = tickets.find((t) => t.ticketTypeId === person.ticketTypeId);
      if (!ticket) throw new Error('checkout_ticket_invalid');
      amountCents += ticket.unitAmountCents;
    }
    if (amountCents <= 0) throw new Error('checkout_amount_invalid');
  }
  return {
    eventId: input.eventId,
    personId: input.personId,
    name: normalizeText(input.name, 'checkout_identity_invalid'),
    email: normalizeText(input.email, 'checkout_identity_invalid').toLowerCase(),
    amountCents,
    currency,
    answers,
    ...(party ? { party } : {}),
    ...(tickets ? { tickets } : {}),
  };
}

const partySizeOf = (normalized: NormalizedRegistrationCheckoutInput): number => normalized.party?.attendees.length ?? 1;

/** What the registration costs: the typed total, or the per-person price times the party. */
const totalOf = (normalized: NormalizedRegistrationCheckoutInput): number =>
  normalized.tickets ? normalized.amountCents : normalized.amountCents * partySizeOf(normalized);

/** The total a stored Checkout request bills: the sum of unit amount x quantity over its line items. */
export function checkoutParamsTotal(params: Pick<StripeCheckoutParams, 'line_items'>): number {
  return params.line_items.reduce((sum, item) => sum + item.price_data.unit_amount * item.quantity, 0);
}

/** SHA-256 over only the normalized submitted registration identity. */
export async function registrationCheckoutRequestDigest(input: RegistrationCheckoutRequestInput): Promise<string> {
  return sha256Utf8(JSON.stringify(normalizeInput(input)));
}

function isAllowedApplicationUrl(url: URL): boolean {
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
}

function hasExactHttpLoopbackAuthority(value: string): boolean {
  return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/.test(value);
}

export function canonicalAppOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('checkout_origin_invalid');
  }
  if (
    !isAllowedApplicationUrl(url)
    || (url.protocol === 'http:' && !hasExactHttpLoopbackAuthority(value))
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('checkout_origin_invalid');
  }
  return url.origin;
}

export function registrationCheckoutCancelUrl(
  originValue: string,
  locale: SupportedLocale,
  eventId: number,
  requestIdValue: string,
): string {
  const origin = canonicalAppOrigin(originValue);
  const requestId = parseCheckoutRequestId(requestIdValue);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('checkout_event_invalid');
  const query = new URLSearchParams({ error: 'waiting', checkoutRequestId: requestId });
  return `${origin}/${locale}/register/${eventId}?${query.toString()}`;
}

/** One line item for the party at the event price, or one per ticket type (people x unit price). A $0 type
 *  adds no line: it contributes nothing to the total. */
function lineItemsFor(normalized: NormalizedRegistrationCheckoutInput, eventTitle: string): StripeCheckoutParams['line_items'] {
  if (!normalized.tickets) {
    return [{
      quantity: partySizeOf(normalized),
      price_data: { currency: normalized.currency, unit_amount: normalized.amountCents, product_data: { name: eventTitle } },
    }];
  }
  const people = normalized.party?.attendees ?? [{ ticketTypeId: null }];
  const lines: StripeCheckoutParams['line_items'] = [];
  for (const ticket of normalized.tickets) {
    const quantity = people.filter((p) => p.ticketTypeId === ticket.ticketTypeId).length;
    if (quantity === 0 || ticket.unitAmountCents === 0) continue;
    lines.push({
      quantity,
      price_data: {
        currency: normalized.currency,
        unit_amount: ticket.unitAmountCents,
        product_data: { name: `${eventTitle} - ${ticket.label}` },
      },
    });
  }
  return lines;
}

/** Build the exact non-secret Stripe parameter map persisted for same-key recovery. */
export function buildRegistrationCheckoutParams(
  input: RegistrationCheckoutRequestInput & { registrationId: number },
): StripeCheckoutParams {
  const requestId = parseCheckoutRequestId(input.requestId);
  const normalized = normalizeInput(input);
  if (!Number.isSafeInteger(input.registrationId) || input.registrationId <= 0) {
    throw new Error('checkout_registration_invalid');
  }
  if (!isSupportedLocale(input.locale)) throw new Error('checkout_locale_invalid');
  const origin = canonicalAppOrigin(input.appOrigin);
  const metadata: RegistrationCheckoutMetadata = {
    kind: 'registration',
    registration_id: String(input.registrationId),
    request_id: requestId,
  };
  return {
    mode: 'payment',
    line_items: lineItemsFor(normalized, normalizeText(input.eventTitle, 'checkout_event_title_invalid')),
    success_url: `${origin}/${input.locale}/register/done?ok=1&paid=1`,
    cancel_url: registrationCheckoutCancelUrl(origin, input.locale, normalized.eventId, requestId),
    customer_email: normalized.email,
    metadata,
    payment_intent_data: { metadata: { ...metadata } },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function corruptRequest(): never {
  throw new Error('checkout_request_corrupt');
}

function safeApplicationUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) corruptRequest();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    corruptRequest();
  }
  if (!isAllowedApplicationUrl(url) || (url.protocol === 'http:' && !hasExactHttpLoopbackAuthority(value))) {
    corruptRequest();
  }
  return url;
}

function requireStoredParams(raw: string, row: CheckoutRequestRow): StripeCheckoutParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    corruptRequest();
  }
  if (
    !isPlainObject(parsed)
    || !hasExactKeys(parsed, [
      'mode',
      'line_items',
      'success_url',
      'cancel_url',
      'customer_email',
      'metadata',
      'payment_intent_data',
    ])
    || parsed.mode !== 'payment'
    || !Array.isArray(parsed.line_items)
    || parsed.line_items.length < 1
    || parsed.line_items.length > 20
    || (!row.typed && parsed.line_items.length !== 1)
    || typeof parsed.customer_email !== 'string'
    || parsed.customer_email !== row.email
    || !isPlainObject(parsed.metadata)
    || !isPlainObject(parsed.payment_intent_data)
    || !hasExactKeys(parsed.payment_intent_data, ['metadata'])
  ) {
    corruptRequest();
  }
  const paymentMetadata = parsed.payment_intent_data.metadata;
  if (!isPlainObject(paymentMetadata)) corruptRequest();
  const registrationId = String(row.registration_id);
  for (const metadata of [parsed.metadata, paymentMetadata]) {
    if (
      !hasExactKeys(metadata, ['kind', 'registration_id', 'request_id'])
      || metadata.kind !== 'registration'
      || metadata.request_id !== row.request_id
      || metadata.registration_id !== registrationId
    ) {
      throw new Error('checkout_request_metadata_mismatch');
    }
  }

  // A plain registration bills one line of party_size people; a ticket-typed one bills one line per
  // paid type, and the lines must add up to exactly the registration's amount.
  let quantity = 0;
  let total = 0;
  for (const lineItem of parsed.line_items as unknown[]) {
    if (
      !isPlainObject(lineItem)
      || !hasExactKeys(lineItem, ['quantity', 'price_data'])
      || !Number.isSafeInteger(lineItem.quantity)
      || (lineItem.quantity as number) < 1
      || !isPlainObject(lineItem.price_data)
      || !hasExactKeys(lineItem.price_data, ['currency', 'unit_amount', 'product_data'])
      || !Number.isSafeInteger(lineItem.price_data.unit_amount)
      || (lineItem.price_data.unit_amount as number) <= 0
      || lineItem.price_data.currency !== row.currency
      || typeof lineItem.price_data.currency !== 'string'
      || !/^[a-z]{3}$/.test(lineItem.price_data.currency)
      || !isPlainObject(lineItem.price_data.product_data)
      || !hasExactKeys(lineItem.price_data.product_data, ['name'])
      || typeof lineItem.price_data.product_data.name !== 'string'
      || lineItem.price_data.product_data.name.trim().length < 1
    ) {
      corruptRequest();
    }
    quantity += lineItem.quantity as number;
    total += (lineItem.price_data.unit_amount as number) * (lineItem.quantity as number);
  }
  if (total !== row.amount_cents || (row.typed ? quantity > row.party_size : quantity !== row.party_size)) corruptRequest();

  const success = safeApplicationUrl(parsed.success_url);
  const cancel = safeApplicationUrl(parsed.cancel_url);
  const successMatch = success.pathname.match(/^\/([^/]+)\/register\/done$/);
  if (
    !successMatch
    || !isSupportedLocale(successMatch[1])
    || success.search !== '?ok=1&paid=1'
    || success.hash
    || cancel.origin !== success.origin
    || cancel.pathname !== `/${successMatch[1]}/register/${row.event_id}`
    || cancel.search !== `?${new URLSearchParams({
      error: 'waiting',
      checkoutRequestId: row.request_id,
    }).toString()}`
    || cancel.hash
  ) {
    corruptRequest();
  }
  return parsed as unknown as StripeCheckoutParams;
}

async function loadRequest(db: AppDb, requestId: string): Promise<CheckoutRequestRow | null> {
  return db
    .prepare(
      `SELECT q.request_id AS request_id, q.request_sha256 AS request_sha256,
              q.registration_id AS registration_id, q.request_json AS request_json,
              q.session_url AS session_url, q.state AS state,
              r.status AS status, r.stripe_checkout_session_id AS stripe_checkout_session_id,
              r.event_id AS event_id, r.amount_cents AS amount_cents, r.party_size AS party_size,
              EXISTS (SELECT 1 FROM reg_attendees ta WHERE ta.registration_id = r.id AND ta.ticket_type_id IS NOT NULL) AS typed,
              r.currency AS currency, r.email AS email,
              q.reconcile_attempts AS reconcile_attempts,
              q.next_reconcile_at AS next_reconcile_at,
              q.last_error AS last_error, q.last_action_by AS last_action_by,
              q.created_at AS created_at, q.updated_at AS updated_at
       FROM church_private.stripe_checkout_requests q
       JOIN registrations r ON r.id = q.registration_id
       WHERE q.request_id = ?1`,
    )
    .bind(requestId)
    .first<CheckoutRequestRow>();
}

export interface RegistrationCheckoutRecoveryClaim {
  requestId: string;
  registrationId: number;
  state: 'creating' | 'attached' | 'manual_review';
  requestJson: StripeCheckoutParams | null;
  sessionId: string | null;
  amountCents: number;
  currency: string;
  createdAt: string;
  claimVersion: string;
  reconcileAttempts: number;
  previousNextReconcileAt: string | null;
  requestInvalid: boolean;
}

const RECOVERY_CLAIM_MS = 10 * 60_000;

function dbTimeMs(value: string): number {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

function hasActiveRecoveryClaim(row: CheckoutRequestRow, now: string): boolean {
  if (row.next_reconcile_at === null) return false;
  const updatedAt = dbTimeMs(row.updated_at);
  const nextAt = dbTimeMs(row.next_reconcile_at);
  const nowAt = dbTimeMs(now);
  return Number.isFinite(updatedAt)
    && Number.isFinite(nextAt)
    && Number.isFinite(nowAt)
    && nextAt > nowAt
    && nextAt - updatedAt === RECOVERY_CLAIM_MS;
}

export async function listDueRegistrationCheckoutRequestIds(
  db: AppDb,
  now: string,
  limit: number,
): Promise<string[]> {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 25) : 10;
  const { results } = await db
    .prepare(
      `SELECT q.request_id AS request_id
       FROM church_private.stripe_checkout_requests q
       JOIN registrations r ON r.id=q.registration_id
       WHERE q.state IN ('creating','attached')
         AND r.status='pending'
         AND q.next_reconcile_at IS NOT NULL
         AND q.next_reconcile_at <= ?1
       ORDER BY q.next_reconcile_at,q.request_id
       LIMIT ?2`,
    )
    .bind(now, safeLimit)
    .all<{ request_id: string }>();
  return results.map((item) => item.request_id);
}

export interface RegistrationCheckoutAdminRow {
  requestId: string;
  registrationId: number;
  state: 'creating' | 'attached' | 'manual_review';
  registrationStatus: 'pending' | 'confirmed' | 'cancelled';
  reconcileAttempts: number;
  nextReconcileAt: string | null;
  lastError: string | null;
  lastActionBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListRegistrationCheckoutRequestsOptions {
  state?: RegistrationCheckoutAdminRow['state'];
  limit?: number;
  offset?: number;
}

/** Bounded operations projection; request JSON, customer email, secrets, and session URLs are never selected. */
export async function listRegistrationCheckoutRequests(
  db: AppDb,
  options: ListRegistrationCheckoutRequestsOptions = {},
): Promise<RegistrationCheckoutAdminRow[]> {
  const limit = Math.max(1, Math.min(100, Number.isSafeInteger(options.limit) ? options.limit! : 50));
  const offset = Math.max(0, Math.min(10_000, Number.isSafeInteger(options.offset) ? options.offset! : 0));
  const { results } = await db.prepare(`
    SELECT q.request_id AS "requestId",q.registration_id AS "registrationId",q.state,
      r.status AS "registrationStatus",q.reconcile_attempts AS "reconcileAttempts",
      q.next_reconcile_at AS "nextReconcileAt",q.last_error AS "lastError",
      q.last_action_by AS "lastActionBy",q.created_at AS "createdAt",q.updated_at AS "updatedAt"
    FROM church_private.stripe_checkout_requests q
    JOIN registrations r ON r.id=q.registration_id
    WHERE q.state IN ('creating','attached','manual_review')
      AND (CAST(?1 AS TEXT) IS NULL OR q.state=?1)
    ORDER BY q.updated_at DESC,q.request_id DESC
    LIMIT ?2 OFFSET ?3
  `).bind(options.state ?? null, limit, offset).all<RegistrationCheckoutAdminRow>();
  return results;
}

export async function claimRegistrationCheckoutRequest(
  db: AppDb,
  requestIdValue: string,
  input: {
    now: string;
    claimExpiresAt: string;
    claimVersion: string;
    force: boolean;
    actorId: number | null;
    incrementAttempts: boolean;
    allowUnattachedManualReview?: boolean;
  },
): Promise<RegistrationCheckoutRecoveryClaim | null> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  const existing = await loadRequest(db, requestId);
  if (!existing || existing.status !== 'pending') return null;
  if (!['creating', 'attached', 'manual_review'].includes(existing.state)) return null;
  if (
    existing.state === 'manual_review'
    && existing.stripe_checkout_session_id === null
    && !input.allowUnattachedManualReview
  ) return null;
  // A manual request may bypass a future checkpoint, but never an active claim lease.
  if (input.force && (existing.updated_at >= input.now || hasActiveRecoveryClaim(existing, input.now))) return null;
  let requestJson: StripeCheckoutParams | null = null;
  let requestInvalid = false;
  if (existing.request_json !== null) {
    try {
      requestJson = requireStoredParams(existing.request_json, existing);
    } catch {
      requestInvalid = true;
    }
  }
  const claimed = await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests q
       SET reconcile_attempts=reconcile_attempts+?9,
           next_reconcile_at=?1,
           last_action_by=COALESCE(?2,last_action_by),
           updated_at=?3
       WHERE q.request_id=?4
         AND q.updated_at=?5
         AND q.state=?6
         AND (?7=1 OR (q.next_reconcile_at IS NOT NULL AND q.next_reconcile_at <= ?8))
         AND EXISTS (
           SELECT 1 FROM registrations r WHERE r.id=q.registration_id AND r.status='pending'
         )
       RETURNING q.request_id AS request_id`,
    )
    .bind(
      input.claimExpiresAt,
      input.actorId,
      input.claimVersion,
      requestId,
      existing.updated_at,
      existing.state,
      input.force ? 1 : 0,
      input.now,
      input.incrementAttempts ? 1 : 0,
    )
    .first<{ request_id: string }>();
  if (!claimed) return null;
  return {
    requestId,
    registrationId: existing.registration_id,
    state: existing.state as RegistrationCheckoutRecoveryClaim['state'],
    requestJson,
    sessionId: existing.stripe_checkout_session_id,
    amountCents: existing.amount_cents,
    currency: existing.currency,
    createdAt: existing.created_at,
    claimVersion: input.claimVersion,
    reconcileAttempts: existing.reconcile_attempts + (input.incrementAttempts ? 1 : 0),
    previousNextReconcileAt: existing.next_reconcile_at,
    requestInvalid,
  };
}

/** Release a manual validation claim without consuming the automated schedule. */
export async function releaseRegistrationCheckoutRecoveryClaim(
  db: AppDb,
  claim: RegistrationCheckoutRecoveryClaim,
  input: { error: string; actorId: number; updatedAt: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests
       SET next_reconcile_at=?1,last_error=?2,last_action_by=?3,updated_at=?4
       WHERE request_id=?5 AND registration_id=?6 AND state=?7 AND updated_at=?8`,
    )
    .bind(
      claim.previousNextReconcileAt,
      input.error,
      input.actorId,
      input.updatedAt,
      claim.requestId,
      claim.registrationId,
      claim.state,
      claim.claimVersion,
    )
    .run();
  return result.meta.changes === 1;
}

export async function registrationCheckoutClaimIsCurrent(
  db: AppDb,
  claim: RegistrationCheckoutRecoveryClaim,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM church_private.stripe_checkout_requests q
         JOIN registrations r ON r.id=q.registration_id
         WHERE q.request_id=?1 AND q.registration_id=?2 AND q.state=?3
           AND q.updated_at=?4 AND r.status='pending'
       ) AS current`,
    )
    .bind(claim.requestId, claim.registrationId, claim.state, claim.claimVersion)
    .first<{ current: boolean | number }>();
  return row?.current === true || row?.current === 1;
}

export async function scheduleClaimedRegistrationCheckoutRequest(
  db: AppDb,
  claim: RegistrationCheckoutRecoveryClaim,
  input: { nextAt: string; error: string; updatedAt: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests
       SET next_reconcile_at=?1,last_error=?2,updated_at=?3
       WHERE request_id=?4 AND registration_id=?5 AND state=?6 AND updated_at=?7`,
    )
    .bind(input.nextAt, input.error, input.updatedAt, claim.requestId, claim.registrationId, claim.state, claim.claimVersion)
    .run();
  return result.meta.changes === 1;
}

export async function markClaimedRegistrationCheckoutManualReview(
  db: AppDb,
  claim: RegistrationCheckoutRecoveryClaim,
  input: { error: string; actorId: number | null; updatedAt: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests
       SET state='manual_review',request_json=NULL,session_url=NULL,next_reconcile_at=NULL,
           last_error=?1,last_action_by=COALESCE(?2,last_action_by),updated_at=?3
       WHERE request_id=?4 AND registration_id=?5 AND state=?6 AND updated_at=?7`,
    )
    .bind(input.error, input.actorId, input.updatedAt, claim.requestId, claim.registrationId, claim.state, claim.claimVersion)
    .run();
  return result.meta.changes === 1;
}

async function cleanupTerminalRequest(db: AppDb, row: CheckoutRequestRow): Promise<void> {
  await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests
       SET state = 'resolved', request_json = NULL, session_url = NULL,
           next_reconcile_at = NULL,
           last_error = CASE WHEN last_error = 'manual_cancel' THEN last_error ELSE NULL END,
           updated_at = datetime('now')
       WHERE request_id = ?1 AND registration_id = ?2`,
    )
    .bind(row.request_id, row.registration_id)
    .run();
}

async function resolveRow(
  db: AppDb,
  row: CheckoutRequestRow,
  digest: string,
): Promise<CheckoutRequestResolution> {
  // Digest mismatch always wins, including over terminal cleanup, so a reused
  // browser identity can never mutate the original pair.
  if (row.request_sha256 !== digest) return { kind: 'conflict' };
  return resolveStoredRow(db, row);
}

async function resolveStoredRow(db: AppDb, row: CheckoutRequestRow): Promise<CheckoutRequestResolution> {
  if (row.status === 'confirmed') {
    await cleanupTerminalRequest(db, row);
    return { kind: 'done', registrationId: row.registration_id };
  }
  if (row.status === 'cancelled') {
    await cleanupTerminalRequest(db, row);
    return { kind: 'expired' };
  }
  if (row.state === 'creating') {
    if (row.stripe_checkout_session_id !== null) return { kind: 'waiting', registrationId: row.registration_id };
    if (row.request_json === null) throw new Error('checkout_request_corrupt');
    return {
      kind: 'create',
      registrationId: row.registration_id,
      requestId: row.request_id,
      requestJson: requireStoredParams(row.request_json, row),
    };
  }
  if (row.state === 'attached') {
    if (row.session_url !== null) {
      let url: URL;
      try {
        url = new URL(row.session_url);
      } catch {
        throw new Error('checkout_request_corrupt');
      }
      if (
        url.protocol !== 'https:'
        || url.hostname !== 'checkout.stripe.com'
        || url.username
        || url.password
        || url.port
      ) {
        throw new Error('checkout_request_corrupt');
      }
      return { kind: 'redirect', registrationId: row.registration_id, checkoutUrl: row.session_url };
    }
    return { kind: 'waiting', registrationId: row.registration_id };
  }
  if (row.state === 'manual_review') {
    return { kind: 'review', registrationId: row.registration_id, reason: 'manual_review' };
  }
  return { kind: 'review', registrationId: row.registration_id, reason: 'request_resolved_while_pending' };
}

function isPgError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

/**
 * Resolve an existing browser request or atomically create its held-seat
 * registration, normalized answers, and private reproducible Stripe request.
 */
export async function resolveRegistrationCheckoutRequest(
  db: AppDb,
  input: RegistrationCheckoutRequestInput,
): Promise<CheckoutRequestResolution> {
  const requestId = parseCheckoutRequestId(input.requestId);
  const normalized = normalizeInput(input);
  const partySize = partySizeOf(normalized);
  const digest = await registrationCheckoutRequestDigest(input);
  const existing = await loadRequest(db, requestId);
  if (existing) return resolveRow(db, existing, digest);

  const reserved = await db
    .prepare(`SELECT nextval(pg_get_serial_sequence('public.registrations', 'id')) AS id`)
    .first<{ id: number }>();
  if (!reserved || !Number.isSafeInteger(reserved.id) || reserved.id <= 0) throw new Error('checkout_registration_id_unavailable');
  const registrationId = reserved.id;
  const requestJson = buildRegistrationCheckoutParams({ ...input, registrationId });
  // Ticket-typed event: the types must be this event's active ones at the prices billed (priceTicketSelection
  // throws ticket_type_required / ticket_type_invalid), so the form can never name a type or a price.
  // Always checked, whatever the caller sent: an event with active ticket types never accepts an untyped
  // request (priceTicketSelection throws ticket_type_required) and the totals must match the database.
  const priced = await priceTicketSelection(db, normalized.eventId, normalized.party?.attendees ?? [{ ticketTypeId: null }]);
  if (normalized.tickets ? priced !== normalized.amountCents : priced !== null) throw new Error('ticket_type_invalid');
  // An event that requires approval is free (no seat is held for payment there): refuse before reserving anything.
  const approval = await db.prepare(`SELECT requires_approval FROM reg_events WHERE id = ?1`).bind(normalized.eventId).first<{ requires_approval: number }>();
  if (approval?.requires_approval === 1) throw new Error('approval_requires_free');
  const serializedRequest = JSON.stringify(requestJson);
  const statements: AppStatement[] = [
    // Acquire the parent-row lock before the registration insert takes its FK
    // key-share lock. Capacity-one contenders therefore serialize instead of
    // deadlocking when they reach the final recount guard.
    db
      .prepare(`SELECT id FROM reg_events WHERE id = ?1 FOR UPDATE`)
      .bind(normalized.eventId),
    // Take the next confirmation number (the same counter the free path uses).
    db.prepare(EVENT_LOCK_AND_NUMBER_SQL).bind(normalized.eventId),
    // The key is derived from the browser request id, so a retry converges on the
    // same registration; ':' keeps it outside the client key alphabet. A paid
    // registration never waitlists: the capacity guard below refuses it instead.
    db
      .prepare(
        `INSERT INTO registrations
           (id, event_id, person_id, name, email, status, amount_cents, currency, submission_key, confirmation_no, party_size,
            locale, phone, payment_method)
         SELECT ?1, e.id, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ${confirmationNoSql('e')}, ?9, ?10, ?11, 'stripe'
         FROM reg_events e WHERE e.id = ?2 AND e.is_template = 0 AND e.requires_approval = 0`,
      )
      .bind(
        registrationId,
        normalized.eventId,
        normalized.personId,
        normalized.name,
        normalized.email,
        // The registration's amount is the whole party's: per-person price times people, or the sum of the ticket prices.
        totalOf(normalized),
        normalized.currency,
        `checkout:${requestId}`,
        partySize,
        input.locale,
        normalized.party?.phone ?? null,
      ),
  ];
  const attendees = normalized.party?.attendees ?? [{ name: normalized.name, personId: normalized.personId }];
  attendees.forEach((attendee, index) => {
    // The first person defaults to the contact's own account, like the free writer.
    const personId = index === 0 ? (attendee.personId ?? normalized.personId) : attendee.personId;
    statements.push(
      db
        .prepare(`INSERT INTO reg_attendees (registration_id, sort, name, person_id, ticket_type_id) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(registrationId, index, attendee.name, personId, (attendee as { ticketTypeId?: number | null }).ticketTypeId ?? null),
    );
  });
  for (const [questionId, value] of normalized.answers) {
    statements.push(
      db
        .prepare(`INSERT INTO reg_answers (registration_id, question_id, value) VALUES (?1, ?2, ${storedAnswerSql('?3')})`)
        .bind(registrationId, questionId, value),
    );
  }
  attendees.forEach((attendee, index) => {
    for (const [questionId, value] of (attendee as { answers?: Array<[number, string]> }).answers ?? []) {
      statements.push(
        db
          .prepare(
            `INSERT INTO reg_attendee_answers (attendee_id, question_id, value)
             SELECT a.id, CAST(?3 AS INTEGER), ${storedAnswerSql('?4')} FROM reg_attendees a
             WHERE a.registration_id = ?1 AND a.sort = CAST(?2 AS INTEGER)`,
          )
          .bind(registrationId, index, questionId, value),
      );
    }
  });
  statements.push(
    db
      .prepare(
        `INSERT INTO church_private.stripe_checkout_requests
           (request_id, request_sha256, registration_id, request_json, state, next_reconcile_at)
         VALUES (?1, ?2, ?3, ?4, 'creating', datetime('now','+45 minutes'))`,
      )
      .bind(requestId, digest, registrationId, serializedRequest),
  );
  // This is intentionally the final statement in the transaction. A zero
  // denominator raises SQLSTATE 22012, causing PgAdapter.batch to roll back the
  // registration, every answer, and the private request as one unit.
  statements.push(
    db
      .prepare(
        `SELECT 1 / CASE
           WHEN e.capacity IS NULL OR held.taken <= e.capacity THEN 1
           ELSE 0
         END AS capacity_guard
         FROM reg_events e
         CROSS JOIN (
           SELECT ${seatsTakenSql('e2.id')}::integer AS taken
           FROM reg_events e2 WHERE e2.id = ?1
         ) held
         WHERE e.id = ?1
         FOR UPDATE OF e`,
      )
      .bind(normalized.eventId),
  );

  // Each ticket type's limit holds the seats (people) already taken, this party included.
  {
    statements.push(
      db
        .prepare(
          `SELECT 1 / CASE WHEN NOT EXISTS (
             SELECT 1 FROM reg_ticket_types tt
             WHERE tt.event_id = ?1 AND tt.capacity IS NOT NULL
               AND (SELECT COUNT(*) FROM reg_attendees ta JOIN registrations r2 ON r2.id = ta.registration_id
                    WHERE ta.ticket_type_id = tt.id AND ta.status = 'active'
                      AND r2.status IN (${SEAT_STATUSES.map((status) => `'${status}'`).join(',')})) > tt.capacity
           ) THEN 1 ELSE 0 END AS ticket_capacity_guard`,
        )
        .bind(normalized.eventId),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    if (isPgError(error, '22012')) throw new Error('event_full');
    if (isPgError(error, '23505')) {
      const winner = await loadRequest(db, requestId);
      if (winner) return resolveRow(db, winner, digest);
    }
    throw error;
  }
  return { kind: 'create', registrationId, requestId, requestJson };
}

/** Continue an exact durable request without asking the browser to replay identity or answers. */
export async function continueRegistrationCheckoutRequest(
  db: AppDb,
  requestIdValue: unknown,
  eventId: number,
): Promise<CheckoutRequestResolution> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return { kind: 'conflict' };
  const row = await loadRequest(db, requestId);
  if (!row || row.event_id !== eventId) return { kind: 'conflict' };
  return resolveStoredRow(db, row);
}

export interface AttachRegistrationCheckoutRequestInput {
  requestId: string;
  registrationId: number;
  sessionId: string;
  sessionUrl: string;
  amountCents: number;
  currency: string;
}

/**
 * Attach the verified create response and clear reproducible request data in one
 * transaction. The final guard deliberately raises on any partial/mismatched
 * update so PgAdapter rolls the pair back together.
 */
export async function attachRegistrationCheckoutRequest(
  db: AppDb,
  input: AttachRegistrationCheckoutRequestInput,
): Promise<boolean> {
  const requestId = parseCheckoutRequestId(input.requestId);
  if (!/^cs_(?:test|live)_[A-Za-z0-9_]{1,240}$/.test(input.sessionId)) return false;
  let url: URL;
  try {
    url = new URL(input.sessionUrl);
  } catch {
    return false;
  }
  if (
    input.sessionUrl.length > 2048
    || url.protocol !== 'https:'
    || url.hostname !== 'checkout.stripe.com'
    || url.username
    || url.password
    || url.port
  ) {
    return false;
  }
  if (!Number.isSafeInteger(input.registrationId) || input.registrationId <= 0) return false;
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || !/^[a-z]{3}$/.test(input.currency)) return false;
  try {
    await db.batch([
      db.prepare(`
        UPDATE registrations
        SET stripe_checkout_session_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND status='pending' AND amount_cents=?3 AND currency=?4
          AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id=?1)
      `).bind(input.sessionId, input.registrationId, input.amountCents, input.currency),
      db.prepare(`
        UPDATE church_private.stripe_checkout_requests
        SET state='attached',request_json=NULL,session_url=?1,last_error=NULL,updated_at=datetime('now')
        WHERE request_id=?2 AND registration_id=?3 AND state='creating' AND request_json IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM registrations r
            WHERE r.id=?3 AND r.status='pending' AND r.stripe_checkout_session_id=?4
          )
      `).bind(input.sessionUrl, requestId, input.registrationId, input.sessionId),
      db.prepare(`
        SELECT 1 / CASE WHEN EXISTS (
          SELECT 1 FROM registrations r
          JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
          WHERE r.id=?1 AND r.status='pending' AND r.stripe_checkout_session_id=?2
            AND q.request_id=?3 AND q.state='attached' AND q.request_json IS NULL AND q.session_url=?4
        ) THEN 1 ELSE 0 END AS attachment_guard
      `).bind(input.registrationId, input.sessionId, requestId, input.sessionUrl),
    ]);
    return true;
  } catch (error) {
    if (isPgError(error, '22012')) return false;
    throw error;
  }
}

/** Definitive preflight/4xx compensation; never used for ambiguous failures. */
export async function cancelRegistrationCheckoutRequest(
  db: AppDb,
  requestIdValue: string,
  registrationId: number,
): Promise<boolean> {
  const requestId = parseCheckoutRequestId(requestIdValue);
  if (!Number.isSafeInteger(registrationId) || registrationId <= 0) return false;
  try {
    await db.batch([
      db.prepare(`
        UPDATE registrations SET status='cancelled',updated_at=datetime('now')
        WHERE id=?1 AND status='pending' AND stripe_checkout_session_id IS NULL
      `).bind(registrationId),
      db.prepare(`
        UPDATE church_private.stripe_checkout_requests
        SET state='resolved',request_json=NULL,session_url=NULL,next_reconcile_at=NULL,
            last_error=NULL,updated_at=datetime('now')
        WHERE request_id=?1 AND registration_id=?2 AND state='creating'
          AND EXISTS (SELECT 1 FROM registrations r WHERE r.id=?2 AND r.status='cancelled')
      `).bind(requestId, registrationId),
      db.prepare(`
        SELECT 1 / CASE WHEN EXISTS (
          SELECT 1 FROM registrations r
          JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
          WHERE r.id=?1 AND r.status='cancelled' AND q.request_id=?2
            AND q.state='resolved' AND q.request_json IS NULL AND q.session_url IS NULL
        ) THEN 1 ELSE 0 END AS cancellation_guard
      `).bind(registrationId, requestId),
    ]);
    return true;
  } catch (error) {
    if (isPgError(error, '22012')) return false;
    throw error;
  }
}
