// Stripe Billing Portal launch (POST-only). A signed-in giver clicks "Manage" on
// /my/giving; we resolve their saved Stripe customer and 303 to a portal session
// where they can update the card / cancel a recurring gift. No customer on file
// (they've only ever given one-time, or never) → back to /my/giving?error=noportal.
// Owned by the `giving` module, so the middleware already 404s this when giving is
// off; the endpoint only has to enforce the session.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createPortalSession, type StripeEnv } from '../../../lib/stripe';
import { getStripeCustomer } from '../../../lib/givingDb';
import { parseLocale, type Locale } from '../../../lib/locales';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response('Forbidden', { status: 403 });

  // Locale from the hidden form field (fall back to the user's preference, then
  // the request default) so the return URL lands in their language.
  let locale: Locale = user.lang ?? locals.locale;
  try {
    const form = await request.formData();
    locale = parseLocale(String(form.get('locale') ?? '')) ?? locale;
  } catch {
    // No/!invalid form body — keep the fallback locale.
  }

  const customerId = await getStripeCustomer(locals.db, user.id);
  if (!customerId) {
    return new Response(null, { status: 303, headers: { location: `/${locale}/my/giving?error=noportal` } });
  }

  const returnUrl = `${new URL(request.url).origin}/${locale}/my/giving`;
  try {
    const { url } = await createPortalSession(env as unknown as StripeEnv, customerId, returnUrl);
    return new Response(null, { status: 303, headers: { location: url } });
  } catch (e) {
    console.error('giving portal: Stripe portal session failed', e);
    return new Response(null, { status: 303, headers: { location: `/${locale}/my/giving?error=portal` } });
  }
};
