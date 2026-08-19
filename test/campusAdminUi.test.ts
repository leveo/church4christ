import { describe, expect, it } from 'vitest';
import campusPage from '../src/pages/admin/campuses/index.astro?raw';
import adminLayout from '../src/layouts/Admin.astro?raw';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

describe('master campus administration UI', () => {
  it('fails closed to master admins and uses the raw shared backend only on the management page', () => {
    expect(campusPage).toContain('user.isSuperAdmin');
    expect(campusPage).toContain('Astro.locals.rawDb');
    expect(campusPage).not.toMatch(/const db\s*=\s*Astro\.locals\.db/);
  });

  it('supports campus creation, campus admin grants, and campus module separation', () => {
    for (const symbol of [
      'createCampus',
      'upsertCampusMembership',
      'setCampusModules',
      'listCampusMemberships',
    ]) expect(campusPage).toContain(symbol);
    for (const action of ['create', 'membership', 'modules']) {
      expect(campusPage).toContain(`value="${action}"`);
    }
    expect(campusPage).toContain('GRANTABLE_AREAS');
    expect(campusPage).toContain('MODULE_GROUPS');
  });

  it('shows a persistent campus switcher and master-only management link in the admin shell', () => {
    expect(adminLayout).toContain('listCampusesForUser');
    expect(adminLayout).toContain('action="/campus/switch"');
    expect(adminLayout).toContain('name="campus"');
    expect(adminLayout).toContain("href: '/admin/campuses'");
    expect(adminLayout).toContain('show: isSuper');
  });

  it('ships complete English and Chinese labels for the campus surface', () => {
    const keys = [
      'admin.nav.campuses',
      'admin.campuses.title',
      'admin.campuses.create',
      'admin.campuses.memberships',
      'admin.campuses.modules',
      'admin.campuses.all',
      'admin.campuses.switch',
    ] as const;
    for (const key of keys) {
      expect(en[key], `en:${key}`).toBeTruthy();
      expect(zh[key], `zh:${key}`).toBeTruthy();
    }
  });
});
