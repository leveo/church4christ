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
import type { ModuleKey } from './modules';
import { retrieveSubscription, StripeError, type StripeEnv } from './stripe';
import type { StripeDispatchResult } from './stripeWebhookInbox';
import {
  insertCardGift,
  markGiftRefunded,
  upsertRecurringGift,
  setRecurringStatus,
  getRecurringBySubscription,
  setStripeCustomer,
} from './givingDb';
import {
  applyRegistrationCheckoutSession,
  type RegistrationCheckoutAction,
  type RegistrationCheckoutTransition,
} from './regDb';

export interface WebhookDeps {
  db: AppDb;
  env: StripeEnv;
  modules: ReadonlySet<ModuleKey>;
  fetcher?: typeof fetch;
  checkpoint?: () => Promise<void>;
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
 * True when `e` is a transient database failure — a case the webhook endpoint
 * answers with a 500 so Stripe retries (anything definitively wrong is a logic
 * bug it logs and swallows as 200, since a retry would just fail again). Matches:
 *  - the postgres.js client codes / socket errnos in {@link DB_CONN_CODES};
 *  - Postgres server-side transient SQLSTATEs (postgres.js sets `.code` to the
 *    SQLSTATE): class 08 (connection exceptions, e.g. 08006 connection_failure),
 *    class 53 (insufficient resources, e.g. 53300 too_many_connections), 57P*
 *    (admin shutdown / crash / cannot_connect_now), and class 40 (transaction
 *    rollback: 40001 serialization_failure, 40P01 deadlock_detected — a retry of
 *    the same transaction is expected to succeed).
 * Money integrity depends on this classification: treating a transient failure as
 * a logic error would 200 the event and silently drop an invoice.paid instead of
 * letting Stripe redeliver it.
 */
export function isDbConnectivityError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return (
    DB_CONN_CODES.has(code) ||
    code.startsWith('08') ||
    code.startsWith('53') ||
    code.startsWith('57P') ||
    code.startsWith('40')
  );
}

/**
 * True when the webhook endpoint should 500 (→ Stripe redelivers) rather than
 * swallow the event as 200. Broader than {@link isDbConnectivityError}: a KNOWN
 * money event whose processing hit a *transient* failure — a Stripe API call that
 * failed (retrieveSubscription during the invoice-before-completed race) or a
 * network error reaching Stripe — must be retried, or the first month's gift is
 * dropped and never re-sent. Retryable when:
 *  - it is a transient DB failure ({@link isDbConnectivityError}); or
 *  - it is a StripeError: readResponse (src/lib/stripe) attaches Stripe's HTTP
 *    status as a numeric `.status` on a non-2xx (429/5xx transient, or even a 4xx
 *    during the race) — redeliver rather than drop the money; or
 *  - the Stripe seam classified a fetch rejection/timeout as a genuine
 *    StripeError transport failure; or
 *  - another network failure has a retryable socket errno nested on `.cause`.
 * NOT retryable — a definitive logic/constraint error (a 23xxx constraint
 * violation, a plain TypeError from a real bug) returns 200 so a broken handler
 * can't wedge an infinite retry loop.
 */
export function isRetryableWebhookError(e: unknown): boolean {
  if (isDbConnectivityError(e)) return true;
  if (e instanceof StripeError && e.stage === 'transport') return true;
  if (typeof (e as { status?: unknown } | null)?.status === 'number') return true;
  if (isDbConnectivityError((e as { cause?: unknown } | null)?.cause)) return true;
  return false;
}

const processed = (outcome: string): StripeDispatchResult => ({ state: 'processed', outcome });
const ignored = (outcome = 'ignored'): StripeDispatchResult => ({ state: 'ignored', outcome });
const deferred = (outcome: string): StripeDispatchResult => ({ state: 'deferred', outcome });
const checked = async (deps: WebhookDeps): Promise<void> => deps.checkpoint?.();

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
function registrationResult(
  transition: RegistrationCheckoutTransition,
  action: RegistrationCheckoutAction,
): StripeDispatchResult {
  if (transition === 'deferred') return deferred('registration_not_visible');
  if (transition === 'mismatch') return ignored('registration_mismatch');
  return processed(action === 'confirm' ? 'registration_confirmed' : 'registration_cancelled');
}

async function applyRegistrationSession(
  deps: WebhookDeps,
  session: Record<string, unknown>,
  action: 'confirm' | 'cancel',
): Promise<StripeDispatchResult> {
  const meta = getMeta(session);
  const registrationId = intOrNull(meta.registration_id);
  const requestId = strOrNull(meta.request_id);
  const sessionId = strOrNull(session.id);
  const amountCents = session.amount_total;
  const currency = strOrNull(session.currency);
  if (
    registrationId === null
    || !sessionId
    || !Number.isInteger(amountCents)
    || (amountCents as number) < 0
    || !currency
  ) return ignored();
  await checked(deps);
  const transition = await applyRegistrationCheckoutSession(deps.db, {
    registrationId,
    requestId,
    sessionId,
    paymentIntentId: action === 'confirm' ? strOrNull(session.payment_intent) : null,
    amountCents: amountCents as number,
    currency,
    action,
  });
  return registrationResult(transition, action);
}

async function onCheckoutCompleted(
  deps: WebhookDeps,
  session: Record<string, unknown>,
): Promise<StripeDispatchResult> {
  if (metaKind(session) === 'registration') {
    if (session.payment_status !== 'paid') return ignored('awaiting_async_payment');
    return applyRegistrationSession(deps, session, 'confirm');
  }
  if (metaKind(session) !== 'gift') return ignored();
  const mode = session.mode;

  if (mode === 'payment') {
    // Only a SETTLED payment books a gift. A completed session whose payment is
    // still processing (async payment methods) or otherwise not 'paid' must not
    // record money — Stripe re-fires completion when it settles. A paid card
    // session always carries a payment_intent, so this gate also closes the
    // null-PI double-insert gap (an unpaid session has no PI to dedup on).
    if (session.payment_status !== 'paid') return ignored('awaiting_async_payment');
    const meta = getMeta(session);
    const fundId = intOrNull(meta.fund_id);
    const amountTotal = session.amount_total;
    if (fundId === null || typeof amountTotal !== 'number') return ignored();
    const personId = intOrNull(meta.person_id);
    const details = session.customer_details as { email?: unknown } | undefined;
    await checked(deps);
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
    if (personId !== null && customerId) {
      await checked(deps);
      await setStripeCustomer(deps.db, personId, customerId);
    }
    return processed('gift_recorded');
  }

  if (mode === 'subscription') {
    const subId = strOrNull(session.subscription);
    if (!subId) return ignored();
    await checked(deps);
    const sub = await retrieveSubscription(deps.env, subId, { fetcher: deps.fetcher });
    const rec = recurringFromSub(sub);
    if (!rec) return ignored();
    await checked(deps);
    await upsertRecurringGift(deps.db, { ...rec, subscriptionId: subId });
    // The money rows come from invoice.paid; here we only persist the customer.
    const customerId = strOrNull(session.customer) ?? strOrNull(sub.customer);
    if (customerId) {
      await checked(deps);
      await setStripeCustomer(deps.db, rec.personId, customerId);
    }
    return processed('recurring_started');
  }

  return ignored();
}

async function onInvoicePaid(deps: WebhookDeps, invoice: Record<string, unknown>): Promise<StripeDispatchResult> {
  const subId = strOrNull(invoice.subscription);
  if (!subId) return ignored(); // one-time payments emit no invoice — be defensive
  let rec = await getRecurringBySubscription(deps.db, subId);
  if (!rec) {
    // Webhook-order race: invoice.paid can arrive before checkout.session.completed.
    // Pull the subscription from Stripe and back-fill the recurring row first.
    await checked(deps);
    const sub = await retrieveSubscription(deps.env, subId, { fetcher: deps.fetcher });
    const built = recurringFromSub(sub);
    if (!built) return ignored();
    await checked(deps);
    await upsertRecurringGift(deps.db, { ...built, subscriptionId: subId });
    rec = { person_id: built.personId, fund_id: built.fundId };
  }
  const amountPaid = invoice.amount_paid;
  if (typeof amountPaid !== 'number') return ignored();
  await checked(deps);
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
  return processed('gift_recorded');
}

/** A Checkout session expired. Only registration sessions hold a seat, so only
 *  those need a guarded cancellation; terminal replays converge. */
async function onCheckoutExpired(
  deps: WebhookDeps,
  session: Record<string, unknown>,
): Promise<StripeDispatchResult> {
  if (metaKind(session) !== 'registration') return ignored();
  return applyRegistrationSession(deps, session, 'cancel');
}

/** True when a charge.refunded event represents a FULL refund. Stripe sets
 *  `charge.refunded` to true exactly when the entire charge has been refunded
 *  (prefer it); comparing amount_refunded against the charge total is a defensive
 *  fallback. A PARTIAL refund returns false so the gift stays 'succeeded'. */
function isFullRefund(charge: Record<string, unknown>): boolean {
  if (charge.refunded === true) return true;
  const amount = charge.amount;
  const refunded = charge.amount_refunded;
  return typeof amount === 'number' && typeof refunded === 'number' && amount > 0 && refunded >= amount;
}

async function onChargeRefunded(deps: WebhookDeps, charge: Record<string, unknown>): Promise<StripeDispatchResult> {
  const pi = strOrNull(charge.payment_intent);
  if (!pi) return ignored();
  // Only a FULL refund zeroes a gift's contribution. A partial refund ($50 on a
  // $1000 gift) must NOT flip status to 'refunded' — that would drop the whole
  // $1000 out of fundTotals/householdYearTotals (both filter status='succeeded'),
  // understating fund totals and the donor's tax statement. On a partial refund
  // we leave the gift 'succeeded' (a partial-refund ledger field is out of scope).
  if (!isFullRefund(charge)) return ignored();
  // markGiftRefunded is scoped to our gifts by PI. A signed internal full refund
  // that cannot yet see its gift is deferred for replay.
  await checked(deps);
  const moved = await markGiftRefunded(deps.db, pi);
  return moved ? processed('refunded') : deferred('gift_not_visible');
}

async function onSubscriptionChange(deps: WebhookDeps, sub: Record<string, unknown>): Promise<StripeDispatchResult> {
  if (metaKind(sub) !== 'gift') return ignored();
  const subId = strOrNull(sub.id);
  const status = mapStatus(sub.status);
  if (!subId || !status) return ignored();
  await checked(deps);
  await setRecurringStatus(deps.db, subId, status);
  return processed('status_synced');
}

/**
 * Handle one verified Stripe event. Returns a short outcome string for logs
 * ('gift_recorded' | 'recurring_started' | 'refunded' | 'status_synced' |
 * 'ignored'). Every unrecognized type — and every gift event that fails the
 * metadata/shape checks above — resolves to 'ignored' without throwing.
 */
export async function handleStripeEvent(deps: WebhookDeps, event: Record<string, unknown>): Promise<StripeDispatchResult> {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const object = data?.object ?? {};
  const kind = metaKind(object);
  const moduleAwareType = type === 'checkout.session.completed'
    || type === 'checkout.session.async_payment_succeeded'
    || type === 'checkout.session.async_payment_failed'
    || type === 'checkout.session.expired'
    || type === 'charge.refunded'
    || type === 'customer.subscription.updated'
    || type === 'customer.subscription.deleted';
  const requiredModule: ModuleKey | null = type === 'invoice.paid'
    ? 'giving'
    : moduleAwareType && kind === 'gift'
      ? 'giving'
      : moduleAwareType && kind === 'registration'
        ? 'registration'
        : null;
  if (requiredModule && !deps.modules.has(requiredModule)) return ignored('module_disabled');

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onCheckoutCompleted(deps, object);
    case 'checkout.session.async_payment_failed':
      if (kind === 'registration') return applyRegistrationSession(deps, object, 'cancel');
      return ignored(kind === 'gift' ? 'awaiting_async_payment' : 'ignored');
    case 'checkout.session.expired':
      return onCheckoutExpired(deps, object);
    case 'invoice.paid':
      return onInvoicePaid(deps, object);
    case 'charge.refunded':
      if (kind !== 'gift') return ignored();
      return onChargeRefunded(deps, object);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionChange(deps, object);
    default:
      return ignored();
  }
}
