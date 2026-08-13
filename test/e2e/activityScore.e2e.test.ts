import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import {
  attendanceModulesBody as modulesBody,
  attendanceSessionCookie as sessionCookie,
  consumeStatus as status,
} from './attendanceHelpers';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (70, 'Ari', 'Activity', 'Ari Activity', 'ari.activity@example.com', 'admin', 0, 'activity-score')
      ON CONFLICT(id) DO UPDATE SET admin_areas='activity-score'`),
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (71, 'Nora', 'Score', 'Nora Score', 'nora.score@example.com', 'admin', 0, '')
      ON CONFLICT(id) DO UPDATE SET admin_areas=''`),
  ]);
});

afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await status(await post('/admin/settings', modulesBody([]), { cookie: admin }));
});

function configBody(revision = 0): string {
  const body = new URLSearchParams({
    action: 'save_config',
    revision: String(revision),
    window_days: '60',
    weight_group_attendance: '100',
    weight_serving: '0',
    weight_registration: '0',
    target_serving: '3',
    target_registration: '2',
    active_threshold: '75',
    watch_threshold: '35',
  });
  body.append('membership_status', 'regular');
  body.append('membership_status', 'member');
  body.append('dimension', 'group_attendance');
  return body.toString();
}

describe('Activity Score built-worker access and rendering', () => {
  it('redirects anonymous users, denies ungranted admins, and renders for its grant and super admin', async () => {
    const anonymous = await get('/admin/activity-score');
    expect(anonymous.status).toBe(303);
    await anonymous.arrayBuffer();

    const denied = await sessionCookie(71, 'nora.score@example.com');
    expect(await status(await get('/admin/activity-score', { cookie: denied }))).toBe(403);

    const granted = await sessionCookie(70, 'ari.activity@example.com');
    const grantedHtml = await (await get('/admin/activity-score', { cookie: granted })).text();
    expect(grantedHtml).toContain('Activity score');
    expect(grantedHtml).toContain('Church-wide average');
    expect(grantedHtml).toContain('Show calculation');
    expect(grantedHtml).not.toContain('name="action" value="save_config"');

    const admin = await sessionCookie(1, 'admin@example.com');
    const adminHtml = await (await get('/admin/activity-score', { cookie: admin })).text();
    expect(adminHtml).toContain('name="action" value="save_config"');
    expect(adminHtml).not.toMatch(/pastoral_notes|person\.email|group_name|position_name/i);
  });

  it('lets only a super admin save a revisioned model', async () => {
    const granted = await sessionCookie(70, 'ari.activity@example.com');
    expect(await status(await post('/admin/activity-score', configBody(), { cookie: granted }))).toBe(403);

    const admin = await sessionCookie(1, 'admin@example.com');
    const saved = await post('/admin/activity-score', configBody(), { cookie: admin });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin/activity-score?saved=1');
    await saved.arrayBuffer();

    expect(await env.DB.prepare(
      'SELECT window_days, active_threshold, watch_threshold, revision FROM activity_score_config WHERE id=1',
    ).first()).toEqual({ window_days: 60, active_threshold: 75, watch_threshold: 35, revision: 1 });
    expect(await env.DB.prepare(
      `SELECT enabled, weight FROM activity_score_dimensions WHERE dimension_key='group_attendance'`,
    ).first()).toEqual({ enabled: 1, weight: 100 });

    const stale = await post('/admin/activity-score', configBody(), { cookie: admin });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain('changed while you were editing');
  });

  it('returns 404 before authentication when the module is disabled, then restores it', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    expect(await status(await post('/admin/settings', modulesBody(['activity-score']), { cookie: admin }))).toBe(303);
    expect(await status(await get('/admin/activity-score'))).toBe(404);
    expect(await status(await post('/admin/activity-score', 'hostile=body'))).toBe(404);

    expect(await status(await post('/admin/settings', modulesBody([]), { cookie: admin }))).toBe(303);
    expect(await status(await get('/admin/activity-score', { cookie: admin }))).toBe(200);
  });
});
