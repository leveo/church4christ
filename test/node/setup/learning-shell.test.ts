import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import rawCatalog from '../../../config/capabilities.json';
import { hasAreaAccess, adminAreaForPath, GRANTABLE_AREAS } from '../../../src/lib/adminAreas';
import { CAPABILITY_KEYS } from '../../../src/lib/capabilityCatalog';
import en from '../../../src/i18n/en';
import zh from '../../../src/i18n/zh';
import { MODULE_KEYS, MODULES, filterByBackend, moduleForPath } from '../../../src/lib/modules';
import { BUILTIN_NAV, resolveDefaultNav } from '../../../src/lib/nav';
import { canAccess, classifyRoute } from '../../../src/lib/routePolicy';
import type { SessionUser } from '../../../src/lib/types';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : '';

const member = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 41,
  email: 'learner@example.test',
  displayName: 'Learner',
  role: 'member',
  isAdmin: false,
  isEditor: false,
  isSuperAdmin: false,
  adminAreas: [],
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  ...over,
});

describe('Learning capability shell', () => {
  it('is the twenty-first portable capability in Website + Community and Full Church only', () => {
    expect(CAPABILITY_KEYS).toHaveLength(21);
    expect(CAPABILITY_KEYS.at(-1)).toBe('learning');
    expect(MODULE_KEYS).toEqual(CAPABILITY_KEYS);
    expect(rawCatalog.capabilities.learning).toMatchObject({
      order: 21,
      group: 'community',
      publicPrefixes: ['/learn'],
      adminPrefixes: ['/admin/learning'],
      navKeys: ['nav.learn'],
      dependsOn: ['people'],
    });
    expect(rawCatalog.capabilities.learning).not.toHaveProperty('requiresBackend');
    expect(rawCatalog.presets.website.modules).not.toContain('learning');
    expect(rawCatalog.presets['website-community'].modules).toContain('learning');
    expect(rawCatalog.presets['website-community'].modules).toHaveLength(18);
    expect(rawCatalog.presets['full-church'].modules).toContain('learning');
    expect(rawCatalog.presets['full-church'].modules).toHaveLength(21);
    expect(filterByBackend(['learning'], 'd1')).toEqual(new Set(['learning']));
    expect(filterByBackend(['learning'], 'supabase')).toEqual(new Set(['learning']));
  });

  it('owns learner/admin routes and contributes a module-gated bilingual top-nav link', () => {
    expect(MODULES.learning).toMatchObject({
      publicPrefixes: ['/learn'],
      adminPrefixes: ['/admin/learning'],
      navKeys: ['nav.learn'],
    });
    for (const path of ['/learn', '/learn/42', '/admin/learning', '/admin/learning/connections']) {
      expect(moduleForPath(path), path).toBe('learning');
    }
    expect(BUILTIN_NAV).toContainEqual({ key: 'nav.learn', path: '/learn' });
    expect(resolveDefaultNav('en', new Set(MODULE_KEYS))).toContainEqual({
      label: 'Learning',
      href: '/en/learn',
    });
    expect(resolveDefaultNav('zh', new Set(MODULE_KEYS))).toContainEqual({
      label: '学习',
      href: '/zh/learn',
    });
    const withoutLearning = new Set(MODULE_KEYS.filter((key) => key !== 'learning'));
    expect(resolveDefaultNav('en', withoutLearning).some((link) => link.href === '/en/learn')).toBe(false);
  });

  it('enforces anonymous/member and limited/Learning/super-admin matrices', () => {
    expect(classifyRoute('/learn')).toBe('authed');
    expect(classifyRoute('/learn/42')).toBe('authed');
    expect(canAccess(classifyRoute('/learn'), null)).toBe(false);
    expect(canAccess(classifyRoute('/learn'), member())).toBe(true);

    expect(classifyRoute('/admin/learning')).toBe('adminOnly');
    expect(adminAreaForPath('/admin/learning')).toBe('learning');
    expect(adminAreaForPath('/admin/learning/connections')).toBe('learning');
    expect(GRANTABLE_AREAS).toContain('learning');

    const limited = member({ role: 'admin', isAdmin: true, adminAreas: ['groups'] });
    const learningAdmin = member({ role: 'admin', isAdmin: true, adminAreas: ['learning'] });
    const superAdmin = member({
      role: 'admin',
      isAdmin: true,
      isSuperAdmin: true,
      adminAreas: [],
    });
    expect(canAccess(classifyRoute('/admin/learning'), member())).toBe(false);
    expect(canAccess(classifyRoute('/admin/learning'), limited)).toBe(true);
    expect(hasAreaAccess(limited, 'learning')).toBe(false);
    expect(hasAreaAccess(learningAdmin, 'learning')).toBe(true);
    expect(hasAreaAccess(superAdmin, 'learning')).toBe(true);
  });

  it('keeps module-off 404 checks ahead of session/grant checks and renders only honest shell states', () => {
    const middleware = read('src/middleware.ts');
    expect(middleware.indexOf('const mod = moduleForPath(rest)')).toBeGreaterThan(-1);
    expect(middleware.indexOf('const mod = moduleForPath(rest)')).toBeLessThan(
      middleware.indexOf('verifySession(vars.SESSION_SECRET'),
    );
    expect(middleware.indexOf('if (hasInvalidLearningCourseLocale(')).toBeLessThan(
      middleware.indexOf('openDb(env as unknown as DbEnv)'),
    );

    const learnerIndex = read('src/pages/[locale]/learn/index.astro');
    const course = read('src/pages/[locale]/learn/[courseId].astro');
    const admin = read('src/pages/admin/learning/index.astro');
    for (const source of [learnerIndex, course, admin]) expect(source).not.toBe('');

    const learnerModule = learnerIndex.indexOf("if (!modules.has('learning'))");
    const learnerUser = learnerIndex.indexOf('if (!user)');
    expect(learnerModule).toBeGreaterThan(-1);
    expect(learnerUser).toBeGreaterThan(learnerModule);
    expect(learnerIndex).toContain("t(locale, 'learning.emptyTitle')");
    expect(learnerIndex).toContain("t(locale, 'learning.emptyBody')");

    const courseLocale = course.indexOf("parseLocale(Astro.params.locale ?? '')");
    const courseModule = course.indexOf("if (!modules.has('learning'))");
    const courseUser = course.indexOf('if (!user)');
    const nonEnrolled = course.indexOf('return notFound();', courseUser);
    expect(courseLocale).toBeGreaterThan(-1);
    expect(courseModule).toBeGreaterThan(courseLocale);
    expect(courseUser).toBeGreaterThan(courseModule);
    expect(nonEnrolled).toBeGreaterThan(courseUser);

    const adminModule = admin.indexOf("if (!modules.has('learning'))");
    const adminArea = admin.indexOf("if (!hasAreaAccess(user, 'learning'))");
    expect(adminModule).toBeGreaterThan(-1);
    expect(adminArea).toBeGreaterThan(adminModule);
    expect(admin).toContain("t(lang, 'admin.learning.emptyTitle')");
    expect(admin).toContain("t(lang, 'admin.learning.emptyBody')");

    for (const source of [learnerIndex, course, admin]) {
      expect(source).not.toMatch(/\.prepare\s*\(|providerConnections\s*=|courses\s*=\s*\[/);
      expect(source).not.toMatch(/Genesis|Google Classroom|Canvas LMS/i);
    }
  });

  it('registers Learning in admin navigation, dashboard, grants, dictionaries, and generated docs', () => {
    const adminLayout = read('src/layouts/Admin.astro');
    const dashboard = read('src/pages/admin/index.astro');
    const personEditor = read('src/pages/admin/people/[id].astro');
    expect(adminLayout).toContain("href: '/admin/learning'");
    expect(adminLayout).toContain("module: 'learning', area: 'learning'");
    expect(dashboard).toContain("modules.has('learning')");
    expect(dashboard).toContain('href="/admin/learning"');
    expect(personEditor).toContain("learning: 'admin.nav.learning'");

    const keys = [
      'nav.learn',
      'learning.title',
      'learning.intro',
      'learning.emptyTitle',
      'learning.emptyBody',
      'admin.nav.learning',
      'admin.learning.title',
      'admin.learning.intro',
      'admin.learning.emptyTitle',
      'admin.learning.emptyBody',
      'modules.learning.label',
      'modules.learning.desc',
    ] as const;
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());

    for (const path of ['README.md', 'docs/features/modules.md', 'docs/architecture.md']) {
      expect(read(path), path).toContain('| `learning` | Learning | 学习 | Either |');
    }
  });

  it('writes all 21 module settings and selects Learning in both applicable setup presets', () => {
    const base = {
      mode: 'local',
      siteSlug: 'learning-church',
      churchName: 'Learning Church',
      locale: 'en',
      adminEmail: 'admin@example.test',
      adminName: 'Admin',
      demoData: false,
    };
    const community = buildSetupPlan({ ...base, preset: 'website-community' }, rawCatalog);
    const full = buildSetupPlan({ ...base, preset: 'full-church' }, rawCatalog);
    expect(Object.keys(community.moduleSettings)).toHaveLength(21);
    expect(community.backend).toBe('d1');
    expect(community.modules).toHaveLength(18);
    expect(community.moduleSettings['module.learning']).toBe('1');
    expect(full.backend).toBe('supabase');
    expect(full.modules).toHaveLength(21);
    expect(full.moduleSettings['module.learning']).toBe('1');
  });
});
