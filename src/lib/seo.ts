// Search-engine helpers shared by the public layout, /robots.txt, and /sitemap.xml.
// Everything here is pure so it can be unit-tested without a request. The public
// origin comes from the deployment's APP_ORIGIN (the same value email links use),
// falling back to the request origin, so canonical URLs, the sitemap, and robots.txt
// always point at the church's own domain rather than a build-time placeholder.
import { LOCALES, localePath, type Locale } from './locales';
import { moduleForPath } from './modules';
import { classifyRoute } from './routePolicy';

/** Normalized `https://host[:port]` origin for public SEO links. */
export function publicOrigin(appOrigin: string | undefined, requestUrl: URL): string {
  if (appOrigin) {
    try {
      const url = new URL(appOrigin);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      /* malformed APP_ORIGIN: fall back to the request origin */
    }
  }
  return requestUrl.origin;
}

// Verification tokens are short opaque strings; anything else is ignored so a
// misconfigured variable can never inject markup into <head>.
const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{8,128}$/u;

export type SiteVerification = Readonly<{ name: string; content: string }>;

/** Optional search-console ownership tags configured through Worker vars. */
export function siteVerificationTags(env: {
  GOOGLE_SITE_VERIFICATION?: string;
  BING_SITE_VERIFICATION?: string;
}): SiteVerification[] {
  const tags: SiteVerification[] = [];
  const google = env.GOOGLE_SITE_VERIFICATION?.trim();
  const bing = env.BING_SITE_VERIFICATION?.trim();
  if (google && VERIFICATION_TOKEN.test(google)) tags.push({ name: 'google-site-verification', content: google });
  if (bing && VERIFICATION_TOKEN.test(bing)) tags.push({ name: 'msvalidate.01', content: bing });
  return tags;
}

/**
 * Locale-stripped public landing pages a visitor can open without signing in.
 * Detail pages (a sermon, an article) are reached by crawling these lists.
 */
export const SITEMAP_PATHS = [
  '/',
  '/about',
  '/about/beliefs',
  '/about/staff',
  '/visit',
  '/new-here',
  '/sermons',
  '/events',
  '/bulletin',
  '/articles',
  '/prayer',
  '/fellowships',
  '/groups',
  '/ministries',
  '/serve',
  '/serve/gifts',
  '/serve/opportunities',
  '/serve/testimonies',
  '/give',
  '/register',
  '/privacy',
] as const;

/** Landing paths that are public and whose owning module (if any) is enabled. */
export function enabledSitemapPaths(modules: ReadonlySet<string>): string[] {
  return SITEMAP_PATHS.filter((path) => {
    if (classifyRoute(path) !== 'public') return false;
    const owner = moduleForPath(path);
    return !owner || modules.has(owner);
  });
}

export type SitemapPage = Readonly<{ path: string; lastmod?: string }>;

function xmlEscape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

const HREFLANG: Record<Locale, string> = { en: 'en', zh: 'zh-Hans' };

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value.includes('T') || value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** sitemaps.org XML with one <url> per locale and hreflang alternates. */
export function renderSitemap(origin: string, pages: readonly SitemapPage[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const page of pages) {
    const lastmod = isoDate(page.lastmod);
    for (const locale of LOCALES) {
      lines.push('  <url>');
      lines.push(`    <loc>${xmlEscape(new URL(localePath(locale, page.path), origin).href)}</loc>`);
      if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
      for (const alt of LOCALES) {
        const href = xmlEscape(new URL(localePath(alt, page.path), origin).href);
        lines.push(`    <xhtml:link rel="alternate" hreflang="${HREFLANG[alt]}" href="${href}"/>`);
      }
      lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(new URL(localePath('en', page.path), origin).href)}"/>`);
      lines.push('  </url>');
    }
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

/** Root-level paths crawlers should skip: staff, token, and machine endpoints. */
const ROBOTS_ROOT_DISALLOW = ['/admin', '/api/', '/auth/', '/respond/', '/email-change/', '/kiosk', '/cal/', '/attendance/'];

/** Locale-prefixed private or one-time pages (signed-in areas, sign-in, recovery). */
const ROBOTS_LOCALE_DISALLOW = ['/my', '/manage', '/profile', '/settings', '/identity', '/signin', '/reauth', '/recover', '/recovery-veto'];

export function robotsDisallowPaths(): string[] {
  const paths = [...ROBOTS_ROOT_DISALLOW];
  for (const locale of LOCALES) {
    for (const path of ROBOTS_LOCALE_DISALLOW) paths.push(`/${locale}${path}$`, `/${locale}${path}/`);
  }
  return paths;
}

export function renderRobots(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    ...robotsDisallowPaths().map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${new URL('/sitemap.xml', origin).href}`,
    '',
  ].join('\n');
}
