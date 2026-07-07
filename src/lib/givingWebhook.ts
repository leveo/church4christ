// The Stripe webhook event dispatcher: one verified event in, a short outcome
// string out. Kept as a pure function (DB + Stripe env injected) so it unit-tests
// against real Postgres without an Astro request — the endpoint at
// src/pages/api/stripe/webhook.ts only verifies the signature and hands the parsed
// event here.
//
// Two hard rules shape every branch:
//  1. This choke point sees ALL of a church's Stripe traffic, not just giving. A
//     foreign event, a gift event with missing/foreign metadata, or a malformed
//     payload must resolve to 'ignored' — never throw — so unrelated Stripe
//     activity can't wedge the webhook into an error/retry loop.
//  2. Every writer it calls (insertCardGift, upsertRecurringGift, markGiftRefunded,
//     setRecurringStatus) is idempotent, so Stripe's at-least-once redelivery is a
//     safe no-op on the second pass.
//
// The metadata.kind gate distinguishes our traffic from everyone else's:
// kind === 'gift' is a donation (fund_id/person_id ride in metadata as strings);
// kind === 'registration' is an event sign-up (confirm/cancel the pending row by
// its attached Checkout session id). Every other kind resolves to 'ignored'.
import type { AppDb } from './appDb';
import { retrieveSubscription, type StripeEnv } from './stripe';
import {
  insertCardGift,
  markGiftRefunded,
  upsertRecurringGift,
  setRecurringStatus,
  getRecurringBySubscription,
  setStripeCustomer,
} from './givingDb';
import { confirmBySession, cancelBySession } from './regDb';

export interface WebhookDeps {
  db: AppDb;
  env: StripeEnv;
  fetcher?: typeof fetch;
}

// postgres.js client-side connection-failure codes (src/lib/dbProvider opens the
// client) plus the socket-level errnos they can surface as.
const DB_CONN_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

/**
 * True when `e` is a transient database-connectivity failure — the one case the
 * webhook endpoint answers with a 500 so Stripe retries (anything else is a logic
 * bug it logs and swallows as 200, since a retry would just fail again). Matches:
 *  - the postgres.js client codes / socket errnos in {@link DB_CONN_CODES};
 *  - Postgres server-side connection-class SQLSTATEs (postgres.js sets `.code` to
 *    the SQLSTATE): class 08 (connection exceptions, e.g. 08006 connection_failure),
 *    class 53 (insufficient resources, e.g. 53300 too_many_connections), and 57P*
 *    (admin shutdown / crash / cannot_connect_now).
 * Money integrity depends on this classification: treating a transient failure as
 * a logic error would 200 the event and silently drop an invoice.paid instead of
 * letting Stripe redeliver it.
 */
export function isDbConnectivityError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return DB_CONN_CODES.has(code) || code.startsWith('08') || code.startsWith('53') || code.startsWith('57P');
}

/** A short outcome for the log line: what the handler did with this event. */
type Outcome =
  | 'gift_recorded'
  | 'recurring_started'
  | 'refunded'
  | 'status_synced'
  | 'registration_confirmed'
  | 'registration_cancelled'
  | 'ignored';

// ── tolerant field readers (a foreign/malformed payload must never throw) ──────
function getMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const m = obj.metadata;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
}
function metaKind(obj: Record<string, unknown>): string | undefined {
  const k = getMeta(obj).kind;
  return typeof k === 'string' ? k : undefined;
}
/** A non-empty string, else null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}
/** A positive integer id from a metadata string ('' / missing → null). */
function intOrNull(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** Map a Stripe subscription status to our three-state model, or null when it is
 *  a state we don't track (leave the row untouched). */
function mapStatus(s: unknown): 'active' | 'past_due' | 'canceled' | null {
  switch (s) {
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

interface RecurringParams {
  personId: number;
  fundId: number;
  amountCents: number;
  currency: string;
  interval: 'week' | 'month';
  status: string;
}

/** Build the recurring-gift row from a retrieved subscription object, or null
 *  when it is not one of ours / is missing a field we require. */
function recurringFromSub(sub: Record<string, unknown>): RecurringParams | null {
  if (metaKind(sub) !== 'gift') return null;
  const meta = getMeta(sub);
  const fundId = intOrNull(meta.fund_id);
  const personId = intOrNull(meta.person_id);
  if (fundId === null || personId === null) return null;
  const items = sub.items as { data?: Array<{ price?: Record<string, unknown> }> } | undefined;
  const price = items?.data?.[0]?.price;
  const amountCents = typeof price?.unit_amount === 'number' ? price.unit_amount : null;
  const recurring = price?.recurring as { interval?: unknown } | undefined;
  const interval = recurring?.interval;
  if (amountCents === null || (interval !== 'week' && interval !== 'month')) return null;
  return {
    personId,
    fundId,
    amountCents,
    currency: strOr(price?.currency, 'usd'),
    interval,
    status: mapStatus(sub.status) ?? 'active',
  };
}

// ── per-event handlers ─────────────────────────────────────────────────────────
async function onCheckoutCompleted(deps: WebhookDeps, session: Record<string, unknown>): Promise<Outcome> {
  // Registration checkouts ride the same choke point as gifts, distinguished by
  // metadata.kind; a paid registration confirms the pending row its Checkout
  // session id is attached to. Matches by session id (confirmBySession), so the
  // registration_id in metadata is informational only.
  if (metaKind(session) === 'registration') {
    const sessionId = strOrNull(session.id);
    if (!sessionId) return 'ignored';
    const confirmed = await confirmBySession(deps.db, sessionId, strOrNull(session.payment_intent));
    return confirmed ? 'registration_confirmed' : 'ignored';
  }
  if (metaKind(session) !== 'gift') return 'ignored';
  const mode = session.mode;

  if (mode === 'payment') {
    const meta = getMeta(session);
    const fundId = intOrNull(meta.fund_id);
    const amountTotal = session.amount_total;
    if (fundId === null || typeof amountTotal !== 'number') return 'ignored';
    const personId = intOrNull(meta.person_id);
    const details = session.customer_details as { email?: unknown } | undefined;
    await insertCardGift(deps.db, {
      personId,
      donorName: strOrNull(meta.donor_name),
      donorEmail: strOrNull(details?.email) ?? strOrNull(meta.donor_email),
      fundId,
      amountCents: amountTotal,
      currency: strOr(session.currency, 'usd'),
      sessionId: strOrNull(session.id),
      paymentIntentId: strOrNull(session.payment_intent),
    });
    const customerId = strOrNull(session.customer);
    if (personId !== null && customerId) await setStripeCustomer(deps.db, personId, customerId);
    return 'gift_recorded';
  }

  if (mode === 'subscription') {
    const subId = strOrNull(session.subscription);
    if (!subId) return 'ignored';
    const sub = await retrieveSubscription(deps.env, subId, deps.fetcher);
    const rec = recurringFromSub(sub);
    if (!rec) return 'ignored';
    await upsertRecurringGift(deps.db, { ...rec, subscriptionId: subId });
    // The money rows come from invoice.paid; here we only persist the customer.
    const customerId = strOrNull(session.customer) ?? strOrNull(sub.customer);
    if (customerId) await setStripeCustomer(deps.db, rec.personId, customerId);
    return 'recurring_started';
  }

  return 'ignored';
}

async function onInvoicePaid(deps: WebhookDeps, invoice: Record<string, unknown>): Promise<Outcome> {
  const subId = strOrNull(invoice.subscription);
  if (!subId) return 'ignored'; // one-time payments emit no invoice — be defensive
  let rec = await getRecurringBySubscription(deps.db, subId);
  if (!rec) {
    // Webhook-order race: invoice.paid can arrive before checkout.session.completed.
    // Pull the subscription from Stripe and back-fill the recurring row first.
    const sub = await retrieveSubscription(deps.env, subId, deps.fetcher);
    const built = recurringFromSub(sub);
    if (!built) return 'ignored';
    await upsertRecurringGift(deps.db, { ...built, subscriptionId: subId });
    rec = { person_id: built.personId, fund_id: built.fundId };
  }
  const amountPaid = invoice.amount_paid;
  if (typeof amountPaid !== 'number') return 'ignored';
  await insertCardGift(deps.db, {
    personId: rec.person_id,
    donorName: null,
    donorEmail: strOrNull(invoice.customer_email),
    fundId: rec.fund_id,
    amountCents: amountPaid,
    currency: strOr(invoice.currency, 'usd'),
    sessionId: null,
    paymentIntentId: strOrNull(invoice.payment_intent),
    invoiceId: strOrNull(invoice.id),
    subscriptionId: subId,
  });
  return 'gift_recorded';
}

/** A Checkout session expired. Only registration sessions hold a seat, so only
 *  those need freeing (a gift checkout expiring records nothing). Idempotent:
 *  cancelBySession moves only a still-pending row → 'ignored' on redelivery. */
async function onCheckoutExpired(deps: WebhookDeps, session: Record<string, unknown>): Promise<Outcome> {
  if (metaKind(session) !== 'registration') return 'ignored';
  const sessionId = strOrNull(session.id);
  if (!sessionId) return 'ignored';
  const cancelled = await cancelBySession(deps.db, sessionId);
  return cancelled ? 'registration_cancelled' : 'ignored';
}

async function onChargeRefunded(deps: WebhookDeps, charge: Record<string, unknown>): Promise<Outcome> {
  const pi = strOrNull(charge.payment_intent);
  if (!pi) return 'ignored';
  // markGiftRefunded is scoped to our gifts by PI, so a foreign charge (or a
  // redelivered refund) simply moves no row → 'ignored'.
  const moved = await markGiftRefunded(deps.db, pi);
  return moved ? 'refunded' : 'ignored';
}

async function onSubscriptionChange(deps: WebhookDeps, sub: Record<string, unknown>): Promise<Outcome> {
  if (metaKind(sub) !== 'gift') return 'ignored';
  const subId = strOrNull(sub.id);
  const status = mapStatus(sub.status);
  if (!subId || !status) return 'ignored';
  await setRecurringStatus(deps.db, subId, status);
  return 'status_synced';
}

/**
 * Handle one verified Stripe event. Returns a short outcome string for logs
 * ('gift_recorded' | 'recurring_started' | 'refunded' | 'status_synced' |
 * 'ignored'). Every unrecognized type — and every gift event that fails the
 * metadata/shape checks above — resolves to 'ignored' without throwing.
 */
export async function handleStripeEvent(deps: WebhookDeps, event: Record<string, unknown>): Promise<string> {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const object = data?.object ?? {};
  switch (type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(deps, object);
    case 'checkout.session.expired':
      return onCheckoutExpired(deps, object);
    case 'invoice.paid':
      return onInvoicePaid(deps, object);
    case 'charge.refunded':
      return onChargeRefunded(deps, object);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionChange(deps, object);
    default:
      return 'ignored';
  }
}
