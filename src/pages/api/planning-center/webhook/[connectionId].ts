import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { sha256Utf8, parsePlanningCenterWebhookEnvelope, verifyPlanningCenterWebhook } from '../../../../lib/planningCenterClient';
import { enqueuePlanningCenterSyncJob, planningCenterCredentials, planningCenterDatabaseId } from '../../../../lib/planningCenterSync';

export const prerender = false;
const MAX_BODY_BYTES = 256 * 1024;
const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (status: number, body?: Record<string, boolean>): Response => new Response(body ? JSON.stringify(body) : null, { status, headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) } });

class PlanningCenterWebhookBodyTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel('planning_center_webhook_too_large'); } catch { /* return the bounded response even if cancellation races disconnect */ }
        throw new PlanningCenterWebhookBodyTooLargeError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const connectionId = Number(params.connectionId);
  if (!Number.isSafeInteger(connectionId) || connectionId < 1) return json(404);
  const connection = await locals.db.prepare(`SELECT id,organization_id FROM planning_center_connections WHERE id=?1 AND state='active'`).bind(connectionId).first<{ id: number; organization_id: string }>();
  if (!connection) return json(404);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return json(413);
  let body: string;
  try {
    const bytes = await readBoundedBody(request);
    body = new TextDecoder().decode(bytes);
  } catch (error) { return json(error instanceof PlanningCenterWebhookBodyTooLargeError ? 413 : 400); }
  const signature = request.headers.get('X-PCO-Webhooks-Authenticity');
  if (!signature) return json(400);
  let credentials;
  try { credentials = planningCenterCredentials(env as unknown as Parameters<typeof planningCenterCredentials>[0]); }
  catch { return json(503); }
  const verified = await verifyPlanningCenterWebhook(signature, body, credentials.webhookSecret);
  if (!verified.ok || !verified.eventDigest) return json(400);
  let envelope;
  try { envelope = parsePlanningCenterWebhookEnvelope(body); } catch { return json(400); }
  if (envelope.organizationId !== connection.organization_id) return json(404);
  const listCursor = '/people/v2/people?include=emails,phone_numbers';
  const exactCursor = envelope.providerPersonId ? `/people/v2/people/${envelope.providerPersonId}?include=emails,phone_numbers` : listCursor;
  const existing = await locals.db.prepare(`SELECT receipt_id FROM planning_center_webhook_receipts WHERE connection_id=?1 AND delivery_id=?2`)
    .bind(connectionId, envelope.deliveryId).first<{ receipt_id: string }>();
  if (existing) {
    try { await Promise.all([enqueuePlanningCenterSyncJob(locals.db, { connectionId, stream: 'people', cursor: exactCursor }), enqueuePlanningCenterSyncJob(locals.db, { connectionId, stream: 'person_mergers' })]); }
    catch { return json(503); }
    return json(200, { ok: true });
  }
  const signatureDigest = await sha256Utf8(signature.trim());
  const receiptId = await sha256Utf8(`planning-center-webhook:v1\0${connectionId}\0${envelope.deliveryId}`);
  const peopleJobId = planningCenterDatabaseId();
  let mergerJobId = planningCenterDatabaseId();
  while (mergerJobId === peopleJobId) mergerJobId = planningCenterDatabaseId();
  try {
    await locals.db.batch([
      locals.db.prepare(`INSERT INTO planning_center_webhook_receipts(receipt_id,connection_id,delivery_id,event_type,attempt,signature_digest,event_digest)
        VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(receiptId, connectionId, envelope.deliveryId, envelope.eventType, envelope.attempt, signatureDigest, verified.eventDigest),
      locals.db.prepare(`INSERT INTO planning_center_sync_jobs(id,connection_id,stream,state,cursor,pending_cursor,rerun_requested,not_before) VALUES(?1,?2,'people','pending',?3,NULL,0,NULL)
        ON CONFLICT(connection_id,stream) DO UPDATE SET
          state=CASE WHEN planning_center_sync_jobs.state='running' THEN 'running' ELSE 'pending' END,
          cursor=CASE WHEN planning_center_sync_jobs.state='running' THEN planning_center_sync_jobs.cursor WHEN excluded.cursor IS NULL THEN planning_center_sync_jobs.cursor ELSE excluded.cursor END,
          pending_cursor=CASE WHEN planning_center_sync_jobs.state='running' THEN COALESCE(excluded.cursor,planning_center_sync_jobs.pending_cursor) ELSE NULL END,
          rerun_requested=CASE WHEN planning_center_sync_jobs.state='running' THEN 1 ELSE 0 END,
          not_before=planning_center_sync_jobs.not_before,updated_at=CURRENT_TIMESTAMP`).bind(peopleJobId, connectionId, exactCursor),
      locals.db.prepare(`INSERT INTO planning_center_sync_jobs(id,connection_id,stream,state,cursor,pending_cursor,rerun_requested,not_before) VALUES(?1,?2,'person_mergers','pending',NULL,NULL,0,NULL)
        ON CONFLICT(connection_id,stream) DO UPDATE SET state=CASE WHEN planning_center_sync_jobs.state='running' THEN 'running' ELSE 'pending' END,
          rerun_requested=CASE WHEN planning_center_sync_jobs.state='running' THEN 1 ELSE 0 END,
          not_before=planning_center_sync_jobs.not_before,updated_at=CURRENT_TIMESTAMP`).bind(mergerJobId, connectionId),
    ]);
  } catch {
    const raced = await locals.db.prepare(`SELECT receipt_id FROM planning_center_webhook_receipts WHERE connection_id=?1 AND delivery_id=?2`)
      .bind(connectionId, envelope.deliveryId).first<{ receipt_id: string }>();
    if (raced) {
      try {
        await Promise.all([enqueuePlanningCenterSyncJob(locals.db, { connectionId, stream: 'people', cursor: exactCursor }), enqueuePlanningCenterSyncJob(locals.db, { connectionId, stream: 'person_mergers' })]);
        return json(200, { ok: true });
      } catch { return json(503); }
    }
    return json(503);
  }
  // Planning Center retries every non-200 response, so acknowledge only after
  // the durable receipt and both authoritative-sync jobs exist.
  return json(200, { ok: true });
};
