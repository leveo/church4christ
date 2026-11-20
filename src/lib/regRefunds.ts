// Refunds for registrations (Postgres + Stripe only). refundRegistration calls the Stripe Refunds API on the
// registration's stored PaymentIntent and records the result; recordOfflineRefund is bookkeeping for a payment
// taken outside Stripe (cash, check): no money moves. The caller has already checked the staff member's
// "payment operations" permission (the same one Giving refunds use).
//
// One cumulative total: the drawer path and the charge.refunded webhook both end in syncRefundedTotal, which only
// ever raises refunded_cents to Stripe's cumulative figure, so whichever arrives first wins and the other adds
// nothing. The Stripe idempotency key is derived from (registration, cumulative refunded target), so retrying
// the same refund (a timeout, a double click) returns the original refund instead of paying twice.
import type { AppDb } from './appDb';
import { getBackend, type DbEnv } from './dbProvider';
import { StripeError, createRefund, stripeConfiguredMode, type StripeEnv } from './stripe';
import { adminCancelRegistration } from './regAdmin';
import { notifyAfterRelease, type RegNotifyEnv } from './regNotify';
import { recordRefund, syncRefundedTotal, type RefundResult } from './regOutbox';

export type RefundFailure =
  | { ok: false; code: 'unavailable' }                    // D1 (no Stripe payments exist), or Stripe is not configured
  | { ok: false; code: 'not_found' | 'invalid_amount' | 'exceeds_paid' | 'not_stripe' | 'no_payment_intent' | 'refund_failed' };

export type StripeRefundResult =
  | { ok: true; refundedCents: number; remainingCents: number; cancelled: boolean }
  | RefundFailure;

export interface RefundInput {
  registrationId: number;
  amountCents: number;
  actor: number | null;
  /** Also cancel the registration afterwards, through the normal cancel path (the waitlist is promoted, people are emailed). */
  alsoCancel?: boolean;
}

const MAX_REFUND_CENTS = 99_999_999;

export function refundIdempotencyKey(registrationId: number, targetCumulativeCents: number): string {
  return `reg-refund:${registrationId}:${targetCumulativeCents}`;
}

/**
 * Refund `amountCents` of a card-paid registration through Stripe. Guards: Postgres + configured Stripe,
 * payment_method 'stripe' with a PaymentIntent, and amount at most paid minus already refunded. Never throws.
 */
export async function refundRegistration(
  env: RegNotifyEnv & StripeEnv & DbEnv,
  db: AppDb,
  input: RefundInput,
  deps: { fetcher?: typeof fetch } = {},
): Promise<StripeRefundResult> {
  if (getBackend(env) !== 'supabase' || stripeConfiguredMode(env) === null) return { ok: false, code: 'unavailable' };
  const { registrationId, amountCents } = input;
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > MAX_REFUND_CENTS) return { ok: false, code: 'invalid_amount' };
  try {
    const reg = await db
      .prepare(`SELECT amount_cents, refunded_cents, payment_method, stripe_payment_intent_id AS pi, status FROM registrations WHERE id = ?1`)
      .bind(registrationId)
      .first<{ amount_cents: number; refunded_cents: number; payment_method: string | null; pi: string | null; status: string }>();
    if (!reg) return { ok: false, code: 'not_found' };
    if (reg.payment_method !== 'stripe' || reg.status === 'pending' || reg.amount_cents <= 0) return { ok: false, code: 'not_stripe' };
    if (!reg.pi) return { ok: false, code: 'no_payment_intent' };
    if (amountCents > reg.amount_cents - reg.refunded_cents) return { ok: false, code: 'exceeds_paid' };
    const target = reg.refunded_cents + amountCents;

    try {
      await createRefund(
        env,
        { paymentIntentId: reg.pi, amountCents, metadata: { kind: 'registration_refund', registration_id: String(registrationId) } },
        { fetcher: deps.fetcher, idempotencyKey: refundIdempotencyKey(registrationId, target) },
      );
    } catch (e) {
      // Bounded and token-free: only the error class and Stripe's status/code reach the log.
      console.error(`registration refund failed for registration ${registrationId}`, e instanceof StripeError ? `${e.stage}:${e.status ?? ''}:${e.code ?? ''}` : 'unknown');
      return { ok: false, code: 'refund_failed' };
    }

    // Stripe accepted it. Converge on the cumulative target: if the charge.refunded webhook already raised it,
    // this adds nothing (no double count); otherwise it records the refund with the staff member as actor.
    const synced = await syncRefundedTotal(db, registrationId, target, { actor: input.actor, via: 'drawer' });
    if (!synced.ok) return { ok: false, code: synced.code === 'not_found' ? 'not_found' : 'invalid_amount' };
    const after = await db
      .prepare(`SELECT amount_cents, refunded_cents FROM registrations WHERE id = ?1`)
      .bind(registrationId)
      .first<{ amount_cents: number; refunded_cents: number }>();
    // The admin cancel op: it records the history row with the actor, promotes the waitlist, and the
    // cancellation and promotion emails follow (never throws).
    let cancelled = false;
    if (input.alsoCancel === true) {
      const released = await adminCancelRegistration(db, registrationId, {}, { actor: input.actor });
      if (released.ok) {
        cancelled = true;
        await notifyAfterRelease(env, db, { cancelledId: registrationId, promoted: released.promoted });
      }
    }
    return {
      ok: true,
      refundedCents: after?.refunded_cents ?? target,
      remainingCents: (after?.amount_cents ?? reg.amount_cents) - (after?.refunded_cents ?? target),
      cancelled,
    };
  } catch (e) {
    console.error(`registration refund failed for registration ${registrationId}`, e instanceof Error ? e.name : 'unknown');
    return { ok: false, code: 'refund_failed' };
  }
}

/**
 * Bookkeeping for a refund handed back outside Stripe (an offline or comp-free payment): adds to refunded_cents
 * and writes the activity row (with `note`). Refused for a card payment (use refundRegistration) and for a comp
 * registration. Works on D1 and Postgres.
 */
export async function recordOfflineRefund(
  db: AppDb,
  input: { registrationId: number; amountCents: number; actor: number | null; note?: string },
): Promise<RefundResult> {
  return recordRefund(db, input.registrationId, input.amountCents, 'offline', { actor: input.actor, note: input.note });
}
