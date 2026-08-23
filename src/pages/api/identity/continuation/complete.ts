import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { EmailEnv } from '../../../../lib/email';
import {
  completeGivingContinuation,
  completeRegistrationContinuation,
  type IdentityBusinessContinuationEnv,
} from '../../../../lib/identityBusinessContinuation';
import { resolveSignupSessionDelivery } from '../../../../lib/identityAccount';
import { IDENTITY_CONTINUATION_COOKIE, clearIdentityContinuationCookieHeader, openIdentityContinuationCookie } from '../../../../lib/identityContinuationCookie';
import { mintSession, sessionCookie } from '../../../../lib/session';
import { parseLocale } from '../../../../lib/locales';

export const prerender = false;
type ContinuationEnv = IdentityBusinessContinuationEnv & EmailEnv & { SESSION_SECRET?: string; APP_ORIGIN?: string };
const vars = env as unknown as ContinuationEnv;

export const POST: APIRoute = async ({ request, locals }) => {
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  let form: FormData;
  try { form = await request.formData(); } catch { return redirect(`/${locals.locale}/identity/continue?error=invalid`, headers); }
  const locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;
  const pending = await openIdentityContinuationCookie(String(vars.IDENTITY_VERIFICATION_SECRET ?? ''), request.headers.get('cookie')?.match(/(?:^|;\s*)c4_identity_continuation=([^;]+)/u)?.[1] ? decodeURIComponent(request.headers.get('cookie')!.match(/(?:^|;\s*)c4_identity_continuation=([^;]+)/u)![1]) : null);
  const campusId = locals.campusMode === 'campus' ? locals.campus?.id : 1;
  const code = String(form.get('code') ?? '').trim();
  if (!pending || !campusId || pending.locale !== locale || !/^\d{6}$/u.test(code)) return redirect(`/${locale}/identity/continue?error=invalid`, headers);
  try {
    const result = pending.kind === 'giving'
      ? await completeGivingContinuation(locals.rawDb, vars, { campusId, intentId: pending.intentId, publicId: pending.publicId, code })
      : await completeRegistrationContinuation(locals.rawDb, vars, { campusId, intentId: pending.intentId, publicId: pending.publicId, code, appOrigin: vars.APP_ORIGIN ?? '' });
    if (result.status === 'review' || result.status === 'invalid') return redirect(`/${locale}/identity/continue?error=invalid`, headers);
    // Stripe/DB recovery is still converging. Keep the signed HttpOnly
    // continuation credential and do not consume the one-time session-delivery
    // claim; the member can submit the same OTP again without exposing a
    // checkout id or confusing a registration id with an event route id.
    if (result.status === 'waiting') return redirect(`/${locale}/identity/continue?error=waiting`, headers);
    if (!('personId' in result) || !result.personId || !('sessionEpoch' in result) || result.sessionEpoch === undefined) {
      return redirect(`/${locale}/identity/continue?error=invalid`, headers);
    }
    if (!vars.SESSION_SECRET) return redirect(`/${locale}/identity/continue?error=invalid`, headers);
    const delivery = await resolveSignupSessionDelivery(locals.rawDb, vars, {
      campusId, operationId: pending.operationId, publicId: pending.publicId, code,
    });
    if (delivery.status === 'invalid' || delivery.sessionEpoch !== result.sessionEpoch) {
      return redirect(`/${locale}/identity/continue?error=invalid`, headers);
    }
    headers.append('set-cookie', clearIdentityContinuationCookieHeader(import.meta.env.PROD));
    if (delivery.status === 'already_claimed' && result.replay === true) return businessRedirect(pending, result, locale, headers);
    if (delivery.status !== 'claimed') return redirect(`/${locale}/identity/continue?error=invalid`, headers);
    const jwt = await mintSession(vars.SESSION_SECRET, { id: result.personId, sessionEpoch: delivery.sessionEpoch }, { authMethod: 'email_otp' });
    headers.append('set-cookie', sessionCookie(jwt, import.meta.env.PROD));
    return businessRedirect(pending, result, locale, headers);
  } catch {
    return redirect(`/${locale}/identity/continue?error=invalid`, headers);
  }
};

function businessRedirect(
  pending: { kind: 'giving' | 'registration'; returnPath: string },
  result: Awaited<ReturnType<typeof completeGivingContinuation>> | Awaited<ReturnType<typeof completeRegistrationContinuation>>,
  locale: string,
  headers: Headers,
): Response {
    if (pending.kind === 'giving' && result.status === 'redirect' && 'url' in result) return redirect(result.url, headers);
    if (pending.kind === 'registration' && result.status === 'redirect' && 'resolution' in result
      && result.resolution?.kind === 'redirect') return redirect(result.resolution.checkoutUrl, headers);
    return redirect(pending.returnPath.includes('/register/') ? `/${locale}/register/done?ok=1` : `/${locale}/give/thanks`, headers);
}

function redirect(location: string, headers: Headers): Response {
  headers.set('location', location);
  return new Response(null, { status: 303, headers });
}
