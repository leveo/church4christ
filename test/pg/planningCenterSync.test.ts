import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { claimPlanningCenterSyncJob, enqueuePlanningCenterSyncJob, failPlanningCenterSyncJob } from '../../src/lib/planningCenterSync';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

vi.mock('cloudflare:workers', () => ({
  env: {
    PLANNING_CENTER_CLIENT_ID: 'client_test',
    PLANNING_CENTER_SECRET: 'secret_test',
    PLANNING_CENTER_WEBHOOK_SECRET: 'planning-center-webhook-secret-test',
    PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
  },
}));

describe.skipIf(!hasPg)('Planning Center synchronization (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });
  afterEach(() => vi.unstubAllGlobals());

  it('uses distinct application-generated integer job ids under concurrent enqueue', async () => {
    await Promise.all([1, 2, 3, 4].map(async (campusId) => {
      if (campusId > 1) await sql.unsafe('INSERT INTO campuses(id,slug,name) VALUES($1,$2,$3)', [campusId, `pco-pg-${campusId}`, `PCO PG ${campusId}`]);
      await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id)
        VALUES($1,$2,'https://api.planningcenteronline.com',$3)`, [1_760_000_000 + campusId, campusId, String(40 + campusId)]);
      await Promise.all([
        enqueuePlanningCenterSyncJob(db, { connectionId: 1_760_000_000 + campusId, stream: 'people' }),
        enqueuePlanningCenterSyncJob(db, { connectionId: 1_760_000_000 + campusId, stream: 'person_mergers' }),
      ]);
    }));
    const rows = await sql.unsafe('SELECT id FROM planning_center_sync_jobs ORDER BY id');
    const ids = rows.map((row) => Number(row.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids.every((id) => Number.isSafeInteger(id) && id >= 1_100_000_000)).toBe(true);
  });

  it('retains disabled connection evidence and permits one new current connection for its campus', async () => {
    await sql.unsafe("UPDATE planning_center_connections SET state='disabled' WHERE campus_id=1");
    await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(1765000099,1,'https://api.planningcenteronline.com','99','active')`);
    const rows = await sql.unsafe('SELECT organization_id,state FROM planning_center_connections WHERE campus_id=1 ORDER BY id');
    expect(rows).toMatchObject([{ organization_id: '41', state: 'disabled' }, { organization_id: '99', state: 'active' }]);
    await expect(sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(1765000100,1,'https://api.planningcenteronline.com','100','active')`)).rejects.toThrow();
  });

  it('keeps a concurrently disabled connection disabled when a stale configure completes', async () => {
    const campusId = 96;
    const connectionId = 1_765_000_096;
    await sql.unsafe(`INSERT INTO campuses(id,slug,name) VALUES($1,'pco-pg-race','PCO PG Race')`, [campusId]);
    await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES($1,$2,'https://api.planningcenteronline.com','196','paused')`, [connectionId, campusId]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { type: 'Organization', id: '196', attributes: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      })));
    let raced = false;
    const racingDb = {
      prepare(sqlText: string) {
        let statement = db.prepare(sqlText);
        const wrapped = {
          bind(...values: unknown[]) { statement = statement.bind(...values); return wrapped; },
          async first<T = unknown>(columnName?: string): Promise<T | null> {
            if (!raced && sqlText.includes(`WHERE organization_id=?1 AND state IN`)) {
              raced = true;
              await sql.unsafe(`UPDATE planning_center_connections SET state='disabled',updated_at=CURRENT_TIMESTAMP
                WHERE id=$1 AND state='paused'`, [connectionId]);
            }
            return statement.first<T>(columnName);
          },
          all<T = unknown>() { return statement.all<T>(); },
          run<T = unknown>() { return statement.run<T>(); },
        };
        return wrapped;
      },
    };

    const { POST } = await import('../../src/pages/api/planning-center/connection');
    const now = Math.floor(Date.now() / 1000);
    const pending = POST({
      request: new Request('https://church.example/api/planning-center/connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campusId, organizationId: '196' }),
      }),
      locals: {
        user: { isSuperAdmin: true },
        assurance: { schemaVersion: 2, sessionId: '12345678-1234-4123-8123-123456789abc', authMethod: 'email_otp', authTime: now, stepUpTime: now },
        rawDb: racingDb,
      },
    } as never) as Promise<Response>;

    const response = await pending;
    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'connection_state_changed' });
    expect((await sql.unsafe(`SELECT state FROM planning_center_connections WHERE id=$1`, [connectionId]))[0].state).toBe('disabled');
  });

  it('preserves Retry-After across a later enqueue through the PostgreSQL adapter', async () => {
    const connectionId = 1_765_000_099;
    const now = new Date();
    await enqueuePlanningCenterSyncJob(db, { connectionId, stream: 'people' });
    const lease = await claimPlanningCenterSyncJob(db, { connectionId, stream: 'people', now });
    expect(lease).toBeTruthy();
    const retryAt = now.getTime() + 5 * 60 * 1000;
    expect(await failPlanningCenterSyncJob(db, { lease: lease!, code: 'rate_limited', retryAt })).toBe(true);
    const before = (await sql.unsafe(`SELECT not_before FROM planning_center_sync_jobs WHERE connection_id=$1 AND stream='people'`, [connectionId]))[0].not_before;
    await enqueuePlanningCenterSyncJob(db, { connectionId, stream: 'people', cursor: '/people/v2/people/6010?include=emails,phone_numbers' });
    const after = (await sql.unsafe(`SELECT not_before FROM planning_center_sync_jobs WHERE connection_id=$1 AND stream='people'`, [connectionId]))[0].not_before;
    expect(after).toBe(before);
    expect(await claimPlanningCenterSyncJob(db, { connectionId, stream: 'people', now: new Date(now.getTime() + 60_000) })).toBeNull();
  });

  it('rolls back the whole webhook-style batch on an application-id collision', async () => {
    const connectionId = 1_765_000_099;
    const existing = (await sql.unsafe(`SELECT id FROM planning_center_sync_jobs WHERE connection_id=$1 AND stream='people'`, [connectionId]))[0];
    const receiptId = 'pg-collision-receipt';
    await expect(db.batch([
      db.prepare(`INSERT INTO planning_center_webhook_receipts(receipt_id,connection_id,delivery_id,event_type,attempt,signature_digest,event_digest)
        VALUES(?1,?2,'pg-collision-delivery','people.v2.events.person.updated',1,?3,?3)`).bind(receiptId, connectionId, 'a'.repeat(64)),
      db.prepare(`INSERT INTO planning_center_sync_jobs(id,connection_id,stream) VALUES(?1,?2,'person_mergers')`).bind(Number(existing.id), connectionId),
    ])).rejects.toThrow();
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_webhook_receipts WHERE receipt_id=$1`, [receiptId]))[0].n)).toBe(0);
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id=$1 AND stream='person_mergers'`, [connectionId]))[0].n)).toBe(0);
  });
});
