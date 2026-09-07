import { t } from './i18n';
import { pickLocaleFromHeader } from './locales';

/** Locale-free emailed links use the same request negotiation as the site root.
 * This controls presentation only; token checks and successful redirects remain
 * in each route. Valid attendance retains the verified owner's saved language. */
export function tokenPagePresentation(
  request: Request,
  kind: 'auth' | 'emailChange' | 'attendance',
  state: 'confirm' | 'error',
  email = '',
) {
  const locale = pickLocaleFromHeader(request.headers.get('accept-language'));
  const prefix = kind === 'attendance' ? 'attendance.invalid'
    : `${kind === 'auth' ? 'auth' : 'portal.emailChange'}.${state}`;
  return {
    locale,
    title: t(locale, `${prefix}.title`),
    body: t(locale, `${prefix}.body`, { site: t(locale, 'site.name'), email }),
    action: kind === 'attendance' ? '' : t(locale, `${prefix}.${state === 'confirm' ? 'button' : 'retry'}`),
    retryHref: `/${locale}/signin`,
  };
}
