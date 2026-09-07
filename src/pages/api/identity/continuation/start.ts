import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { EmailEnv } from '../../../../lib/email';
import { getFund } from '../../../../lib/fundDb';
import { getOpenEvent, listQuestions, validateAnswers } from '../../../../lib/regDb';
import {
  beginGivingContinuation,
  beginRegistrationContinuation,
  signupOperationPublicId,
  type IdentityBusinessContinuationEnv,
} from '../../../../lib/identityBusinessContinuation';
import { identityTrustedRequestContext } from '../../../../lib/identityAuth';
import { IDENTITY_DEVICE_COOKIE, identityDeviceCookieHeader, resolveIdentityDeviceCookie } from '../../../../lib/identityDeviceCookie';
import { sendIdentitySignupOtp } from '../../../../lib/identityNotify';
import { scheduleIdentityDelivery } from '../../../../lib/identityDelivery';
import {
  identityContinuationCookieHeader,
  sealIdentityContinuationCookie,
} from '../../../../lib/identityContinuationCookie';
import { parseLocale, type Locale } from '../../../../lib/locales';
import { getSetting } from '../../../../lib/settings';

export const prerender = false;

type ContinuationEnv = IdentityBusinessContinuationEnv & EmailEnv;
const vars = env as unknown as ContinuationEnv;

export const POST: APIRoute = async ({ request, locals }) => {
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  if (!locals.modules.has('giving') && !locals.modules.has('registration')) return new Response(null, { status: 404, headers });
  let form: FormData;
  try { form = await request.formData(); } catch { return redirect(`/${locals.locale}/identity/continue`, headers); }
  const locale: Locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;
  const flow = String(form.get('flow') ?? '');
  if (String(form.get('website') ?? '') !== '') return redirect(`/${locale}/identity/continue`, headers);
  const campusId = locals.campusMode === 'campus' ? locals.campus?.id : 1;
  if (!campusId || (flow !== 'giving' && flow !== 'registration')) return redirect(`/${locale}/identity/continue`, headers);
  const suppliedIntentId = String(form.get('identityIntentId') ?? form.get('checkoutRequestId') ?? '').trim().toLowerCase();
  const intentId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(suppliedIntentId)
    ? suppliedIntentId : crypto.randomUUID();
  try {
    const rawDeviceCookie = request.headers.get('cookie')?.match(/(?:^|;\s*)c4c_identity_device=([^;]+)/u)?.[1];
    const resolvedDevice = await resolveIdentityDeviceCookie(vars, rawDeviceCookie ? decodeURIComponent(rawDeviceCookie) : null);
    if (resolvedDevice.replaced) headers.append('set-cookie', identityDeviceCookieHeader(resolvedDevice.cookieValue, import.meta.env.PROD));
    const requestContext = identityTrustedRequestContext(request.headers, resolvedDevice.deviceId);
    if (flow === 'giving') {
      if (!locals.modules.has('giving') || String(form.get('frequency') ?? 'once') !== 'once') throw new Error('identity_continuation_invalid');
      const fundId = Number(form.get('fund_id'));
      const amount = Number(form.get('amount'));
      const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
      const fund = await getFund(locals.db, locale, fundId);
      const currency = await getSetting(locals.db, 'giving.currency', 'usd');
      if (!fund || fund.active !== 1) throw new Error('identity_continuation_invalid');
      const begun = await beginGivingContinuation(locals.rawDb, vars, {
        campusId, intentId, requestContext, fundId, fundName: fund.name, amountCents, currency,
        frequency: 'once', locale, name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''),
      });
      const publicId = begun.status === 'verification_required' ? begun.delivery.publicId : await signupOperationPublicId(locals.rawDb, campusId, begun.operationId);
      if (!publicId) throw new Error('identity_continuation_pending');
      const cookie = await sealIdentityContinuationCookie(String(vars.IDENTITY_VERIFICATION_SECRET ?? ''), {
        intentId, operationId: begun.operationId, publicId,
        kind: 'giving', locale, returnPath: `/${locale}/give`,
      });
      headers.append('set-cookie', identityContinuationCookieHeader(cookie, import.meta.env.PROD));
      if (begun.status === 'verification_required') {
        await scheduleIdentityDelivery(locals.cfContext, () => sendIdentitySignupOtp(vars, locals.rawDb, begun.delivery, locale));
      }
    } else {
      if (!locals.modules.has('registration')) throw new Error('identity_continuation_invalid');
      const eventId = Number(form.get('event_id'));
      const event = await getOpenEvent(locals.db, locale, eventId);
      if (!event) throw new Error('identity_continuation_invalid');
      const questions = await listQuestions(locals.db, locale, eventId);
      const answerForm: Record<string, string | string[]> = {};
      for (const question of questions) answerForm[String(question.id)] = form.getAll(String(question.id)).map(String);
      const answers = validateAnswers(questions, answerForm);
      const begun = await beginRegistrationContinuation(locals.rawDb, vars, {
        campusId, intentId, requestContext, event, name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''), locale, answers,
      });
      const publicId = begun.status === 'verification_required' ? begun.delivery.publicId : await signupOperationPublicId(locals.rawDb, campusId, begun.operationId);
      if (!publicId) throw new Error('identity_continuation_pending');
      const cookie = await sealIdentityContinuationCookie(String(vars.IDENTITY_VERIFICATION_SECRET ?? ''), {
        intentId, operationId: begun.operationId, publicId,
        kind: 'registration', locale, returnPath: `/${locale}/register/${event.id}`,
      });
      headers.append('set-cookie', identityContinuationCookieHeader(cookie, import.meta.env.PROD));
      if (begun.status === 'verification_required') {
        await scheduleIdentityDelivery(locals.cfContext, () => sendIdentitySignupOtp(vars, locals.rawDb, begun.delivery, locale));
      }
    }
  } catch {
    // The flow intentionally collapses validation, unavailable identity, and
    // delivery failures into the same neutral continuation screen.
    return redirect(`/${locale}/identity/continue`, headers);
  }
  return redirect(`/${locale}/identity/continue`, headers);
};

function redirect(location: string, headers: Headers): Response {
  headers.set('location', location);
  return new Response(null, { status: 303, headers });
}
