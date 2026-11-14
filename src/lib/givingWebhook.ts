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
import {
  findInvoiceIdsByPaymentIntent,
  livemodeMatches,
  retrieveInvoiceWithPayments,
  retrieveSubscription,
  StripeError,
  stripeMode,
  type StripeEnv,
} from './stripe';
import type { StripeDispatchResult } from './stripeWebhookInbox';
import {
  applyGiftRefund,
  backfillGiftStripeIds,
  findGiftByCharge,
  findGiftByInvoice,
  findGiftByPaymentIntent,
  getFundCampus,
  getRecurringBySubscription,
  insertCardGift,
  markAchGiftFailed,
  markGiftDisputed,
  markRecurringPastDue,
  reinstateDisputedGift,
  setRecurringStatus,
  setStripeCustomer,
  settlePendingGift,
  syncRecurringGift,
  unixToUtcSql,
  upsertRecurringGift,
  type GiftIdentity,
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
/** A concrete Stripe PaymentIntent id; expanded/foreign/malformed values are rejected. */
function paymentIntentIdOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^pi_[A-Za-z0-9_]{1,252}$/.test(v) ? v : null;
}
/** A Stripe expandable reference may be an id string or an expanded object. */
function expandableId(v: unknown): string | null {
  if (typeof v === 'string') return strOrNull(v);
  if (!v || typeof v !== 'object') return null;
  return strOrNull((v as Record<string, unknown>).id);
}
/** Subscription reference across pre-Basil and current Invoice shapes. */
function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent;
  if (parent && typeof parent === 'object') {
    const parentRecord = parent as Record<string, unknown>;
    if (parentRecord.type === 'subscription_details') {
      const details = parentRecord.subscription_details;
      if (details && typeof details === 'object') {
        const current = expandableId((details as Record<string, unknown>).subscription);
        if (current) return current;
      }
    }
  }
  return expandableId(invoice.subscription);
}
/**
 * A single PaymentIntent across pre-Basil and current Invoice shapes. Current
 * invoices may have zero or several payments, so only return an id when exactly
 * one distinct payment_intent member is present; the invoice id remains the
 * authoritative dedup key in every case.
 */
function invoicePaymentIntentId(invoice: Record<string, unknown>): string | null {
  const payments = invoice.payments;
  if (payments && typeof payments === 'object') {
    const data = (payments as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      const ids = new Set<string>();
      for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        const payment = (item as Record<string, unknown>).payment;
        if (!payment || typeof payment !== 'object') continue;
        const member = payment as Record<string, unknown>;
        if (member.type !== 'payment_intent') continue;
        const id = expandableId(member.payment_intent);
        if (id) ids.add(id);
      }
      return ids.size === 1 ? [...ids][0] : null;
    }
  }
  return expandableId(invoice.payment_intent);
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
  interval: 'week' | 'month' | 'year';
  status: string | null;
  campusMeta: unknown;
}

/** Build the recurring-gift fields from a retrieved subscription object, or null
 *  when it is not one of ours / is missing a field we require. `status` is null
 *  for a Stripe state we do not track (leave an existing row's status alone). */
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
  if (amountCents === null || (interval !== 'week' && interval !== 'month' && interval !== 'year')) return null;
  return {
    personId,
    fundId,
    amountCents,
    currency: strOr(price?.currency, 'usd'),
    interval,
    status: mapStatus(sub.status),
    campusMeta: meta.campus_id,
  };
}

/** Validate the campus a gift/subscription is written to. The fund is authoritative
 *  (it must exist); metadata.campus_id, when present, must agree with it. A legacy
 *  session without campus_id inherits the fund's campus. Null means reject. */
async function resolveCampus(deps: WebhookDeps, fundId: number, campusMeta: unknown): Promise<number | null> {
  const fundCampus = await getFundCampus(deps.db, fundId);
  if (fundCampus === null) return null;
  if (campusMeta === undefined || campusMeta === null || campusMeta === '') return fundCampus;
  const claimed = intOrNull(campusMeta);
  return claimed === fundCampus ? fundCampus : null;
}

/** True when the runtime is configured for Stripe live mode. */
const isLive = (deps: WebhookDeps): boolean => stripeMode(deps.env) === 'live';

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
  const transition = await applyRegistrationCheckoutSession(deps.db, {
    registrationId,
    requestId,
    sessionId,
    paymentIntentId: action === 'confirm' ? strOrNull(session.payment_intent) : null,
    amountCents: amountCents as number,
    currency,
    action,
  }, deps.checkpoint);
  return registrationResult(transition, action);
}

type PaymentSessionOutcome = 'succeeded' | 'pending' | 'failed';

/**
 * Record a one-time gift Checkout Session in the state Stripe reports. Card
 * payments arrive 'paid'; ACH (us_bank_account) completes 'unpaid' and settles
 * days later via async_payment_succeeded / async_payment_failed. Every call is an
 * idempotent insert-then-guarded-transition, so the three events converge on one
 * row whatever order they arrive in, and a settled gift is never downgraded.
 * paid_at is Stripe's own event time, never the insert time.
 */
async function recordPaymentSession(
  deps: WebhookDeps,
  session: Record<string, unknown>,
  outcome: PaymentSessionOutcome,
  method: 'card' | 'us_bank_account',
  eventTime: string | null,
): Promise<StripeDispatchResult> {
  const meta = getMeta(session);
  const fundId = intOrNull(meta.fund_id);
  const amountTotal = session.amount_total;
  const paymentIntentId = paymentIntentIdOrNull(session.payment_intent);
  if (fundId === null || typeof amountTotal !== 'number' || paymentIntentId === null) return ignored();
  const campusId = await resolveCampus(deps, fundId, meta.campus_id);
  if (campusId === null) return ignored('campus_mismatch');
  const personId = intOrNull(meta.person_id);
  const details = session.customer_details as { email?: unknown } | undefined;
  const paidAt = outcome === 'succeeded' ? eventTime : null;
  await checked(deps);
  await insertCardGift(deps.db, {
    personId,
    donorName: strOrNull(meta.donor_name),
    donorEmail: strOrNull(details?.email) ?? strOrNull(meta.donor_email),
    fundId,
    amountCents: amountTotal,
    currency: strOr(session.currency, 'usd'),
    sessionId: strOrNull(session.id),
    paymentIntentId,
    method,
    status: outcome,
    paidAt,
    livemode: isLive(deps),
    campusId,
  });
  if (outcome !== 'pending') {
    await checked(deps);
    await settlePendingGift(deps.db, paymentIntentId, { status: outcome, paidAt });
  }
  const customerId = strOrNull(session.customer);
  if (outcome !== 'failed' && personId !== null && customerId) {
    await checked(deps);
    await setStripeCustomer(deps.db, personId, customerId, isLive(deps), campusId);
  }
  return processed(outcome === 'pending' ? 'gift_pending' : outcome === 'failed' ? 'gift_failed' : 'gift_recorded');
}

async function onCheckoutCompleted(
  deps: WebhookDeps,
  session: Record<string, unknown>,
  eventType: string,
  eventTime: string | null,
): Promise<StripeDispatchResult> {
  if (metaKind(session) === 'registration') {
    if (session.payment_status !== 'paid') return ignored('awaiting_async_payment');
    return applyRegistrationSession(deps, session, 'confirm');
  }
  if (metaKind(session) !== 'gift') return ignored();
  const mode = session.mode;

  if (mode === 'payment') {
    const asyncSettled = eventType === 'checkout.session.async_payment_succeeded';
    if (session.payment_status === 'paid') {
      return recordPaymentSession(deps, session, 'succeeded', asyncSettled ? 'us_bank_account' : 'card', eventTime);
    }
    // 'unpaid' is how Checkout reports a bank debit that is still processing: book
    // it as PENDING money (never counted) and wait for the async settle event.
    if (session.payment_status === 'unpaid' && !asyncSettled) {
      return recordPaymentSession(deps, session, 'pending', 'us_bank_account', eventTime);
    }
    return ignored('awaiting_async_payment');
  }

  if (mode === 'subscription') {
    const subId = strOrNull(session.subscription);
    if (!subId) return ignored();
    await checked(deps);
    const sub = await retrieveSubscription(deps.env, subId, { fetcher: deps.fetcher });
    const rec = recurringFromSub(sub);
    if (!rec) return ignored();
    const campusId = await resolveCampus(deps, rec.fundId, rec.campusMeta);
    if (campusId === null) return ignored('campus_mismatch');
    await checked(deps);
    await upsertRecurringGift(deps.db, {
      ...rec,
      status: rec.status ?? 'active',
      subscriptionId: subId,
      livemode: isLive(deps),
      campusId,
    });
    // The money rows come from invoice.paid; here we only persist the customer.
    const customerId = strOrNull(session.customer) ?? strOrNull(sub.customer);
    if (customerId) {
      await checked(deps);
      await setStripeCustomer(deps.db, rec.personId, customerId, isLive(deps), campusId);
    }
    return processed('recurring_started');
  }

  return ignored();
}

/** An ACH Checkout whose bank debit failed: the pending gift becomes failed. */
async function onAsyncPaymentFailed(
  deps: WebhookDeps,
  session: Record<string, unknown>,
  eventTime: string | null,
): Promise<StripeDispatchResult> {
  if (getMeta(session).kind !== 'gift' || session.mode !== 'payment') return ignored();
  return recordPaymentSession(deps, session, 'failed', 'us_bank_account', eventTime);
}

/**
 * Learn the PaymentIntent behind an invoice-keyed gift. Current API versions do not
 * put it on the invoice.paid payload, so expand the invoice's payments. Best effort:
 * refunds and disputes still attribute through the invoice without it.
 */
async function backfillInvoicePaymentIntent(deps: WebhookDeps, invoiceId: string): Promise<void> {
  const gift = await findGiftByInvoice(deps.db, invoiceId);
  if (!gift || gift.stripe_payment_intent_id) return;
  try {
    const expanded = await retrieveInvoiceWithPayments(deps.env, invoiceId, { fetcher: deps.fetcher });
    const pi = paymentIntentIdOrNull(invoicePaymentIntentId(expanded));
    if (pi) await backfillGiftStripeIds(deps.db, gift.id, { paymentIntentId: pi });
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
  }
}

async function onInvoicePaid(
  deps: WebhookDeps,
  invoice: Record<string, unknown>,
  eventTime: string | null,
): Promise<StripeDispatchResult> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return ignored(); // one-time payments emit no invoice — be defensive
  const amountPaid = invoice.amount_paid;
  if (!Number.isInteger(amountPaid) || (amountPaid as number) <= 0) return ignored();
  const invoiceId = expandableId(invoice.id);
  const paymentIntentId = paymentIntentIdOrNull(invoicePaymentIntentId(invoice));
  if (!invoiceId && !paymentIntentId) return ignored();
  let rec = await getRecurringBySubscription(deps.db, subId);
  if (!rec) {
    // Webhook-order race: invoice.paid can arrive before checkout.session.completed.
    // Pull the subscription from Stripe and back-fill the recurring row first.
    await checked(deps);
    const sub = await retrieveSubscription(deps.env, subId, { fetcher: deps.fetcher });
    const built = recurringFromSub(sub);
    if (!built) return ignored();
    const campusId = await resolveCampus(deps, built.fundId, built.campusMeta);
    if (campusId === null) return ignored('campus_mismatch');
    await checked(deps);
    await upsertRecurringGift(deps.db, {
      ...built,
      status: built.status ?? 'active',
      subscriptionId: subId,
      livemode: isLive(deps),
      campusId,
    });
    rec = { person_id: built.personId, fund_id: built.fundId, campus_id: campusId };
  }
  const transitions = invoice.status_transitions as { paid_at?: unknown } | undefined;
  const chargeId = typeof invoice.charge === 'string' ? invoice.charge : null; // pre-Basil shape only
  await checked(deps);
  await insertCardGift(deps.db, {
    personId: rec.person_id,
    donorName: null,
    donorEmail: strOrNull(invoice.customer_email),
    fundId: rec.fund_id,
    amountCents: amountPaid as number,
    currency: strOr(invoice.currency, 'usd'),
    sessionId: null,
    paymentIntentId,
    invoiceId,
    subscriptionId: subId,
    chargeId,
    paidAt: unixToUtcSql(transitions?.paid_at) ?? eventTime,
    livemode: isLive(deps),
    campusId: rec.campus_id,
  });
  if (invoiceId && !paymentIntentId) {
    await checked(deps);
    await backfillInvoicePaymentIntent(deps, invoiceId);
  }
  return processed('gift_recorded');
}

/** Stripe emails the donor itself (dunning); we only mirror the state. No email from here. */
async function onInvoicePaymentFailed(deps: WebhookDeps, invoice: Record<string, unknown>): Promise<StripeDispatchResult> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return ignored();
  await checked(deps);
  return (await markRecurringPastDue(deps.db, subId)) ? processed('recurring_past_due') : ignored('recurring_not_active');
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

// ── refunds, disputes, bank failures: attribute by the database, not metadata ──
interface ChargeRef {
  chargeId: string | null;
  paymentIntentId: string | null;
  /** Pre-Basil charges expose the invoice id directly. */
  invoiceId: string | null;
  /** Allow the Stripe invoice-payments lookup (skipped for noisy event types). */
  lookup: boolean;
}

/**
 * Find OUR gift behind a Stripe charge. Order: stored charge id, PaymentIntent,
 * `charge.invoice` against gifts.stripe_invoice_id, then (current API) the Stripe
 * invoice-payments lookup by PaymentIntent. A hit back-fills the missing ids so the
 * next event resolves directly. No match means the charge is not ours (a
 * registration, another app on the same Stripe account): the caller ignores it.
 */
async function attributeGift(deps: WebhookDeps, ref: ChargeRef): Promise<GiftIdentity | null> {
  let gift: GiftIdentity | null = null;
  if (ref.chargeId) gift = await findGiftByCharge(deps.db, ref.chargeId);
  if (!gift && ref.paymentIntentId) gift = await findGiftByPaymentIntent(deps.db, ref.paymentIntentId);
  if (!gift && ref.invoiceId) gift = await findGiftByInvoice(deps.db, ref.invoiceId);
  if (!gift && ref.paymentIntentId && ref.lookup) {
    await checked(deps);
    const invoiceIds = await findInvoiceIdsByPaymentIntent(deps.env, ref.paymentIntentId, { fetcher: deps.fetcher });
    for (const invoiceId of invoiceIds) {
      gift = await findGiftByInvoice(deps.db, invoiceId);
      if (gift) break;
    }
  }
  if (gift && (!gift.stripe_payment_intent_id || !gift.stripe_charge_id)) {
    await backfillGiftStripeIds(deps.db, gift.id, {
      paymentIntentId: ref.paymentIntentId,
      chargeId: ref.chargeId,
    });
  }
  return gift;
}

function chargeRef(charge: Record<string, unknown>, lookup: boolean): ChargeRef {
  return {
    chargeId: strOrNull(charge.id),
    paymentIntentId: paymentIntentIdOrNull(expandableId(charge.payment_intent)),
    invoiceId: expandableId(charge.invoice),
    lookup,
  };
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
  const amountRefunded = charge.amount_refunded;
  if (typeof amountRefunded !== 'number' || !Number.isInteger(amountRefunded) || amountRefunded < 0) return ignored();
  const gift = await attributeGift(deps, chargeRef(charge, true));
  if (!gift) {
    // A charge we tagged as a gift whose row is not visible yet: replay later.
    // Anything else is foreign traffic and is ignored, never retried.
    return metaKind(charge) === 'gift' ? deferred('gift_not_visible') : ignored('not_our_charge');
  }
  const full = isFullRefund(charge);
  await checked(deps);
  await applyGiftRefund(deps.db, gift.id, { amountRefundedCents: amountRefunded, fullyRefunded: full });
  return processed(full ? 'refunded' : 'partial_refund');
}

async function onDispute(
  deps: WebhookDeps,
  dispute: Record<string, unknown>,
  closed: boolean,
): Promise<StripeDispatchResult> {
  const gift = await attributeGift(deps, {
    chargeId: expandableId(dispute.charge),
    paymentIntentId: paymentIntentIdOrNull(expandableId(dispute.payment_intent)),
    invoiceId: null,
    lookup: true,
  });
  if (!gift) return ignored('not_our_charge');
  await checked(deps);
  if (!closed) {
    await markGiftDisputed(deps.db, gift.id);
    return processed('disputed');
  }
  // Closed: won (or a warning that closed without escalating) is money in hand
  // again; lost stays 'disputed' so it never reaches totals or statements.
  if (dispute.status === 'won' || dispute.status === 'warning_closed') {
    await reinstateDisputedGift(deps.db, gift.id);
    return processed('dispute_won');
  }
  return processed(dispute.status === 'lost' ? 'dispute_lost' : 'dispute_closed');
}

/** A bank debit failed after we recorded it (pending or even settled): not money in hand. */
async function onChargeFailed(deps: WebhookDeps, charge: Record<string, unknown>): Promise<StripeDispatchResult> {
  const gift = await attributeGift(deps, chargeRef(charge, false));
  if (!gift) return ignored('not_our_charge');
  await checked(deps);
  return (await markAchGiftFailed(deps.db, gift.id)) ? processed('gift_failed') : ignored();
}

async function onSubscriptionChange(
  deps: WebhookDeps,
  sub: Record<string, unknown>,
  type: string,
): Promise<StripeDispatchResult> {
  if (metaKind(sub) !== 'gift') return ignored();
  const subId = strOrNull(sub.id);
  const status = type === 'customer.subscription.deleted' ? 'canceled' : mapStatus(sub.status);
  if (!subId) return ignored();
  // customer.subscription.updated also carries what the Billing Portal can change:
  // the amount (price), the interval, and our fund metadata.
  const built = type === 'customer.subscription.updated' ? recurringFromSub(sub) : null;
  if (built) {
    const campusId = await resolveCampus(deps, built.fundId, built.campusMeta);
    if (campusId === null) return ignored('campus_mismatch');
    await checked(deps);
    const synced = await syncRecurringGift(deps.db, subId, {
      amountCents: built.amountCents,
      currency: built.currency,
      interval: built.interval,
      fundId: built.fundId,
      status: built.status,
    });
    if (!synced) {
      await upsertRecurringGift(deps.db, {
        ...built,
        status: built.status ?? 'active',
        subscriptionId: subId,
        livemode: isLive(deps),
        campusId,
      });
    }
    return processed('subscription_synced');
  }
  if (!status) return ignored();
  await checked(deps);
  await setRecurringStatus(deps.db, subId, status);
  return processed('status_synced');
}

const CHARGE_EVENT_TYPES = new Set([
  'charge.refunded',
  'charge.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
]);

/**
 * Handle one verified Stripe event. Returns a short outcome string for logs
 * ('gift_recorded' | 'gift_pending' | 'recurring_started' | 'refunded' | ... |
 * 'ignored'). Every unrecognized type — and every gift event that fails the
 * metadata/shape checks above — resolves to 'ignored' without throwing. An event
 * whose livemode does not equal the configured mode is ignored (no crossover).
 */
export async function handleStripeEvent(deps: WebhookDeps, event: Record<string, unknown>): Promise<StripeDispatchResult> {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!livemodeMatches(deps.env, event.livemode)) return ignored('livemode_mismatch');
  const eventTime = unixToUtcSql(event.created);
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const object = data?.object ?? {};
  const kind = metaKind(object);
  const moduleAwareType = type === 'checkout.session.completed'
    || type === 'checkout.session.async_payment_succeeded'
    || type === 'checkout.session.async_payment_failed'
    || type === 'checkout.session.expired'
    || type === 'customer.subscription.updated'
    || type === 'customer.subscription.deleted';
  let requiredModule: ModuleKey | null = null;
  if (type === 'invoice.paid' || type === 'invoice.payment_failed') requiredModule = 'giving';
  else if (CHARGE_EVENT_TYPES.has(type)) {
    // Registration charges are handled by the registration flow, never as gifts.
    if (kind === 'registration') return ignored();
    requiredModule = 'giving';
  } else if (moduleAwareType && kind === 'gift') requiredModule = 'giving';
  else if (moduleAwareType && kind === 'registration') requiredModule = 'registration';
  if (requiredModule && !deps.modules.has(requiredModule)) return ignored('module_disabled');

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onCheckoutCompleted(deps, object, type, eventTime);
    case 'checkout.session.async_payment_failed':
      if (kind === 'registration') return applyRegistrationSession(deps, object, 'cancel');
      return kind === 'gift' ? onAsyncPaymentFailed(deps, object, eventTime) : ignored();
    case 'checkout.session.expired':
      return onCheckoutExpired(deps, object);
    case 'invoice.paid':
      return onInvoicePaid(deps, object, eventTime);
    case 'invoice.payment_failed':
      return onInvoicePaymentFailed(deps, object);
    case 'charge.refunded':
      return onChargeRefunded(deps, object);
    case 'charge.failed':
      return onChargeFailed(deps, object);
    case 'charge.dispute.created':
      return onDispute(deps, object, false);
    case 'charge.dispute.closed':
      return onDispute(deps, object, true);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionChange(deps, object, type);
    default:
      return ignored();
  }
}
