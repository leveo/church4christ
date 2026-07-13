// Pure fetch-based Stripe client — no SDK, no DB. Talks to the Stripe REST API
// with form-encoded bodies and Bearer auth so it runs unchanged on the Cloudflare
// Workers runtime (which has no Node crypto and no room for the official SDK).
// The webhook verifier uses WebCrypto HMAC-SHA256 with a timing-safe compare via
// crypto.subtle.verify. Every network-touching function takes an injectable
// `fetcher` so the whole module is unit-testable without hitting Stripe.
//
// Secret hygiene: the secret key travels only in the Authorization header; it is
// never interpolated into an error message, thrown value, or log line.
import { parseCheckoutRequestId, type StripeCheckoutParams } from './stripeCheckoutRequests';

export type StripeEnv = {
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_ORIGIN?: string;
};

export type StripeErrorStage = 'configuration' | 'transport' | 'response';

/** A bounded, structured error safe for recovery classification and logs. */
export class StripeError extends Error {
  status?: number;
  type?: string;
  code?: string;
  requestId?: string;
  stage: StripeErrorStage;

  constructor(
    message: string,
    fields: {
      stage: StripeErrorStage;
      status?: number;
      type?: string;
      code?: string;
      requestId?: string;
    },
  ) {
    super(message.slice(0, 500));
    this.name = 'StripeError';
    this.stage = fields.stage;
    if (Number.isInteger(fields.status) && fields.status! >= 100 && fields.status! <= 599) {
      this.status = fields.status;
    }
    for (const key of ['type', 'code', 'requestId'] as const) {
      const value = fields[key];
      if (typeof value === 'string' && value.length > 0) this[key] = value.slice(0, 128);
    }
  }
}

export interface StripeRequestOptions {
  fetcher?: typeof fetch;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface StripeCheckoutRequestOptions {
  fetcher?: typeof fetch;
  requestId: string;
  signal?: AbortSignal;
}

export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

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
  if (env.STRIPE_MODE !== 'test') {
    throw new StripeError('Stripe test mode is required', {
      stage: 'configuration',
      code: 'stripe_test_mode_required',
    });
  }
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? '';
  if (!secret.startsWith('sk_test_')) {
    throw new StripeError('A Stripe test secret key is required', {
      stage: 'configuration',
      code: 'stripe_test_key_required',
    });
  }
  return secret;
}

function requireOrigin(env: StripeEnv): string {
  if (!env.APP_ORIGIN) throw new Error('APP_ORIGIN is not set');
  return env.APP_ORIGIN;
}

function requireIdempotencyKey(value: string): string {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(value)) {
    throw new StripeError('Invalid Stripe idempotency key', {
      stage: 'configuration',
      code: 'stripe_idempotency_key_invalid',
    });
  }
  return value;
}

async function stripeFetch(fetcher: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch {
    throw new StripeError('Stripe request failed during transport', { stage: 'transport' });
  }
}

/** Parse a Stripe response without retaining its raw body. */
async function readResponse<T>(res: Response): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new StripeError('Stripe response body could not be read', {
      stage: 'response',
      status: res.status,
      requestId: res.headers.get('request-id') ?? undefined,
      code: 'stripe_response_invalid',
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StripeError('Malformed Stripe response', {
      stage: 'response',
      status: res.status,
      requestId: res.headers.get('request-id') ?? undefined,
      code: 'stripe_response_invalid',
    });
  }
  if (!res.ok) {
    const stripeError =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { error?: unknown }).error
        : undefined;
    const fields =
      stripeError && typeof stripeError === 'object' && !Array.isArray(stripeError)
        ? (stripeError as { message?: unknown; type?: unknown; code?: unknown })
        : {};
    const message =
      (typeof fields.message === 'string' && fields.message) ||
      res.statusText ||
      `Stripe request failed with status ${res.status}`;
    throw new StripeError(message, {
      stage: 'response',
      status: res.status,
      type: typeof fields.type === 'string' ? fields.type : undefined,
      code: typeof fields.code === 'string' ? fields.code : undefined,
      requestId: res.headers.get('request-id') ?? undefined,
    });
  }
  return body as T;
}

/** POST /v1/<path> with a form-encoded body. Throws a StripeError on non-2xx. */
export async function stripeRequest<T = Record<string, unknown>>(
  env: StripeEnv,
  path: string,
  params: Record<string, unknown>,
  options: StripeRequestOptions = {},
): Promise<T> {
  const secret = requireSecret(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = requireIdempotencyKey(options.idempotencyKey);
  }
  const res = await stripeFetch(options.fetcher ?? fetch, `https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers,
    body: stripeForm(params).toString(),
    signal: options.signal ?? AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
  });
  return readResponse<T>(res);
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  livemode: false;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required' | null;
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
  metadata: Record<string, string>;
}

const invalidCheckoutResponse = (): StripeError =>
  new StripeError('Malformed Stripe Checkout response', {
    stage: 'response',
    code: 'stripe_response_invalid',
  });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Strictly validate the bounded Checkout fields consumed by recovery code. */
export function requireTestCheckoutSession(value: unknown): StripeCheckoutSession {
  if (!isPlainObject(value)) throw invalidCheckoutResponse();
  if (value.livemode === true) {
    throw new StripeError('Stripe live mode is disabled', {
      stage: 'response',
      code: 'live_mode_disabled',
    });
  }
  if (value.livemode !== false || typeof value.id !== 'string' || !/^cs_test_[A-Za-z0-9_]{1,240}$/.test(value.id)) {
    throw invalidCheckoutResponse();
  }
  if (!((typeof value.url === 'string' && value.url.length <= 2048) || value.url === null)) {
    throw invalidCheckoutResponse();
  }
  if (![null, 'open', 'complete', 'expired'].includes(value.status as string | null)) {
    throw invalidCheckoutResponse();
  }
  if (![null, 'paid', 'unpaid', 'no_payment_required'].includes(value.payment_status as string | null)) {
    throw invalidCheckoutResponse();
  }
  if (!((typeof value.payment_intent === 'string' && value.payment_intent.length <= 255) || value.payment_intent === null)) {
    throw invalidCheckoutResponse();
  }
  if (!(value.amount_total === null || (Number.isSafeInteger(value.amount_total) && (value.amount_total as number) >= 0))) {
    throw invalidCheckoutResponse();
  }
  if (!(value.currency === null || (typeof value.currency === 'string' && /^[a-z]{1,128}$/.test(value.currency)))) {
    throw invalidCheckoutResponse();
  }
  if (!isPlainObject(value.metadata)) throw invalidCheckoutResponse();
  const metadataEntries = Object.entries(value.metadata);
  if (
    metadataEntries.length > 50 ||
    metadataEntries.some(
      ([key, metadataValue]) =>
        key.length < 1 ||
        key.length > 128 ||
        typeof metadataValue !== 'string' ||
        metadataValue.length > 500,
    )
  ) {
    throw invalidCheckoutResponse();
  }
  return value as unknown as StripeCheckoutSession;
}

function requireCheckoutRedirect(value: unknown): { id: string; url: string } {
  const session = requireTestCheckoutSession(value);
  if (typeof session.url !== 'string' || session.url.length === 0) throw invalidCheckoutResponse();
  try {
    if (new URL(session.url).protocol !== 'https:') throw invalidCheckoutResponse();
  } catch (error) {
    if (error instanceof StripeError) throw error;
    throw invalidCheckoutResponse();
  }
  return { id: session.id, url: session.url };
}

export async function retrieveCheckoutSession(
  env: StripeEnv,
  id: string,
  options: StripeRequestOptions = {},
): Promise<StripeCheckoutSession> {
  if (typeof id !== 'string' || !/^cs_test_[A-Za-z0-9_]{1,240}$/.test(id)) {
    throw new StripeError('Invalid test Checkout Session ID', {
      stage: 'configuration',
      code: 'stripe_session_id_invalid',
    });
  }
  const secret = requireSecret(env);
  const response = await stripeFetch(
    options.fetcher ?? fetch,
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
      signal: options.signal ?? AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    },
  );
  return requireTestCheckoutSession(await readResponse<unknown>(response));
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
  options: StripeCheckoutRequestOptions,
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
  const session = await stripeRequest<unknown>(env, 'checkout/sessions', params, {
    fetcher: options.fetcher,
    signal: options.signal,
    idempotencyKey: `church4christ:giving:${parseCheckoutRequestId(options.requestId)}`,
  });
  return requireCheckoutRedirect(session);
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
  options: StripeCheckoutRequestOptions,
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
  const session = await stripeRequest<unknown>(env, 'checkout/sessions', params, {
    fetcher: options.fetcher,
    signal: options.signal,
    idempotencyKey: `church4christ:giving:${parseCheckoutRequestId(options.requestId)}`,
  });
  return requireCheckoutRedirect(session);
}

/**
 * One-time (payment-mode) Checkout Session for an event REGISTRATION. Distinct
 * from a gift: `metadata.kind = 'registration'` routes it to the registration
 * branch of the shared webhook. Registrations are always email-prefilled (no
 * saved customer reuse — giving owns that).
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
  options: StripeCheckoutRequestOptions,
): Promise<{ id: string; url: string }> {
  assertAmount(args.amountCents);
  const origin = requireOrigin(env);
  const metadata: Record<string, string | number> = {
    kind: 'registration',
    registration_id: args.registrationId,
  };
  const requestId = parseCheckoutRequestId(options.requestId);
  metadata.request_id = requestId;
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
    metadata,
    payment_intent_data: { metadata },
  };
  const session = await stripeRequest<unknown>(env, 'checkout/sessions', params, {
    fetcher: options.fetcher,
    signal: options.signal,
    idempotencyKey: `church4christ:registration:${requestId}`,
  });
  return requireCheckoutRedirect(session);
}

/** Send the exact canonical parameter map retained by the private request pair. */
export async function createRegistrationCheckoutFromParams(
  env: StripeEnv,
  params: StripeCheckoutParams,
  options: StripeCheckoutRequestOptions,
): Promise<StripeCheckoutSession & { url: string }> {
  const requestId = parseCheckoutRequestId(options.requestId);
  const session = requireTestCheckoutSession(await stripeRequest<unknown>(env, 'checkout/sessions', params as unknown as Record<string, unknown>, {
    fetcher: options.fetcher,
    signal: options.signal,
    idempotencyKey: `church4christ:registration:${requestId}`,
  }));
  const expected = params.line_items[0].price_data;
  if (
    typeof session.url !== 'string'
    || session.url.length === 0
    || session.amount_total !== expected.unit_amount
    || session.currency !== expected.currency
    || session.metadata.kind !== 'registration'
    || session.metadata.request_id !== requestId
    || session.metadata.registration_id !== params.metadata.registration_id
  ) {
    throw invalidCheckoutResponse();
  }
  try {
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || url.port) {
      throw invalidCheckoutResponse();
    }
  } catch (error) {
    if (error instanceof StripeError) throw error;
    throw invalidCheckoutResponse();
  }
  return session as StripeCheckoutSession & { url: string };
}

/** A Billing Portal session so a donor can manage their recurring gift. */
export async function createPortalSession(
  env: StripeEnv,
  customerId: string,
  returnUrl: string,
  options: StripeRequestOptions = {},
): Promise<{ url: string }> {
  const session = await stripeRequest<{ url: string }>(
    env,
    'billing_portal/sessions',
    { customer: customerId, return_url: returnUrl },
    options,
  );
  return { url: session.url };
}

/** GET /v1/subscriptions/<id> — read a subscription's current state. */
export async function retrieveSubscription(
  env: StripeEnv,
  id: string,
  options: StripeRequestOptions = {},
): Promise<Record<string, unknown>> {
  const secret = requireSecret(env);
  const res = await stripeFetch(options.fetcher ?? fetch, `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
    signal: options.signal ?? AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
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
