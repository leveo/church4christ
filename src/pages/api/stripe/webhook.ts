// Shared Stripe webhook endpoint (POST-only). It is owned by no module, so the
// middleware never module-gates it and never CSRF-blocks it (Stripe sends no Origin
// / Sec-Fetch-Site, which passes the same-origin check); authenticity is the
// signature, not a session. Flow:
//   1. read the RAW body first — verifyStripeWebhook must see the exact bytes Stripe
//      signed, so this happens before any parse.
//   2. verify the signature (rotation-safe); a bad/absent signature → 400.
//   3. dispatch the parsed event to the pure handler and return 200 with its outcome.
//
// Retry discipline: Stripe retries any non-2xx. A *processing* bug must not build an
// infinite retry queue, so a logic error is logged and returned as 200 'error_logged'
// (the event is effectively dropped, but Stripe stops hammering us). The ONE
// exception is a database-connectivity failure — that IS transient, so we 500 and
// let Stripe retry once the DB is back. We tell them apart by the postgres.js
// connection error codes.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { verifyStripeWebhook, type StripeEnv } from '../../../lib/stripe';
import { handleStripeEvent } from '../../../lib/givingWebhook';

export const prerender = false;

// postgres.js connection-failure codes (src/lib/dbProvider opens the client) plus
// the socket-level errnos they can surface as. These are transient → let Stripe retry.
const DB_CONN_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);
function isDbConnectivityError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DB_CONN_CODES.has(code);
}

export const POST: APIRoute = async ({ request, locals }) => {
  // The webhook backs BOTH Supabase modules; live when either is enabled.
  if (!(locals.modules.has('giving') || locals.modules.has('registration'))) {
    return new Response('Not found', { status: 404 });
  }

  const stripeEnv = env as unknown as StripeEnv;
  const body = await request.text(); // RAW body first — never parse before verifying.
  // No secret configured → we cannot verify authenticity, so reject rather than
  // trust the payload. Guards against verifyStripeWebhook throwing on a zero-length
  // HMAC key (WebCrypto rejects it) for a well-formed-but-unverifiable signature.
  const secret = stripeEnv.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('webhook not configured', { status: 400 });
  const event = await verifyStripeWebhook(body, request.headers.get('stripe-signature') ?? '', secret);
  if (!event) return new Response('invalid signature', { status: 400 });

  try {
    const outcome = await handleStripeEvent({ db: locals.db, env: stripeEnv }, event);
    return new Response(outcome, { status: 200 });
  } catch (e) {
    if (isDbConnectivityError(e)) {
      console.error('stripe webhook: database connectivity error (will retry)', e);
      return new Response('db_error', { status: 500 });
    }
    // A logic bug: log it and swallow with a 200 so Stripe does not retry forever.
    console.error('stripe webhook: processing error (dropping event)', e);
    return new Response('error_logged', { status: 200 });
  }
};
