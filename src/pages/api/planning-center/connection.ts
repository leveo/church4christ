import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { fetchPlanningCenterOrganization, validatePlanningCenterBaseUrl } from '../../../lib/planningCenterClient';
import { hasRecentStepUp } from '../../../lib/sessionAssurance';
import { planningCenterCredentials } from '../../../lib/planningCenterSync';

export const prerender = false;
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json' };
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const ID = /^[0-9]{1,32}$/u;

function newId(): number {
  return 1_200_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 800_000_000);
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user?.isSuperAdmin) return json(403, { error: 'forbidden' });
  if (!hasRecentStepUp(locals.assurance)) return json(428, { error: 'step_up_required' });
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 16 * 1024) return json(413, { error: 'invalid_request' });
  let input: Record<string, unknown>;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 16 * 1024) return json(413, { error: 'invalid_request' });
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, { error: 'invalid_request' });
    input = parsed as Record<string, unknown>;
  } catch { return json(400, { error: 'invalid_request' }); }
  const action = typeof input.action === 'string' ? input.action : 'configure';
  if (!['configure', 'pause', 'resume', 'disable'].includes(action)) return json(400, { error: 'invalid_request' });
  let credentials;
  try { credentials = planningCenterCredentials(env as never); } catch { return json(503, { error: 'not_configured' }); }
  if (action === 'pause' || action === 'resume' || action === 'disable') {
    if (!ID.test(String(input.connectionId ?? ''))) return json(400, { error: 'invalid_request' });
    const connectionId = Number(input.connectionId);
    if (!Number.isSafeInteger(connectionId) || connectionId < 1) return json(400, { error: 'invalid_request' });
    const row = await locals.rawDb.prepare(`SELECT id,organization_id,base_url,state FROM planning_center_connections WHERE id=?1`).bind(connectionId).first<{ id: number; organization_id: string; base_url: string; state: string }>();
    if (!row) return json(404, { error: 'not_found' });
    if (action === 'disable' && row.state !== 'paused') return json(409, { error: 'pause_required' });
    if (action === 'resume' && row.state === 'disabled') return json(409, { error: 'disabled_connection' });
    if (action === 'resume') {
      try {
        const organization = await fetchPlanningCenterOrganization({ baseUrl: row.base_url, clientId: credentials.clientId, secret: credentials.secret, userAgent: credentials.userAgent });
        if (organization.id !== row.organization_id) return json(409, { error: 'organization_mismatch' });
      } catch { return json(503, { error: 'verification_unavailable' }); }
    }
    const nextState = action === 'pause' ? 'paused' : action === 'disable' ? 'disabled' : 'active';
    const allowedState = action === 'pause' ? "state IN ('active','error')" : action === 'disable' ? "state='paused'" : "state IN ('paused','error')";
    const changed = await locals.rawDb.prepare(`UPDATE planning_center_connections SET state=?1,last_error_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND ${allowedState}`)
      .bind(nextState, connectionId).run();
    if ((changed.meta?.changes ?? 0) !== 1) return json(409, { error: 'connection_state_changed' });
    return json(200, { ok: true });
  }
  const campusId = Number(input.campusId);
  const organizationId = String(input.organizationId ?? '');
  if (!Number.isSafeInteger(campusId) || campusId < 1 || !ID.test(organizationId)) return json(400, { error: 'invalid_request' });
  const campus = await locals.rawDb.prepare(`SELECT id FROM campuses WHERE id=?1 AND active=1`).bind(campusId).first<{ id: number }>();
  if (!campus) return json(404, { error: 'not_found' });
  const baseUrl = validatePlanningCenterBaseUrl('https://api.planningcenteronline.com');
  try {
    const organization = await fetchPlanningCenterOrganization({ baseUrl, clientId: credentials.clientId, secret: credentials.secret, userAgent: credentials.userAgent });
    if (organization.id !== organizationId) return json(409, { error: 'organization_mismatch' });
  } catch { return json(503, { error: 'verification_unavailable' }); }
  const current = await locals.rawDb.prepare(`SELECT id,organization_id,state FROM planning_center_connections
    WHERE campus_id=?1 AND state IN ('active','paused','error')`).bind(campusId).first<{ id: number; organization_id: string; state: 'active' | 'paused' | 'error' }>();
  if (current && current.organization_id !== organizationId) return json(409, { error: 'organization_change_requires_disable' });
  const organizationConnection = await locals.rawDb.prepare(`SELECT id,campus_id FROM planning_center_connections
    WHERE organization_id=?1 AND state IN ('active','paused','error')`).bind(organizationId).first<{ id: number; campus_id: number }>();
  if (organizationConnection && organizationConnection.campus_id !== campusId) return json(409, { error: 'organization_already_connected' });
  if (current) {
    const changed = await locals.rawDb.prepare(`UPDATE planning_center_connections SET state='active',last_error_code=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id=?1 AND organization_id=?2 AND state=?3`).bind(current.id, organizationId, current.state).run();
    if ((changed.meta?.changes ?? 0) !== 1) return json(409, { error: 'connection_state_changed' });
    return json(200, { ok: true });
  }
  const inserted = await locals.rawDb.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
    VALUES(?1,?2,?3,?4,'active') ON CONFLICT DO NOTHING`).bind(newId(), campusId, baseUrl, organizationId).run();
  if ((inserted.meta?.changes ?? 0) !== 1) {
    const raced = await locals.rawDb.prepare(`SELECT organization_id FROM planning_center_connections
      WHERE campus_id=?1 AND state IN ('active','paused','error')`).bind(campusId).first<{ organization_id: string }>();
    if (!raced || raced.organization_id !== organizationId) {
      const organizationRace = await locals.rawDb.prepare(`SELECT campus_id FROM planning_center_connections
        WHERE organization_id=?1 AND state IN ('active','paused','error')`).bind(organizationId).first<{ campus_id: number }>();
      return json(409, { error: organizationRace ? 'organization_already_connected' : 'organization_change_requires_disable' });
    }
  }
  return json(200, { ok: true });
};
