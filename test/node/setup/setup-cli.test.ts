import { describe, expect, it, vi } from 'vitest';
import rawCatalog from '../../../config/capabilities.json';
import { collectStripeTestSecrets, collectSupabaseSecret, configuredStripeTestMode, createPlanPreview, formatPlan, formatResult, preflightWranglerConfig, runSetup } from '../../../scripts/setup/index.mjs';
import { renderWrangler } from '../../../scripts/setup/render-wrangler.mjs';
import { manifestFromPlan } from '../../../scripts/setup/manifest.mjs';
import { readFile } from 'node:fs/promises';
import { collectInteractiveAnswers } from '../../../scripts/setup/prompts.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const baseFlags = [
  '--mode', 'local', '--preset', 'website-community', '--site-slug', 'grace-church',
  '--church-name', 'Grace Church', '--locale', 'en', '--admin-name', 'Grace Admin',
  '--admin-email', 'admin@example.test',
];

function deps(overrides: Record<string, unknown> = {}): any {
  const output = vi.fn();
  return {
    catalog: rawCatalog,
    interactive: false,
    output,
    errorOutput: vi.fn(),
    inspectExisting: vi.fn(async () => ({})),
    preflightConfig: vi.fn(async () => ({ approvedContent: null })),
    apply: vi.fn(async (_plan: unknown, _options: unknown) => ({ doctor: { schemaVersion: 1, status: 'ready', checks: [], exitCode: 0 } })),
    doctor: vi.fn(async () => ({ schemaVersion: 1, status: 'ready', checks: [], exitCode: 0 })),
    confirm: vi.fn(async () => true),
    previewPlan: vi.fn(),
    collectSupabaseSecret: vi.fn(async () => ({ dbUrl: 'postgres://user:password@db.example.test/app' })),
    collectStripeTestSecrets: vi.fn(async () => null),
    collectStripeSetupRedactionValues: vi.fn(async () => []),
    formatPlan: (plan: unknown) => JSON.stringify(plan, null, 2),
    formatResult: (result: unknown) => JSON.stringify(result, null, 2),
    formatDoctor: (result: unknown) => JSON.stringify(result, null, 2),
    ...overrides,
  };
}

describe('guided setup CLI', () => {
  it('--help exits zero without prompting, files, commands, inspection, or apply', async () => {
    const d = deps({ ask: vi.fn(), runner: { run: vi.fn() }, writeFile: vi.fn() });
    await expect(runSetup(['--help'], d as any)).resolves.toBe(0);
    expect(d.output).toHaveBeenCalledOnce();
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.inspectExisting).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.runner.run).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it('registers raw one-shot values for dry-run inspection without validating or serializing them', async () => {
    const rawValues = ['sk_live_raw_dry_run', 'whsec_raw_dry_run'];
    const d = deps({
      collectStripeSetupRedactionValues: vi.fn(async () => rawValues),
      inspectExisting: vi.fn(async (options) => {
        expect(options.secretValues).toEqual(rawValues);
        return {};
      }),
      collectStripeTestSecrets: vi.fn(async () => { throw new Error('must not validate dry-run values'); }),
    });
    await expect(runSetup(['--mode', 'local', '--preset', 'full-church', '--site-slug', 'dry-raw', '--church-name', 'Dry Raw', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--dry-run', '--json'], d)).resolves.toBe(0);
    expect(d.collectStripeSetupRedactionValues).toHaveBeenCalledOnce();
    expect(d.collectStripeTestSecrets).not.toHaveBeenCalled();
    expect(JSON.stringify(d.output.mock.calls)).not.toContain('sk_live_raw_dry_run');
  });

  it('interactive answers and equivalent flags build deeply equal plans', async () => {
    const flagDeps = deps();
    await runSetup([...baseFlags, '--dry-run', '--json'], flagDeps as any);
    const flagged = JSON.parse(flagDeps.output.mock.calls[0][0]).plan;
    const values: Record<string, unknown> = {
      mode: 'local', featureChoice: 'website-community', siteSlug: 'grace-church',
      churchName: 'Grace Church', locale: 'en', adminName: 'Grace Admin',
      adminEmail: 'admin@example.test', demoData: false,
    };
    const interactiveDeps = deps({ interactive: true, ask: vi.fn(async (question: any) => values[question.key]) });
    await runSetup(['--dry-run', '--json'], interactiveDeps as any);
    const prompted = JSON.parse(interactiveDeps.output.mock.calls[0][0]).plan;
    expect(prompted).toEqual(flagged);
    expect(prompted.backend).toBe('d1');
    expect(prompted.modules).toHaveLength(13);
  });

  it('Full Church automatically selects Supabase and all 16 modules', async () => {
    const d = deps();
    await runSetup(['--mode', 'local', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--dry-run', '--json'], d as any);
    const plan = JSON.parse(d.output.mock.calls[0][0]).plan;
    expect(plan.backend).toBe('supabase');
    expect(plan.modules).toHaveLength(16);
    expect(d.collectSupabaseSecret).not.toHaveBeenCalled();
  });

  it('--dry-run --json emits one versioned plan and performs zero mutations', async () => {
    const d = deps({ runner: { run: vi.fn() }, writeFile: vi.fn(), stateStore: { mark: vi.fn() } });
    await expect(runSetup([...baseFlags, '--dry-run', '--json'], d as any)).resolves.toBe(0);
    expect(d.output).toHaveBeenCalledOnce();
    expect(JSON.parse(d.output.mock.calls[0][0])).toMatchObject({ schemaVersion: 1, kind: 'setup-plan' });
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.runner.run).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(d.stateStore.mark).not.toHaveBeenCalled();
  });

  it('noninteractive missing answers fail with all exact missing flags listed', async () => {
    const d = deps();
    await expect(runSetup(['--mode', 'deploy', '--preset', 'website'], d as any)).rejects.toThrow(
      '--site-slug, --church-name, --locale, --admin-email, --admin-name, --app-origin, --email-from',
    );
    expect(d.inspectExisting).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('D1 override plus portal/giving/registration lists all offenders before mutation', async () => {
    const d = deps();
    await expect(runSetup(['--mode', 'local', '--modules', 'portal,giving,registration', '--backend', 'd1', '--site-slug', 'bad', '--church-name', 'Bad', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--yes'], d as any))
      .rejects.toThrow(/portal, giving, registration/);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('confirmation rejection leaves files, commands, state, database, and secrets untouched', async () => {
    const d = deps({ interactive: true, ask: vi.fn(), confirm: vi.fn(async () => false), runner: { run: vi.fn() }, writeFile: vi.fn(), stateStore: { mark: vi.fn() }, db: { prepare: vi.fn() } });
    await expect(runSetup([...baseFlags, '--demo-data'], d as any)).resolves.toBe(0);
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.collectSupabaseSecret).not.toHaveBeenCalled();
    expect(d.runner.run).not.toHaveBeenCalled();
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(d.stateStore.mark).not.toHaveBeenCalled();
    expect(d.db.prepare).not.toHaveBeenCalled();
    expect(d.previewPlan).toHaveBeenCalledOnce();
  });

  it('preflights wrangler config before preview, confirmation, secrets, or apply', async () => {
    const events: string[] = [];
    const d = deps({
      interactive: true,
      ask: vi.fn(async (question: any) => ({
        mode: 'local', featureChoice: 'website', siteSlug: 'preflight', churchName: 'Preflight',
        locale: 'en', adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
      } as Record<string, unknown>)[question.key]),
      preflightConfig: vi.fn(async () => { events.push('config'); return { approvedContent: 'approved bytes' }; }),
      previewPlan: vi.fn(() => events.push('preview')),
      confirm: vi.fn(async () => { events.push('confirm'); return true; }),
      collectSupabaseSecret: vi.fn(async () => { events.push('secret'); return {}; }),
      apply: vi.fn(async (_plan: any, options: any) => {
        events.push(`apply:${options.approvedConfigContent}`);
        return { doctor: { exitCode: 0 } };
      }),
    });
    await runSetup([], d);
    expect(events).toEqual(['config', 'preview', 'confirm', 'apply:approved bytes']);
  });

  it('registers one-shot Stripe values before existing-installation inspection or diagnostics', async () => {
    const events: string[] = [];
    const stripeSecrets = { secretKey: 'sk_test_early_registration', webhookSecret: 'whsec_early_registration' };
    const d = deps({
      collectStripeSetupRedactionValues: vi.fn(async () => { events.push('raw-registration'); return ['sk_test_early_registration', 'whsec_early_registration']; }),
      collectStripeTestSecrets: vi.fn(async () => { events.push('stripe-registration'); return stripeSecrets; }),
      inspectExisting: vi.fn(async (options) => {
        events.push('inspect');
        expect(options.secretValues).toEqual(['sk_test_early_registration', 'whsec_early_registration']);
        return {};
      }),
      preflightConfig: vi.fn(async () => { events.push('config'); return { approvedContent: null }; }),
    });
    await runSetup(['--mode', 'local', '--preset', 'full-church', '--site-slug', 'early-pg', '--church-name', 'Early PG', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--yes'], d);
    expect(events.slice(0, 4)).toEqual(['raw-registration', 'stripe-registration', 'inspect', 'config']);
  });

  it('does not treat --yes as approval to replace an unrecognized config', async () => {
    const d = deps({ preflightConfig: vi.fn(async () => { throw new Error('rerun with --force-config'); }) });
    await expect(runSetup([...baseFlags, '--yes'], d)).rejects.toThrow(/--force-config/);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.collectSupabaseSecret).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('noninteractive apply without --yes fails before inspection and names the exact flag', async () => {
    const d = deps();
    await expect(runSetup(baseFlags, d as any)).rejects.toThrow(/--yes/);
    expect(d.inspectExisting).not.toHaveBeenCalled();
    expect(d.previewPlan).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('doctor is exclusive and emits a single JSON document', async () => {
    const d = deps();
    await expect(runSetup(['--doctor', '--strict', '--json'], d as any)).resolves.toBe(0);
    expect(d.doctor).toHaveBeenCalledWith({ strict: true });
    expect(JSON.parse(d.output.mock.calls[0][0])).toMatchObject({ schemaVersion: 1, status: 'ready' });
    await expect(runSetup(['--doctor', '--dry-run'], d as any)).rejects.toThrow(/cannot be combined/i);
  });

  it('requires explicit Hyperdrive credential argv consent before deploy mutation', async () => {
    const flags = ['--mode', 'deploy', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--app-origin', 'https://full.example.test', '--email-from', 'serve@full.example.test', '--yes'];
    const refused = deps();
    await expect(runSetup(flags, refused as any)).rejects.toThrow(/allow-hyperdrive-secret-in-argv/);
    expect(refused.collectSupabaseSecret).not.toHaveBeenCalled();
    expect(refused.apply).not.toHaveBeenCalled();

    const allowed = deps();
    await runSetup([...flags, '--allow-hyperdrive-secret-in-argv'], allowed as any);
    expect(allowed.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowHyperdriveSecretInArgv: true }));
  });

  it('does not require argv consent for a healthy recorded deploy Hyperdrive', async () => {
    const flags = ['--mode', 'deploy', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--app-origin', 'https://full.example.test', '--email-from', 'serve@full.example.test', '--yes'];
    const d = deps({ inspectExisting: vi.fn(async () => ({ existingBackend: 'supabase', existingMode: 'deploy', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'full-media', hyperdriveId: 'healthy-id' } })) });
    await expect(runSetup(flags, d)).resolves.toBe(0);
    expect(d.apply).toHaveBeenCalledWith(expect.objectContaining({ resources: expect.objectContaining({ hyperdriveId: 'healthy-id' }) }), expect.objectContaining({ allowHyperdriveSecretInArgv: false }));
  });

  it('passes the Supabase URL only inside secretContext', async () => {
    const d = deps();
    await runSetup(['--mode', 'local', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--yes'], d as any);
    expect(d.collectSupabaseSecret).toHaveBeenCalledOnce();
    expect(d.apply.mock.calls[0][1]).toMatchObject({ secretContext: { dbUrl: 'postgres://user:password@db.example.test/app' } });
    expect(JSON.stringify(d.apply.mock.calls[0][0])).not.toContain('postgres://');
  });

  it('registers Stripe setup credentials for redaction but consumes them only for Supabase secretContext', async () => {
    const stripeSecrets = { secretKey: 'sk_test_setup_only', webhookSecret: 'whsec_setup_only' };
    const pg = deps({ collectStripeTestSecrets: vi.fn(async () => stripeSecrets) });
    await runSetup(['--mode', 'local', '--preset', 'full-church', '--site-slug', 'full', '--church-name', 'Full', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--yes'], pg);
    expect(pg.collectStripeTestSecrets).toHaveBeenCalledOnce();
    expect(pg.preflightConfig).toHaveBeenCalledWith(expect.objectContaining({ secretValues: ['sk_test_setup_only', 'whsec_setup_only'] }));
    expect(pg.apply.mock.calls[0][1].secretContext.stripeSecrets).toEqual(stripeSecrets);
    expect(pg.apply.mock.calls[0][1].secretValues).toEqual(expect.arrayContaining(['sk_test_setup_only', 'whsec_setup_only']));
    expect(JSON.stringify(pg.apply.mock.calls[0][0])).not.toContain('sk_test_setup_only');

    const d1 = deps();
    await runSetup([...baseFlags, '--yes'], d1);
    expect(d1.collectStripeTestSecrets).not.toHaveBeenCalled();
    expect(d1.collectStripeSetupRedactionValues).not.toHaveBeenCalled();
    expect(d1.apply.mock.calls[0][1].secretContext).not.toHaveProperty('stripeSecrets');
  });

  it('accepts only a complete dedicated test-mode Stripe pair and ignores ambient runtime names', async () => {
    await expect(collectStripeTestSecrets({ environment: {} })).resolves.toBeNull();
    await expect(collectStripeTestSecrets({ environment: {
      STRIPE_SECRET_KEY: 'sk_test_ambient', STRIPE_WEBHOOK_SECRET: 'whsec_ambient',
    } })).resolves.toBeNull();
    await expect(collectStripeTestSecrets({ environment: {
      CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_test_setup', CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'whsec_setup',
    } })).resolves.toEqual({ secretKey: 'sk_test_setup', webhookSecret: 'whsec_setup' });
    await expect(collectStripeTestSecrets({ environment: {
      CHURCH_SETUP_STRIPE_SECRET_KEY: '  sk_test_trimmed  ', CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: '  whsec_trimmed  ',
    } })).resolves.toEqual({ secretKey: 'sk_test_trimmed', webhookSecret: 'whsec_trimmed' });
    for (const environment of [
      { CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_test_partial' },
      { CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_live_forbidden', CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'whsec_setup' },
      { CHURCH_SETUP_STRIPE_SECRET_KEY: 'unknown', CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'whsec_setup' },
      { CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_test_setup', CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'unknown' },
    ]) await expect(collectStripeTestSecrets({ environment })).rejects.toThrow(/Stripe test|complete pair/i);
  });

  it('parses STRIPE_MODE structurally and never accepts a comment or unrelated text match', () => {
    expect(configuredStripeTestMode('{ "vars": { "STRIPE_MODE": "test" } }')).toBe(true);
    expect(configuredStripeTestMode('// "STRIPE_MODE": "test"\n{ "vars": { "DB_BACKEND": "supabase" } }')).toBe(false);
    expect(configuredStripeTestMode('{ "note": "\\\"STRIPE_MODE\\\": \\\"test\\\"", "vars": {} }')).toBe(false);
    expect(configuredStripeTestMode('invalid')).toBe(false);
  });

  it('collects the Supabase URL from env first and otherwise requires masked interactive input', async () => {
    const maskedInput = vi.fn(async () => 'postgres://masked:password@db.example.test/app');
    await expect(collectSupabaseSecret({ environment: { SUPABASE_DB_URL: 'postgres://env:password@db.example.test/app' }, interactive: true, maskedInput }))
      .resolves.toEqual({ dbUrl: 'postgres://env:password@db.example.test/app', source: 'environment' });
    expect(maskedInput).not.toHaveBeenCalled();
    await expect(collectSupabaseSecret({ environment: {}, interactive: false, maskedInput })).rejects.toThrow(/SUPABASE_DB_URL/);
    expect(maskedInput).not.toHaveBeenCalled();
    await expect(collectSupabaseSecret({ environment: {}, interactive: true, maskedInput })).resolves.toEqual({ dbUrl: 'postgres://masked:password@db.example.test/app', source: 'masked' });
    expect(maskedInput).toHaveBeenCalledOnce();
  });

  it('asks interactive questions sequentially in the documented order', async () => {
    const ordered: string[] = [];
    const values: Record<string, unknown> = {
      mode: 'deploy', featureChoice: 'website', siteSlug: 'ordered', churchName: 'Ordered Church',
      locale: 'zh', adminName: 'Admin', adminEmail: 'admin@example.test',
      appOrigin: 'https://ordered.example.test', emailFrom: 'serve@ordered.example.test', demoData: false,
    };
    const ask = vi.fn(async (question: any) => { ordered.push(question.key); return values[question.key]; });
    await collectInteractiveAnswers({ demoData: false, demoDataSpecified: false } as any, rawCatalog, ask);
    expect(ordered).toEqual(['mode', 'featureChoice', 'siteSlug', 'churchName', 'locale', 'adminName', 'adminEmail', 'appOrigin', 'emailFrom', 'demoData']);
    expect(ask).toHaveBeenCalledTimes(10);
  });

  it('formats a confirmation preview with capabilities, provider requirements, reasons, dependencies, and actions', () => {
    const rendered = formatPlan({
      site: { name: 'Full Church' }, backend: 'supabase',
      modules: ['portal', 'giving'], services: ['hyperdrive', 'r2', 'worker'],
      addedDependencies: [{ capability: 'portal', added: 'people' }],
      providerReasons: [{ capability: 'portal', requiresBackend: 'supabase' }],
      actions: ['ensure-resources', 'migrate', 'doctor'],
    } as any);
    expect(rendered).toContain('portal, giving');
    expect(rendered).toContain('Supabase');
    expect(rendered).toContain('hyperdrive, r2, worker');
    expect(rendered).toMatch(/Cloudflare.*Supabase/s);
    expect(rendered).toContain('portal adds people');
    expect(rendered).toContain('portal requires Supabase');
    expect(rendered).toContain('ensure-resources -> migrate -> doctor');
  });

  it.each([
    ['local', 'd1', 'none (local setup)'],
    ['local', 'supabase', 'Supabase'],
    ['deploy', 'd1', 'Cloudflare'],
    ['deploy', 'supabase', 'Cloudflare and Supabase'],
  ])('formats truthful required accounts for %s %s', (mode, backend, accounts) => {
    const rendered = formatPlan({
      mode, site: { name: 'Accounts' }, backend, modules: ['events'], services: ['worker'],
      addedDependencies: [], providerReasons: [], providerSelectionReason: 'default', actions: ['doctor'],
    } as any);
    expect(rendered).toContain(`Required accounts: ${accounts}`);
  });

  it('explains an explicit Supabase override for otherwise D1-compatible capabilities', () => {
    const plan = buildSetupPlan({
      mode: 'local', preset: 'website', backendOverride: 'supabase', siteSlug: 'override',
      churchName: 'Override', locale: 'en', adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    }, rawCatalog);
    expect(formatPlan(plan)).toMatch(/Supabase selected by explicit --backend override/i);
    expect(formatPlan(plan)).not.toContain('selected capabilities are D1-compatible');
  });

  it('previews the resolved plan immediately before interactive confirmation', async () => {
    const events: string[] = [];
    const values: Record<string, unknown> = {
      mode: 'local', featureChoice: 'website', siteSlug: 'preview', churchName: 'Preview',
      locale: 'en', adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    };
    const d = deps({
      interactive: true,
      ask: vi.fn(async (question: any) => values[question.key]),
      previewPlan: vi.fn(() => events.push('preview')),
      confirm: vi.fn(async () => { events.push('confirm'); return false; }),
    });
    await runSetup([], d);
    expect(events).toEqual(['preview', 'confirm']);
    expect(d.previewPlan).toHaveBeenCalledWith(expect.objectContaining({ backend: 'd1', modules: expect.any(Array) }), { json: false });
  });

  it('routes the default plan preview to stderr in JSON mode to preserve single-document stdout', () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const preview = createPlanPreview({ output: stdout, errorOutput: stderr });
    const plan = { site: { name: 'JSON Preview' }, backend: 'd1', modules: ['events'], services: ['worker'], addedDependencies: [], providerReasons: [], actions: ['doctor'] } as any;
    preview(plan, { json: true });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('JSON Preview'));
    preview(plan, { json: false });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('JSON Preview'));
  });

  it('formats completion with doctor detail and actionable handoff', () => {
    const text = formatResult({
      doctor: { status: 'ready-with-limitations', checks: [{ severity: 'warning', code: 'services.stripe-absent', message: 'Stripe is absent.', remediation: 'Configure both Stripe secrets.' }] },
      handoff: { mode: 'local', url: 'http://localhost:4321', adminEmail: 'admin@example.test', capabilities: ['events', 'giving'], startCommand: 'npm run dev', limitations: ['services.stripe-absent'] },
    } as any);
    expect(text).toContain('services.stripe-absent');
    expect(text).toContain('Stripe is absent.');
    expect(text).toContain('Configure both Stripe secrets.');
    expect(text).toContain('npm run dev');
    expect(text).toContain('http://localhost:4321');
    expect(text).toContain('admin@example.test');
    expect(text).toContain('events, giving');
  });

  it('Customize asks one boolean per group and supports correction plus exact re-review', async () => {
    const ordered: string[] = [];
    const responses: Record<string, unknown[]> = {
      mode: ['local'], featureChoice: ['customize'],
      'group.content': [true], 'group.community': [false], 'group.volunteering': [false],
      moduleReview: [false, true], moduleSelection: [['giving', 'bulletins']],
      siteSlug: ['custom'], churchName: ['Custom'], locale: ['en'], adminName: ['Admin'],
      adminEmail: ['admin@example.test'], demoData: [false],
    };
    const ask = vi.fn(async (question: any) => {
      ordered.push(question.key);
      if (question.key.startsWith('group.')) {
        expect(question.multiple).not.toBe(true);
        expect(question.choices.map((choice: any) => choice.value)).toEqual([true, false]);
      }
      return responses[question.key].shift();
    });
    const answers = await collectInteractiveAnswers({ demoData: false, demoDataSpecified: false } as any, rawCatalog, ask);
    expect(ordered.slice(0, 8)).toEqual(['mode', 'featureChoice', 'group.content', 'group.community', 'group.volunteering', 'moduleReview', 'moduleSelection', 'moduleReview']);
    expect(answers.modules).toEqual(['bulletins', 'giving']);
  });
});

describe('wrangler replacement preflight', () => {
  async function replacementPreview(plan: ReturnType<typeof buildSetupPlan>, existingManifest: unknown = null) {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const output = vi.fn();
    await expect(preflightWranglerConfig({
      current: '{ "name": "legacy-config" }\n',
      template,
      plan,
      existingManifest,
      catalog: rawCatalog,
      interactive: true,
      forceConfig: false,
      output,
      confirmConfigReplacement: vi.fn(async () => false),
    })).rejects.toThrow(/replacement was not approved/i);
    return output.mock.calls[0][0] as string;
  }

  it('accepts baseline and only canonical generated bytes for a validated manifest', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const plan = buildSetupPlan({
      mode: 'local', preset: 'website', siteSlug: 'canonical', churchName: 'Canonical', locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    }, rawCatalog);
    const manifest = manifestFromPlan(plan, rawCatalog);
    const canonical = renderWrangler(template, manifest);
    await expect(preflightWranglerConfig({ current: baseline, baseline, template, existingManifest: null, catalog: rawCatalog, interactive: false, forceConfig: false }))
      .resolves.toMatchObject({ classification: 'baseline', approvedContent: baseline });
    await expect(preflightWranglerConfig({ current: canonical, baseline, template, existingManifest: manifest, catalog: rawCatalog, interactive: false, forceConfig: false }))
      .resolves.toMatchObject({ classification: 'canonical-generated', approvedContent: canonical });
    await expect(preflightWranglerConfig({ current: `${canonical}\n// local edit`, baseline, template, existingManifest: manifest, catalog: rawCatalog, interactive: false, forceConfig: false }))
      .rejects.toThrow(/--force-config/);
  });

  it('requires the normal explicit replacement path for a pre-recovery generated Supabase config', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const plan = buildSetupPlan({
      mode: 'local', preset: 'full-church', siteSlug: 'upgrade-pg', churchName: 'Upgrade PG', locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    }, rawCatalog);
    const manifest = manifestFromPlan(plan, rawCatalog);
    const canonical = renderWrangler(template, manifest);
    const oldGenerated = canonical
      .replace(', "*/5 * * * *"', '')
      .replace(', "STRIPE_MODE": "test"', '');
    const output = vi.fn();
    const confirmConfigReplacement = vi.fn(async () => false);
    await expect(preflightWranglerConfig({ current: oldGenerated, baseline, template, plan, existingManifest: manifest, catalog: rawCatalog, interactive: true, forceConfig: false, output, confirmConfigReplacement }))
      .rejects.toThrow(/replacement was not approved/i);
    expect(confirmConfigReplacement).toHaveBeenCalledOnce();
    expect(output.mock.calls[0][0]).toContain('*/5 * * * *');
    await expect(preflightWranglerConfig({ current: oldGenerated, baseline, template, plan, existingManifest: manifest, catalog: rawCatalog, interactive: false, forceConfig: false }))
      .rejects.toThrow(/--force-config/);
  });

  it('requires a separate interactive replacement confirmation and emits a concise redacted diff', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const plan = buildSetupPlan({
      mode: 'local', preset: 'website', siteSlug: 'replacement', churchName: 'Replacement', locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    }, rawCatalog);
    const output = vi.fn();
    const confirmConfigReplacement = vi.fn(async () => false);
    const registered = 'sk_test_registered_input';
    const current = `{ "name": "private", "vars": { "TOKEN": "postgres://owner:very-secret-password@example/db" } }\n// ${registered}\n`;
    await expect(preflightWranglerConfig({ current, baseline, template, plan, existingManifest: null, catalog: rawCatalog, interactive: true, forceConfig: false, secretValues: [registered], output, confirmConfigReplacement }))
      .rejects.toThrow(/replacement was not approved/i);
    expect(confirmConfigReplacement).toHaveBeenCalledOnce();
    const preview = output.mock.calls[0][0];
    expect(preview).toContain('wrangler.jsonc replacement');
    expect(preview).not.toContain('very-secret-password');
    expect(preview).not.toContain(registered);

    confirmConfigReplacement.mockResolvedValueOnce(true);
    await expect(preflightWranglerConfig({ current, baseline, template, plan, existingManifest: null, catalog: rawCatalog, interactive: true, forceConfig: false, secretValues: [registered], output, confirmConfigReplacement }))
      .resolves.toMatchObject({ classification: 'unrecognized', approvedContent: current });
  });

  it.each([
    ['D1', 'website', 'd1-local', '"DB_BACKEND": "d1"', '"binding": "DB"', '"database_name": "d1-local-db"', '"database_id": "local"'],
    ['Supabase', 'full-church', 'supabase-local', '"DB_BACKEND": "supabase"', '"binding": "HYPERDRIVE"', '"id": "local"', '"bucket_name": "supabase-local-media"'],
  ])('renders an exact prospective %s local config without a manifest', async (_label, preset, siteSlug, backend, binding, providerResource, localId) => {
    const plan = buildSetupPlan({
      mode: 'local', preset, siteSlug, churchName: `${_label} Local`, locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
    }, rawCatalog);
    const preview = await replacementPreview(plan);
    expect(preview).toContain(`"name": "${siteSlug}"`);
    expect(preview).toContain(backend);
    expect(preview).toContain(binding);
    expect(preview).toContain(providerResource);
    expect(preview).toContain(localId);
    expect(preview).toContain('"APP_ORIGIN": "http://localhost:4321"');
    expect(preview).toContain(`"EMAIL_FROM": "serve@${siteSlug}.invalid"`);
    expect(preview).toContain(`"bucket_name": "${siteSlug}-media"`);
    expect(preview).not.toMatch(/@@[A-Z_]+@@|PENDING_[A-Z_]+_AFTER_APPROVAL/);
  });

  it.each([
    ['D1', 'website', 'd1-deploy', 'PENDING_D1_DATABASE_ID_AFTER_APPROVAL', '"binding": "DB"', '"database_name": "d1-deploy-db"'],
    ['Supabase', 'full-church', 'supabase-deploy', 'PENDING_HYPERDRIVE_ID_AFTER_APPROVAL', '"binding": "HYPERDRIVE"', '"bucket_name": "supabase-deploy-media"'],
  ])('renders a prospective new %s deploy config with only its provider ID pending', async (_label, preset, siteSlug, pendingId, binding, resourceName) => {
    const plan = buildSetupPlan({
      mode: 'deploy', preset, siteSlug, churchName: `${_label} Deploy`, locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
      appOrigin: `https://${siteSlug}.example.test`, emailFrom: `serve@${siteSlug}.example.test`,
    }, rawCatalog);
    const preview = await replacementPreview(plan);
    expect(preview).toContain(`"name": "${siteSlug}"`);
    expect(preview).toContain(binding);
    expect(preview).toContain(resourceName);
    expect(preview).toContain(`"bucket_name": "${siteSlug}-media"`);
    expect(preview.match(/PENDING_(?:D1_DATABASE|HYPERDRIVE)_ID_AFTER_APPROVAL/g)).toEqual([pendingId]);
    expect(preview).toMatch(/only those IDs will be substituted after setup approval/i);
    expect(preview).not.toMatch(/@@[A-Z_]+@@|"(?:database_id|id)": null/);
  });

  it('renders exact existing deploy resources from a legacy installation with no manifest', async () => {
    const resources = {
      d1DatabaseName: 'legacy-church-db', d1DatabaseId: 'legacy-d1-id',
      r2BucketName: 'legacy-church-media', hyperdriveId: null,
    };
    const plan = buildSetupPlan({
      mode: 'deploy', preset: 'website', siteSlug: 'legacy-church', churchName: 'Legacy Church', locale: 'en',
      adminName: 'Admin', adminEmail: 'admin@example.test', demoData: false,
      appOrigin: 'https://legacy-church.example.test', emailFrom: 'serve@legacy-church.example.test',
    }, rawCatalog, { existingBackend: 'd1', existingMode: 'deploy', resources });
    const preview = await replacementPreview(plan);
    expect(preview).toContain('"database_name": "legacy-church-db"');
    expect(preview).toContain('"database_id": "legacy-d1-id"');
    expect(preview).toContain('"bucket_name": "legacy-church-media"');
    expect(preview).toContain('"APP_ORIGIN": "https://legacy-church.example.test"');
    expect(preview).toContain('"EMAIL_FROM": "serve@legacy-church.example.test"');
    expect(preview).not.toMatch(/@@[A-Z_]+@@|PENDING_[A-Z_]+_AFTER_APPROVAL/);
  });
});
