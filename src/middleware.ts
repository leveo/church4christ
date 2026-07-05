import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { DEFAULT_LOCALE, pathWithoutLocale, pickLocaleFromHeader } from './lib/locales';
import { THEME_DEFAULT } from './lib/theme';
import { applySecurityHeaders } from './lib/securityHeaders';
import { SESSION_COOKIE, verifySession } from './lib/session';
import { loadSessionUser, loadSessionUserByEmail } from './lib/currentUser';
import { canAccess, classifyRoute } from './lib/routePolicy';

// Baseline security headers (spec §14) live in ./lib/securityHeaders; the route
// authorization policy lives in ./lib/routePolicy (both dependency-free +
// unit-tested). Static assets are served by the ASSETS binding before middleware
// runs; the isAsset guard below is a dev-time safety net.

// SESSION_SECRET and AUTH_DEV_BYPASS_EMAIL are runtime secrets/vars that
// `wrangler types` cannot see (they're not in wrangler.jsonc), so read them off
// the Worker env with a cast — same technique as dcfc-serve's middleware.
type AuthEnv = { DB: D1Database; SESSION_SECRET?: string; AUTH_DEV_BYPASS_EMAIL?: string };

/** Minimal 403 page. Deliberately unstyled this slice; visual polish lands later. */
function forbidden(locale: string): Response {
  const html = `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>403 Forbidden</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; text-align: center;">
<h1>403</h1><p>You do not have access to this page.</p><p><a href="/${locale}/">Home</a></p>
</body></html>`;
  return new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Bare root: content-negotiate a locale and 302 to its localized home. The
  // redirect carries the security headers too, so no response leaves unhardened.
  if (pathname === '/') {
    const locale = pickLocaleFromHeader(context.request.headers.get('accept-language'));
    const redirect = context.redirect(`/${locale}/`, 302);
    applySecurityHeaders(redirect.headers);
    return redirect;
  }

  // Locale comes from the leading path segment when it is a known locale;
  // otherwise fall back to the default so unmatched paths still 404 in a real
  // locale. `rest` is the locale-stripped path the route policy classifies.
  const { locale, rest } = pathWithoutLocale(pathname);
  context.locals.locale = locale ?? DEFAULT_LOCALE;
  context.locals.theme = THEME_DEFAULT; // settings-driven in slice 5
  context.locals.user = null;

  // Session: reload the person row every request so deactivation / soft-delete /
  // epoch bumps take effect immediately. Fail closed — a missing SESSION_SECRET
  // (or any verify/load failure) simply leaves the user anonymous, never a 500.
  const vars = env as unknown as AuthEnv;
  const cookie = context.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && vars.SESSION_SECRET) {
    const claims = await verifySession(vars.SESSION_SECRET, cookie);
    if (claims) {
      context.locals.user = await loadSessionUser(vars.DB, claims.personId, claims.epoch);
    }
  }
  // Dev bypass: in `astro dev`, AUTH_DEV_BYPASS_EMAIL attaches that person with no
  // cookie so authed pages can be built without the mail round-trip. `import.meta.
  // env.DEV` is statically false in the production build, so this is tree-shaken.
  if (!context.locals.user && import.meta.env.DEV && vars.AUTH_DEV_BYPASS_EMAIL) {
    context.locals.user = await loadSessionUserByEmail(vars.DB, vars.AUTH_DEV_BYPASS_EMAIL);
  }

  // Route policy gate: the policy classifies BEFORE route existence, so a
  // not-yet-built protected page (e.g. /my) still redirects rather than 404s.
  const cls = classifyRoute(rest);
  if (!canAccess(cls, context.locals.user)) {
    if (!context.locals.user && context.request.method === 'GET') {
      const nextPath = encodeURIComponent(pathname + context.url.search);
      return context.redirect(`/${context.locals.locale}/signin?next=${nextPath}`, 303);
    }
    return forbidden(context.locals.locale);
  }

  const res = await next();

  const isAsset =
    pathname.startsWith('/_astro/') ||
    pathname.startsWith('/images/') ||
    pathname === '/favicon.svg' ||
    pathname === '/robots.txt';
  if (!isAsset) {
    applySecurityHeaders(res.headers);
    // Any page rendered with a user is personal — never store it in a shared cache.
    if (context.locals.user) res.headers.set('cache-control', 'no-store');
  }
  return res;
});
