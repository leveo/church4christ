import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { enqueueDuePlanningCenterSyncJobs, enqueuePlanningCenterSyncJobs, runPlanningCenterSyncPass } from '../../src/lib/planningCenterSync';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const sourceEnv = {
  IDENTITY_SOURCE_KEY_SECRET: 'planning-center-test-stable-source-key-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
  PLANNING_CENTER_CLIENT_ID: 'client_test',
  PLANNING_CENTER_SECRET: 'secret_test',
  PLANNING_CENTER_WEBHOOK_SECRET: 'planning-center-webhook-secret-test',
  PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
};

describe.skipIf(!hasPg)('Planning Center scheduler fairness (PostgreSQL)', () => {
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

  it('fairly enqueues and processes 33 active connections with portable SQL', async () => {
    for (let index = 0; index < 33; index += 1) {
      const campusId = 1_000 + index;
      const connectionId = 1_780_000_000 + index;
      await sql.unsafe(`INSERT INTO campuses(id,slug,name) VALUES($1,$2,$3)`, [campusId, `pco-pg-fair-${campusId}`, `PCO PG Fair ${campusId}`]);
      await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
        VALUES($1,$2,'https://api.planningcenteronline.com',$3,'active')`, [connectionId, campusId, String(connectionId)]);
    }

    expect(await enqueuePlanningCenterSyncJobs(db)).toBe(32);
    expect(await enqueuePlanningCenterSyncJobs(db)).toBe(32);
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_sync_jobs`))[0].n)).toBe(66);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], included: [], links: { next: null } }), {
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' },
    })));
    const first = await runPlanningCenterSyncPass(sourceEnv, db, new Date('2031-02-02T00:00:00Z'));
    const second = await runPlanningCenterSyncPass(sourceEnv, db, new Date('2031-02-02T00:01:00Z'));
    expect(first).toMatchObject({ claimed: 64, completed: 64, retried: 0 });
    expect(second).toMatchObject({ claimed: 2, completed: 2, retried: 0 });
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_connections WHERE last_success_at IS NOT NULL`))[0].n)).toBe(33);
    await sql.unsafe(`UPDATE planning_center_connections SET state='disabled' WHERE id BETWEEN 1780000000 AND 1780000032`);
  });

  it('filters due rows before the PostgreSQL batch limit, including an invalid timestamp', async () => {
    const connections: number[] = [];
    for (let index = 0; index < 34; index += 1) {
      const campusId = 2_000 + index;
      const connectionId = 1_781_000_000 + index;
      connections.push(connectionId);
      await sql.unsafe(`INSERT INTO campuses(id,slug,name) VALUES($1,$2,$3)`, [campusId, `pco-pg-due-${campusId}`, `PCO PG Due ${campusId}`]);
      await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state,last_success_at)
        VALUES($1,$2,'https://api.planningcenteronline.com',$3,'active','2031-02-01 00:30:00')`, [connectionId, campusId, String(connectionId)]);
    }
    await sql.unsafe(`UPDATE planning_center_connections SET last_success_at='2031-01-01 00:00:00' WHERE id=$1`, [connections[32]]);
    await sql.unsafe(`UPDATE planning_center_connections SET last_success_at='not-a-timestamp' WHERE id=$1`, [connections[33]]);

    expect(await enqueueDuePlanningCenterSyncJobs(db, new Date('2031-02-01T01:00:00Z'))).toBe(2);
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id IN ($1,$2)`, [connections[32], connections[33]]))[0].n)).toBe(4);
    expect(Number((await sql.unsafe(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN $1 AND $2`, [connections[0], connections[31]]))[0].n)).toBe(0);
  });
});
