// Giving checkout endpoint with a server-rendered browser request UUID. Giving
// has no local pre-Checkout row; Stripe's stable idempotency key converges retries.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  createOneTimeCheckout,
  createRecurringCheckout,
  StripeError,
  type StripeEnv,
} from '../../../lib/stripe';
import { newCheckoutRequestId, parseCheckoutRequestId } from '../../../lib/stripeCheckoutRequests';
import { getFund } from '../../../lib/fundDb';
import { getStripeCustomer } from '../../../lib/givingDb';
import { getSetting } from '../../../lib/settings';
import {
  givingCheckoutRequestDigest,
  normalizeGivingCheckoutInput,
  parseAmountToCents,
  parseFrequency,
  signRetryGivingCheckoutProof,
  verifyGivingCheckoutProof,
} from '../../../lib/givingCheckout';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;

interface GivingCheckoutDeps {
  sessionSecret: string;
  stripeEnv: StripeEnv;
  getFund: typeof getFund;
  getStripeCustomer: typeof getStripeCustomer;
  getSetting: typeof getSetting;
  createOneTimeCheckout: typeof createOneTimeCheckout;
  createRecurringCheckout: typeof createRecurringCheckout;
}

const defaultDeps: GivingCheckoutDeps = {
  sessionSecret: String((env as unknown as { SESSION_SECRET?: string }).SESSION_SECRET ?? ''),
  stripeEnv: env as unknown as StripeEnv,
  getFund,
  getStripeCustomer,
  getSetting,
  createOneTimeCheckout,
  createRecurringCheckout,
};

export function createGivingCheckoutHandler(deps: GivingCheckoutDeps = defaultDeps): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('giving')) return new Response('Not found', { status: 404 });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return back(locals.locale, 'form');
    }
    const locale: Locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;
    let candidateRequestId: string;
    try {
      candidateRequestId = parseCheckoutRequestId(form.get('checkoutRequestId'));
    } catch {
      return back(locale, 'form');
    }
    const candidateProof = typeof form.get('checkoutRequestProof') === 'string'
      ? String(form.get('checkoutRequestProof'))
      : '';
    const verifiedProof = await verifyGivingCheckoutProof(
      deps.sessionSecret,
      candidateRequestId,
      candidateProof,
    );

    const fundId = Number(form.get('fund_id'));
    const amountCents = parseAmountToCents(String(form.get('amount') ?? ''));
    const frequency = parseFrequency(String(form.get('frequency') ?? 'once'));
    if (!Number.isInteger(fundId) || fundId <= 0) return back(locale, 'fund');
    if (amountCents === null) return back(locale, 'amount');
    if (frequency === null) return back(locale, 'frequency');

    const user = locals.user;
    if (frequency !== 'once' && !user) {
      return redirect(`/${locale}/signin?next=${encodeURIComponent(`/${locale}/give`)}`);
    }
    const fund = await deps.getFund(locals.db, locale, fundId);
    if (!fund || fund.active !== 1) return back(locale, 'fund');
    const currency = await deps.getSetting(locals.db, 'giving.currency', 'usd');

    let personId: number | null;
    let donorName: string;
    let donorEmail: string;
    let customerId: string | null = null;
    if (user) {
      personId = user.id;
      donorName = user.displayName;
      donorEmail = user.email;
      customerId = await deps.getStripeCustomer(locals.db, user.id);
    } else {
      personId = null;
      donorName = String(form.get('name') ?? '');
      donorEmail = String(form.get('email') ?? '');
    }

    let normalized: ReturnType<typeof normalizeGivingCheckoutInput>;
    try {
      normalized = normalizeGivingCheckoutInput({
        fundId,
        fundName: fund.name,
        amountCents,
        currency,
        frequency,
        locale,
        personId,
        donorName,
        donorEmail,
        customerId,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'giving_name_invalid') return back(locale, 'name');
      if (error instanceof Error && error.message === 'giving_email_invalid') return back(locale, 'email');
      return back(locale, 'form');
    }
    const digest = await givingCheckoutRequestDigest(normalized);
    const requestId = verifiedProof?.kind === 'initial'
      || (verifiedProof?.kind === 'retry' && verifiedProof.digest === digest)
      ? candidateRequestId
      : newCheckoutRequestId();

    try {
      if (frequency === 'once') {
        const session = await deps.createOneTimeCheckout(deps.stripeEnv, {
          amountCents: normalized.amountCents,
          currency: normalized.currency,
          fundId: normalized.fundId,
          fundName: normalized.fundName,
          locale: normalized.locale,
          personId: normalized.personId,
          donorName: normalized.donorName,
          donorEmail: normalized.donorEmail,
          customerId: normalized.customerId,
        }, { requestId });
        return redirect(session.url);
      }

      const session = await deps.createRecurringCheckout(deps.stripeEnv, {
        amountCents: normalized.amountCents,
        currency: normalized.currency,
        interval: frequency,
        fundId: normalized.fundId,
        fundName: normalized.fundName,
        locale: normalized.locale,
        personId: normalized.personId!,
        email: normalized.donorEmail,
        customerId: normalized.customerId,
      }, { requestId });
      return redirect(session.url);
    } catch (error) {
      if (!isAmbiguousStripeFailure(error)) return back(locale, 'stripe');
      const proof = await signRetryGivingCheckoutProof(deps.sessionSecret, requestId, digest);
      return backWithRequest(locale, 'stripe', requestId, proof);
    }
  };
}

export const POST: APIRoute = createGivingCheckoutHandler();

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
function back(locale: string, error: string): Response {
  return redirect(`/${locale}/give?error=${error}`);
}
function backWithRequest(locale: string, error: string, requestId: string, proof: string): Response {
  const query = new URLSearchParams({
    error,
    checkoutRequestId: parseCheckoutRequestId(requestId),
    checkoutRequestProof: proof,
  });
  return redirect(`/${locale}/give?${query.toString()}`);
}

function isAmbiguousStripeFailure(error: unknown): boolean {
  if (!(error instanceof StripeError)) return false;
  if (error.stage === 'transport' || error.code === 'stripe_response_invalid') return true;
  return error.stage === 'response'
    && error.status !== undefined
    && ([408, 409, 424, 429].includes(error.status) || error.status >= 500);
}
