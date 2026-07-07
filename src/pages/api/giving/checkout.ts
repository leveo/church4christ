// Giving checkout endpoint (POST-only). Thin adapter: module-gate, parse + validate
// the give form via the pure helpers in src/lib/givingCheckout, look up the fund and
// any saved Stripe customer, build the matching Checkout Session (one-time vs
// recurring) through src/lib/stripe, then 303 the browser to Stripe. Validation
// failures 303 back to /<locale>/give?error=… ; a recurring gift from an anonymous
// visitor 303s to signin first (a subscription needs a person to attach to).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createOneTimeCheckout, createRecurringCheckout, type StripeEnv } from '../../../lib/stripe';
import { getFund } from '../../../lib/fundDb';
import { getStripeCustomer } from '../../../lib/givingDb';
import { getSetting } from '../../../lib/settings';
import { parseAmountToCents, parseFrequency } from '../../../lib/givingCheckout';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ request, locals }) => {
  // Owned by the `giving` module: the middleware already 404s /api/giving when the
  // module is off, but re-check here so the endpoint is safe on its own.
  if (!locals.modules.has('giving')) return new Response('Not found', { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(locals.locale, 'form');
  }

  // Locale rides in a hidden form field so the redirects + Stripe success/cancel
  // URLs land in the giver's language (the endpoint itself is locale-free).
  const locale: Locale = parseLocale(String(form.get('locale') ?? '')) ?? locals.locale;

  const fundId = Number(form.get('fund_id'));
  const amountCents = parseAmountToCents(String(form.get('amount') ?? ''));
  const frequency = parseFrequency(String(form.get('frequency') ?? 'once'));

  if (!Number.isInteger(fundId) || fundId <= 0) return back(locale, 'fund');
  if (amountCents === null) return back(locale, 'amount');
  if (frequency === null) return back(locale, 'frequency');

  const user = locals.user;
  // A subscription must attach to a person — send an anonymous giver to sign in first.
  if (frequency !== 'once' && !user) {
    const next = encodeURIComponent(`/${locale}/give`);
    return redirect(`/${locale}/signin?next=${next}`);
  }

  const fund = await getFund(locals.db, locale, fundId);
  if (!fund || fund.active !== 1) return back(locale, 'fund');

  const currency = await getSetting(locals.db, 'giving.currency', 'usd');
  const stripeEnv = env as unknown as StripeEnv;

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
        customerId = await getStripeCustomer(locals.db, user.id);
      } else {
        personId = null;
        donorName = String(form.get('name') ?? '').trim();
        donorEmail = String(form.get('email') ?? '').trim();
        if (!donorName) return back(locale, 'name');
        if (!EMAIL_RE.test(donorEmail)) return back(locale, 'email');
      }
      const session = await createOneTimeCheckout(stripeEnv, {
        amountCents,
        currency,
        fundId,
        fundName: fund.name,
        locale,
        personId,
        donorName,
        donorEmail,
        customerId,
      });
      return redirect(session.url);
    }

    // Recurring — user is guaranteed by the anonymous guard above.
    const customerId = await getStripeCustomer(locals.db, user!.id);
    const session = await createRecurringCheckout(stripeEnv, {
      amountCents,
      currency,
      interval: frequency,
      fundId,
      fundName: fund.name,
      locale,
      personId: user!.id,
      email: user!.email,
      customerId,
    });
    return redirect(session.url);
  } catch (e) {
    console.error('giving checkout: Stripe session creation failed', e);
    return back(locale, 'stripe');
  }
};

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
function back(locale: string, error: string): Response {
  return redirect(`/${locale}/give?error=${error}`);
}
