import type { AppDb, AppStatement } from './appDb';
import { sha256Utf8 } from './stripeWebhookInbox';

export interface StripeCheckoutParams {
  mode: 'payment';
  line_items: Array<{
    quantity: 1;
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

export interface RegistrationCheckoutRequestInput {
  requestId: string;
  eventId: number;
  personId: number | null;
  name: string;
  email: string;
  amountCents: number;
  currency: string;
  answers: Array<[number, string]>;
  eventTitle: string;
  locale: 'en' | 'zh';
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
  currency: string;
  email: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Browser Checkout retries must carry the exact canonical UUID rendered by the server. */
export function parseCheckoutRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error('checkout_request_id_invalid');
  return value;
}

/** Generate the one browser identity that must survive every retry of a rendered form. */
export function newCheckoutRequestId(): string {
  return parseCheckoutRequestId(crypto.randomUUID());
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
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('checkout_amount_invalid');
  const currency = normalizeText(input.currency, 'checkout_currency_invalid').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('checkout_currency_invalid');
  const answers = input.answers.map(([questionId, value]) => {
    if (!Number.isSafeInteger(questionId) || questionId <= 0) throw new Error('checkout_answer_invalid');
    return [questionId, normalizeText(value, 'checkout_answer_invalid')] as [number, string];
  });
  answers.sort(([leftId, leftValue], [rightId, rightValue]) => leftId - rightId || leftValue.localeCompare(rightValue));
  if (answers.some(([questionId], index) => index > 0 && answers[index - 1][0] === questionId)) {
    throw new Error('checkout_answer_invalid');
  }
  return {
    eventId: input.eventId,
    personId: input.personId,
    name: normalizeText(input.name, 'checkout_identity_invalid'),
    email: normalizeText(input.email, 'checkout_identity_invalid').toLowerCase(),
    amountCents: input.amountCents,
    currency,
    answers,
  };
}

/** SHA-256 over only the normalized submitted registration identity. */
export async function registrationCheckoutRequestDigest(input: RegistrationCheckoutRequestInput): Promise<string> {
  return sha256Utf8(JSON.stringify(normalizeInput(input)));
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('checkout_origin_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('checkout_origin_invalid');
  }
  return url.origin;
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
  if (input.locale !== 'en' && input.locale !== 'zh') throw new Error('checkout_locale_invalid');
  const origin = canonicalOrigin(input.appOrigin);
  const metadata: RegistrationCheckoutMetadata = {
    kind: 'registration',
    registration_id: String(input.registrationId),
    request_id: requestId,
  };
  return {
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: normalized.currency,
        unit_amount: normalized.amountCents,
        product_data: { name: normalizeText(input.eventTitle, 'checkout_event_title_invalid') },
      },
    }],
    success_url: `${origin}/${input.locale}/register/done?ok=1&paid=1`,
    cancel_url: `${origin}/${input.locale}/register/${normalized.eventId}`,
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
  if (url.protocol !== 'https:' || url.username || url.password) corruptRequest();
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
    || parsed.line_items.length !== 1
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

  const lineItem = parsed.line_items[0];
  if (
    !isPlainObject(lineItem)
    || !hasExactKeys(lineItem, ['quantity', 'price_data'])
    || lineItem.quantity !== 1
    || !isPlainObject(lineItem.price_data)
    || !hasExactKeys(lineItem.price_data, ['currency', 'unit_amount', 'product_data'])
    || lineItem.price_data.unit_amount !== row.amount_cents
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

  const success = safeApplicationUrl(parsed.success_url);
  const cancel = safeApplicationUrl(parsed.cancel_url);
  const successMatch = success.pathname.match(/^\/(en|zh)\/register\/done$/);
  if (
    !successMatch
    || success.search !== '?ok=1&paid=1'
    || success.hash
    || cancel.origin !== success.origin
    || cancel.pathname !== `/${successMatch[1]}/register/${row.event_id}`
    || cancel.search
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
              r.event_id AS event_id, r.amount_cents AS amount_cents,
              r.currency AS currency, r.email AS email
       FROM church_private.stripe_checkout_requests q
       JOIN registrations r ON r.id = q.registration_id
       WHERE q.request_id = ?1`,
    )
    .bind(requestId)
    .first<CheckoutRequestRow>();
}

async function cleanupTerminalRequest(db: AppDb, row: CheckoutRequestRow): Promise<void> {
  await db
    .prepare(
      `UPDATE church_private.stripe_checkout_requests
       SET state = 'resolved', request_json = NULL, session_url = NULL,
           next_reconcile_at = NULL, last_error = NULL, updated_at = datetime('now')
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
  const digest = await registrationCheckoutRequestDigest(input);
  const existing = await loadRequest(db, requestId);
  if (existing) return resolveRow(db, existing, digest);

  const reserved = await db
    .prepare(`SELECT nextval(pg_get_serial_sequence('public.registrations', 'id')) AS id`)
    .first<{ id: number }>();
  if (!reserved || !Number.isSafeInteger(reserved.id) || reserved.id <= 0) throw new Error('checkout_registration_id_unavailable');
  const registrationId = reserved.id;
  const requestJson = buildRegistrationCheckoutParams({ ...input, registrationId });
  const serializedRequest = JSON.stringify(requestJson);
  const statements: AppStatement[] = [
    // Acquire the parent-row lock before the registration insert takes its FK
    // key-share lock. Capacity-one contenders therefore serialize instead of
    // deadlocking when they reach the final recount guard.
    db
      .prepare(`SELECT id FROM reg_events WHERE id = ?1 FOR UPDATE`)
      .bind(normalized.eventId),
    db
      .prepare(
        `INSERT INTO registrations
           (id, event_id, person_id, name, email, status, amount_cents, currency)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
      )
      .bind(
        registrationId,
        normalized.eventId,
        normalized.personId,
        normalized.name,
        normalized.email,
        normalized.amountCents,
        normalized.currency,
      ),
  ];
  for (const [questionId, value] of normalized.answers) {
    statements.push(
      db
        .prepare(`INSERT INTO reg_answers (registration_id, question_id, value) VALUES (?1, ?2, ?3)`)
        .bind(registrationId, questionId, value),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO church_private.stripe_checkout_requests
           (request_id, request_sha256, registration_id, request_json, state)
         VALUES (?1, ?2, ?3, ?4, 'creating')`,
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
           SELECT count(*)::integer AS taken
           FROM registrations r
           WHERE r.event_id = ?1 AND r.status IN ('pending','confirmed')
         ) held
         WHERE e.id = ?1
         FOR UPDATE OF e`,
      )
      .bind(normalized.eventId),
  );

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
  if (!/^cs_test_[A-Za-z0-9_]{1,240}$/.test(input.sessionId)) return false;
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
        SET state='attached',request_json=NULL,session_url=?1,next_reconcile_at=NULL,
            last_error=NULL,updated_at=datetime('now')
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
