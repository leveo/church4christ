import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listCustomPages } from '../lib/pagesDb';
import { enabledSitemapPaths, publicOrigin, renderSitemap, type SitemapPage } from '../lib/seo';

// Public landing pages for the enabled modules plus published custom pages, in
// both locales with hreflang alternates. Private and token pages never appear.
export const GET: APIRoute = async ({ url, locals }) => {
  const origin = publicOrigin((env as { APP_ORIGIN?: string }).APP_ORIGIN, url);
  const pages: SitemapPage[] = enabledSitemapPaths(locals.modules).map((path) => ({ path }));
  try {
    for (const page of await listCustomPages(locals.db)) {
      if (page.published) pages.push({ path: `/p/${encodeURIComponent(page.slug)}`, lastmod: page.updated_at });
    }
  } catch {
    /* custom pages unavailable: still serve the landing pages */
  }
  return new Response(renderSitemap(origin, pages), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
};
