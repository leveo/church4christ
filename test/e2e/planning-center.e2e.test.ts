import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN } from './helpers';

const connectionId = 1_765_000_001;
const webhookSecret = 'e2e-planning-center-webhook-secret-at-least-thirty-two-characters';

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(webhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function eventBody(deliveryId: string): string {
  return JSON.stringify({ data: [{
    type: 'EventDelivery', id: deliveryId,
    attributes: {
      name: 'people.v2.events.person.updated', attempt: 1,
      payload: JSON.stringify({ data: { type: 'Person', id: '6010', attributes: { email: 'must-not-persist@example.test' } } }),
    },
    relationships: { organization: { data: { type: 'Organization', id: '42' } } },
  }] });
}

describe('Planning Center webhook through middleware', () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(?1,1,'https://api.planningcenteronline.com','42','active')`).bind(connectionId).run();
  });

  it('reaches the raw-body HMAC route without browser Origin headers and commits both jobs before 200', async () => {
    const body = eventBody(`delivery-${crypto.randomUUID()}`);
    const response = await SELF.fetch(`${ORIGIN}/api/planning-center/webhook/${connectionId}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'X-PCO-Webhooks-Authenticity': await signature(body) },
    });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) n FROM planning_center_sync_jobs WHERE connection_id=?1').bind(connectionId).first<number>('n')).toBe(2);
    expect(await env.DB.prepare('SELECT count(*) n FROM planning_center_webhook_receipts WHERE connection_id=?1').bind(connectionId).first<number>('n')).toBe(1);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM planning_center_webhook_receipts WHERE connection_id=?1').bind(connectionId).first())).not.toContain('must-not-persist');
  });

  it('still rejects a forged signature after the CSRF exemption', async () => {
    const body = eventBody(`forged-${crypto.randomUUID()}`);
    const response = await SELF.fetch(`${ORIGIN}/api/planning-center/webhook/${connectionId}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'X-PCO-Webhooks-Authenticity': '0'.repeat(64) },
    });
    expect(response.status).toBe(400);
  });

  it('does not let a valid new webhook bypass an existing provider Retry-After delay', async () => {
    const notBefore = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await env.DB.prepare(`UPDATE planning_center_sync_jobs SET state='pending',not_before=?1 WHERE connection_id=?2 AND stream='people'`).bind(notBefore, connectionId).run();
    const body = eventBody(`rate-${crypto.randomUUID()}`);
    const response = await SELF.fetch(`${ORIGIN}/api/planning-center/webhook/${connectionId}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'X-PCO-Webhooks-Authenticity': await signature(body) },
    });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare(`SELECT not_before FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream='people'`).bind(connectionId).first<string>('not_before')).toBe(notBefore);
  });
});
