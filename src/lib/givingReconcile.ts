// Stripe reconciliation against the OPTIONAL Supabase Stripe FDW (foreign data
// wrapper). A church MAY expose read-only Stripe foreign tables in a `stripe`
// schema (setup: migrations-supabase/9000_stripe_fdw.sql.example, run by hand in
// the Supabase SQL editor with their own key). This module feature-detects that
// schema and, when present, cross-checks the local `gifts` ledger against Stripe:
//   • missingLocally — a paid gift-kind Checkout Session that Stripe has but no
//     local gift carries its session id (a webhook we dropped);
//   • amountMismatch — a local gift whose amount_cents differs from its session's
//     Stripe amount_total (a mis-recorded amount);
//   • refundDrift — a Stripe charge marked refunded whose local gift is still
//     'succeeded' (a charge.refunded webhook we missed).
// Everything degrades: stripeFdwAvailable never throws, so a deployment WITHOUT
// the FDW renders setup instructions instead of 500ing. Online giving works with
// or without the FDW — the webhook already records gifts; this is audit only.
//
// FDW column notes (per the Supabase docs): most Stripe fields live in an `attrs`
// jsonb column and only a handful are mapped columns. So a Checkout Session's
// payment_status / amount_total / created (unix epoch) / metadata all read from
// attrs, and a charge's `refunded` flag reads from attrs; charges expose
// payment_intent + created as real mapped columns. The queries below touch ONLY
// columns the .example migration defines (id + attrs on checkout_sessions;
// payment_intent + created + attrs on charges).
import type { AppDb } from './appDb';

export interface ReconcileReport {
  missingLocally: Array<{ session_id: string; amount: number; created: string; email: string | null }>;
  amountMismatch: Array<{ gift_id: number; session_id: string; local_cents: number; stripe_cents: number }>;
  refundDrift: Array<{ gift_id: number; payment_intent_id: string }>;
}

/**
 * True when the Stripe FDW (or a plain-table stub) exposes
 * `stripe.checkout_sessions`. Uses to_regclass, which returns NULL (never errors)
 * for an absent relation, so a Supabase deployment WITHOUT the wrapper reports
 * false rather than throwing. Any unexpected error (e.g. a backend with no
 * to_regclass) also degrades to false — feature detection must never 500 a page.
 */
export async function stripeFdwAvailable(db: AppDb): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT to_regclass('stripe.checkout_sessions') IS NOT NULL AS ok`)
      .first<{ ok: boolean }>();
    return row?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Cross-check the local gift ledger against the Stripe FDW over a trailing window
 * of `sinceDays`, applied to each Stripe row's created timestamp. Checkout
 * sessions store `created` as a unix epoch inside attrs (compared as an absolute
 * instant); charges expose a mapped `created` timestamp in UTC wall-clock, which
 * the ISO cutoff (with its trailing Z dropped by ::timestamp) also is. Assumes
 * stripeFdwAvailable(db) is true — the page guards that.
 */
export async function reconcile(db: AppDb, opts: { sinceDays: number }): Promise<ReconcileReport> {
  const cutoff = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();

  const missingLocally = (
    await db
      .prepare(
        `SELECT cs.id AS session_id,
                (cs.attrs->>'amount_total')::bigint AS amount,
                to_char(to_timestamp((cs.attrs->>'created')::bigint) AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') AS created,
                COALESCE(cs.attrs->>'customer_email', cs.attrs->'customer_details'->>'email') AS email
           FROM stripe.checkout_sessions cs
          WHERE cs.attrs->>'payment_status' = 'paid'
            AND cs.attrs->'metadata'->>'kind' = 'gift'
            AND to_timestamp((cs.attrs->>'created')::bigint) >= ?1::timestamptz
            AND NOT EXISTS (SELECT 1 FROM gifts g WHERE g.stripe_checkout_session_id = cs.id)
          ORDER BY created DESC`,
      )
      .bind(cutoff)
      .all<{ session_id: string; amount: number; created: string; email: string | null }>()
  ).results;

  const amountMismatch = (
    await db
      .prepare(
        `SELECT g.id AS gift_id, cs.id AS session_id,
                g.amount_cents AS local_cents,
                (cs.attrs->>'amount_total')::bigint AS stripe_cents
           FROM gifts g
           JOIN stripe.checkout_sessions cs ON cs.id = g.stripe_checkout_session_id
          WHERE g.amount_cents <> (cs.attrs->>'amount_total')::bigint
            AND to_timestamp((cs.attrs->>'created')::bigint) >= ?1::timestamptz
          ORDER BY g.id`,
      )
      .bind(cutoff)
      .all<{ gift_id: number; session_id: string; local_cents: number; stripe_cents: number }>()
  ).results;

  const refundDrift = (
    await db
      .prepare(
        `SELECT g.id AS gift_id, ch.payment_intent AS payment_intent_id
           FROM gifts g
           JOIN stripe.charges ch ON ch.payment_intent = g.stripe_payment_intent_id
          WHERE (ch.attrs->>'refunded')::boolean IS TRUE
            AND g.status <> 'refunded'
            AND ch.created >= ?1::timestamp
          ORDER BY g.id`,
      )
      .bind(cutoff)
      .all<{ gift_id: number; payment_intent_id: string }>()
  ).results;

  return { missingLocally, amountMismatch, refundDrift };
}
