// The member app's service worker for one locale, served at /<locale>/app/sw.js so
// its default scope is exactly /<locale>/app/ (it never controls website pages).
// Revalidated on every check (no-cache) so a new release reaches installed apps.
import type { APIRoute } from 'astro';
import pkg from '../../../../package.json';
import { parseLocale } from '../../../lib/locales';
import { buildServiceWorker, resolveAppTabs } from '../../../lib/memberApp';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const locale = parseLocale(params.locale ?? '');
  if (!locale || !(await resolveAppTabs(locals.db, locals.modules, null))) {
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response(buildServiceWorker(locale, pkg.version), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
};
