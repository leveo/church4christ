// /app: the member app's language-neutral entry (the address to share or print on
// a bulletin). Opens the app in the language this device last chose (the
// language cookie, when that language is still enabled), else in the site's
// default language from Settings -> Languages (English unless an admin changed it).
import type { APIRoute } from 'astro';
import { LOCALE_COOKIE, isSupportedLocale } from '../lib/locales';

export const prerender = false;

export const GET: APIRoute = ({ cookies, locals, redirect }) => {
  const saved = cookies.get(LOCALE_COOKIE)?.value;
  const { enabled, default: fallback } = locals.locales;
  const locale = saved && isSupportedLocale(saved) && enabled.includes(saved) ? saved : fallback;
  return redirect(`/${locale}/app`, 302);
};
