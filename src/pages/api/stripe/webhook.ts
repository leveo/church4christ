import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { DbEnv } from '../../../lib/dbProvider';
import type { StripeEnv } from '../../../lib/stripe';
import { handleStripeWebhookRequest } from '../../../lib/stripeWebhookEndpoint';

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) => handleStripeWebhookRequest(request, {
  db: locals.db,
  env: env as unknown as StripeEnv & DbEnv,
  modules: locals.modules,
  waitUntil: locals.cfContext?.waitUntil?.bind(locals.cfContext),
});
