import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/pages/api/planning-center/connection';

const SESSION_ID = '12345678-1234-4123-8123-123456789abc';
const assurance = () => {
  const now = Math.floor(Date.now() / 1000);
  return { schemaVersion: 2 as const, sessionId: SESSION_ID, authMethod: 'email_otp' as const, authTime: now, stepUpTime: now };
};

function request(body: unknown): Request {
  return new Request('http://localhost/api/planning-center/connection', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function post(body: unknown, overrides: Record<string, unknown> = {}): Promise<Response> {
  return POST({
    request: request(body),
    locals: { user: { isSuperAdmin: true }, assurance: assurance(), rawDb: env.DB, ...overrides },
  } as never) as Promise<Response>;
}

describe('Planning Center connection administration', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { type: 'Organization', id: '9038', attributes: { name: 'Reviewed replacement' } },
    }), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } })));
    await env.DB.prepare(`INSERT OR IGNORE INTO campuses(id,slug,name,active,is_default) VALUES(9037,'pco-review','PCO Review',1,0)`).run();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('enforces super-admin, recent step-up, and the actual UTF-8 byte limit before parsing', async () => {
    expect((await post({ action: 'configure' }, { user: { isSuperAdmin: false } })).status).toBe(403);
    expect((await post({ action: 'configure' }, { assurance: null })).status).toBe(428);
    const oversized = new Request('http://localhost/api/planning-center/connection', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: '教'.repeat(6_000) }),
    });
    const response = await POST({ request: oversized, locals: { user: { isSuperAdmin: true }, assurance: assurance(), rawDb: env.DB } } as never) as Response;
    expect(response.status).toBe(413);
  });

  it('requires pause then disable and creates a clean replacement connection without reusing old cursors', async () => {
    const oldId = 1_903_700_001;
    await env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(?1,9037,'https://api.planningcenteronline.com','9037','active')`).bind(oldId).run();
    await env.DB.prepare(`INSERT INTO planning_center_sync_cursors(connection_id,stream,next_url)
      VALUES(?1,'people','/people/v2/people?page=old')`).bind(oldId).run();

    const rejected = await post({ campusId: 9037, organizationId: '9038' });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: 'organization_change_requires_disable' });
    expect((await post({ action: 'disable', connectionId: oldId })).status).toBe(409);
    expect((await post({ action: 'pause', connectionId: oldId })).status).toBe(200);
    expect((await post({ action: 'disable', connectionId: oldId })).status).toBe(200);
    expect((await post({ campusId: 9037, organizationId: '9038' })).status).toBe(200);

    const rows = (await env.DB.prepare(`SELECT id,organization_id,state FROM planning_center_connections WHERE campus_id=9037 ORDER BY id`).all()).results as Array<{ id: number; organization_id: string; state: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === oldId)).toMatchObject({ organization_id: '9037', state: 'disabled' });
    const replacement = rows.find((row) => row.id !== oldId)!;
    expect(replacement).toMatchObject({ organization_id: '9038', state: 'active' });
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_cursors WHERE connection_id=?1`).bind(oldId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM planning_center_sync_cursors WHERE connection_id=?1`).bind(replacement.id).first<number>('n')).toBe(0);
  });

  it('returns 409 when a stale configure loses a race to permanent disable', async () => {
    const connectionId = 1_903_700_002;
    const campusId = 9_039;
    await env.DB.prepare(`INSERT INTO campuses(id,slug,name,active,is_default) VALUES(?1,'pco-race','PCO Race',1,0)`).bind(campusId).run();
    await env.DB.prepare(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(?1,?2,'https://api.planningcenteronline.com','9039','paused')`).bind(connectionId, campusId).run();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        data: { type: 'Organization', id: '9039', attributes: { name: 'Race-safe organization' } },
      }), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } })));
    let raced = false;
    const racingDb = {
      prepare(sql: string) {
        let statement = env.DB.prepare(sql);
        const wrapped = {
          bind(...values: unknown[]) { statement = statement.bind(...values); return wrapped; },
          async first<T = unknown>(columnName?: string): Promise<T | null> {
            if (!raced && sql.includes(`WHERE organization_id=?1 AND state IN`)) {
              raced = true;
              await env.DB.prepare(`UPDATE planning_center_connections SET state='disabled',updated_at=CURRENT_TIMESTAMP
                WHERE id=?1 AND state='paused'`).bind(connectionId).run();
            }
            return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
          },
          all<T = unknown>() { return statement.all<T>(); },
          run<T = unknown>() { return statement.run<T>(); },
        };
        return wrapped;
      },
    };

    const response = await post({ campusId, organizationId: '9039' }, { rawDb: racingDb });
    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'connection_state_changed' });
    expect(await env.DB.prepare(`SELECT state FROM planning_center_connections WHERE id=?1`).bind(connectionId).first<string>('state')).toBe('disabled');
  });

  it('does not rewrite an arbitrary insert or trigger failure as a connection conflict', async () => {
    const campusId = 9_040;
    await env.DB.prepare(`INSERT INTO campuses(id,slug,name,active,is_default) VALUES(?1,'pco-trigger','PCO Trigger',1,0)`).bind(campusId).run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: { type: 'Organization', id: '9040', attributes: { name: 'Trigger-safe organization' } },
    }), { status: 200, headers: { 'content-type': 'application/vnd.api+json' } })));
    const failingDb = {
      prepare(sql: string) {
        let statement = env.DB.prepare(sql);
        const wrapped = {
          bind(...values: unknown[]) { statement = statement.bind(...values); return wrapped; },
          first<T = unknown>(columnName?: string) {
            return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
          },
          all<T = unknown>() { return statement.all<T>(); },
          run<T = unknown>() {
            if (sql.includes(`INSERT INTO planning_center_connections`)) throw new Error('planning_center_trigger_abort');
            return statement.run<T>();
          },
        };
        return wrapped;
      },
    };

    await expect(post({ campusId, organizationId: '9040' }, { rawDb: failingDb })).rejects.toThrow('planning_center_trigger_abort');
  });
});
