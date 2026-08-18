import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

beforeAll(async () => {
  const connectionString = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE.connectionString;
  const sql = postgres(connectionString, { max: 1, fetch_types: false, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (70, 'Ari', 'Activity', 'Ari Activity', 'ari.activity@example.com', 'admin', 0, 'activity-score')
      ON CONFLICT (id) DO UPDATE SET admin_areas='activity-score'`);
  } finally {
    await sql.end();
  }
});

describe('Activity Score built worker on PostgreSQL', () => {
  it('renders for the dedicated grant and saves configuration only for super admin', async () => {
    const granted = await sessionCookie(70, 'ari.activity@example.com');
    const grantedResponse = await get('/admin/activity-score', { cookie: granted });
    expect(grantedResponse.status).toBe(200);
    expect(await grantedResponse.text()).toContain('Church-wide average');

    const body = new URLSearchParams({
      action: 'save_config', revision: '0', window_days: '30',
      weight_group_attendance: '50', weight_serving: '50', weight_registration: '0',
      weight_learning_engagement: '0', target_serving: '3', target_registration: '2',
      target_learning_engagement: '3', active_threshold: '70', watch_threshold: '40',
    });
    body.append('membership_status', 'regular');
    body.append('membership_status', 'member');
    body.append('dimension', 'group_attendance');
    body.append('dimension', 'serving');
    expect((await post('/admin/activity-score', body.toString(), { cookie: granted })).status).toBe(403);

    const admin = await sessionCookie(1, 'admin@example.com');
    const saved = await post('/admin/activity-score', body.toString(), { cookie: admin });
    expect(saved.status).toBe(303);
    await saved.arrayBuffer();
  });
});
