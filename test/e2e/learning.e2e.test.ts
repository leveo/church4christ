// Learning shell authorization against the BUILT worker (SELF.fetch). These
// assertions exercise the real middleware, dynamic Astro routes, session
// loading, module toggle, and per-admin area gate rather than source shape.
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
      VALUES (80, 'Lena', 'Learning', 'Lena Learning', 'lena.learning@example.com', 'admin', 0, 'learning')
      ON CONFLICT(id) DO UPDATE SET role='admin', super_admin=0, admin_areas='learning'`),
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (81, 'Nora', 'Groups', 'Nora Groups', 'nora.groups@example.com', 'admin', 0, 'groups')
      ON CONFLICT(id) DO UPDATE SET role='admin', super_admin=0, admin_areas='groups'`),
  ]);
});

afterEach(async () => {
  const superAdmin = await sessionCookie(1, 'admin@example.com');
  await status(await post('/admin/settings', modulesBody([]), { cookie: superAdmin }));
});

describe('Learning built-worker shell boundaries', () => {
  it.each([
    ['unknown', 'xx'],
    ['case-variant', 'EN'],
    ['encoded', '%65n'],
  ])('returns a stable non-reflecting 404 for a %s locale', async (_label, locale) => {
    const marker = 'private-course-marker-9Z';
    const response = await get(`/${locale}/learn/${marker}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(marker);
  });

  it('returns module-off 404s before anonymous auth and admin grant handling', async () => {
    const superAdmin = await sessionCookie(1, 'admin@example.com');
    expect(await status(await post('/admin/settings', modulesBody(['learning']), { cookie: superAdmin }))).toBe(303);

    expect(await status(await get('/en/learn'))).toBe(404);
    expect(await status(await get('/admin/learning'))).toBe(404);
    expect(await status(await get('/admin/learning', { cookie: superAdmin }))).toBe(404);
  });

  it('redirects an anonymous learner and renders the honest index for a member', async () => {
    const anonymous = await get('/en/learn');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/en/signin?next=%2Fen%2Flearn');
    await anonymous.arrayBuffer();

    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const response = await get('/en/learn', { cookie: member });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('No courses to show');
    expect(html).not.toMatch(/Google Classroom|Canvas LMS|Genesis/i);
  });

  it('keeps every course id non-disclosing for a signed-in non-enrolled member', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    for (const courseId of ['course-alpha-marker-7K', 'private-course-marker-9Z']) {
      const response = await get(`/en/learn/${courseId}`, { cookie: member });
      expect(response.status, courseId).toBe(404);
      expect(await response.text(), courseId).not.toContain(courseId);
    }
  });

  it('denies members and wrong-grant admins, but renders for Learning and super admins', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const wrongGrant = await sessionCookie(81, 'nora.groups@example.com');
    expect(await status(await get('/admin/learning', { cookie: member }))).toBe(403);
    expect(await status(await get('/admin/learning', { cookie: wrongGrant }))).toBe(403);

    const learningAdmin = await sessionCookie(80, 'lena.learning@example.com');
    const learningPage = await get('/admin/learning', { cookie: learningAdmin });
    expect(learningPage.status).toBe(200);
    const learningHtml = await learningPage.text();
    expect(learningHtml).toContain('No Google Classroom or Canvas connection has been configured.');
    expect(learningHtml).toContain('action="/admin/learning/connections"');

    const superAdmin = await sessionCookie(1, 'admin@example.com');
    expect(await status(await get('/admin/learning', { cookie: superAdmin }))).toBe(200);
  });
});
