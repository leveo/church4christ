// Learning shell authorization against the BUILT worker (SELF.fetch). These
// assertions exercise the real middleware, dynamic Astro routes, session
// loading, module toggle, and per-admin area gate rather than source shape.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get, ORIGIN, post } from './helpers';
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

  it('fails closed for built-worker Learning mutations without exact same-origin provenance', async () => {
    const learningAdmin = await sessionCookie(80, 'lena.learning@example.com');
    const mutate = (headers: Record<string, string>) => SELF.fetch(`${ORIGIN}/admin/learning/connections`, {
      method: 'POST',
      headers: {
        cookie: learningAdmin,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: 'action=health_check&connection_id=999999&revision=0&provider=canvas&status=active',
      redirect: 'manual',
    });
    expect(await status(await mutate({ origin: ORIGIN }))).toBe(303);
    for (const [label, headers] of [
      ['missing', {}],
      ['none', { 'sec-fetch-site': 'none' }],
      ['same-site', { 'sec-fetch-site': 'same-site' }],
      ['cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['unknown', { 'sec-fetch-site': 'unexpected' }],
      ['mismatched Origin', { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin' }],
    ] as const) expect.soft(await status(await mutate(headers)), label).toBe(403);
  });

  it('allowlists banners and renders safe bilingual health errors and statuses', async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM learning_provider_connections WHERE id BETWEEN 880 AND 883`),
      env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
        VALUES (880,'google_classroom','Pending provider',NULL,'pending',0,80,80)`),
      env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
        VALUES (881,'google_classroom','Active provider',NULL,'active',0,80,80)`),
      env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,last_error_code,created_by_person_id,updated_by_person_id)
        VALUES (882,'google_classroom','Error provider',NULL,'error',0,'provider_unavailable',80,80)`),
      env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id,deleted_at)
        VALUES (883,'canvas','Disabled provider','https://disabled.canvas.test','disabled',1,80,80,datetime('now'))`),
    ]);
    try {
      const learningAdmin = await sessionCookie(80, 'lena.learning@example.com');
      const arbitrary = await get('/admin/learning?saved=anything&error=anything', { cookie: learningAdmin });
      const arbitraryHtml = await arbitrary.text();
      expect(arbitraryHtml).not.toContain('Connection settings were saved.');
      expect(arbitraryHtml).not.toContain('Connection settings could not be saved.');

      const mixed = await get('/admin/learning?saved=connection_created&extra=anything', { cookie: learningAdmin });
      expect(await mixed.text()).not.toContain('Connection settings were saved.');

      const saved = await get('/admin/learning?saved=connection_created', { cookie: learningAdmin });
      const savedHtml = await saved.text();
      expect(savedHtml).toContain('Connection settings were saved.');
      for (const label of ['Pending authorization', 'Active', 'Needs attention', 'Disconnected']) {
        expect(savedHtml).toContain(label);
      }
      expect(savedHtml).not.toMatch(/>\s*(?:pending|active|error|disabled)\s*</);

      const health = await get('/admin/learning?error=provider_unavailable', { cookie: learningAdmin });
      const healthHtml = await health.text();
      expect(healthHtml).toContain('The Learning provider is temporarily unavailable.');
      expect(healthHtml).toContain('text-danger');
      expect(healthHtml).not.toContain('Connection settings were saved.');

      await env.DB.prepare("UPDATE people SET lang='zh' WHERE id=80").run();
      const chinese = await get('/admin/learning?error=provider_unavailable', { cookie: learningAdmin });
      const chineseHtml = await chinese.text();
      expect(chineseHtml).toContain('学习平台暂时不可用。');
      for (const label of ['等待授权', '正常', '需要处理', '已断开']) expect(chineseHtml).toContain(label);
    } finally {
      await env.DB.batch([
        env.DB.prepare("UPDATE people SET lang='en' WHERE id=80"),
        env.DB.prepare(`DELETE FROM learning_provider_connections WHERE id BETWEEN 880 AND 883`),
      ]);
    }
  });
});
