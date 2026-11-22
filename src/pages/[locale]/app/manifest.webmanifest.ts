// The member app's web app manifest for one locale: the church name from Settings,
// the locale's tagline, the active theme's colors, and the bundled app icons.
import type { APIRoute } from 'astro';
import { localeMeta, parseLocale } from '../../../lib/locales';
import { t } from '../../../lib/i18n';
import { getSiteIdentity } from '../../../lib/settings';
import { THEME_DEFAULT } from '../../../lib/theme';
import { THEME_META } from '../../../lib/themeMeta.generated';
import { buildManifest, resolveAppTabs } from '../../../lib/memberApp';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const locale = parseLocale(params.locale ?? '');
  if (!locale || !(await resolveAppTabs(locals.db, locals.modules, null))) {
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  let name = t(locale, 'site.name');
  let description = t(locale, 'site.tagline');
  try {
    const identity = await getSiteIdentity(locals.db, locale);
    if (identity.name) name = identity.name;
    if (identity.tagline) description = identity.tagline;
  } catch {
    /* keep the built-in name and tagline */
  }
  const theme = THEME_META.find((m) => m.name === (locals.theme ?? THEME_DEFAULT)) ?? THEME_META[0];
  const manifest = buildManifest({
    locale,
    lang: localeMeta(locale).bcp47,
    name,
    description,
    themeColor: theme.swatches.primary,
    backgroundColor: theme.swatches.surface,
  });
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
};
