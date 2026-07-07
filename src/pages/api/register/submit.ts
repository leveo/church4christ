// Registration submit endpoint (POST-only). Thin adapter owned by the
// `registration` module: module-gate, look up the open event, resolve the
// registrant's identity (a signed-in member's session identity wins; an
// anonymous visitor must supply name + email), validate the dynamic answers,
// then split on price. A FREE event writes a confirmed registration and lands on
// the done page. A PAID event writes a PENDING registration (which holds a seat),
// builds a Stripe Checkout session, attaches it, and 303s to Stripe. If Stripe
// fails AFTER the pending row exists we compensate — cancel the row to free its
// held seat — before bouncing back, so an abandoned attempt never strands a seat.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createRegistrationCheckout, type StripeEnv } from '../../../lib/stripe';
import {
  getOpenEvent,
  listQuestions,
  validateAnswers,
  createRegistration,
  attachCheckoutSession,
  cancelRegistration,
} from '../../../lib/regDb';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request, locals }) => {
  // Owned by the `registration` module: the middleware already 404s /api/register
  // when the module is off, but re-check here so the endpoint is safe on its own.
  if (!locals.modules.has('registration')) return new Response('Not found', { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToList(locals.locale);
  }

  // Locale rides in a hidden form field so the redirects + Stripe success/cancel
  // URLs land in the registrant's language (the endpoint itself is locale-free).
  const locale: Locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;

  // Honeypot: real visitors never fill the hidden `website` field. Pretend it
  // worked (the exact free-registration success state) so bots get no signal,
  // but write nothing — a bot must not be able to exhaust an event's capacity.
  if (String(form.get('website') ?? '') !== '') return redirect(`/${locale}/register/done?ok=1`);

  const eventId = Number(form.get('event_id'));
  if (!Number.isInteger(eventId) || eventId <= 0) return backToList(locale);

  const event = await getOpenEvent(locals.db, locale, eventId);
  if (!event) return back(locale, eventId, 'closed');

  // Identity: a signed-in member's session identity is authoritative (the page
  // renders their name/email read-only); an anonymous visitor must supply both.
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

  // Validate the dynamic question answers (question id → value(s)).
  const questions = await listQuestions(locals.db, locale, eventId);
  const answerForm: Record<string, string | string[]> = {};
  for (const q of questions) answerForm[String(q.id)] = form.getAll(String(q.id)).map(String);
  let answers: Array<[number, string]>;
  try {
    answers = validateAnswers(questions, answerForm);
  } catch {
    return back(locale, eventId, 'invalid');
  }

  const paid = event.price_cents !== null && event.price_cents > 0;

  // Write the registration (holds a seat). The only expected throw is the
  // capacity backstop's 'event_full'; anything else is unexpected and bubbles.
  let registrationId: number;
  try {
    registrationId = await createRegistration(locals.db, {
      eventId,
      personId,
      name,
      email,
      status: paid ? 'pending' : 'confirmed',
      amountCents: paid ? event.price_cents! : 0,
      currency: event.currency,
      answers,
    });
  } catch (e) {
    if ((e as Error).message === 'event_full') return back(locale, eventId, 'full');
    throw e;
  }

  if (!paid) return redirect(`/${locale}/register/done?ok=1`);

  // Paid: build Stripe Checkout and hand off. On any Stripe failure after the
  // pending row exists, compensate by cancelling it (freeing the held seat).
  try {
    const session = await createRegistrationCheckout(env as unknown as StripeEnv, {
      amountCents: event.price_cents!,
      currency: event.currency,
      eventTitle: event.title,
      eventId,
      locale,
      registrationId,
      email,
    });
    await attachCheckoutSession(locals.db, registrationId, session.id);
    return redirect(session.url);
  } catch (e) {
    console.error('register submit: Stripe checkout failed, compensating', e);
    await cancelRegistration(locals.db, registrationId);
    return back(locale, eventId, 'invalid');
  }
};

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
/** Back to the event page with an error banner (?error=full|closed|invalid). */
function back(locale: string, eventId: number, error: string): Response {
  return redirect(`/${locale}/register/${eventId}?error=${error}`);
}
/** Back to the events list (bad/absent event id — no page to bounce to). */
function backToList(locale: string): Response {
  return redirect(`/${locale}/register`);
}
