// Public, locale-free prayer-request endpoint (POST-only; classified `public` by
// the route policy, and the middleware's CSRF check already rejects cross-origin
// POSTs). Thin adapter over src/lib/prayerRequest: parse the form, persist via
// the pure helper, then 303 back to the submitting page with a ?prayer= flag and
// the #prayer anchor so the form's banner + scroll position line up.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { safeReturnPath, submitPrayerRequest, type PrayerOutcome } from '../../lib/prayerRequest';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const origin = new URL(request.url).origin;
  const back = (status: PrayerOutcome): Response => {
    const path = safeReturnPath(request.headers.get('referer'), origin);
    return new Response(null, { status: 303, headers: { location: `${path}?prayer=${status}#prayer` } });
  };

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('error');
  }

  const outcome = await submitPrayerRequest((env as { DB: D1Database }).DB, form);
  return back(outcome);
};
