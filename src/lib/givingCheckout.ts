// Pure checkout-form parsing for the giving checkout endpoint — no Astro, no DB,
// so it unit-tests without a request lifecycle. The endpoint stays thin: it reads
// the raw form fields, runs them through here, and turns a rejection into a 303
// back to /give?error=…. Money is integer cents everywhere downstream, so amounts
// cross this seam as cents, never floats.

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
