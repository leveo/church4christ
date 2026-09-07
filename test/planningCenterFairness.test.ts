import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueDuePlanningCenterSyncJobs,
  enqueuePlanningCenterSyncJob,
  enqueuePlanningCenterSyncJobs,
  runPlanningCenterSyncPass,
} from '../src/lib/planningCenterSync';

const sourceEnv = {
  IDENTITY_SOURCE_KEY_SECRET: 'planning-center-test-stable-source-key-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
  PLANNING_CENTER_CLIENT_ID: 'client_test',
  PLANNING_CENTER_SECRET: 'secret_test',
  PLANNING_CENTER_WEBHOOK_SECRET: 'planning-center-webhook-secret-test',
  PLANNING_CENTER_USER_AGENT: 'Church CMS <https://church.example/contact>',
};

async function connectionFleet(input: { campusBase: number; connectionBase: number; count?: number }): Promise<number[]> {
  const count = input.count ?? 33;
  const ids = Array.from({ length: count }, (_, index) => input.connectionBase + index);
  await env.DB.batch(ids.flatMap((connectionId, index) => {
    const campusId = input.campusBase + index;
    return [
      env.DB.prepare(`INSERT INTO campuses(id,slug,name,active,is_default) VALUES(?1,?2,?3,1,0)`)
        .bind(campusId, `pco-fair-${campusId}`, `PCO Fair ${campusId}`),
      env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
        VALUES(?1,?2,'https://api.planningcenteronline.com',?3,'active')`).bind(connectionId, campusId, String(connectionId)),
    ];
  }));
  return ids;
}

async function cleanupFleet(input: { campusBase: number; connectionBase: number; count?: number }): Promise<void> {
  const count = input.count ?? 33;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2`).bind(input.connectionBase, input.connectionBase + count - 1),
    env.DB.prepare(`DELETE FROM planning_center_sync_cursors WHERE connection_id BETWEEN ?1 AND ?2`).bind(input.connectionBase, input.connectionBase + count - 1),
    env.DB.prepare(`DELETE FROM planning_center_connections WHERE id BETWEEN ?1 AND ?2`).bind(input.connectionBase, input.connectionBase + count - 1),
    env.DB.prepare(`DELETE FROM campuses WHERE id BETWEEN ?1 AND ?2`).bind(input.campusBase, input.campusBase + count - 1),
  ]);
}

function stubPlanningCenterPages(): void {
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request : request.url);
    const exact = /^\/people\/v2\/people\/([0-9]{1,32})$/u.exec(url.pathname);
    return new Response(JSON.stringify({
      data: exact ? { type: 'Person', id: exact[1], attributes: { name: `Webhook ${exact[1]}` } } : [],
      included: [],
      links: { next: null },
    }), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } });
  }));
}

describe('Planning Center bounded scheduler fairness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fairly enqueues and processes all 33 active connections across bounded manual passes', async () => {
    const fleet = { campusBase: 9_100, connectionBase: 1_711_000_000 };
    await connectionFleet(fleet);
    try {
      expect(await enqueuePlanningCenterSyncJobs(env.DB)).toBe(32);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2`)
        .bind(fleet.connectionBase, fleet.connectionBase + 32).first<number>('n')).toBe(64);
      expect(await enqueuePlanningCenterSyncJobs(env.DB)).toBe(32);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2`)
        .bind(fleet.connectionBase, fleet.connectionBase + 32).first<number>('n')).toBe(66);

      stubPlanningCenterPages();
      const first = await runPlanningCenterSyncPass(sourceEnv, env.DB, new Date('2031-02-01T00:00:00Z'));
      const second = await runPlanningCenterSyncPass(sourceEnv, env.DB, new Date('2031-02-01T00:01:00Z'));
      expect(first).toMatchObject({ claimed: 64, completed: 64, retried: 0 });
      expect(second).toMatchObject({ claimed: 2, completed: 2, retried: 0 });
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2 AND state='succeeded'`)
        .bind(fleet.connectionBase, fleet.connectionBase + 32).first<number>('n')).toBe(66);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_connections WHERE id BETWEEN ?1 AND ?2 AND last_success_at IS NOT NULL`)
        .bind(fleet.connectionBase, fleet.connectionBase + 32).first<number>('n')).toBe(33);
    } finally {
      await cleanupFleet(fleet);
    }
  });

  it('eventually enqueues all 33 due connections across bounded hourly calls', async () => {
    const fleet = { campusBase: 9_200, connectionBase: 1_712_000_000 };
    await connectionFleet(fleet);
    try {
      const now = new Date('2031-02-01T01:00:00Z');
      expect(await enqueueDuePlanningCenterSyncJobs(env.DB, now)).toBe(32);
      expect(await enqueueDuePlanningCenterSyncJobs(env.DB, now)).toBe(32);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2`)
        .bind(fleet.connectionBase, fleet.connectionBase + 32).first<number>('n')).toBe(66);
    } finally {
      await cleanupFleet(fleet);
    }
  });

  it('selects old and invalid due timestamps before limiting a mixed 34-connection fleet', async () => {
    const fleet = { campusBase: 9_500, connectionBase: 1_715_000_000, count: 34 };
    const connections = await connectionFleet(fleet);
    try {
      await env.DB.prepare(`UPDATE planning_center_connections SET last_success_at='2031-02-01 00:30:00'
        WHERE id BETWEEN ?1 AND ?2`).bind(connections[0], connections[31]).run();
      await env.DB.prepare(`UPDATE planning_center_connections SET last_success_at='2031-01-01 00:00:00'
        WHERE id=?1`).bind(connections[32]).run();
      await env.DB.prepare(`UPDATE planning_center_connections SET last_success_at='not-a-timestamp'
        WHERE id=?1`).bind(connections[33]).run();

      expect(await enqueueDuePlanningCenterSyncJobs(env.DB, new Date('2031-02-01T01:00:00Z'))).toBe(2);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id IN (?1,?2)`)
        .bind(connections[32], connections[33]).first<number>('n')).toBe(4);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2`)
        .bind(connections[0], connections[31]).first<number>('n')).toBe(0);
    } finally {
      await cleanupFleet(fleet);
    }
  });

  it('prioritizes an unattempted 33rd connection over an equal-timestamp failed prefix', async () => {
    const fleet = { campusBase: 9_400, connectionBase: 1_714_000_000 };
    const connections = await connectionFleet(fleet);
    try {
      await enqueuePlanningCenterSyncJobs(env.DB);
      await enqueuePlanningCenterSyncJobs(env.DB);
      await env.DB.prepare(`UPDATE planning_center_sync_jobs
        SET state='failed',attempts=1,updated_at='2031-01-01 00:00:00'
        WHERE connection_id BETWEEN ?1 AND ?2`).bind(connections[0], connections[31]).run();
      await env.DB.prepare(`UPDATE planning_center_sync_jobs SET updated_at='2031-01-01 00:00:00'
        WHERE connection_id=?1`).bind(connections[32]).run();
      stubPlanningCenterPages();

      const result = await runPlanningCenterSyncPass(sourceEnv, env.DB, new Date('2031-02-01T01:30:00Z'));
      expect(result).toMatchObject({ claimed: 64, completed: 64, retried: 0 });
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id=?1 AND attempts=1`)
        .bind(connections[32]).first<number>('n')).toBe(2);
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_jobs WHERE connection_id BETWEEN ?1 AND ?2 AND attempts>1`)
        .bind(connections[0], connections[31]).first<number>('n')).toBe(62);
    } finally {
      await cleanupFleet(fleet);
    }
  });

  it('claims a webhook-style job for connection 33 without an id-prefix gate', async () => {
    const fleet = { campusBase: 9_300, connectionBase: 1_713_000_000 };
    const connections = await connectionFleet(fleet);
    const last = connections[32];
    await enqueuePlanningCenterSyncJob(env.DB, { connectionId: last, stream: 'people', cursor: '/people/v2/people/9300?include=emails,phone_numbers' });
    stubPlanningCenterPages();

    const result = await runPlanningCenterSyncPass(sourceEnv, env.DB, new Date('2031-02-01T02:00:00Z'));
    expect(result).toMatchObject({ claimed: 2, completed: 2, retried: 0 });
    expect(await env.DB.prepare(`SELECT state,attempts,cursor FROM planning_center_sync_jobs WHERE connection_id=?1 AND stream='people'`).bind(last).first())
      .toMatchObject({ state: 'pending', attempts: 1, cursor: '/people/v2/people?include=emails,phone_numbers' });
    expect(await env.DB.prepare(`SELECT last_success_at FROM planning_center_connections WHERE id=?1`).bind(last).first<string>('last_success_at')).not.toBeNull();
  });
});
