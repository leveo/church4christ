import { defineMiddleware } from 'astro:middleware';
import { DEFAULT_LOCALE, pathWithoutLocale, pickLocaleFromHeader } from './lib/locales';
import { THEME_DEFAULT } from './lib/theme';
import { applySecurityHeaders } from './lib/securityHeaders';

// Baseline security headers (spec §14) live in ./lib/securityHeaders so the
// values are unit-tested independently of Astro. Static assets are served by
// the ASSETS binding before middleware runs; the isAsset guard below is a
// dev-time safety net.

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
  // otherwise fall back to the default so unmatched paths still 404 (Astro's
  // 404 route) rendered in a real locale. Unknown prefixes are not blocked here.
  const { locale } = pathWithoutLocale(pathname);
  context.locals.locale = locale ?? DEFAULT_LOCALE;
  context.locals.theme = THEME_DEFAULT; // settings-driven in slice 5
  context.locals.user = null; // session wiring lands in slice 3

  const res = await next();

  const isAsset =
    pathname.startsWith('/_astro/') ||
    pathname.startsWith('/images/') ||
    pathname === '/favicon.svg' ||
    pathname === '/robots.txt';
  if (!isAsset) {
    applySecurityHeaders(res.headers);
  }
  return res;
});
