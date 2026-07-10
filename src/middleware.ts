import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { DEFAULT_LOCALE, pathWithoutLocale, pickLocaleFromHeader } from './lib/locales';
import { getActiveTheme, THEME_DEFAULT } from './lib/theme';
import { MODULE_KEYS, filterByBackend, getEnabledModules, moduleForPath } from './lib/modules';
import { applySecurityHeaders } from './lib/securityHeaders';
import { SESSION_COOKIE, verifySession } from './lib/session';
import { loadSessionUser, loadSessionUserByEmail } from './lib/currentUser';
import { canAccess, classifyRoute } from './lib/routePolicy';
import { adminAreaForPath, hasAreaAccess } from './lib/adminAreas';
import { openDb, type DbEnv } from './lib/dbProvider';

// Baseline security headers (spec §14) live in ./lib/securityHeaders; the route
// authorization policy lives in ./lib/routePolicy (both dependency-free +
// unit-tested). Static assets are served by the ASSETS binding before middleware
// runs; the isAsset guard below is a dev-time safety net.

// SESSION_SECRET and AUTH_DEV_BYPASS_EMAIL are runtime secrets/vars that
// `wrangler types` cannot see (they're not in wrangler.jsonc), so read them off
// the Worker env with a cast — same technique as the reference stack's middleware.
type AuthEnv = { SESSION_SECRET?: string; AUTH_DEV_BYPASS_EMAIL?: string };

/** Minimal 403 page. Deliberately unstyled this slice; visual polish lands later.
 *  Hardened like every other response: baseline security headers + no-store
 *  (this branch can be reached with a user attached — insufficient role). */
function forbidden(locale: string): Response {
  const html = `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>403 Forbidden</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; text-align: center;"> <!-- /* tokens-ok */ intentional system-font fallback: this minimal 403 renders without the token CSS bundle -->
<h1>403</h1><p>You do not have access to this page.</p><p><a href="/${locale}/">Home</a></p>
</body></html>`;
  const res = new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
  applySecurityHeaders(res.headers);
  return res;
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
  context.locals.user = null;

  // Per-request database seam. openDb is a zero-copy passthrough on the D1
  // default (env.DB IS the AppDb) and cannot throw when DB is bound, so it runs
  // OUTSIDE the fail-safe try/catch blocks below (those guard the reads, not the
  // open). On supabase it opens a request-scoped postgres.js client; every exit
  // from here on — the finish() returns AND thrown exceptions (the catch at the
  // bottom) — drains that client exactly once via the idempotent release().
  const { db, backend, end } = openDb(env as unknown as DbEnv);
  context.locals.db = db;
  context.locals.dbBackend = backend;
  // Defer draining the db client until after the response is handed off, without
  // blocking the streamed body. cfContext is the adapter's ExecutionContext
  // (Astro v6 replaced the removed locals.runtime.ctx with locals.cfContext);
  // optional-chained so a runtime-less unit caller never crashes, and end() is a
  // no-op on D1 so this is free on the default backend.
  let released = false;
  // Drain the per-request db client exactly once (ends the postgres.js client on
  // supabase; a no-op on D1).
  const drainClient = (): Promise<void> => {
    if (released) return Promise.resolve();
    released = true;
    return end();
  };
  // Non-streaming exits (redirects, 403, and the whole D1 backend) can drain in
  // the background — nothing streams a db query after they return.
  const release = () => {
    context.locals.cfContext?.waitUntil?.(drainClient());
  };
  const finish = (res: Response): Response => {
    // supabase: a rendered body streams LAZILY — component db queries run as the
    // client consumes the stream, so ending the postgres.js client at
    // middleware-return would race them (CONNECTION_ENDED mid-render). Pipe the
    // body through a pass-through TransformStream whose flush() — fired after the
    // last byte on NORMAL completion — drains the client, deferring end() until
    // every in-render query has run. But flush() only fires on a clean close: a
    // client disconnect or a mid-render throw ABORTS the writable side instead, so
    // flush() never runs and the client would leak. Drive a BACKSTOP off the pipe
    // promise, which settles on EVERY outcome (resolves on clean close, rejects on
    // abort/error), and drain there too. drainClient()'s `released` flag makes the
    // double-drain a no-op — the client is ended exactly once, whichever path
    // fires first. The backstop rides waitUntil so it never blocks the response;
    // where waitUntil is absent (unit callers), flush() still covers the success
    // path. Null-body exits (redirects) have nothing to stream.
    if (backend === 'supabase' && res.body) {
      const { readable, writable } = new TransformStream({
        async flush() {
          await drainClient();
        },
      });
      const pumped = res.body.pipeTo(writable);
      context.locals.cfContext?.waitUntil?.(pumped.catch(() => {}).finally(() => drainClient()));
      return new Response(readable, res);
    }
    release();
    return res;
  };

  try {
    // Active theme from the `theme.name` setting, cached per-isolate (60s) in
    // ./lib/theme. Guarded: an empty DB or a missing settings table (fresh install)
    // falls back to THEME_DEFAULT rather than 500ing every page.
    const vars = env as unknown as AuthEnv;
    try {
      context.locals.theme = (await getActiveTheme(db)).theme;
    } catch {
      context.locals.theme = THEME_DEFAULT;
    }

    // Module gating (spec addendum §A): the single choke point. A path owned by a
    // disabled module 404s — public and admin alike, anon or authed — before the
    // route policy runs (the module check is orthogonal). locals.modules is ALWAYS
    // set: an empty DB / missing settings table (fresh install) fails safe to
    // all-enabled rather than 500ing. The 404 renders the real /404 page via the
    // rewrite pattern, reconstructed with a 404 status and the baseline headers.
    let modules: Set<string>;
    try {
      modules = await getEnabledModules(db, context.locals.dbBackend);
    } catch {
      // Fail safe to all-enabled, but STILL honor backend gating: a supabase-only
      // module (giving/registration) must stay off on D1 even when the settings
      // read fails, or a core route like /give would call listFunds against a
      // nonexistent table and 500 instead of falling back gracefully.
      modules = filterByBackend(MODULE_KEYS, context.locals.dbBackend);
    }
    context.locals.modules = modules;

    const mod = moduleForPath(rest);
    if (mod && !modules.has(mod)) {
      const rendered = await context.rewrite('/404');
      const res = new Response(rendered.body, { status: 404, headers: rendered.headers });
      applySecurityHeaders(res.headers);
      return finish(res);
    }

    // CSRF: reject cross-origin state-changing requests before doing any work. When
    // the Origin header is present it must match this origin; when it is absent,
    // fall back to Sec-Fetch-Site (a forged cross-site POST cannot set it to
    // same-origin). SameSite=Lax on the session cookie is the backstop. The 403 is
    // hardened like every other early return (baseline headers + no-store).
    const method = context.request.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = context.request.headers.get('origin');
      const site = context.request.headers.get('sec-fetch-site');
      const sameOrigin = origin
        ? origin === context.url.origin
        : site === null || site === 'same-origin' || site === 'none';
      if (!sameOrigin) {
        const res = new Response('Forbidden', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
        applySecurityHeaders(res.headers);
        return finish(res);
      }
    }

    // Session: reload the person row every request so deactivation / soft-delete /
    // epoch bumps take effect immediately. Fail closed — a missing SESSION_SECRET
    // (or any verify/load failure) simply leaves the user anonymous, never a 500.
    const cookie = context.cookies.get(SESSION_COOKIE)?.value;
    if (cookie && vars.SESSION_SECRET) {
      const claims = await verifySession(vars.SESSION_SECRET, cookie);
      if (claims) {
        context.locals.user = await loadSessionUser(db, claims.personId, claims.epoch);
      }
    }
    // Dev bypass: in `astro dev`, AUTH_DEV_BYPASS_EMAIL attaches that person with no
    // cookie so authed pages can be built without the mail round-trip. `import.meta.
    // env.DEV` is statically false in the production build, so this is tree-shaken.
    if (!context.locals.user && import.meta.env.DEV && vars.AUTH_DEV_BYPASS_EMAIL) {
      context.locals.user = await loadSessionUserByEmail(db, vars.AUTH_DEV_BYPASS_EMAIL);
    }

    // Route policy gate: the policy classifies BEFORE route existence, so a
    // not-yet-built protected page (e.g. /my) still redirects rather than 404s.
    // Both early returns are hardened — no response leaves without the baseline
    // security headers (the 303 branch is anonymous-only, so no no-store needed).
    const cls = classifyRoute(rest);
    if (!canAccess(cls, context.locals.user)) {
      if (!context.locals.user && context.request.method === 'GET') {
        const nextPath = encodeURIComponent(pathname + context.url.search);
        const redirect = context.redirect(`/${context.locals.locale}/signin?next=${nextPath}`, 303);
        applySecurityHeaders(redirect.headers);
        return finish(redirect);
      }
      return finish(forbidden(context.locals.locale));
    }

    // Per-admin area gate (spec 2026-07-10): narrows LIMITED admins only — a
    // non-admin passing canAccess (editor / leader / finance member) is exactly
    // as authorized as before, and super admins pass everything. Runs after the
    // role gate so the failure modes stay distinct: module off = 404 (above,
    // pre-session), role short = 403 (canAccess), grant missing = 403 (here).
    // Unknown /admin paths carry no area and fail closed to super-admin-only.
    const u = context.locals.user;
    if (u?.isAdmin && !u.isSuperAdmin && (rest === '/admin' || rest.startsWith('/admin/'))) {
      if (rest !== '/admin') {
        const area = adminAreaForPath(rest);
        if (!area || !hasAreaAccess(u, area)) return finish(forbidden(context.locals.locale));
      }
    }

    const res = await next();

    const isAsset =
      pathname.startsWith('/_astro/') ||
      pathname.startsWith('/images/') ||
      pathname === '/favicon.svg' ||
      pathname === '/robots.txt';
    if (!isAsset) {
      applySecurityHeaders(res.headers);
      // Any page rendered with a user is personal — never store it in a shared
      // cache. /media/ and /cal/ are long-cacheable public assets (R2 media, iCal
      // feed) that set their own caching even when a user is attached, so exempt
      // them from the personal no-store (those routes land in a later slice).
      const isCacheable = pathname.startsWith('/media/') || pathname.startsWith('/cal/');
      if (context.locals.user && !isCacheable) res.headers.set('cache-control', 'no-store');
    }
    return finish(res);
  } catch (e) {
    // An exception after openDb (verifySession, loadSessionUser, next()'s render,
    // …) would skip every finish() — drain the client here too, then rethrow so
    // Astro's error handling sees the original failure unchanged.
    release();
    throw e;
  }
});
