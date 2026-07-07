import type { APIRoute } from 'astro';
import { clearSessionCookie } from '../lib/session';
import { DEFAULT_LOCALE, pathWithoutLocale, type Locale } from '../lib/locales';

// Locale-free POST endpoint. Bumping session_epoch invalidates EVERY outstanding
// JWT for this person (all devices), then we clear the cookie on this one and
// send the user back to a localized home.

/** Best-effort locale from the referring page so signout lands in the same UI language. */
function localeFromReferer(referer: string | null): Locale {
  if (!referer) return DEFAULT_LOCALE;
  try {
    return pathWithoutLocale(new URL(referer).pathname).locale ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const userId = locals.user?.id;
  if (userId) {
    try {
      await locals.db
        .prepare(`UPDATE people SET session_epoch = session_epoch + 1 WHERE id = ?`)
        .bind(userId)
        .run();
    } catch (e) {
      console.error('session epoch bump failed', e);
    }
  }
  const locale = localeFromReferer(request.headers.get('referer'));
  return new Response(null, {
    status: 303,
    headers: {
      location: `/${locale}/`,
      'set-cookie': clearSessionCookie(import.meta.env.PROD),
    },
  });
};

export const GET: APIRoute = () =>
  new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
