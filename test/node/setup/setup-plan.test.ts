import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
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
  it('turns Website into a D1 plan with all 16 settings explicit', () => {
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
    expect(plan.actions).not.toContain('seed');
    expect(plan.actions).not.toContain('seed-media');
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

  it('contains no secret fields, secret values, connection strings, or database URLs', () => {
    const plan = buildSetupPlan({ ...base, preset: 'full-church' }, raw);
    const secretNames = new Set([
      'password',
      'secret',
      'secretKey',
      'stripeKey',
      'connectionString',
      'databaseUrl',
      'DATABASE_URL',
    ]);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(secretNames.has(key)).toBe(false);
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
