// Giving checkout endpoint with a server-rendered browser request UUID. Giving
// has no local pre-Checkout row; Stripe's stable idempotency key converges retries.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createOneTimeCheckout, createRecurringCheckout, type StripeEnv } from '../../../lib/stripe';
import { parseCheckoutRequestId } from '../../../lib/stripeCheckoutRequests';
import { getFund } from '../../../lib/fundDb';
import { getStripeCustomer } from '../../../lib/givingDb';
import { getSetting } from '../../../lib/settings';
import { parseAmountToCents, parseFrequency } from '../../../lib/givingCheckout';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GivingCheckoutDeps {
  stripeEnv: StripeEnv;
  getFund: typeof getFund;
  getStripeCustomer: typeof getStripeCustomer;
  getSetting: typeof getSetting;
  createOneTimeCheckout: typeof createOneTimeCheckout;
  createRecurringCheckout: typeof createRecurringCheckout;
}

const defaultDeps: GivingCheckoutDeps = {
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
    let requestId: string;
    try {
      requestId = parseCheckoutRequestId(form.get('checkoutRequestId'));
    } catch {
      return back(locale, 'form');
    }

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

    try {
      if (frequency === 'once') {
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
          donorName = String(form.get('name') ?? '').trim();
          donorEmail = String(form.get('email') ?? '').trim();
          if (!donorName) return back(locale, 'name');
          if (!EMAIL_RE.test(donorEmail)) return back(locale, 'email');
        }
        const session = await deps.createOneTimeCheckout(deps.stripeEnv, {
          amountCents,
          currency,
          fundId,
          fundName: fund.name,
          locale,
          personId,
          donorName,
          donorEmail,
          customerId,
        }, { requestId });
        return redirect(session.url);
      }

      const customerId = await deps.getStripeCustomer(locals.db, user!.id);
      const session = await deps.createRecurringCheckout(deps.stripeEnv, {
        amountCents,
        currency,
        interval: frequency,
        fundId,
        fundName: fund.name,
        locale,
        personId: user!.id,
        email: user!.email,
        customerId,
      }, { requestId });
      return redirect(session.url);
    } catch {
      return backWithRequest(locale, 'stripe', requestId);
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
function backWithRequest(locale: string, error: string, requestId: string): Response {
  const query = new URLSearchParams({ error, checkoutRequestId: parseCheckoutRequestId(requestId) });
  return redirect(`/${locale}/give?${query.toString()}`);
}
