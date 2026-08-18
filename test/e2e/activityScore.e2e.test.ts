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
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas, lang)
      VALUES (72, 'Lin', 'Score', 'Lin Score', 'lin.score@example.com', 'admin', 0, 'activity-score', 'zh')
      ON CONFLICT(id) DO UPDATE SET admin_areas='activity-score', lang='zh'`),
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
    weight_learning_engagement: '0',
    target_serving: '3',
    target_registration: '2',
    target_learning_engagement: '3',
    active_threshold: '75',
    watch_threshold: '35',
  });
  body.append('membership_status', 'regular');
  body.append('membership_status', 'member');
  body.append('dimension', 'group_attendance');
  return body.toString();
}

function learningConfigBody(): string {
  const body = new URLSearchParams({
    action: 'save_config', revision: '0', window_days: '60',
    weight_group_attendance: '0', weight_serving: '0', weight_registration: '0',
    weight_learning_engagement: '100', target_serving: '3', target_registration: '2',
    target_learning_engagement: '3', active_threshold: '70', watch_threshold: '40',
  });
  body.append('membership_status', 'regular');
  body.append('membership_status', 'member');
  body.append('dimension', 'learning_engagement');
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
    expect(adminHtml).toContain('Learning engagement');
    expect(adminHtml).not.toMatch(/pastoral_notes|person\.email|group_name|position_name/i);

    const chinese = await sessionCookie(72, 'lin.score@example.com');
    const chineseHtml = await (await get('/admin/activity-score', { cookie: chinese })).text();
    expect(chineseHtml).toContain('学习参与');
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

  it('renders privacy-bounded Learning submission evidence through the built Worker', async () => {
    await env.DB.batch([
      env.DB.prepare(`UPDATE people SET membership_status='member', active=1, deleted_at=NULL WHERE id=1`),
      env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,status) VALUES (19610,'google_classroom','Built score source','active')`),
      env.DB.prepare(`INSERT INTO learning_programs
        (id,slug,display_name,status) VALUES (19620,'built-score','Built score program','active')`),
      env.DB.prepare(`INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state)
        VALUES (19630,19620,19610,'google_classroom','built-score-course','Secret course name',
          'https://classroom.google.com/c/built-score','active')`),
      env.DB.prepare(`INSERT INTO learning_identity_links
        (id,connection_id,person_id,external_user_id,status)
        VALUES (19640,19610,1,'built-score-user','active')`),
      env.DB.prepare(`INSERT INTO learning_enrollments
        (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state)
        VALUES (19650,19610,19630,19640,'built-score-enrollment','student','active')`),
      env.DB.prepare(`INSERT INTO learning_activities
        (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url)
        VALUES (19660,19630,'built-score-assignment','Secret assignment title','assignment','published',
          'https://classroom.google.com/a/built-score')`),
      env.DB.prepare(`INSERT INTO learning_activity_events
        (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
         enrollment_id,course_id,activity_id,activity_kind,occurred_at)
        VALUES ('built-score-event',19610,'google_classroom','built-score-event','assignment_submitted',
          1,19640,19650,19630,19660,'assignment','2026-08-18T12:00:00Z')`),
    ]);
    const admin = await sessionCookie(1, 'admin@example.com');
    const saved = await post('/admin/activity-score', learningConfigBody(), { cookie: admin });
    expect(saved.status).toBe(303);
    await saved.arrayBuffer();

    const html = await (await get('/admin/activity-score', { cookie: admin })).text();
    expect(html).toContain('Learning engagement');
    expect(html).toContain('1/3');
    expect(html).toContain('1 of');
    expect(html).not.toMatch(/Secret course name|Secret assignment title|grade|answer|comment/i);
  });
});
