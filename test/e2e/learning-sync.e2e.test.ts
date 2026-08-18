// Task 10 boundaries against the built Worker: real middleware/manual route,
// admin render, scheduled-event dispatch, and both compiled webhook surfaces.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { attendanceSessionCookie as sessionCookie } from './attendanceHelpers';
import { ORIGIN } from './helpers';
// The e2e script always builds first. A glob keeps pre-build type-checking free
// of a hard dependency on ignored dist/, while Vite eagerly includes the exact
// generated Worker entry for this built-artifact suite.
const builtEntries = import.meta.glob('../../dist/server/entry.mjs', {
  eager: true, import: 'default',
});
const builtWorker = Object.values(builtEntries)[0] as ExportedHandler<Cloudflare.Env> | undefined;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM learning_courses WHERE id=896'),
    env.DB.prepare('DELETE FROM learning_programs WHERE id=896'),
    env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=896'),
    env.DB.prepare('DELETE FROM people WHERE id=896'),
    env.DB.prepare(`INSERT INTO people
      (id,first_name,last_name,display_name,email,role,super_admin,admin_areas)
      VALUES(896,'Mara','Learning','Mara Learning','mara.learning@example.test','admin',0,'learning')
      ON CONFLICT(id) DO UPDATE SET role='admin',super_admin=0,admin_areas='learning'`),
    env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(896,'google_classroom','Built Classroom',NULL,'active',1,896)`),
    env.DB.prepare(`INSERT INTO learning_programs(id,slug,display_name,status)
      VALUES(896,'built-sync','Built Sync','active')`),
    env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state)
      VALUES(896,896,896,'google_classroom','built-course','Built Course',
        'https://classroom.google.com/c/built','active')`),
  ]);
});

describe('Learning synchronization built-worker boundaries', () => {
  it('renders the mapped course and queues only an authorized same-origin manual sync', async () => {
    const cookie = await sessionCookie(896, 'mara.learning@example.test');
    const page = await SELF.fetch(`${ORIGIN}/admin/learning`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Course synchronization');
    expect(html).toContain('action="/admin/learning/sync"');
    expect(html).toContain('Sync now: Built Course');

    const queued = await SELF.fetch(`${ORIGIN}/admin/learning/sync`, {
      method: 'POST', redirect: 'manual', body: 'course_id=896',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(queued.status).toBe(303);
    expect(queued.headers.get('location')).toBe('/admin/learning?saved=sync_started');
    await queued.arrayBuffer();

    const crossOrigin = await SELF.fetch(`${ORIGIN}/admin/learning/sync`, {
      method: 'POST', redirect: 'manual', body: 'course_id=896',
      headers: { cookie, origin: 'https://attacker.test', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(crossOrigin.status).toBe(403);
    await crossOrigin.arrayBuffer();
  });

  it('dispatches both halves of the shared Learning cron through the built scheduled handler', async () => {
    for (const time of [
      Date.parse('2026-08-18T12:15:00.000Z'),
      Date.parse('2026-08-18T12:45:00.000Z'),
    ]) {
      const waits: Promise<unknown>[] = [];
      if (!builtWorker?.scheduled) throw new Error('built Worker scheduled handler is unavailable');
      builtWorker.scheduled({
        cron: '15,45 * * * *', scheduledTime: time, noRetry() {},
      } as ScheduledController, env as never, {
        waitUntil(promise: Promise<unknown>) { waits.push(promise); },
      } as ExecutionContext);
      expect(waits).toHaveLength(1);
      await expect(Promise.all(waits)).resolves.toHaveLength(1);
    }
  });

  it('keeps the compiled notification boundaries opaque and no-store', async () => {
    const canvas = await SELF.fetch(`${ORIGIN}/api/learning/canvas/live-events`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' }, body: 'not-a-compact-jwt',
    });
    expect(canvas.status).toBe(401);
    expect(canvas.headers.get('cache-control')).toBe('no-store');
    expect(await canvas.text()).toBe('');

    const google = await SELF.fetch(`${ORIGIN}/api/learning/google/pubsub`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(google.status).toBe(503);
    expect(google.headers.get('cache-control')).toBe('no-store');
    expect(await google.text()).toBe('');
  });
});
