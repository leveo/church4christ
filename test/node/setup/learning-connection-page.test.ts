import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning connection administration page', () => {
  it('renders safe create/update/health/disconnect and OAuth forms from metadata only', () => {
    const page = readFileSync('src/pages/admin/learning/index.astro', 'utf8');
    expect(page).toContain('listLearningConnections');
    expect(page).toContain('action="/admin/learning/connections"');
    expect(page).toContain('action="/admin/learning/google/start"');
    expect(page).toContain('action="/admin/learning/canvas/start"');
    expect(page).toContain('/admin/learning/canvas/courses?connection_id=');
    expect(page).toContain('/admin/learning/google/courses?connection_id=');
    expect(page).toContain("'google_connected'");
    expect(page).toContain('google_authorization_failed');
    for (const action of ['create', 'update', 'health_check', 'disconnect']) {
      expect(page).toContain(`value="${action}"`);
    }
    expect(page).not.toContain('name="access_token"');
    expect(page.match(/name="base_url"/g)).toHaveLength(2);
    expect(page.match(/type="url" name="base_url"/g)).toHaveLength(1);
    expect(page).toContain('Canvas address cannot be changed');
    expect(page).toContain('Canvas 地址建立后不能修改');
    expect(page).not.toMatch(/\bciphertext\b|\bnonce\b|\bkeyVersion\b|\bclientSecret\b|\bkey_version\b|\bclient_secret\b/);
  });

  it('renders Canvas course mapping without provider credentials or student work', () => {
    const page = readFileSync('src/pages/admin/learning/canvas/courses.astro', 'utf8');
    expect(page).toContain("import { btn, btnSecondary, card, lab, tin } from '../../../../lib/adminUi'");
    expect(page).not.toMatch(/\bsel\b/u);
    expect(page).toContain('listCanvasCourseOptions');
    expect(page).toContain('action="/admin/learning/canvas/map-course"');
    for (const name of ['action', 'connection_id', 'revision', 'external_course_id', 'program_id']) {
      expect(page).toContain(`name="${name}"`);
    }
    expect(page).not.toContain('name="root_account_id"');
    expect(page).toContain("course: 'Canvas 课程'");
    expect(page).toContain("course: 'Canvas course'");
    expect(page).toContain('value="unmap"');
    const markup = page.split('---').slice(2).join('---');
    expect(markup).not.toMatch(/accessToken|refreshToken|clientSecret|ciphertext|CLIENT_SECRET|CREDENTIAL_KEYS/iu);
    expect(markup).not.toMatch(/name="(?:token|credential|grade|answer|submission)"/iu);
  });

  it('renders provider-neutral mapped-course selection without credential or raw activity fields', () => {
    const page = readFileSync('src/pages/admin/learning/google/courses.astro', 'utf8');
    expect(page).toContain('listGoogleClassroomCourseOptions');
    expect(page).toContain('action="/admin/learning/google/map-course"');
    for (const name of ['action', 'connection_id', 'revision', 'external_course_id', 'program_id']) {
      expect(page).toContain(`name="${name}"`);
    }
    expect(page).toContain('googleClassroomPushReadiness');
    expect(page).toContain('reconnectDeadline');
    expect(page).toContain('value="unmap"');
    expect(page).toContain("t(lang, 'admin.learning.google.pushReady')");
    expect(page).toContain("t(lang, 'admin.learning.google.reconnectDeadline')");
    const markup = page.split('---').slice(2).join('---');
    expect(markup).not.toMatch(/accessToken|refreshToken|clientSecret|ciphertext|CLIENT_SECRET|CREDENTIAL_KEYS/iu);
    expect(markup).not.toMatch(/name="(?:token|credential|grade|answer|submission)"/iu);
  });
});
