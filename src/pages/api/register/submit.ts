// Registration submit endpoint. Free registrations retain their direct confirmed
// write. Paid registrations use the durable private request pair so browser and
// network retries converge on one seat and one Stripe idempotency key.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createRegistrationCheckoutFromParams, type StripeEnv } from '../../../lib/stripe';
import {
  attachRegistrationCheckoutRequest,
  cancelRegistrationCheckoutRequest,
  continueRegistrationCheckoutRequest,
  parseCheckoutRequestId,
  resolveRegistrationCheckoutRequest,
  type CheckoutRequestResolution,
} from '../../../lib/stripeCheckoutRequests';
import {
  getOpenEvent,
  listQuestions,
  createRegistration,
} from '../../../lib/regDb';
import { restrictAttendeePersons, validateSubmission } from '../../../lib/regManage';
import { bagFromFormData, manageLanding, myEventLanding, submissionFromBag } from '../../../lib/regPublic';
import { parseLocale, type Locale } from '../../../lib/locales';
import { continuationPayloadDigest, signedInExistingIdentitySourceContext, signedInIdentitySourceContext, type IdentityBusinessContinuationEnv } from '../../../lib/identityBusinessContinuation';
import { classifyRegistrationCheckoutFailure } from '../../../lib/registrationCheckoutFailure';
import { sendConfirmation, type RegNotifyEnv } from '../../../lib/regNotify';

export const prerender = false;

export { classifyRegistrationCheckoutFailure } from '../../../lib/registrationCheckoutFailure';

interface RegistrationSubmitDeps {
  stripeEnv: StripeEnv;
  getOpenEvent: typeof getOpenEvent;
  listQuestions: typeof listQuestions;
  validateSubmission: typeof validateSubmission;
  restrictAttendeePersons: typeof restrictAttendeePersons;
  createRegistration: typeof createRegistration;
  sendConfirmation: typeof sendConfirmation;
  resolveRequest: typeof resolveRegistrationCheckoutRequest;
  continueRequest: typeof continueRegistrationCheckoutRequest;
  createCheckout: typeof createRegistrationCheckoutFromParams;
  attachRequest: typeof attachRegistrationCheckoutRequest;
  cancelRequest: typeof cancelRegistrationCheckoutRequest;
  identityEnv: IdentityBusinessContinuationEnv;
  attachIdentitySource: typeof signedInIdentitySourceContext;
  attachExistingIdentitySource: typeof signedInExistingIdentitySourceContext;
  getSessionEpoch(db: App.Locals['db'], personId: number): Promise<number | null>;
}

const defaultDeps: RegistrationSubmitDeps = {
  stripeEnv: env as unknown as StripeEnv,
  getOpenEvent,
  listQuestions,
  validateSubmission,
  restrictAttendeePersons,
  createRegistration,
  sendConfirmation,
  resolveRequest: resolveRegistrationCheckoutRequest,
  continueRequest: continueRegistrationCheckoutRequest,
  createCheckout: createRegistrationCheckoutFromParams,
  attachRequest: attachRegistrationCheckoutRequest,
  cancelRequest: cancelRegistrationCheckoutRequest,
  identityEnv: env as unknown as IdentityBusinessContinuationEnv,
  attachIdentitySource: signedInIdentitySourceContext,
  attachExistingIdentitySource: signedInExistingIdentitySourceContext,
  getSessionEpoch: (db, personId) => db.prepare('SELECT session_epoch FROM people WHERE id=?1 AND active=1 AND deleted_at IS NULL')
    .bind(personId).first<number>('session_epoch'),
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
    const user = locals.user;
    if (!user) return redirect(`/${locale}/signin?next=${encodeURIComponent(`/${locale}/register/${eventId}`)}`);
    const campusId = locals.campusMode === 'campus' ? locals.campus?.id : 1;
    const epoch = await deps.getSessionEpoch(locals.db, user.id);
    if (!campusId || epoch === null || !Number.isSafeInteger(epoch) || epoch < 0) return back(locale, eventId, 'invalid');

    const processResolution = async (
      requestId: string,
      resolution: CheckoutRequestResolution,
    ): Promise<Response> => {
      const immediate = responseForResolution(locale, eventId, requestId, resolution, false);
      if (immediate) return immediate;
      if (resolution.kind !== 'create') return backWaiting(locale, eventId, requestId);

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
          // The registration's amount is the whole party's: unit price times quantity.
          amountCents: price.unit_amount * resolution.requestJson.line_items[0].quantity,
          currency: price.currency,
        });
        if (attached) return redirect(session.url);
        try {
          const converged = await deps.continueRequest(locals.db, resolution.requestId, eventId);
          return responseForResolution(locale, eventId, requestId, converged, true)
            ?? backWaiting(locale, eventId, requestId);
        } catch {
          return backWaiting(locale, eventId, requestId);
        }
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

    if (String(form.get('action') ?? '') === 'continue') {
      let requestId: string;
      try {
        requestId = parseCheckoutRequestId(form.get('checkoutRequestId'));
      } catch {
        return back(locale, eventId, 'invalid');
      }
      try {
        await deps.attachExistingIdentitySource(locals.rawDb, deps.identityEnv, {
          campusId, source: 'registration', intentId: requestId, personId: user.id, sessionEpoch: epoch,
        });
        return await processResolution(
          requestId,
          await deps.continueRequest(locals.db, requestId, eventId),
        );
      } catch {
        return backWaiting(locale, eventId, requestId);
      }
    }

    const event = await deps.getOpenEvent(locals.db, locale, eventId);
    if (!event) return back(locale, eventId, 'closed');
    const paid = event.price_cents !== null && event.price_cents > 0;
    // Paid registration needs Stripe + Postgres: on D1 a priced event is refused.
    if (paid && locals.dbBackend === 'd1') return back(locale, eventId, 'paid_unavailable');

    let personId: number | null;
    let name: string;
    let email: string;
    personId = user.id;
    name = user.displayName;
    email = user.email;

    const questions = await deps.listQuestions(locals.db, locale, eventId);
    // The whole submission (contact, people, answers) is validated by the same function the
    // review step ran. The contact is the signed-in account; only the phone is typed. A
    // failure sends the SAME body back to the form (307), which re-validates and shows every
    // problem inline, so nothing the person typed is lost and no value rides in a URL.
    const checked = deps.validateSubmission(
      event,
      questions,
      submissionFromBag(bagFromFormData(form), questions, event.max_party_size ?? 1, { name, email }),
    );
    if (!checked.ok) return redirect307(`/${locale}/register/${eventId}`);
    const answers = checked.value.answers;
    // Household links are only honoured for the contact's own household (a forged person id is dropped).
    const attendees = await deps.restrictAttendeePersons(locals.db, user.id, checked.value.attendees);
    const phone = checked.value.contact.phone;
    const party = { phone, attendees: attendees.map((a) => ({ name: a.name, personId: a.personId })) };

    let requestId: string;
    try {
      requestId = parseCheckoutRequestId(form.get('checkoutRequestId'));
    } catch {
      return back(locale, eventId, 'invalid');
    }

    if (!paid) {
      // The idempotency key: a well-formed client key wins; otherwise one derived
      // from the form's request id, so a double click converges on one registration.
      // ':' keeps a derived key outside the client alphabet.
      const clientKey = String(form.get('submission_key') ?? '');
      const submissionKey = /^[A-Za-z0-9_-]{16,64}$/.test(clientKey) ? clientKey : `form:${requestId}`;
      let created: Awaited<ReturnType<typeof createRegistration>>;
      try {
        await deps.attachIdentitySource(locals.rawDb, deps.identityEnv, {
          campusId, source: 'registration', intentId: requestId, personId: user.id, sessionEpoch: epoch,
          sourceDigest: await continuationPayloadDigest({ eventId, name, email, amountCents: 0, currency: event.currency, locale, answers, party }), name, email,
        });
        created = await deps.createRegistration(locals.db, {
          eventId,
          personId,
          name,
          email,
          status: 'confirmed',
          amountCents: 0,
          currency: event.currency,
          answers,
          attendees,
          phone,
          submissionKey,
          locale,
          allowWaitlist: true,
        });
      } catch (error) {
        if ((error as Error).message === 'event_full') return back(locale, eventId, 'full');
        throw error;
      }
      // The confirmation carries the manage link, which only exists in this call (a
      // replayed submission has no token and is not mailed again). Awaited rather than
      // deferred: on Postgres the request's client is drained once the redirect returns.
      // Never throws; a failed send is retried by the daily sweep.
      if (created.manageToken && (created.status === 'confirmed' || created.status === 'waitlist')) {
        await deps.sendConfirmation(env as unknown as RegNotifyEnv, locals.db, created.id, { manageToken: created.manageToken });
      }
      // The confirmed-or-waitlisted registration opens on its manage page (the token only exists
      // on the creating call and rides in the fragment); a replay lands on the member's own page.
      return redirect(created.manageToken ? manageLanding(locale, created.manageToken, locals.campus?.slug) : myEventLanding(locale, created.id));
    }

    await deps.attachIdentitySource(locals.rawDb, deps.identityEnv, {
      campusId, source: 'registration', intentId: requestId, personId: user.id, sessionEpoch: epoch,
      sourceDigest: await continuationPayloadDigest({ eventId, name, email, amountCents: event.price_cents!, currency: event.currency, locale, answers, party }), name, email,
    });

    let resolution: Awaited<ReturnType<typeof resolveRegistrationCheckoutRequest>>;
    try {
      resolution = await deps.resolveRequest(locals.db, {
        requestId,
        eventId,
        personId,
        name,
        email,
        // The per-person price: the checkout multiplies it by the party.
        amountCents: event.price_cents!,
        currency: event.currency,
        answers,
        party,
        eventTitle: event.title,
        locale,
        appOrigin: deps.stripeEnv.APP_ORIGIN ?? '',
      });
    } catch (error) {
      if ((error as Error).message === 'event_full') return back(locale, eventId, 'full');
      // Corrupt/ambiguous durable state stays untouched for operator recovery.
      return backWaiting(locale, eventId, requestId);
    }

    return processResolution(requestId, resolution);
  };
}

function responseForResolution(
  locale: Locale,
  eventId: number,
  requestId: string,
  resolution: CheckoutRequestResolution,
  createAsWaiting: boolean,
): Response | null {
  if (resolution.kind === 'done') return redirect(`/${locale}/register/done?ok=1&paid=1`);
  if (resolution.kind === 'redirect') return redirect(resolution.checkoutUrl);
  if (resolution.kind === 'waiting' || resolution.kind === 'review') return backWaiting(locale, eventId, requestId);
  if (resolution.kind === 'expired' || resolution.kind === 'conflict') return back(locale, eventId, 'invalid');
  return createAsWaiting ? backWaiting(locale, eventId, requestId) : null;
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
/** 307 keeps the method and the body: the browser re-POSTs the same form to the register page. */
function redirect307(location: string): Response {
  return new Response(null, { status: 307, headers: { location, 'cache-control': 'no-store' } });
}
function backToList(locale: string): Response {
  return redirect(`/${locale}/register`);
}
