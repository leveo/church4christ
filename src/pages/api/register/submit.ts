// Registration submit endpoint. Free registrations retain their direct confirmed
// write. Paid registrations use the durable private request pair so browser and
// network retries converge on one seat and one Stripe idempotency key.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  StripeError,
  createRegistrationCheckoutFromParams,
  type StripeEnv,
} from '../../../lib/stripe';
import {
  attachRegistrationCheckoutRequest,
  cancelRegistrationCheckoutRequest,
  parseCheckoutRequestId,
  resolveRegistrationCheckoutRequest,
} from '../../../lib/stripeCheckoutRequests';
import {
  getOpenEvent,
  listQuestions,
  validateAnswers,
  createRegistration,
} from '../../../lib/regDb';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AMBIGUOUS_4XX = new Set([408, 409, 424, 429]);

export type RegistrationCheckoutFailureAction = 'cancel' | 'recover';

/** Apply the reviewed compensation table without inspecting human messages. */
export function classifyRegistrationCheckoutFailure(error: unknown): RegistrationCheckoutFailureAction {
  if (!(error instanceof StripeError)) return 'recover';
  if (error.stage === 'configuration') return 'cancel';
  if (error.stage !== 'response') return 'recover';
  if (error.code === 'stripe_response_invalid' || error.code === 'live_mode_disabled') return 'recover';
  return error.status !== undefined
    && error.status >= 400
    && error.status < 500
    && !AMBIGUOUS_4XX.has(error.status)
    ? 'cancel'
    : 'recover';
}

interface RegistrationSubmitDeps {
  stripeEnv: StripeEnv;
  getOpenEvent: typeof getOpenEvent;
  listQuestions: typeof listQuestions;
  validateAnswers: typeof validateAnswers;
  createRegistration: typeof createRegistration;
  resolveRequest: typeof resolveRegistrationCheckoutRequest;
  createCheckout: typeof createRegistrationCheckoutFromParams;
  attachRequest: typeof attachRegistrationCheckoutRequest;
  cancelRequest: typeof cancelRegistrationCheckoutRequest;
}

const defaultDeps: RegistrationSubmitDeps = {
  stripeEnv: env as unknown as StripeEnv,
  getOpenEvent,
  listQuestions,
  validateAnswers,
  createRegistration,
  resolveRequest: resolveRegistrationCheckoutRequest,
  createCheckout: createRegistrationCheckoutFromParams,
  attachRequest: attachRegistrationCheckoutRequest,
  cancelRequest: cancelRegistrationCheckoutRequest,
};

/** Injectable route factory keeps ordering and failure policy testable without Stripe. */
export function createRegistrationSubmitHandler(deps: RegistrationSubmitDeps = defaultDeps): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('registration')) return new Response('Not found', { status: 404 });

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return backToList(locals.locale);
    }
    const locale: Locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;
    if (String(form.get('website') ?? '') !== '') return redirect(`/${locale}/register/done?ok=1`);

    const eventId = Number(form.get('event_id'));
    if (!Number.isInteger(eventId) || eventId <= 0) return backToList(locale);
    const event = await deps.getOpenEvent(locals.db, locale, eventId);
    if (!event) return back(locale, eventId, 'closed');

    const user = locals.user;
    let personId: number | null;
    let name: string;
    let email: string;
    if (user) {
      personId = user.id;
      name = user.displayName;
      email = user.email;
    } else {
      personId = null;
      name = String(form.get('name') ?? '').trim();
      email = String(form.get('email') ?? '').trim();
      if (!name || !EMAIL_RE.test(email)) return back(locale, eventId, 'invalid');
    }

    const questions = await deps.listQuestions(locals.db, locale, eventId);
    const answerForm: Record<string, string | string[]> = {};
    for (const question of questions) answerForm[String(question.id)] = form.getAll(String(question.id)).map(String);
    let answers: Array<[number, string]>;
    try {
      answers = deps.validateAnswers(questions, answerForm);
    } catch {
      return back(locale, eventId, 'invalid');
    }

    const paid = event.price_cents !== null && event.price_cents > 0;
    if (!paid) {
      try {
        await deps.createRegistration(locals.db, {
          eventId,
          personId,
          name,
          email,
          status: 'confirmed',
          amountCents: 0,
          currency: event.currency,
          answers,
        });
      } catch (error) {
        if ((error as Error).message === 'event_full') return back(locale, eventId, 'full');
        throw error;
      }
      return redirect(`/${locale}/register/done?ok=1`);
    }

    let requestId: string;
    try {
      requestId = parseCheckoutRequestId(form.get('checkoutRequestId'));
    } catch {
      return back(locale, eventId, 'invalid');
    }

    let resolution: Awaited<ReturnType<typeof resolveRegistrationCheckoutRequest>>;
    try {
      resolution = await deps.resolveRequest(locals.db, {
        requestId,
        eventId,
        personId,
        name,
        email,
        amountCents: event.price_cents!,
        currency: event.currency,
        answers,
        eventTitle: event.title,
        locale,
        appOrigin: deps.stripeEnv.APP_ORIGIN ?? '',
      });
    } catch (error) {
      if ((error as Error).message === 'event_full') return back(locale, eventId, 'full');
      // Corrupt/ambiguous durable state stays untouched for operator recovery.
      return backWaiting(locale, eventId, requestId);
    }

    if (resolution.kind === 'done') return redirect(`/${locale}/register/done?ok=1&paid=1`);
    if (resolution.kind === 'redirect') return redirect(resolution.checkoutUrl);
    if (resolution.kind === 'waiting' || resolution.kind === 'review') return backWaiting(locale, eventId, requestId);
    if (resolution.kind === 'expired' || resolution.kind === 'conflict') return back(locale, eventId, 'invalid');

    try {
      const session = await deps.createCheckout(deps.stripeEnv, resolution.requestJson, {
        requestId: resolution.requestId,
      });
      const price = resolution.requestJson.line_items[0].price_data;
      const attached = await deps.attachRequest(locals.db, {
        requestId: resolution.requestId,
        registrationId: resolution.registrationId,
        sessionId: session.id,
        sessionUrl: session.url,
        amountCents: price.unit_amount,
        currency: price.currency,
      });
      return attached ? redirect(session.url) : backWaiting(locale, eventId, requestId);
    } catch (error) {
      if (classifyRegistrationCheckoutFailure(error) === 'cancel') {
        try {
          const cancelled = await deps.cancelRequest(locals.db, resolution.requestId, resolution.registrationId);
          if (!cancelled) return backWaiting(locale, eventId, requestId);
        } catch {
          // A failed compensating write remains pending for the recovery service.
          return backWaiting(locale, eventId, requestId);
        }
        return back(locale, eventId, 'invalid');
      }
      return backWaiting(locale, eventId, requestId);
    }
  };
}

export const POST: APIRoute = createRegistrationSubmitHandler();

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
function back(locale: string, eventId: number, error: string): Response {
  return redirect(`/${locale}/register/${eventId}?error=${error}`);
}
function backWaiting(locale: string, eventId: number, requestId: string): Response {
  const query = new URLSearchParams({
    error: 'waiting',
    checkoutRequestId: parseCheckoutRequestId(requestId),
  });
  return redirect(`/${locale}/register/${eventId}?${query.toString()}`);
}
function backToList(locale: string): Response {
  return redirect(`/${locale}/register`);
}
