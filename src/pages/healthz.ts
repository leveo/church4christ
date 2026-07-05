import type { APIRoute } from 'astro';

// Liveness probe: no locale, no session, no DB. Just proves the Worker is up.
export const GET: APIRoute = () => Response.json({ ok: true });
