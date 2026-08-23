import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { IDENTITY_MERGE_RISK_FACT_CATEGORIES } from '../src/lib/identityMergeModel';
import { claimPlanningCenterSyncJob, completePlanningCenterSyncJob, enqueuePlanningCenterSyncJob, failPlanningCenterSyncJob, recordPlanningCenterMergerEvidence, syncPlanningCenterPeoplePage } from '../src/lib/planningCenterSync';
import { POST as planningCenterWebhookPost } from '../src/pages/api/planning-center/webhook/[connectionId]';

const sourceEnv = {
  IDENTITY_SOURCE_KEY_SECRET: 'planning-center-test-stable-source-key-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
  PLANNING_CENTER_CLIENT_ID: 'client_test', PLANNING_CENTER_SECRET: 'secret_test',
  PLANNING_CENTER_WEBHOOK_SECRET: 'planning-center-webhook-secret-test', PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
};
const id = 1_700_000_001;

async function connection() {
  const connectionId = id;
  await env.DB.prepare(`INSERT OR IGNORE INTO planning_center_connections(id,campus_id,base_url,organization_id) VALUES(?1,1,?2,?3)`)
    .bind(connectionId, 'https://api.planningcenteronline.com', String(connectionId)).run();
  return connectionId;
}

describe('Planning Center durable sync', () => {
  it('stores only a hash of the short-lived lease token and rejects a lost completion claim', async () => {
    const connectionId = await connection();
    const [left, right] = await Promise.all([
      claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', now: new Date('2031-01-01T00:00:00Z') }),
      claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', now: new Date('2031-01-01T00:00:00Z') }),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const lease = left ?? right;
    expect(lease).toBeTruthy();
    const persisted = await env.DB.prepare('SELECT lease_token_hash FROM planning_center_sync_jobs WHERE connection_id=?1').bind(connectionId).first<{ lease_token_hash: string }>();
    expect(persisted?.lease_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.lease_token_hash).not.toBe(lease?.token);
    expect(await completePlanningCenterSyncJob(env.DB, { lease: { ...lease!, token: 'wrong' }, nextUrl: null, now: new Date('2031-01-01T00:01:00Z') })).toBe(false);
    expect(await completePlanningCenterSyncJob(env.DB, { lease: lease!, nextUrl: null, now: new Date('2031-01-01T00:01:00Z') })).toBe(true);
  });

  it('reclaims a running job only after its lease expires, while a succeeded cursor stays quiescent', async () => {
    const connectionId = await connection();
    const first = await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'person_mergers', now: new Date('2031-01-01T00:00:00Z'), leaseSeconds: 30 });
    expect(first).toBeTruthy();
    expect(await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'person_mergers', now: new Date('2031-01-01T00:00:29Z'), leaseSeconds: 30 })).toBeNull();
    const recovered = await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'person_mergers', now: new Date('2031-01-01T00:00:30Z'), leaseSeconds: 30 });
    expect(recovered).toBeTruthy();
    expect(await completePlanningCenterSyncJob(env.DB, { lease: recovered!, nextUrl: null, now: new Date('2031-01-01T00:00:31Z') })).toBe(true);
    expect(await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'person_mergers', now: new Date('2031-01-01T00:01:00Z') })).toBeNull();
  });

  it('retains a webhook cursor arriving during a running job until the lease completes', async () => {
    const connectionId = await connection();
    await enqueuePlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', cursor: '/people/v2/people?include=emails,phone_numbers' });
    const lease = await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', now: new Date('2031-01-02T00:00:00Z') });
    expect(lease).toBeTruthy();
    const exact = '/people/v2/people/6010?include=emails,phone_numbers';
    await enqueuePlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', cursor: exact });
    expect(await env.DB.prepare('SELECT state,pending_cursor,rerun_requested FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream=\'people\'').bind(connectionId).first()).toMatchObject({ state: 'running', pending_cursor: exact, rerun_requested: 1 });
    expect(await completePlanningCenterSyncJob(env.DB, { lease: lease!, nextUrl: null, now: new Date('2031-01-02T00:01:00Z') })).toBe(true);
    expect(await env.DB.prepare('SELECT state,cursor,pending_cursor,rerun_requested FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream=\'people\'').bind(connectionId).first()).toMatchObject({ state: 'pending', cursor: exact, pending_cursor: null, rerun_requested: 0 });
  });

  it('never shortens a provider Retry-After delay when another enqueue arrives', async () => {
    const connectionId = await connection();
    const now = new Date();
    const lease = await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', now });
    expect(lease).toBeTruthy();
    const retryAt = now.getTime() + 5 * 60 * 1000;
    expect(await failPlanningCenterSyncJob(env.DB, { lease: lease!, code: 'rate_limited', retryAt })).toBe(true);
    const before = await env.DB.prepare(`SELECT not_before FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream='people'`).bind(connectionId).first<string>('not_before');
    await enqueuePlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', cursor: '/people/v2/people/6010?include=emails,phone_numbers' });
    expect(await env.DB.prepare(`SELECT not_before FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream='people'`).bind(connectionId).first<string>('not_before')).toBe(before);
    expect(await claimPlanningCenterSyncJob(env.DB, { connectionId, stream: 'people', now: new Date(now.getTime() + 60_000) })).toBeNull();
  });

  it('idempotently records provider observations/mapping without creating an active person or PII receipt', async () => {
    const connectionId = await connection();
    const page = { data: [{ type: 'Person', id: '6001', attributes: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', updated_at: '2031-01-01T00:00:00Z' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    await expect(syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page })).resolves.toMatchObject({ processed: 1, reviews: 1 });
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page });
    expect(await env.DB.prepare('SELECT count(*) n FROM planning_center_person_mappings WHERE connection_id=?1').bind(connectionId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind('ada@example.test').first<number>('n')).toBe(0);
    const receipt = await env.DB.prepare('SELECT payload_digest,action FROM planning_center_sync_receipts WHERE connection_id=?1').bind(connectionId).first<{ payload_digest: string; action: string }>();
    expect(receipt?.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('Ada');
  });

  it('stops reading and cancels an oversized webhook stream without trusting Content-Length', async () => {
    const connectionId = await connection();
    for (const contentLength of [undefined, 'not-a-number']) {
      let produced = 0;
      let cancelled = false;
      const chunks = [new Uint8Array(128 * 1024), new Uint8Array(128 * 1024), new Uint8Array([1]), new Uint8Array([2])];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[produced++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const headers = new Headers({ 'content-type': 'application/json' });
      if (contentLength) headers.set('content-length', contentLength);
      const request = new Request(`https://church.example/api/planning-center/webhook/${connectionId}`, { method: 'POST', headers, body });
      const response = await planningCenterWebhookPost({ request, params: { connectionId: String(connectionId) }, locals: { db: env.DB } } as never);
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(produced).toBe(3);
    }
  });

  it('matches included contacts by the JSON:API type and id tuple', async () => {
    const connectionId = await connection();
    const page = {
      data: [{
        type: 'Person', id: '6099', attributes: { name: 'Tuple Match' },
        relationships: {
          emails: { data: [{ type: 'Email', id: 'shared-email' }] },
          phone_numbers: { data: [{ type: 'PhoneNumber', id: 'shared-phone' }] },
        },
      }],
      included: [
        { type: 'PhoneNumber', id: 'shared-email', attributes: { address: 'wrong@example.test', primary: true } },
        { type: 'Email', id: 'shared-email', attributes: { address: 'right@example.test', primary: false } },
        { type: 'Email', id: 'shared-phone', attributes: { number: '+13125550999', primary: true } },
        { type: 'PhoneNumber', id: 'shared-phone', attributes: { number: '+13125550100', primary: false } },
      ],
      links: { next: null },
      rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null },
    } as const;
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page });
    const observation = await env.DB.prepare(`SELECT o.normalized_email,o.normalized_phone
      FROM planning_center_person_mappings m
      JOIN identity_source_records s ON s.id=m.source_record_id
      JOIN identity_observations o ON o.id=s.observation_id
      WHERE m.connection_id=?1 AND m.provider_person_id='6099'`).bind(connectionId).first<{ normalized_email: string | null; normalized_phone: string | null }>();
    expect(observation).toMatchObject({ normalized_email: 'right@example.test', normalized_phone: '+13125550100' });
  });

  it('rejects a wrong JSON:API resource type before creating identity observations', async () => {
    const connectionId = await connection();
    const before = await env.DB.prepare("SELECT count(*) n FROM identity_source_records WHERE source='planning_center'").first<number>('n');
    const wrongPage = { data: [{ type: 'Email', id: '6011', attributes: { address: 'wrong@example.test' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    await expect(syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page: wrongPage })).rejects.toThrow('planning_center_person_shape_invalid');
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_source_records WHERE source='planning_center'").first<number>('n')).toBe(before);
  });

  it('namespaces source records by organization and permits audited connection generations', async () => {
    const campusId = 9_036;
    await env.DB.prepare(`INSERT OR IGNORE INTO campuses(id,slug,name,active,is_default) VALUES(?1,'pco-generation','PCO Generation',1,0)`).bind(campusId).run();
    const connections = [1_703_600_001, 1_703_600_002, 1_703_600_003, 1_703_600_004];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state) VALUES(?1,?2,?3,'90361','disabled')`).bind(connections[0], campusId, 'https://api.planningcenteronline.com'),
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state) VALUES(?1,?2,?3,'90362','active')`).bind(connections[1], campusId, 'https://api.planningcenteronline.com'),
    ]);
    const page = { data: [{ type: 'Person', id: '6010', attributes: { name: 'Same provider id' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId: connections[0], campusId, page });
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId: connections[1], campusId, page });
    const differentOrganizations = (await env.DB.prepare(`SELECT source_record_id FROM planning_center_person_mappings WHERE connection_id IN (?1,?2) ORDER BY connection_id`).bind(connections[0], connections[1]).all<{ source_record_id: number }>()).results;
    expect(differentOrganizations).toHaveLength(2);
    expect(differentOrganizations[0].source_record_id).not.toBe(differentOrganizations[1].source_record_id);

    await env.DB.prepare(`UPDATE planning_center_connections SET state='disabled' WHERE id=?1`).bind(connections[1]).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state) VALUES(?1,?2,?3,'90363','disabled')`).bind(connections[2], campusId, 'https://api.planningcenteronline.com'),
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state) VALUES(?1,?2,?3,'90363','active')`).bind(connections[3], campusId, 'https://api.planningcenteronline.com'),
    ]);
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId: connections[2], campusId, page });
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId: connections[3], campusId, page });
    const sameOrganization = (await env.DB.prepare(`SELECT source_record_id FROM planning_center_person_mappings WHERE connection_id IN (?1,?2) ORDER BY connection_id`).bind(connections[2], connections[3]).all<{ source_record_id: number }>()).results;
    expect(sameOrganization).toHaveLength(2);
    expect(sameOrganization[0].source_record_id).toBe(sameOrganization[1].source_record_id);
  });

  it('snapshots exact PCO mappings and makes an approval transition stale after substitution', async () => {
    const campusId = 9_034; const connectionId = 1_703_400_001;
    const loser = 1_703_400_011; const canonical = 1_703_400_012; const caseId = 1_703_400_013;
    const operationId = '123e4567-e89b-42d3-a456-426614179037';
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO campuses(id,slug,name,active,is_default) VALUES(?1,'pco-merge','PCO Merge',1,0)`).bind(campusId),
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state) VALUES(?1,?2,?3,'90341','active')`).bind(connectionId, campusId, 'https://api.planningcenteronline.com'),
      env.DB.prepare(`INSERT INTO people(id,display_name,email,home_campus_id) VALUES(?1,'PCO merge loser',?2,?3)`).bind(loser, `pco-loser-${loser}@example.test`, campusId),
      env.DB.prepare(`INSERT INTO people(id,display_name,email,home_campus_id) VALUES(?1,'PCO merge canonical',?2,?3)`).bind(canonical, `pco-canonical-${canonical}@example.test`, campusId),
      env.DB.prepare(`INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version) VALUES(?1,?2,?3,?4,99,'high','same_person',1)`).bind(caseId, campusId, loser, canonical),
    ]);
    const page = { data: [{ type: 'Person', id: '7037', attributes: { name: 'PCO mapped identity' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId, page });
    await env.DB.prepare(`UPDATE planning_center_person_mappings SET person_id=?1,match_state='matched' WHERE connection_id=?2 AND provider_person_id='7037'`).bind(loser, connectionId).run();
    const insertOperation = (id: string, risk: 'normal' | 'high', approvals: 1 | 2) => env.DB.prepare(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,expected_resolution_case_version,
      resolution_case_hash,scope_kind,campus_id,expected_loser_identity_version,expected_loser_session_epoch,
      expected_canonical_identity_version,expected_canonical_session_epoch,preview_hash,preview_version,
      preview_expires_at,risk,risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES(?1,?2,?3,?4,1,?5,'campus',?6,1,0,1,0,?7,1,'2099-01-01T00:00:00.000Z',?8,?9,1,?10,'previewed',?2)`)
      .bind(id, loser, canonical, caseId, 'c'.repeat(64), campusId, 'a'.repeat(64), risk, 'b'.repeat(64), approvals).run();
    await expect(insertOperation('123e4567-e89b-42d3-a456-426614179036', 'normal', 1)).rejects.toThrow(/planning_center_merge_requires_external_identity_review/);
    await insertOperation(operationId, 'high', 2);
    expect(await env.DB.prepare(`SELECT side,connection_id,provider_person_id FROM planning_center_merge_mapping_snapshots WHERE operation_id=?1`).bind(operationId).first()).toMatchObject({ side: 'loser', connection_id: connectionId, provider_person_id: '7037' });
    await expect(env.DB.prepare(`INSERT INTO planning_center_merge_mapping_snapshots(
      operation_id,side,connection_id,provider_person_id,source_record_id)
      SELECT ?1,'canonical',connection_id,provider_person_id,source_record_id
      FROM planning_center_person_mappings WHERE connection_id=?2 AND provider_person_id='7037'`)
      .bind(operationId, connectionId).run()).rejects.toThrow(/sealed/);
    await env.DB.batch(IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category) => {
      const side = category === 'campus_membership' ? 1 : 0;
      return env.DB.prepare(`INSERT INTO person_merge_risk_facts(operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
        VALUES(?1,?2,?3,?3,?4,?5,?6,1)`).bind(operationId, category, side, side * 2, category === 'campus_membership' ? 1 : 0, 'b'.repeat(64));
    }));
    await env.DB.prepare(`UPDATE planning_center_person_mappings SET person_id=?1 WHERE connection_id=?2 AND provider_person_id='7037'`).bind(canonical, connectionId).run();
    await expect(env.DB.prepare(`UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1`).bind(operationId).run()).rejects.toThrow(/planning_center_merge_mapping_stale/);
    expect(await env.DB.prepare(`SELECT state FROM person_merge_operations WHERE operation_id=?1`).bind(operationId).first<string>('state')).toBe('previewed');
    await expect(env.DB.prepare(`DELETE FROM planning_center_merge_mapping_snapshots WHERE operation_id=?1`).bind(operationId).run()).rejects.toThrow(/append_only/);
    await expect(env.DB.prepare(`DELETE FROM planning_center_merge_mapping_snapshot_seals WHERE operation_id=?1`).bind(operationId).run()).rejects.toThrow(/append_only/);
  });

  it('records both merger identities and opens a local review case without executing a merge', async () => {
    const connectionId = await connection();
    const page = (id: string) => ({ data: [{ type: 'Person', id, attributes: { name: `Provider ${id}` } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const);
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page: page('6002') });
    await syncPlanningCenterPeoplePage(env.DB, sourceEnv, { connectionId, campusId: 1, page: page('6003') });
    const keepPerson = 1_710_000_001; const removePerson = 1_710_000_002;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people(id,display_name,email,role,home_campus_id) VALUES(?1,?2,?3,'member',1)`).bind(keepPerson, 'Keep', `keep-${keepPerson}@example.test`),
      env.DB.prepare(`INSERT INTO people(id,display_name,email,role,home_campus_id) VALUES(?1,?2,?3,'member',1)`).bind(removePerson, 'Remove', `remove-${removePerson}@example.test`),
      env.DB.prepare(`UPDATE planning_center_person_mappings SET person_id=?1,match_state='matched' WHERE connection_id=?2 AND provider_person_id='6002'`).bind(keepPerson, connectionId),
      env.DB.prepare(`UPDATE planning_center_person_mappings SET person_id=?1,match_state='matched' WHERE connection_id=?2 AND provider_person_id='6003'`).bind(removePerson, connectionId),
    ]);
    const mergerPage = { data: [{ type: 'PersonMerger', id: 'merge-1', attributes: { person_to_keep_id: '6002', person_to_remove_id: '6003' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    expect(await recordPlanningCenterMergerEvidence(env.DB, { connectionId, page: mergerPage })).toBe(1);
    const evidence = await env.DB.prepare(`SELECT provider_person_id,provider_person_remove_id,review_case_id FROM planning_center_external_evidence WHERE connection_id=?1`).bind(connectionId).first<{ provider_person_id: string; provider_person_remove_id: string; review_case_id: number | null }>();
    expect(evidence).toMatchObject({ provider_person_id: '6002', provider_person_remove_id: '6003' });
    expect(evidence?.review_case_id).toBeTypeOf('number');
    expect(await env.DB.prepare('SELECT count(*) n FROM person_merge_redirects').first<number>('n')).toBe(0);
  });

  it('rejects non-PersonMerger rows without recording external evidence', async () => {
    const connectionId = await connection();
    const wrongPage = { data: [{ type: 'Person', id: 'merge-wrong', attributes: { person_to_keep_id: '6002', person_to_remove_id: '6003' } }], included: [], links: { next: null }, rate: { limit: null, count: null, remaining: null, periodSeconds: null, resetAt: null } } as const;
    await expect(recordPlanningCenterMergerEvidence(env.DB, { connectionId, page: wrongPage })).rejects.toThrow('planning_center_merger_shape_invalid');
  });
});
