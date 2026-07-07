// Pure fetch-based Stripe client — no SDK, no DB. Talks to the Stripe REST API
// with form-encoded bodies and Bearer auth so it runs unchanged on the Cloudflare
// Workers runtime (which has no Node crypto and no room for the official SDK).
// The webhook verifier uses WebCrypto HMAC-SHA256 with a timing-safe compare via
// crypto.subtle.verify. Every network-touching function takes an injectable
// `fetcher` so the whole module is unit-testable without hitting Stripe.
//
// Secret hygiene: the secret key travels only in the Authorization header; it is
// never interpolated into an error message, thrown value, or log line.

export type StripeEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_ORIGIN?: string;
};

/** An error carrying Stripe's own message plus the HTTP status of the failure. */
export type StripeError = Error & { status?: number };

/**
 * Form-encode nested params Stripe-style: objects become `a[b]`, arrays become
 * `c[0][d]`. undefined/null values are skipped; numbers and booleans are
 * stringified; empty strings are kept (Stripe reads `metadata[x]=` as "").
 */
export function stripeForm(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => add(`${key}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        add(`${key}[${k}]`, v);
      }
    } else {
      out.append(key, typeof value === 'string' ? value : String(value));
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out;
}

function requireSecret(env: StripeEnv): string {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return env.STRIPE_SECRET_KEY;
}

function requireOrigin(env: StripeEnv): string {
  if (!env.APP_ORIGIN) throw new Error('APP_ORIGIN is not set');
  return env.APP_ORIGIN;
}

/** Parse a Stripe response; on a non-2xx, throw with Stripe's error.message
 *  (falling back to the status text) and the HTTP status attached. */
async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = {};
  try {
    if (text) body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!res.ok) {
    const message =
      (body as { error?: { message?: string } }).error?.message ||
      res.statusText ||
      `Stripe request failed with status ${res.status}`;
    const err = new Error(message) as StripeError;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

/** POST /v1/<path> with a form-encoded body. Throws a StripeError on non-2xx. */
export async function stripeRequest<T = Record<string, unknown>>(
  env: StripeEnv,
  path: string,
  params: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const secret = requireSecret(env);
  const res = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: stripeForm(params).toString(),
  });
  return readResponse<T>(res);
}

/** Guard amounts: Stripe unit_amount must be a positive integer number of cents. */
function assertAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('amountCents must be a positive integer number of cents');
  }
}

function checkoutUrls(origin: string, locale: string): { success_url: string; cancel_url: string } {
  return {
    // Stripe substitutes {CHECKOUT_SESSION_ID} into the redirect on success.
    success_url: `${origin}/${locale}/give/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${locale}/give`,
  };
}

/**
 * One-time (payment-mode) Checkout Session. A saved `customerId` is reused
 * directly; otherwise the donor's email prefills checkout. For a signed-in donor
 * without a saved customer we set `customer_creation: 'always'` so Stripe mints a
 * customer we can persist — Stripe rejects that flag when `customer` is already
 * set, so the two branches are mutually exclusive.
 */
export async function createOneTimeCheckout(
  env: StripeEnv,
  args: {
    amountCents: number;
    currency: string;
    fundId: number;
    fundName: string;
    locale: string;
    personId: number | null;
    donorName: string;
    donorEmail: string;
    customerId?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  assertAmount(args.amountCents);
  const origin = requireOrigin(env);
  const params: Record<string, unknown> = {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.currency,
          unit_amount: args.amountCents,
          product_data: { name: `${args.fundName} (giving)` },
        },
      },
    ],
    ...checkoutUrls(origin, args.locale),
    metadata: {
      kind: 'gift',
      fund_id: args.fundId,
      person_id: args.personId ?? '',
      donor_name: args.donorName,
      donor_email: args.donorEmail,
    },
    payment_intent_data: {
      metadata: { kind: 'gift', fund_id: args.fundId, person_id: args.personId ?? '' },
    },
  };
  if (args.customerId) {
    params.customer = args.customerId;
  } else {
    params.customer_email = args.donorEmail;
    // Only mint-and-save a customer for a signed-in donor; anonymous one-off
    // gifts stay customer-less.
    if (args.personId != null) params.customer_creation = 'always';
  }
  const session = await stripeRequest<{ id: string; url: string }>(env, 'checkout/sessions', params, fetcher);
  return { id: session.id, url: session.url };
}

/**
 * Recurring (subscription-mode) Checkout Session. Subscription mode always
 * creates a customer, so `customer_creation` is never set here. A saved
 * `customerId` is reused; otherwise the email prefills checkout.
 */
export async function createRecurringCheckout(
  env: StripeEnv,
  args: {
    amountCents: number;
    currency: string;
    interval: 'week' | 'month';
    fundId: number;
    fundName: string;
    locale: string;
    personId: number;
    email: string;
    customerId?: string | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  assertAmount(args.amountCents);
  const origin = requireOrigin(env);
  const params: Record<string, unknown> = {
    mode: 'subscription',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.currency,
          unit_amount: args.amountCents,
          recurring: { interval: args.interval },
          product_data: { name: `${args.fundName} (giving)` },
        },
      },
    ],
    ...checkoutUrls(origin, args.locale),
    subscription_data: {
      metadata: { kind: 'gift', fund_id: args.fundId, person_id: args.personId },
    },
    metadata: { kind: 'gift', fund_id: args.fundId, person_id: args.personId },
  };
  if (args.customerId) {
    params.customer = args.customerId;
  } else {
    params.customer_email = args.email;
  }
  const session = await stripeRequest<{ id: string; url: string }>(env, 'checkout/sessions', params, fetcher);
  return { id: session.id, url: session.url };
}

/**
 * One-time (payment-mode) Checkout Session for an event REGISTRATION. Distinct
 * from a gift: `metadata.kind = 'registration'` routes it to the registration
 * branch of the shared webhook, and `expires_at` (now + 30.5 min — Stripe's
 * 30-min minimum plus a skew margin) bounds how long the pending row holds its
 * seat — an abandoned checkout expires, fires checkout.session.expired, and the
 * webhook frees the seat. `Date.now()` is read at call time so each session gets
 * a fresh window. Registrations
 * are always email-prefilled (no saved customer reuse — giving owns that).
 * success → /register/done?ok=1&paid=1 (the paid marker drives the receipt copy);
 * cancel → back to the event page so the visitor can retry.
 */
export async function createRegistrationCheckout(
  env: StripeEnv,
  args: {
    amountCents: number;
    currency: string;
    eventTitle: string;
    eventId: number;
    locale: string;
    registrationId: number;
    email: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  assertAmount(args.amountCents);
  const origin = requireOrigin(env);
  const metadata = { kind: 'registration', registration_id: args.registrationId };
  const params: Record<string, unknown> = {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.currency,
          unit_amount: args.amountCents,
          product_data: { name: args.eventTitle },
        },
      },
    ],
    success_url: `${origin}/${args.locale}/register/done?ok=1&paid=1`,
    cancel_url: `${origin}/${args.locale}/register/${args.eventId}`,
    customer_email: args.email,
    // Plan said now+1800 (Stripe's exact minimum); the +30s margin is deliberate
    // so latency/clock skew can't land the value under the minimum and reject.
    expires_at: Math.floor(Date.now() / 1000) + 1830,
    metadata,
    payment_intent_data: { metadata },
  };
  const session = await stripeRequest<{ id: string; url: string }>(env, 'checkout/sessions', params, fetcher);
  return { id: session.id, url: session.url };
}

/** A Billing Portal session so a donor can manage their recurring gift. */
export async function createPortalSession(
  env: StripeEnv,
  customerId: string,
  returnUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string }> {
  const session = await stripeRequest<{ url: string }>(
    env,
    'billing_portal/sessions',
    { customer: customerId, return_url: returnUrl },
    fetcher,
  );
  return { url: session.url };
}

/** GET /v1/subscriptions/<id> — read a subscription's current state. */
export async function retrieveSubscription(
  env: StripeEnv,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const secret = requireSecret(env);
  const res = await fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  return readResponse<Record<string, unknown>>(res);
}

/**
 * Verify a Stripe-Signature header (`t=...,v1=...`) with WebCrypto HMAC-SHA256.
 * Rejects when |now - t| > toleranceSeconds (default 300). Returns the parsed
 * event JSON or null when the signature is invalid.
 *
 * During webhook-secret rotation Stripe signs each event with every active
 * secret and sends one `v1=` entry per signature; like Stripe's own libraries,
 * this accepts when ANY v1 entry verifies — so ALL v1 values are kept (a
 * key-value map would collapse them to the last).
 */
export async function verifyStripeWebhook(
  payload: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown> | null> {
  let t: string | undefined;
  const v1s: string[] = [];
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1);
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  const candidates = v1s.filter((v) => /^[0-9a-f]{64}$/.test(v));
  if (!t || !/^\d+$/.test(t) || candidates.length === 0) return null;
  if (Math.abs(nowSeconds - Number(t)) > toleranceSeconds) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const message = new TextEncoder().encode(`${t}.${payload}`);
  for (const v1 of candidates) {
    const sigBytes = new Uint8Array(v1.match(/../g)!.map((h) => parseInt(h, 16)));
    if (await crypto.subtle.verify('HMAC', key, sigBytes, message)) {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}
