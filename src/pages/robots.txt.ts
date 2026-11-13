import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { publicOrigin, renderRobots } from '../lib/seo';

// Generated so the Sitemap line names this deployment's own domain (APP_ORIGIN).
export const GET: APIRoute = ({ url }) => {
  const origin = publicOrigin((env as { APP_ORIGIN?: string }).APP_ORIGIN, url);
  return new Response(renderRobots(origin), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
};
