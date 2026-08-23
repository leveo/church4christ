import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasRecentStepUp } from '../../../lib/sessionAssurance';
import { enqueuePlanningCenterSyncJobs, planningCenterCredentials, runPlanningCenterSyncPass } from '../../../lib/planningCenterSync';

export const prerender = false;
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json' };
const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const POST: APIRoute = async ({ locals }) => {
  if (!locals.user?.isSuperAdmin) return response(403, { error: 'forbidden' });
  if (!hasRecentStepUp(locals.assurance)) return response(428, { error: 'step_up_required' });
  try { planningCenterCredentials(env as never); }
  catch (error) { return response(error instanceof Error && error.message === 'planning_center_not_configured' ? 503 : 400, { error: 'not_configured' }); }
  try {
    await enqueuePlanningCenterSyncJobs(locals.rawDb);
    const result = await runPlanningCenterSyncPass(env as never, locals.rawDb);
    return response(200, result);
  } catch { return response(503, { error: 'sync_unavailable' }); }
};
