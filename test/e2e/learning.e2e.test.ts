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
  await cleanupLearnerExperience();
});

async function cleanupLearnerExperience(): Promise<void> {
  const deletedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled',
      deleted_at=COALESCE(deleted_at,?1) WHERE id=890`).bind(deletedAt),
    env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='archived',
      deleted_at=COALESCE(deleted_at,?1) WHERE id=890`).bind(deletedAt),
    env.DB.prepare(`DELETE FROM learning_submission_snapshots WHERE course_id=890`),
    env.DB.prepare(`DELETE FROM learning_resources WHERE activity_id BETWEEN 8900 AND 8999`),
    env.DB.prepare(`DELETE FROM learning_activities WHERE course_id=890`),
    env.DB.prepare(`DELETE FROM learning_enrollments WHERE course_id=890`),
    env.DB.prepare(`DELETE FROM learning_identity_links WHERE id=890`),
    env.DB.prepare(`DELETE FROM learning_courses WHERE id=890`),
    env.DB.prepare(`DELETE FROM learning_programs WHERE id=890`),
    env.DB.prepare(`DELETE FROM learning_provider_credentials WHERE connection_id=890`),
    env.DB.prepare(`DELETE FROM learning_provider_connections WHERE id=890`),
  ]);
}

async function seedLearnerExperience(): Promise<void> {
  const now = Date.now();
  const stale = new Date(now - 3 * 24 * 60 * 60 * 1_000).toISOString();
  const published = new Date(now - 2 * 60 * 60 * 1_000).toISOString();
  const dueSoon = new Date(now + 24 * 60 * 60 * 1_000).toISOString();
  const dueLater = new Date(now + 2 * 24 * 60 * 60 * 1_000).toISOString();
  await cleanupLearnerExperience();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,last_successful_sync_at,
       created_by_person_id,updated_by_person_id)
      VALUES (890,'canvas','Private connection label','https://canvas.learner.test',
        'active',1,?1,1,1)`).bind(stale),
    env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES (890,CAST('hidden-credential-890' AS BLOB),randomblob(12),'AES-256-GCM',1,2,NULL)`),
    env.DB.prepare(`INSERT INTO learning_programs
      (id,slug,display_name,status,created_by_person_id,updated_by_person_id)
      VALUES (890,'learner-fixture','Learner Fixture Program','active',1,1)`),
    env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,
       lifecycle_state,provider_updated_at,last_synced_at)
      VALUES (890,890,890,'canvas','fixture-course',
        '<script id="course-xss">Course attack</script>',
        'https://canvas.learner.test/courses/890','active',?1,?1)`).bind(stale),
    env.DB.prepare(`INSERT INTO learning_identity_links
      (id,connection_id,person_id,external_user_id,status)
      VALUES (890,890,3,'private-external-user-890','active')`),
    env.DB.prepare(`INSERT INTO learning_enrollments
      (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state,last_synced_at)
      VALUES (890,890,890,890,'private-external-enrollment-890','student','active',?1)`).bind(stale),
    env.DB.prepare(`INSERT INTO learning_activities
      (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url,due_at,
       published_at,provider_updated_at,last_synced_at)
      VALUES
      (8901,890,'material-fixture','Prepared lesson video','material','published',
        'https://canvas.learner.test/courses/890/modules/items/1',NULL,?1,?1,?1),
      (8902,890,'assignment-fixture','<img src=x onerror="activityAttack()">','assignment','published',
        'https://canvas.learner.test/courses/890/assignments/2',?2,?1,?1,?1),
      (8903,890,'quiz-fixture','Review quiz','quiz','published',
        'https://canvas.learner.test/courses/890/quizzes/3',?3,?1,?1,?1)`).bind(published, dueSoon, dueLater),
    env.DB.prepare(`INSERT INTO learning_resources
      (id,activity_id,external_resource_id,title,kind,launch_url,youtube_video_id,mime_type,size_bytes,
       provider_updated_at)
      VALUES
      (8901,8901,'video-fixture','Creation $& overview','youtube',
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ','dQw4w9WgXcQ',NULL,NULL,?1),
      (8902,8901,'file-fixture','Lesson & $& handout','provider_file',
        'https://canvas.learner.test/files/8902',NULL,'application/pdf',2048,?1),
      (8903,8901,'link-fixture','Further reading','link',
        'https://canvas.learner.test/courses/890/pages/further-reading',NULL,NULL,NULL,?1)`)
      .bind(published),
    env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number,
       submitted_at,returned_at,provider_updated_at,synced_at)
      VALUES (890,8902,'assignment',890,'submitted',0,1,?1,NULL,?1,?1)`).bind(published),
  ]);
}

describe('Learning built-worker shell boundaries', () => {
  it.each([
    ['unknown', 'xx'],
    ['case-variant', 'EN'],
    ['encoded', '%65n'],
  ])('returns a stable non-reflecting 404 for a %s locale', async (_label, locale) => {
    const marker = 'private-course-marker-9Z';
    for (const path of [`/${locale}/learn`, `/${locale}/learn/${marker}`]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(marker);
    }
  });

  it('returns module-off 404s before anonymous auth and admin grant handling', async () => {
    const superAdmin = await sessionCookie(1, 'admin@example.com');
    expect(await status(await post('/admin/settings', modulesBody(['learning']), { cookie: superAdmin }))).toBe(303);

    expect(await status(await get('/en/learn'))).toBe(404);
    expect(await status(await get('/admin/learning'))).toBe(404);
    expect(await status(await get('/admin/learning', { cookie: superAdmin }))).toBe(404);
  });

  it('redirects an anonymous learner and renders the canonical Genesis demo for both seeded learners', async () => {
    const anonymous = await get('/en/learn');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/en/signin?next=%2Fen%2Flearn');
    await anonymous.arrayBuffer();

    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const response = await get('/en/learn', { cookie: member });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Genesis Sunday School / 创世记主日学');
    expect(html).toContain('Genesis 1: Creation / 创世记第一章：创造');
    expect(html).toContain('/en/learn/21000');
    expect(html).toContain('Assignment: Creation care reflection / 作业：创造关怀反思');
    expect(html).toContain('Quiz: Genesis 1 review / 测验：创世记第一章复习');
    expect(html).not.toContain('No courses to show');

    const englishDetail = await get('/en/learn/21000', { cookie: member });
    expect(englishDetail.status).toBe(200);
    const englishHtml = await englishDetail.text();
    for (const marker of [
      'Opening: In the beginning / 开场：起初',
      'Scripture overview: Genesis 1 / 经文概览：创世记第一章',
      'Days 1–3: Forming creation / 第1–3日：塑造创造',
      'Days 4–6: Humanity and stewardship / 第4–6日：人类与管家职分',
      'Submitted',
      'Not submitted',
    ]) expect(englishHtml).toContain(marker);
    expect(englishHtml).toContain('data-embed="https://www.youtube-nocookie.com/embed/DemoGen1Vid"');
    expect(englishHtml).not.toContain('<iframe');
    expect(englishHtml).not.toContain('autoplay=1');
    expect(englishHtml).toContain('href="https://canvas-learning.example.test/files/genesis-1-learner-handout/download"');
    expect(englishHtml).toContain('href="https://canvas-learning.example.test/files/genesis-1-teacher-guide/download"');
    expect(englishHtml).toContain('href="https://canvas-learning.example.test/courses/genesis-1-creation/pages/creation-and-stewardship"');
    expect(englishHtml).not.toMatch(/access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|provider_credentials/i);

    const chineseMember = await sessionCookie(4, 'grace.lin@example.com');
    const chinese = await get('/zh/learn/21000', { cookie: chineseMember });
    expect(chinese.status).toBe(200);
    const chineseHtml = await chinese.text();
    expect(chineseHtml).toContain('课程活动');
    expect(chineseHtml).toContain('已退回');
    expect(chineseHtml).toContain('已提交');

    const notEnrolled = await sessionCookie(5, 'mark.liu@example.com');
    const denied = await get('/en/learn/21000', { cookie: notEnrolled });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('Genesis');
  });

  it('keeps every course id non-disclosing for a signed-in non-enrolled member', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    for (const courseId of ['course-alpha-marker-7K', 'private-course-marker-9Z']) {
      const response = await get(`/en/learn/${courseId}`, { cookie: member });
      expect(response.status, courseId).toBe(404);
      expect(await response.text(), courseId).not.toContain(courseId);
    }
  });

  it('renders a privacy-safe English learner dashboard from authorized snapshots only', async () => {
    await seedLearnerExperience();
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const response = await get('/en/learn', { cookie: member });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-src https://www.youtube-nocookie.com");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain('Learner Fixture Program');
    expect(html).toContain('Provider connection active');
    expect(html).toContain('/en/learn/890');
    expect(html).toContain('Course data may be out of date');
    expect(html).toContain('Upcoming work');
    expect(html.indexOf('&lt;img src=x onerror=&quot;activityAttack()&quot;&gt;'))
      .toBeLessThan(html.indexOf('Review quiz'));
    expect(html).toContain('Submitted');
    expect(html).toContain('Recent materials');
    expect(html).not.toContain('<script id="course-xss">');
    expect(html).not.toMatch(/private-external|hidden-credential|Private connection label/);
  });

  it('renders an authorized course with click-only no-autoplay video and safe provider links', async () => {
    await seedLearnerExperience();
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const response = await get('/en/learn/890', { cookie: member });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    const html = await response.text();
    expect(html).toContain('Prepared lesson video');
    expect(html).toContain('Unlisted YouTube links are not private');
    expect(html).toContain('data-embed="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).not.toContain('autoplay=1');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('i.ytimg.com');
    expect(html).toContain('aria-label="Play Creation $&amp; overview"');
    expect(html).toContain('href="https://canvas.learner.test/files/8902"');
    expect(html).toContain('aria-label="Open Lesson &amp; $&amp; handout"');
    expect(html).not.toMatch(/aria-label="(?:Open|Play)[^"]*\{title\}/u);
    expect(html).not.toContain('aria-label="Open Lesson &amp;amp; $&amp; handout"');
    expect(html).toContain('href="https://canvas.learner.test/courses/890/pages/further-reading"');
    expect(html).toContain('href="https://canvas.learner.test/courses/890/assignments/2"');
    expect(html).not.toContain('<img src=x onerror="activityAttack()">');
    expect(html).not.toMatch(/private-external|hidden-credential|Private connection label/);

    const other = await sessionCookie(4, 'michael.chen@example.com');
    const denied = await get('/en/learn/890', { cookie: other });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('890');
  });

  it('renders bilingual learner copy and hides a course immediately after provider disconnect', async () => {
    await seedLearnerExperience();
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const chinese = await get('/zh/learn/890', { cookie: member });
    expect(chinese.status).toBe(200);
    const chineseHtml = await chinese.text();
    expect(chineseHtml).toContain('课程数据可能已过期');
    expect(chineseHtml).toContain('课程活动');
    expect(chineseHtml).toContain('已提交');

    await env.DB.prepare(`UPDATE learning_provider_connections
      SET status='disabled' WHERE id IN (890,21000)`).run();
    const hiddenDetail = await get('/en/learn/890', { cookie: member });
    expect(hiddenDetail.status).toBe(404);
    await hiddenDetail.arrayBuffer();
    const dashboard = await get('/en/learn', { cookie: member });
    const disconnectedHtml = await dashboard.text();
    expect(disconnectedHtml).not.toContain('Learner Fixture Program');
    expect(disconnectedHtml).toContain('provider is disconnected');
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
