import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { normalizeSetupAnswers } from '../../../scripts/setup/answers.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const base = {
  mode: 'local',
  siteSlug: 'grace-church',
  churchName: 'Grace Church',
  locale: 'en',
  adminEmail: 'admin@example.com',
  adminName: 'Grace Admin',
  demoData: true,
};

describe('buildSetupPlan', () => {
  it('turns Website into a D1 plan with all 17 settings explicit', () => {
    const plan = buildSetupPlan({ ...base, preset: 'website' }, raw);
    expect(plan.backend).toBe('d1');
    expect(plan.preset).toBe('website');
    expect(Object.keys(plan.moduleSettings)).toEqual(raw.order.map((key) => `module.${key}`));
    expect(plan.moduleSettings['module.sermons']).toBe('1');
    expect(plan.moduleSettings['module.portal']).toBe('0');
    expect(plan.services).toEqual(['r2', 'worker']);
    expect(plan.site).toEqual({
      slug: 'grace-church',
      name: 'Grace Church',
      locale: 'en',
      appOrigin: 'http://localhost:4321',
      emailFrom: 'serve@grace-church.invalid',
    });
    expect(plan.actions).toEqual([
      'verify-provider',
      'ensure-resources',
      'write-manifest',
      'write-config',
      'configure-secrets',
      'migrate',
      'seed',
      'seed-media',
      'initialize-modules',
      'bootstrap-admin',
      'doctor',
    ]);
  });

  it('turns Full Church into Supabase with every module enabled', () => {
    const plan = buildSetupPlan({ ...base, preset: 'full-church' }, raw);
    expect(plan.backend).toBe('supabase');
    expect(new Set(Object.values(plan.moduleSettings))).toEqual(new Set(['1']));
    expect(plan.services).toEqual(['hyperdrive', 'r2', 'worker']);
  });

  it('builds a no-demo custom plan and honors a compatible provider override', () => {
    const plan = buildSetupPlan(
      { ...base, preset: undefined, modules: ['sermons'], backendOverride: 'supabase', demoData: false },
      raw,
    );
    expect(plan.preset).toBeNull();
    expect(plan.backend).toBe('supabase');
    expect(plan.providerSelectionReason).toBe('explicit-override');
    expect(plan.actions).not.toContain('seed');
    expect(plan.actions).not.toContain('seed-media');
  });

  it('records whether provider selection was default, required, or explicitly overridden', () => {
    expect(buildSetupPlan({ ...base, preset: 'website' }, raw).providerSelectionReason).toBe('default');
    expect(buildSetupPlan({ ...base, preset: 'full-church' }, raw).providerSelectionReason).toBe('capability-requirement');
    expect(buildSetupPlan({ ...base, preset: 'website', backendOverride: 'd1' }, raw).providerSelectionReason).toBe('explicit-override');
  });

  it('is deeply frozen and does not mutate answers or catalog', () => {
    const answers = { ...base, modules: ['sermons'] };
    const catalog = structuredClone(raw);
    const before = JSON.stringify({ answers, catalog });
    const plan = buildSetupPlan(answers, catalog);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.site)).toBe(true);
    expect(Object.isFrozen(plan.modules)).toBe(true);
    expect(Object.isFrozen(plan.moduleSettings)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(JSON.stringify({ answers, catalog })).toBe(before);
  });

  it('normalizes direct answers through the same boundary as CLI input', () => {
    const plan = buildSetupPlan(
      {
        ...base,
        preset: 'website',
        churchName: '  Grace Church  ',
        adminEmail: ' Admin@Example.com ',
        adminName: '  Grace Admin ',
        appOrigin: 'https://church.example/',
        emailFrom: ' Serve@Church.Example ',
      },
      raw,
    );
    expect(plan.site.name).toBe('Grace Church');
    expect(plan.site.appOrigin).toBe('https://church.example');
    expect(plan.site.emailFrom).toBe('serve@church.example');
    expect(plan.adminEmail).toBe('admin@example.com');
    expect(plan.adminName).toBe('Grace Admin');
    expect(Object.isFrozen(plan.site)).toBe(true);
  });

  it.each([
    'http://localhost:4321',
    'http://127.0.0.1:4321',
    'http://[::1]:4321',
  ])('accepts HTTP loopback origin in local mode: %s', (appOrigin) => {
    expect(buildSetupPlan({ ...base, preset: 'website', appOrigin }, raw).site.appOrigin).toBe(appOrigin);
  });

  it('rejects HTTP loopback origins in deploy mode and deceptive local hostnames', () => {
    const deploy = { ...base, mode: 'deploy', preset: 'website', emailFrom: 'serve@example.com' };
    expect(() => buildSetupPlan({ ...deploy, appOrigin: 'http://localhost:4321' }, raw)).toThrow(/app-origin/i);
    expect(() => buildSetupPlan({ ...base, preset: 'website', appOrigin: 'http://localhost.evil' }, raw)).toThrow(/app-origin/i);
  });

  it.each([
    [{ mode: 'remote' }, /mode.*local.*deploy/i],
    [{ locale: 'fr' }, /locale.*en.*zh/i],
    [{ siteSlug: 'Grace_Church' }, /site-slug.*kebab/i],
    [{ adminEmail: 'admin@example..com' }, /admin-email.*valid/i],
    [{ emailFrom: 'sender@.example.com' }, /email-from.*valid/i],
    [{ appOrigin: 'http://church.example' }, /app-origin.*HTTPS origin/i],
    [{ appOrigin: 'https://church.example/path' }, /app-origin.*without a path/i],
    [{ appOrigin: 'https://user:password@church.example' }, /app-origin.*HTTPS origin/i],
    [{ appOrigin: 'postgres://user:do-not-leak-this@db.example/church' }, /app-origin.*HTTPS origin/i],
    [{ backendOverride: 'sqlite' }, /backend.*d1.*supabase/i],
  ])('rejects invalid direct plan answer %#', (change, message) => {
    expect(() => buildSetupPlan({ ...base, preset: 'website', ...change }, raw)).toThrow(message);
  });

  it.each(['false', 0, 1, {}, []])('rejects non-boolean demoData value %#', (demoData) => {
    expect(() => buildSetupPlan({ ...base, preset: 'website', demoData }, raw)).toThrow(
      /demoData.*boolean/i,
    );
  });

  it('returns only normalized answer fields and defaults demoData to false', () => {
    const normalized = normalizeSetupAnswers(
      {
        mode: 'local',
        preset: 'website',
        siteSlug: 'grace-church',
        churchName: 'Grace Church',
        locale: 'en',
        adminEmail: 'admin@example.com',
        adminName: 'Grace Admin',
        databaseUrl: 'postgres://user:do-not-leak-this@db.example/church',
        integration: { secretKey: 'do-not-leak-this' },
      },
      raw,
    );
    expect(normalized.demoData).toBe(false);
    expect(normalized).not.toHaveProperty('databaseUrl');
    expect(normalized).not.toHaveProperty('integration');
    expect(Object.keys(normalized).sort()).toEqual(
      [
        'adminEmail',
        'adminName',
        'appOrigin',
        'backendOverride',
        'churchName',
        'demoData',
        'emailFrom',
        'locale',
        'mode',
        'modules',
        'preset',
        'siteSlug',
      ].sort(),
    );
  });

  it('rejects conflicting or unknown direct feature selections', () => {
    expect(() =>
      buildSetupPlan({ ...base, preset: 'website', modules: ['sermons'] }, raw),
    ).toThrow(/preset.*modules/i);
    expect(() => buildSetupPlan({ ...base, preset: 'missing' }, raw)).toThrow(
      /unknown preset.*missing/i,
    );
    expect(() => buildSetupPlan({ ...base, modules: ['sermons', 'missing'] }, raw)).toThrow(
      /unknown capabilities.*missing/i,
    );
  });

  it('contains no secret fields, secret values, connection strings, or database URLs', () => {
    const plan = buildSetupPlan({ ...base, preset: 'full-church' }, raw);
    const secretKeyPattern = /^(?:password|secret(?:[_-]?key)?|api[_-]?key|stripe[_-]?key|connection[_-]?string|database[_-]?url)$/i;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(key).not.toMatch(secretKeyPattern);
        visit(child);
      }
    };
    visit(plan);
    const json = JSON.stringify(plan);
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain('postgresql://');
    expect(json).not.toContain('do-not-leak-this');
  });

  it('refuses an existing D1 to Supabase switch because content migration is not implemented', () => {
    expect(() =>
      buildSetupPlan({ ...base, modules: ['portal'] }, raw, { existingBackend: 'd1' }),
    ).toThrow(/D1-to-Supabase content migration is not implemented/i);
  });

  it('requires all common and deploy-only answers', () => {
    expect(() => buildSetupPlan({ ...base, adminName: '', preset: 'website' }, raw)).toThrow(
      /Missing setup answer: adminName/i,
    );
    expect(() => buildSetupPlan({ ...base, mode: 'deploy', preset: 'website' }, raw)).toThrow(
      /appOrigin.*emailFrom/i,
    );
    expect(() => buildSetupPlan(base, raw)).toThrow(/preset or custom modules/i);
  });
});
