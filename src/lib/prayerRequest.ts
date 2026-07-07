// Pure prayer-request handling, split out of the API route so it can be unit
// tested against a live D1 binding without importing an Astro route (mirrors how
// the auth flow is tested through its libs). The route stays a thin adapter:
// read the form + env, call submitPrayerRequest, redirect back. Ported from
// the reference stack's endpoint, adapted so name/email are optional and the redirect
// target is derived from a sanitized Referer instead of a fixed home path.

import type { AppDb } from './appDb';

const MAX_MESSAGE = 4000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PrayerOutcome = 'sent' | 'error';

/**
 * Reduce a Referer header to a same-origin absolute PATH (no query/hash), so the
 * redirect can never be steered off-site (open-redirect safe). A pathname
 * beginning '//' is also rejected: emitted in a Location header it reads as a
 * protocol-relative URL, not a path. Anything missing, unparseable, or
 * cross-origin falls back to the English home page.
 */
export function safeReturnPath(referer: string | null, origin: string): string {
  if (referer) {
    try {
      const u = new URL(referer);
      if (u.origin === origin && u.pathname.startsWith('/') && !u.pathname.startsWith('//')) {
        return u.pathname;
      }
    } catch {
      /* malformed Referer — fall through to the default */
    }
  }
  return '/en/';
}

/**
 * Validate and persist a public prayer request. Never throws: a filled honeypot
 * is silently accepted (returns 'sent', stores nothing), a missing consent
 * checkbox, an empty message, or a malformed email returns 'error', and a DB
 * failure is logged + returned as 'error'. name/email are optional; when
 * present the email must look like one.
 */
export async function submitPrayerRequest(db: AppDb, form: FormData): Promise<PrayerOutcome> {
  // Honeypot: real visitors never fill the hidden `website` field. Pretend it
  // worked so bots get no signal, but write nothing.
  if (String(form.get('website') ?? '') !== '') return 'sent';

  // Consent is required client-side (checkbox), but enforce it server-side too:
  // an unchecked box is simply absent from the form, a checked one posts 'on'.
  if (String(form.get('consent') ?? '') !== 'on') return 'error';

  const name = String(form.get('name') ?? '').trim().slice(0, 100);
  const email = String(form.get('email') ?? '').trim().slice(0, 200);
  const message = String(form.get('message') ?? '').trim().slice(0, MAX_MESSAGE);

  if (!message) return 'error';
  if (email && !EMAIL_RE.test(email)) return 'error';

  try {
    await db
      .prepare('INSERT INTO prayer_requests (name, email, message) VALUES (?, ?, ?)')
      .bind(name, email, message)
      .run();
  } catch (e) {
    console.error('prayer-request D1 failure', e);
    return 'error';
  }
  return 'sent';
}
