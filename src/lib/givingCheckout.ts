// Pure checkout-form parsing for the giving checkout endpoint — no Astro, no DB,
// so it unit-tests without a request lifecycle. The endpoint stays thin: it reads
// the raw form fields, runs them through here, and turns a rejection into a 303
// back to /give?error=…. Money is integer cents everywhere downstream, so amounts
// cross this seam as cents, never floats.
import { isCheckoutRequestId, newCheckoutRequestId, parseCheckoutRequestId } from './stripeCheckoutRequests';
import { sha256Utf8 } from './stripeWebhookInbox';

/** The accepted giving cadences: a one-off gift or a weekly/monthly subscription. */
export type Frequency = 'once' | 'week' | 'month';

// Stripe's own floor and a sane ceiling, in cents: $1.00 min, $99,999.99 max.
const MIN_CENTS = 100;
const MAX_CENTS = 9_999_999;

/**
 * Parse a dollars string from the form ("50", "50.00", "12.5") into an integer
 * number of cents, or null when it is not a clean amount inside the accepted
 * band. Rejects: non-numeric, negative, exponent notation, more than two decimal
 * places, and anything below $1.00 or above $99,999.99. A leading/trailing space
 * is tolerated (trimmed) so a copy-pasted amount still parses.
 */
export function parseAmountToCents(raw: string): number | null {
  const s = raw.trim();
  // Digits with an optional 1–2 digit fractional part. This alone rejects '',
  // '-5', '1e3', '.5', '50.', and '5.005'.
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) return null;
  return cents;
}

/** Whitelist the frequency field; anything unexpected (or missing) is null so the
 *  caller can reject it rather than silently defaulting to a charge cadence. */
export function parseFrequency(raw: string | null): Frequency | null {
  return raw === 'once' || raw === 'week' || raw === 'month' ? raw : null;
}

export interface GivingCheckoutDigestInput {
  fundId: number;
  fundName: string;
  amountCents: number;
  currency: string;
  frequency: Frequency;
  locale: 'en' | 'zh';
  personId: number | null;
  donorName: string;
  donorEmail: string;
  customerId: string | null;
}

declare const normalizedGivingCheckoutInput: unique symbol;
export type NormalizedGivingCheckoutInput = GivingCheckoutDigestInput & {
  readonly [normalizedGivingCheckoutInput]: true;
};

const normalizeProofText = (value: string): string => value.normalize('NFC').trim();
const NORMALIZED_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate and canonicalize the exact values shared by retry identity and Stripe payloads. */
export function normalizeGivingCheckoutInput(input: GivingCheckoutDigestInput): NormalizedGivingCheckoutInput {
  if (!Number.isSafeInteger(input.fundId) || input.fundId <= 0) throw new Error('giving_fund_invalid');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('giving_amount_invalid');
  if (!(input.personId === null || (Number.isSafeInteger(input.personId) && input.personId > 0))) {
    throw new Error('giving_person_invalid');
  }
  const currency = normalizeProofText(input.currency).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new Error('giving_currency_invalid');
  if (!parseFrequency(input.frequency)) throw new Error('giving_frequency_invalid');
  if (input.locale !== 'en' && input.locale !== 'zh') throw new Error('giving_locale_invalid');

  const fundName = normalizeProofText(input.fundName);
  const donorName = normalizeProofText(input.donorName);
  const donorEmail = normalizeProofText(input.donorEmail).toLowerCase();
  const customerId = input.customerId === null ? null : normalizeProofText(input.customerId);
  if (!fundName) throw new Error('giving_fund_invalid');
  if (!NORMALIZED_EMAIL_RE.test(donorEmail)) throw new Error('giving_email_invalid');
  if (input.frequency === 'once' && !donorName) throw new Error('giving_name_invalid');
  if (input.customerId !== null && !customerId) throw new Error('giving_customer_invalid');

  return {
    fundId: input.fundId,
    fundName,
    amountCents: input.amountCents,
    currency,
    frequency: input.frequency,
    locale: input.locale,
    personId: input.personId,
    donorName,
    donorEmail,
    customerId,
  } as NormalizedGivingCheckoutInput;
}

/** Stable SHA-256 identity for retry binding; the proof contains only this digest, never raw donor fields. */
export async function givingCheckoutRequestDigest(input: NormalizedGivingCheckoutInput): Promise<string> {
  return sha256Utf8(JSON.stringify(input));
}

export type GivingCheckoutProof = { kind: 'initial' } | { kind: 'retry'; digest: string };

function proofKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 1) throw new Error('giving_checkout_proof_secret_invalid');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function proofMessage(kind: 'initial' | 'retry', requestId: string, digest = ''): string {
  return `church4christ:giving:v1:${kind}:${parseCheckoutRequestId(requestId)}:${digest}`;
}

async function proofSignature(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await proofKey(secret), new TextEncoder().encode(message));
  return base64Url(new Uint8Array(mac));
}

export async function signInitialGivingCheckoutProof(secret: string, requestId: string): Promise<string> {
  return `i.${await proofSignature(secret, proofMessage('initial', requestId))}`;
}

export async function signRetryGivingCheckoutProof(
  secret: string,
  requestId: string,
  digest: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('giving_checkout_digest_invalid');
  return `r.${digest}.${await proofSignature(secret, proofMessage('retry', requestId, digest))}`;
}

export async function verifyGivingCheckoutProof(
  secret: string,
  requestId: string,
  proof: string,
): Promise<GivingCheckoutProof | null> {
  let message: string;
  let signature: string;
  let result: GivingCheckoutProof;
  if (/^i\.[A-Za-z0-9_-]{43}$/.test(proof)) {
    signature = proof.slice(2);
    message = proofMessage('initial', requestId);
    result = { kind: 'initial' };
  } else {
    const match = /^r\.([0-9a-f]{64})\.([A-Za-z0-9_-]{43})$/.exec(proof);
    if (!match) return null;
    const digest = match[1];
    signature = match[2];
    message = proofMessage('retry', requestId, digest);
    result = { kind: 'retry', digest };
  }
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await proofKey(secret),
      Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) => char.charCodeAt(0)),
      new TextEncoder().encode(message),
    );
    return valid ? result : null;
  } catch {
    return null;
  }
}

/** Reuse only a server-signed browser identity; every untrusted query gets a fresh signed UUID. */
export async function selectGivingCheckoutIdentityForRender(
  secret: string,
  requestIdValue: unknown,
  proofValue: unknown,
): Promise<{ requestId: string; proof: string; reused: boolean }> {
  if (isCheckoutRequestId(requestIdValue) && typeof proofValue === 'string') {
    const verified = await verifyGivingCheckoutProof(secret, requestIdValue, proofValue);
    if (verified?.kind === 'retry') return { requestId: requestIdValue, proof: proofValue, reused: true };
  }
  const requestId = newCheckoutRequestId();
  return {
    requestId,
    proof: await signInitialGivingCheckoutProof(secret, requestId),
    reused: false,
  };
}
