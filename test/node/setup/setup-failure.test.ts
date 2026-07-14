import { describe, expect, it, vi } from 'vitest';
import rawCatalog from '../../../config/capabilities.json';
import { runSetup } from '../../../scripts/setup/index.mjs';
import { SetupApplyError } from '../../../scripts/setup/apply.mjs';
import { buildSetupRerunCommand } from '../../../scripts/setup/failure.mjs';

function deps(overrides: Record<string, unknown> = {}): any {
  return {
    catalog: rawCatalog,
    interactive: false,
    output: vi.fn(),
    errorOutput: vi.fn(),
    inspectExisting: vi.fn(async () => ({})),
    preflightConfig: vi.fn(async () => ({ approvedContent: null })),
    confirm: vi.fn(async () => true),
    collectSupabaseSecret: vi.fn(async () => ({ dbUrl: 'postgres://user:password@db.example.test/app' })),
    collectStripeTestSecrets: vi.fn(async () => null),
    collectStripeSetupRedactionValues: vi.fn(async () => []),
    formatResult: vi.fn(),
    formatPlan: vi.fn(),
    apply: vi.fn(),
    ...overrides,
  };
}

describe('setup failure recovery', () => {
  it('builds a shell-safe, nonsecret rerun command from the normalized plan and setup controls', () => {
    const command = buildSetupRerunCommand({
      mode: 'deploy', preset: null, modules: ['events', 'portal'], backend: 'supabase', demoData: true,
      site: { slug: 'saint-johns', name: "St. John's Church", locale: 'en', appOrigin: 'https://church.example.test', emailFrom: 'serve@church.example.test' },
      adminEmail: 'admin@example.test', adminName: "O'Reilly Admin",
    }, { forceConfig: true, allowHyperdriveSecretInArgv: true });
    expect(command).toContain("--modules 'events,portal'");
    expect(command).toContain("--church-name 'St. John'\"'\"'s Church'");
    expect(command).toContain("--admin-name 'O'\"'\"'Reilly Admin'");
    expect(command).toContain("--backend 'supabase'");
    expect(command).toContain("--app-origin 'https://church.example.test'");
    expect(command).toContain('--demo-data');
    expect(command).toContain('--force-config');
    expect(command).toContain('--allow-hyperdrive-secret-in-argv');
    expect(command).toMatch(/--yes$/);
    expect(command).not.toMatch(/SUPABASE_DB_URL|postgres(?:ql)?:\/\//i);
  });

  it('pins resolved capability modules instead of re-expanding a mutable preset on recovery', () => {
    const command = buildSetupRerunCommand({
      mode: 'local', preset: 'website', modules: ['pages', 'events'], backend: 'd1', demoData: false,
      site: { slug: 'pinned', name: 'Pinned Church', locale: 'en' },
      adminEmail: 'admin@example.test', adminName: 'Admin',
    });
    expect(command).toContain("--modules 'pages,events'");
    expect(command).not.toContain('--preset');
  });

  it('keeps JSON stdout empty and reports structured apply recovery on stderr', async () => {
    const secret = 'postgres://user:password@db.example.test/church';
    const d = deps({
      collectSupabaseSecret: vi.fn(async () => ({ dbUrl: secret })),
      apply: vi.fn(async (_plan: unknown, options: any) => {
        throw new SetupApplyError({
          step: 'migrate', phase: 'apply', completed: [], unchanged: ['initialize-modules', 'bootstrap-admin'],
          cause: { error: new Error(`migration exposed ${secret}`), secretValues: options.secretValues },
          rerunCommand: options.rerunCommand,
        });
      }),
    });
    const flags = ['--mode', 'local', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full Church', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--yes', '--json'];
    await expect(runSetup(flags, d)).rejects.toMatchObject({ code: 'SETUP_APPLY_FAILED', step: 'migrate' });
    expect(d.output).not.toHaveBeenCalled();
    expect(d.errorOutput).toHaveBeenCalledOnce();
    expect(d.errorOutput.mock.calls[0][0]).toContain('Failed step: migrate (apply)');
    expect(d.errorOutput.mock.calls[0][0]).toContain('Rerun: npm run --silent setup --');
    expect(d.errorOutput.mock.calls[0][0]).not.toContain(secret);
    expect(d.errorOutput.mock.calls[0][0]).not.toContain('password');
    expect(d.apply.mock.calls[0][1]).toMatchObject({ rerunCommand: expect.any(String), secretValues: [secret] });
  });

  it('preserves separate interactive config replacement approval in a noninteractive rerun', async () => {
    let captured = '';
    const d = deps({
      interactive: true,
      ask: vi.fn(async (question: any) => ({
        mode: 'local', featureChoice: 'website', siteSlug: 'recovery', churchName: 'Recovery',
        locale: 'en', adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
      } as Record<string, unknown>)[question.key]),
      preflightConfig: vi.fn(async () => ({ approvedContent: 'custom', classification: 'unrecognized' })),
      previewPlan: vi.fn(),
      confirm: vi.fn(async () => true),
      apply: vi.fn(async (_plan: unknown, options: any) => {
        captured = options.rerunCommand;
        throw new SetupApplyError({
          step: 'migrate', phase: 'apply', completed: [], unchanged: [],
          cause: { error: new Error('migration failed'), secretValues: [] }, rerunCommand: options.rerunCommand,
        });
      }),
    });
    await expect(runSetup([], d)).rejects.toMatchObject({ code: 'SETUP_APPLY_FAILED' });
    expect(captured).toContain('--force-config');
  });
});
