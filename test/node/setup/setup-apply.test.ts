import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applySetup, createD1Steps, createResourceStep, createSupabaseSteps, SetupApplyError } from '../../../scripts/setup/apply.mjs';
import { acquireApprovedContentLease } from '../../../scripts/setup/files.mjs';
import { createStateStore, fingerprintPlan } from '../../../scripts/setup/state.mjs';
import { configureSecrets } from '../../../scripts/setup/secrets.mjs';
import { probeR2Object } from '../../../scripts/setup/probes.mjs';

const ORDER = ['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor'];

function memoryStore(initialOrigin?: 'managed' | 'imported') {
  const completed = new Set<string>();
  const evidence = new Map<string, unknown>();
  let origin = initialOrigin;
  return { completed, async load(_fingerprint?: string, hint: 'managed' | 'imported' = 'managed') { origin ??= hint; return origin; }, async has(name: string) { return completed.has(name); }, async getEvidence(name: string) { return evidence.get(name) ?? null; }, async mark(name: string, value: unknown) { completed.add(name); evidence.set(name, value); } };
}

describe('setup apply coordinator', () => {
  it('applies in canonical order and verifies persisted completions as no-ops', async () => {
    const calls: string[] = [];
    const applied = new Set<string>();
    const resources = { d1DatabaseName: 'church-db', d1DatabaseId: 'id', r2BucketName: 'church-media', hyperdriveId: null };
    const steps = Object.fromEntries(ORDER.map((name) => [name, { apply: async (context: any) => { calls.push(name); applied.add(name); return name === 'ensure-resources' ? { changed: true, resolvedResources: resources } : { changed: true, saw: context.plan.resources }; }, verify: async () => applied.has(name) }]));
    const stateStore = memoryStore();
    const plan = Object.freeze({ actions: [...ORDER], planVersion: 1, backend: 'd1', site: { slug: 'church' } });
    const first = await applySetup(plan, { steps, stateStore, dryRun: false });
    expect(calls).toEqual(ORDER);
    expect(first.results[2]).toMatchObject({ step: 'write-manifest' });
    expect(plan).not.toHaveProperty('resources');
    calls.length = 0;
    await applySetup(plan, { steps, stateStore, dryRun: false });
    expect(calls).toEqual([]);
  });

  it('dry-run calls no step and loads/writes no state', async () => {
    const apply = vi.fn(); const verify = vi.fn(); const load = vi.fn(); const mark = vi.fn();
    const result = await applySetup({ actions: ['migrate'] }, { steps: { migrate: { apply, verify } }, stateStore: { load, has: vi.fn(), mark }, dryRun: true });
    expect(result).toEqual({ status: 'dry-run', actions: ['migrate'], results: [] });
    expect(apply).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled();
  });

  it('rechecks config ownership before state and every later mutation boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-lease-'));
    const configPath = join(root, 'wrangler.jsonc');
    const statePath = join(root, '.church/setup-state.json');
    await writeFile(configPath, 'approved');
    const lease = await acquireApprovedContentLease(configPath, 'approved');
    const mutate = vi.fn(async () => ({ changed: true }));
    await writeFile(configPath, 'changed before state');
    await expect(applySetup({ actions: ['migrate'] }, {
      steps: { migrate: { apply: mutate, verify: async () => false } },
      stateStore: createStateStore(statePath),
      beforeMutation: () => lease.assertUnchanged(),
    })).rejects.toThrow(/changed.*approval/i);
    expect(mutate).not.toHaveBeenCalled();
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.release();

    await writeFile(configPath, 'approved');
    const secondLease = await acquireApprovedContentLease(configPath, 'approved');
    let boundaries = 0;
    await expect(applySetup({ actions: ['migrate'] }, {
      steps: { migrate: { apply: mutate, verify: async () => false } },
      stateStore: createStateStore(statePath),
      beforeMutation: async () => {
        boundaries += 1;
        if (boundaries === 2) await writeFile(configPath, 'changed before external call');
        await secondLease.assertUnchanged();
      },
    })).rejects.toThrow(/changed.*approval/i);
    expect(mutate).not.toHaveBeenCalled();
    await secondLease.release();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects unknown, duplicate, out-of-order, and malformed requested actions', async () => {
    const deps: any = { steps: {}, stateStore: memoryStore(), dryRun: false };
    await expect(applySetup({ actions: ['wat'] }, deps)).rejects.toThrow(/unknown/i);
    await expect(applySetup({ actions: ['migrate', 'migrate'] }, deps)).rejects.toThrow(/duplicate/i);
    await expect(applySetup({ actions: ['doctor', 'migrate'] }, deps)).rejects.toThrow(/order/i);
    await expect(applySetup({ actions: ['migrate'] }, deps)).rejects.toThrow(/step.*migrate/i);
  });

  it('stops on failure and marks only after post-apply verification', async () => {
    const mark = vi.fn(); const second = vi.fn();
    await expect(applySetup({ actions: ['migrate', 'seed'] }, { steps: {
      migrate: { apply: async () => ({ changed: true }), verify: async () => false },
      seed: { apply: second, verify: async () => true },
    }, stateStore: { async load() { return 'managed'; }, async has() { return false; }, mark }, dryRun: false })).rejects.toThrow(/did not verify/i);
    expect(mark).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });

  it('reports a migration failure with safe recovery context and leaves later actions untouched', async () => {
    const secret = 'postgres://setup-user:super-secret-password@db.example.test/church';
    const seed = vi.fn();
    let failure: unknown;
    try {
      await applySetup({ actions: ['verify-provider', 'migrate', 'seed'] }, {
        steps: {
          'verify-provider': { apply: vi.fn(), verify: async () => true },
          migrate: { apply: async () => { throw new Error(`migration rejected ${secret}`); }, verify: async () => false },
          seed: { apply: seed, verify: async () => false },
        },
        stateStore: memoryStore(),
        dryRun: false,
        rerunCommand: "npm run --silent setup -- --mode 'local' --yes",
        secretValues: [secret] as string[],
      });
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(SetupApplyError);
    expect(failure).toMatchObject({
      code: 'SETUP_APPLY_FAILED', step: 'migrate', phase: 'apply',
      completed: [{ step: 'verify-provider', status: 'verified' }],
      unchanged: ['seed'], causeMessage: 'migration rejected [REDACTED]',
      rerunCommand: "npm run --silent setup -- --mode 'local' --yes",
    });
    expect(String(failure)).toContain('Failed step: migrate (apply)');
    expect(String(failure)).toContain('Completed: verify-provider (verified)');
    expect(String(failure)).toContain('Unchanged: seed');
    expect(String(failure)).toContain('Remediation:');
    expect(String(failure)).toContain("Rerun: npm run --silent setup -- --mode 'local' --yes");
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain('super-secret-password');
    expect(seed).not.toHaveBeenCalled();
  });

  it('classifies preverification, postverification, and state-mark failures', async () => {
    const cases = [
      { expected: 'preverify', step: { apply: vi.fn(), verify: async () => { throw new Error('probe failed'); } }, mark: vi.fn() },
      { expected: 'postverify', step: { apply: async () => ({ changed: true }), verify: vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('postcheck failed')) }, mark: vi.fn() },
      { expected: 'mark', step: { apply: async () => ({ changed: true }), verify: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) }, mark: vi.fn(async () => { throw new Error('state write failed'); }) },
    ];
    for (const item of cases) {
      const state = { async load() { return 'managed'; }, async has() { return false; }, mark: item.mark };
      await expect(applySetup({ actions: ['migrate'] }, { steps: { migrate: item.step }, stateStore: state, rerunCommand: 'npm run setup -- --yes' }))
        .rejects.toMatchObject({ step: 'migrate', phase: item.expected, completed: [], unchanged: [] });
    }
  });

  it('classifies invalid resource evidence at the boundary where it is observed', async () => {
    const plan: any = { actions: ['ensure-resources'], backend: 'd1', site: { slug: 'church' } };
    await expect(applySetup(plan, {
      steps: { 'ensure-resources': { apply: async () => ({ changed: true }), verify: async () => false } },
      stateStore: memoryStore(),
    })).rejects.toMatchObject({ step: 'ensure-resources', phase: 'apply' });

    const completed = memoryStore();
    completed.completed.add('ensure-resources');
    await expect(applySetup(plan, {
      steps: { 'ensure-resources': { apply: vi.fn(), verify: async () => true } },
      stateStore: completed,
    })).rejects.toMatchObject({ step: 'ensure-resources', phase: 'preverify' });
  });

  it('turns administrator bootstrap classifications into explicit recovery actions', async () => {
    const outcome = (status: string) => ({
      prepare() {
        return { bind() { return this; }, async first() { return { id: 1, role: status === 'already-admin' ? 'admin' : 'member', active: status === 'inactive' ? 0 : 1, deleted_at: status === 'reactivation-required' ? '2026-01-01' : null }; }, async run() { return { meta: { changes: 1 } }; } };
      },
    });
    const verify = { migrate: async () => true, seed: async () => true, 'initialize-modules': async () => true, 'bootstrap-admin': async () => true };
    const plan: any = { adminEmail: 'member@example.test', adminName: 'Member', site: { locale: 'en' } };

    const promotion = createD1Steps({ runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', db: outcome('promotion-required'), moduleKeys: [], verify });
    await expect(promotion['bootstrap-admin'].apply({ plan })).rejects.toThrow(/--promote-existing-admin/);
    await expect(applySetup({ ...plan, actions: ['bootstrap-admin'] }, {
      steps: { 'bootstrap-admin': { ...promotion['bootstrap-admin'], verify: async () => false } },
      stateStore: memoryStore(),
      rerunCommand: "npm run --silent setup -- --admin-email 'member@example.test' --yes",
    })).rejects.toMatchObject({
      step: 'bootstrap-admin', phase: 'apply',
      rerunCommand: "npm run --silent setup -- --admin-email 'member@example.test' --promote-existing-admin --yes",
    });
    await expect(applySetup({ ...plan, actions: ['bootstrap-admin'] }, {
      steps: { 'bootstrap-admin': { ...promotion['bootstrap-admin'], verify: async () => false } },
      stateStore: memoryStore(),
      rerunCommand: "npm run --silent setup -- --church-name '--promote-existing-admin' --yes",
    })).rejects.toMatchObject({
      rerunCommand: "npm run --silent setup -- --church-name '--promote-existing-admin' --promote-existing-admin --yes",
    });
    const inactive = createD1Steps({ runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', db: outcome('inactive'), moduleKeys: [], verify });
    await expect(inactive['bootstrap-admin'].apply({ plan })).rejects.toThrow(/reactivate.*member@example\.test.*rerun/i);
    const deleted = createD1Steps({ runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', db: outcome('reactivation-required'), moduleKeys: [], verify });
    await expect(deleted['bootstrap-admin'].apply({ plan })).rejects.toThrow(/restore.*reactivate.*member@example\.test.*rerun/i);
  });

  it('requires exact true verification and resource evidence access', async () => {
    const state: any = { async load() { return 'managed'; }, async has() { return true; }, async mark() {} };
    const step = { apply: vi.fn(async () => ({ changed: false })), verify: vi.fn().mockResolvedValueOnce(1).mockResolvedValue(true) };
    await applySetup({ actions: ['migrate'] }, { steps: { migrate: step }, stateStore: state, dryRun: false });
    expect(step.apply).toHaveBeenCalledTimes(1);
    await expect(applySetup({ actions: ['ensure-resources'] }, { steps: { 'ensure-resources': { apply: vi.fn(), verify: async () => true } }, stateStore: state, dryRun: false }))
      .rejects.toThrow(/getEvidence/i);
  });
});

describe('concrete provider actions', () => {
  const unusedDb = { prepare() { throw new Error('unused'); } };
  it('uses exact D1 migration and seed argument arrays', async () => {
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const steps = createD1Steps({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'deploy', db: unusedDb, moduleKeys: [], verify: { migrate: async () => true, seed: async () => true, 'initialize-modules': async () => true, 'bootstrap-admin': async () => true } });
    await steps.migrate.apply(); await steps.seed.apply();
    expect(calls.map((call) => call[1])).toEqual([
      ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.jsonc'],
      ['d1', 'execute', 'DB', '--remote', '--file', 'seed/dev-seed.sql', '--config', 'wrangler.jsonc', '--yes'],
    ]);
  });

  it('threads one local persistence root through D1 and R2 commands', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const verify = { migrate: async () => true, seed: async () => true, 'initialize-modules': async () => true, 'bootstrap-admin': async () => true };
    const steps = createD1Steps({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', persistTo: '/tmp/state', db: unusedDb, moduleKeys: [], verify });
    await steps.migrate.apply(); await steps.seed.apply();
    await probeR2Object({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', bucket: 'media', key: 'x', mode: 'local', persistTo: '/tmp/state' });
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.slice(-2).join(' ') === '--persist-to /tmp/state')).toBe(true);
  });

  it('passes Supabase URL only in child environment and never argv', async () => {
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0 }; } };
    const url = 'postgres://user:secret@db.test/church';
    const steps = createSupabaseSteps({ runner, root: '/repo', dbUrl: url, db: unusedDb, moduleKeys: [], verify: { migrate: async () => true, seed: async () => true, 'initialize-modules': async () => true, 'bootstrap-admin': async () => true } });
    await steps.migrate.apply(); await steps.seed.apply();
    expect(calls[0][1]).toEqual(['scripts/db/migrate-supabase.mjs']);
    expect(calls[1][1]).toEqual(['scripts/db/seed-supabase.mjs']);
    expect(JSON.stringify(calls.map((call) => call[1]))).not.toContain(url);
    expect(calls[0][2].env.SUPABASE_DB_URL).toBe(url);
  });

  it('reconciles deploy resources, treating stored IDs as hints and checking Hyperdrive before R2', async () => {
    const order: string[] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      order.push(args.slice(0, 3).join(' '));
      if (args[0] === 'hyperdrive' && args[1] === 'list') return { stdout: '📋 Listing Hyperdrive configs', stderr: '', exitCode: 0 };
      throw new Error('cloud mutation');
    } };
    const plan: any = { backend: 'supabase', mode: 'deploy', site: { slug: 'church' }, resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'old-media', hyperdriveId: 'stale' } };
    const step = createResourceStep({ plan, runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', dbUrl: 'postgres://u:p@db.test/church', verify: async () => true });
    await expect(step.apply()).rejects.toThrow(/imported Hyperdrive.*refusing.*replacement/i);
    expect(order).toEqual(['hyperdrive list --config']);
  });

  it('recreates an owned deleted Hyperdrive only in explicit recovery context', async () => {
    const table = [
      '📋 Listing Hyperdrive configs',
      '┌────┬──────┬──────┬──────┬──────┬────────┬──────────┬─────────┬──────┬─────────────────────────┐',
      '│ id │ name │ user │ host │ port │ scheme │ database │ caching │ mtls │ origin_connection_limit │',
      '├────┼──────┼──────┼──────┼──────┼────────┼──────────┼─────────┼──────┼─────────────────────────┤',
      '│ new-id │ church-db │ u │ h │ 5432 │ Postgres │ db │ x │ {} │ 1 │',
      '└────┴──────┴──────┴──────┴──────┴────────┴──────────┴─────────┴──────┴─────────────────────────┘',
    ].join('\n');
    let lists = 0; const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'hyperdrive' && args[1] === 'list') return { stdout: lists++ === 0 ? '📋 Listing Hyperdrive configs' : table, stderr: '', exitCode: 0 };
      if (args[0] === 'hyperdrive' && args[1] === 'create') return { stdout: '', stderr: '', exitCode: 0 };
      if (args.slice(0, 3).join(' ') === 'r2 bucket info') return { stdout: JSON.stringify({ name: 'old-media' }), stderr: '', exitCode: 0 };
      throw new Error(`unexpected ${args.join(' ')}`);
    } };
    const plan: any = { backend: 'supabase', mode: 'deploy', site: { slug: 'church' }, resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'old-media', hyperdriveId: 'stale' } };
    const resource = createResourceStep({ plan, runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', dbUrl: 'postgres://u:p@db.test/church', allowHyperdriveSecretInArgv: true, verify: async () => true });
    await expect(resource.apply({ recovering: true } as any)).resolves.toMatchObject({ resolvedResources: { hyperdriveId: 'new-id' } });
    expect(calls.findIndex((args) => args[0] === 'hyperdrive' && args[1] === 'create')).toBeLessThan(calls.findIndex((args) => args[0] === 'r2'));
  });

  it('fails deleted owned Hyperdrive recovery before mutation without explicit argv consent', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'hyperdrive' && args[1] === 'list') return { stdout: '📋 Listing Hyperdrive configs', stderr: '', exitCode: 0 };
      throw new Error('mutation should not run');
    } };
    const plan: any = { backend: 'supabase', mode: 'deploy', site: { slug: 'church' }, resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'old-media', hyperdriveId: 'stale' } };
    const resource = createResourceStep({ plan, runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', dbUrl: 'postgres://u:p@db.test/church', allowHyperdriveSecretInArgv: false, verify: async () => true });
    await expect(resource.apply({ recovering: true } as any)).rejects.toThrow(/--allow-hyperdrive-secret-in-argv.*no resource mutation/i);
    expect(calls).toHaveLength(1);
  });

  it('rejects an imported Hyperdrive name match with a different ID before touching R2', async () => {
    const table = (id: string) => [
      '📋 Listing Hyperdrive configs',
      '┌────┬──────┬──────┬──────┬──────┬────────┬──────────┬─────────┬──────┬─────────────────────────┐',
      '│ id │ name │ user │ host │ port │ scheme │ database │ caching │ mtls │ origin_connection_limit │',
      '├────┼──────┼──────┼──────┼──────┼────────┼──────────┼─────────┼──────┼─────────────────────────┤',
      `│ ${id} │ church-db │ u │ h │ 5432 │ Postgres │ db │ x │ {} │ 1 │`,
      '└────┴──────┴──────┴──────┴──────┴────────┴──────────┴─────────┴──────┴─────────────────────────┘',
    ].join('\n');
    let r2Calls = 0;
    const plan: any = { backend: 'supabase', mode: 'deploy', site: { slug: 'church' }, resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'imported-media', hyperdriveId: 'old-id' } };
    const makeStep = (id: string) => createResourceStep({ plan, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', dbUrl: 'postgres://u:p@db.test/church', verify: async () => true, runner: { run: async (_file: string, args: string[]) => {
      if (args[0] === 'hyperdrive') return { stdout: table(id), stderr: '', exitCode: 0 };
      if (args.slice(0, 3).join(' ') === 'r2 bucket info') { r2Calls += 1; return { stdout: JSON.stringify({ name: 'imported-media' }), stderr: '', exitCode: 0 }; }
      throw new Error(`unexpected ${args.join(' ')}`);
    } } });
    await expect(makeStep('other-id').apply()).rejects.toThrow(/Hyperdrive.*(?:ambiguous|mismatch)/i);
    expect(r2Calls).toBe(0);
    await expect(makeStep('old-id').apply()).resolves.toMatchObject({ resolvedResources: { hyperdriveId: 'old-id', r2BucketName: 'imported-media' } });
    expect(r2Calls).toBe(1);
  });

  it('preserves imported D1 and R2 names while re-resolving stale IDs', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.slice(0, 2).join(' ') === 'd1 list') return { stdout: JSON.stringify([{ name: 'imported-db', uuid: 'fresh-id' }]), stderr: '', exitCode: 0 };
      if (args.slice(0, 3).join(' ') === 'r2 bucket info') return { stdout: JSON.stringify({ name: 'imported-media' }), stderr: '', exitCode: 0 };
      throw new Error(`unexpected ${args.join(' ')}`);
    } };
    const plan: any = { backend: 'd1', mode: 'deploy', site: { slug: 'church' }, resources: { d1DatabaseName: 'imported-db', d1DatabaseId: 'stale-id', r2BucketName: 'imported-media', hyperdriveId: null } };
    const step = createResourceStep({ plan, runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', verify: async () => true });
    await expect(step.apply()).resolves.toMatchObject({ resolvedResources: { d1DatabaseName: 'imported-db', d1DatabaseId: 'fresh-id', r2BucketName: 'imported-media' } });
    expect(calls.some((args) => args.includes('church-db') || args.includes('church-media'))).toBe(false);
  });
});

describe('setup state', () => {
  it('keeps desired-plan fingerprints stable across resolved provider IDs', () => {
    const base: any = { planVersion: 1, backend: 'd1', mode: 'local', site: { slug: 'church', name: 'Church' }, modules: ['events'], actions: ['ensure-resources'] };
    const resolved = { ...base, resources: { d1DatabaseName: 'church-db', d1DatabaseId: 'local', r2BucketName: 'church-media', hyperdriveId: null }, existingInstallation: true };
    expect(fingerprintPlan(base)).toBe(fingerprintPlan(resolved));
    expect(fingerprintPlan({ ...resolved, proposedChanges: ['display-only preview metadata'] })).toBe(fingerprintPlan(base));
    expect(fingerprintPlan({ ...resolved, resources: { ...resolved.resources, d1DatabaseId: 'remote-id' } })).toBe(fingerprintPlan(base));
    expect(fingerprintPlan({ ...resolved, resources: { ...resolved.resources, d1DatabaseName: 'other-db' } })).not.toBe(fingerprintPlan(base));
    expect(fingerprintPlan({ ...base, backend: 'supabase' })).not.toBe(fingerprintPlan(base));
    expect(fingerprintPlan({ ...base, site: { ...base.site, name: 'Other Church' } })).not.toBe(fingerprintPlan(base));
  });

  it('recovers a managed crash after seed, then preserves a completed canonical customization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-partial-recovery-'));
    const store = createStateStore(join(root, 'state.json'));
    const resources = { d1DatabaseName: 'church-db', d1DatabaseId: 'local', r2BucketName: 'church-media', hyperdriveId: null };
    const plan: any = { planVersion: 1, backend: 'd1', mode: 'local', site: { slug: 'church', name: 'Requested Church', locale: 'en' }, modules: ['events'], actions: ['ensure-resources', 'write-manifest', 'write-config', 'seed', 'initialize-modules'], existingInstallation: false };
    const completed = new Set<string>();
    const simple = (name: string) => ({ apply: async () => { completed.add(name); return { changed: true }; }, verify: async () => completed.has(name) });
    const firstSteps: any = {
      'ensure-resources': { apply: async () => { completed.add('ensure-resources'); return { changed: true, resolvedResources: resources }; }, verify: async () => completed.has('ensure-resources') },
      'write-manifest': simple('write-manifest'), 'write-config': simple('write-config'), seed: simple('seed'),
      'initialize-modules': { apply: async () => { throw new Error('crash before initialize'); }, verify: async () => false },
    };
    await expect(applySetup(plan, { steps: firstSteps, stateStore: store })).rejects.toThrow('crash before initialize');

    let siteName = 'Church4Christ'; const settings = new Map<string, string>();
    const db: any = { prepare(sql: string) { let binds: any[] = []; return { bind(...values: any[]) { binds = values; return this; }, async first(column?: string) { const value = settings.get(binds[0]) ?? (binds[0] === 'site.name.en' ? siteName : null); return column ? value : value === null ? null : { value }; }, async run() { if (sql.startsWith('INSERT INTO settings') && binds[0] === 'site.name.en') siteName = binds[1]; else for (let i = 0; i < binds.length; i += 2) settings.set(binds[i], binds[i + 1]); return { success: true, meta: { changes: 1 } }; } }; } };
    const provider = createD1Steps({ runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', db, moduleKeys: ['events'], preserveSiteIdentity: true, verify: { migrate: async () => true, seed: async () => true, 'initialize-modules': async (context: any) => context.recovering ? Boolean(siteName) : siteName === 'Requested Church', 'bootstrap-admin': async () => true } });
    const secondSteps: any = { 'ensure-resources': { apply: vi.fn(), verify: async () => true }, 'write-manifest': simple('write-manifest'), 'write-config': simple('write-config'), seed: simple('seed'), 'initialize-modules': provider['initialize-modules'] };
    await applySetup({ ...plan, resources, existingInstallation: true }, { steps: secondSteps, stateStore: createStateStore(join(root, 'state.json')) });
    expect(siteName).toBe('Requested Church');
    siteName = 'Church4Christ';
    await applySetup({ ...plan, resources, existingInstallation: true }, { steps: secondSteps, stateStore: createStateStore(join(root, 'state.json')) });
    expect(siteName).toBe('Church4Christ');
  });

  it('preserves an imported custom identity through a partial run and resource-resolved rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-imported-recovery-'));
    const path = join(root, 'state.json');
    const resources = { d1DatabaseName: 'church-db', d1DatabaseId: 'local', r2BucketName: 'church-media', hyperdriveId: null };
    const plan: any = { planVersion: 1, backend: 'd1', mode: 'local', site: { slug: 'church', name: 'Requested Church', locale: 'en' }, modules: ['events'], actions: ['verify-provider', 'write-manifest', 'write-config', 'seed', 'initialize-modules'], existingInstallation: true };
    const completed = new Set<string>();
    const simple = (name: string) => ({ apply: async () => { completed.add(name); return { changed: true }; }, verify: async () => completed.has(name) });
    await expect(applySetup(plan, { steps: {
      'verify-provider': { apply: vi.fn(), verify: async () => true },
      'write-manifest': simple('write-manifest'), 'write-config': simple('write-config'), seed: simple('seed'),
      'initialize-modules': { apply: async () => { throw new Error('crash before initialize'); }, verify: async () => false },
    } as any, stateStore: createStateStore(path) })).rejects.toThrow('crash before initialize');

    let siteName = 'Imported Custom Church'; const settings = new Map<string, string>();
    const db: any = { prepare(sql: string) { let binds: any[] = []; return { bind(...values: any[]) { binds = values; return this; }, async first(column?: string) { const value = settings.get(binds[0]) ?? (binds[0] === 'site.name.en' ? siteName : null); return column ? value : value === null ? null : { value }; }, async run() { if (sql.startsWith('INSERT INTO settings') && binds[0] === 'site.name.en') siteName = binds[1]; else for (let i = 0; i < binds.length; i += 2) settings.set(binds[i], binds[i + 1]); return { success: true, meta: { changes: 1 } }; } }; } };
    const provider = createD1Steps({ runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local', db, moduleKeys: ['events'], preserveSiteIdentity: true, verify: { migrate: async () => true, seed: async () => true, 'initialize-modules': async (context: any) => !context.managedInstallation && Boolean(siteName), 'bootstrap-admin': async () => true } });
    await applySetup({ ...plan, resources }, { steps: { 'verify-provider': { apply: vi.fn(), verify: async () => true }, 'write-manifest': simple('write-manifest'), 'write-config': simple('write-config'), seed: simple('seed'), 'initialize-modules': provider['initialize-modules'] } as any, stateStore: createStateStore(path) });
    expect(siteName).toBe('Imported Custom Church');
  });

  it('persists immutable origin without secrets and keeps it across hint and fingerprint changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-state-origin-')); const path = join(root, 'state.json');
    const first = fingerprintPlan({ version: 'a', secret: 'do-not-serialize' });
    const second = fingerprintPlan({ version: 'b' });
    const managed = createStateStore(path);
    await expect(managed.load(first, 'managed')).resolves.toBe('managed');
    expect(await readFile(path, 'utf8')).not.toContain('do-not-serialize');
    await expect(createStateStore(path).load(first, 'imported')).resolves.toBe('managed');
    await expect(createStateStore(path).load(second, 'imported')).resolves.toBe('managed');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 2, installationOrigin: 'managed', planFingerprint: second });

    const importedPath = join(root, 'imported.json');
    await expect(createStateStore(importedPath).load(first, 'imported')).resolves.toBe('imported');
    await expect(createStateStore(importedPath).load(second, 'managed')).resolves.toBe('imported');
  });

  it('reads strict v1 state and deterministically migrates it on the next mark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-state-v1-')); const path = join(root, 'state.json');
    const fingerprint = fingerprintPlan({ version: 'legacy' });
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, planFingerprint: fingerprint, completed: {} }, null, 2)}\n`);
    const store = createStateStore(path);
    await expect(store.load(fingerprint, 'imported')).resolves.toBe('imported');
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(1);
    await store.mark('migrate');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 2, installationOrigin: 'imported' });
    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, planFingerprint: fingerprint, completed: {}, extra: true })}\n`);
    await expect(createStateStore(path).load(fingerprint, 'managed')).rejects.toThrow(/corrupt|unsupported/i);
  });

  it('is versioned, resets completion on fingerprint change, clones evidence, and fails corrupt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-state-')); const path = join(root, 'state.json');
    const store = createStateStore(path);
    const firstFingerprint = fingerprintPlan({ version: 'a' });
    const secondFingerprint = fingerprintPlan({ version: 'b' });
    await store.load(firstFingerprint);
    const evidence: any = { d1DatabaseName: 'church-db', d1DatabaseId: 'safe', r2BucketName: 'church-media', hyperdriveId: null };
    await store.mark('ensure-resources', evidence); evidence.d1DatabaseId = 'changed';
    expect(JSON.parse(await readFile(path, 'utf8')).completed['ensure-resources'].evidence.d1DatabaseId).toBe('safe');
    await expect(store.mark('seed', { token: 'oops' })).rejects.toThrow(/evidence.*null/i);
    await expect(store.mark('seed', { value: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' })).rejects.toThrow(/evidence.*null/i);
    await store.load(secondFingerprint); expect(await store.has('migrate')).toBe(false);
    await writeFile(path, '{bad'); await expect(store.load(fingerprintPlan({ version: 'c' }))).rejects.toThrow(/state/i);
    expect(fingerprintPlan({ b: 2, a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses CAS and does not mark memory after a stale or failed write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-state-cas-')); const path = join(root, 'state.json');
    const a = createStateStore(path); const b = createStateStore(path); const fp = fingerprintPlan({ a: 1 });
    await a.load(fp); await b.load(fp);
    await a.mark('migrate', null);
    await expect(b.mark('seed', null)).rejects.toThrow(/expected content|concurrent/i);
    expect(await b.has('seed')).toBe(false);
    let writes = 0;
    const failing = createStateStore(join(root, 'fail.json'), { writeJsonAtomic: async () => { if (writes++ > 0) throw new Error('disk'); } });
    await failing.load(fp); await expect(failing.mark('seed', null)).rejects.toThrow('disk'); expect(await failing.has('seed')).toBe(false);
  });

  it('makes state unreadable after an atomic fingerprint rewrite fails', async () => {
    const fingerprint = fingerprintPlan({ version: 'first' });
    let content: string | null = null;
    let writes = 0;
    const store = createStateStore('/virtual/state.json', {
      readJson: async () => {
        if (content === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { value: JSON.parse(content), sourceContent: content };
      },
      writeJsonAtomic: async (_path, next) => { if (writes++ > 0) throw new Error('disk'); content = next; },
    });
    await store.load(fingerprint, 'managed');
    await expect(store.load(fingerprintPlan({ version: 'second' }), 'imported')).rejects.toThrow('disk');
    await expect(store.has('migrate')).rejects.toThrow(/must be loaded/i);
  });
});

describe('setup secrets', () => {
  it('writes local secrets atomically as 0600, preserves unrelated content, and never returns values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-secrets-')); const path = join(root, '.dev.vars');
    const existingSecret = 'existing-session-secret-with-at-least-32-chars';
    await writeFile(path, `# user\nOTHER=value\nSESSION_SECRET=${existingSecret}\n`, { mode: 0o600 });
    const result = await configureSecrets({ mode: 'local', adminEmail: ' Admin@Example.COM ', path });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('OTHER=value'); expect(text).toContain(`SESSION_SECRET=${existingSecret}`);
    expect(text).toContain('AUTH_DEV_BYPASS_EMAIL=admin@example.com');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(existingSecret);
  });

  it('writes a supplied test Stripe pair under runtime names without returning either value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-stripe-secrets-')); const path = join(root, '.dev.vars');
    await writeFile(path, 'OTHER=preserved\n', { mode: 0o644 });
    const stripeSecrets = { secretKey: 'sk_test_setup_local', webhookSecret: 'whsec_setup_local' };
    const result = await configureSecrets({ mode: 'local', adminEmail: 'admin@example.test', path, stripeSecrets });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('OTHER=preserved');
    expect(text).toContain('STRIPE_SECRET_KEY=sk_test_setup_local');
    expect(text).toContain('STRIPE_WEBHOOK_SECRET=whsec_setup_local');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain('sk_test_setup_local');
    expect(JSON.stringify(result)).not.toContain('whsec_setup_local');
  });

  it.each(['live', 'unexpected'])('removes reserved STRIPE_MODE=%s overrides while preserving unrelated local entries', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-stripe-mode-')); const path = join(root, '.dev.vars');
    await writeFile(path, `OTHER=preserved\nSTRIPE_MODE=${mode}\n`, { mode: 0o644 });
    await configureSecrets({
      mode: 'local', adminEmail: 'admin@example.test', path,
      stripeSecrets: { secretKey: 'sk_test_setup_local', webhookSecret: 'whsec_setup_local' },
    });
    const text = await readFile(path, 'utf8');
    expect(text).toContain('OTHER=preserved');
    expect(text).not.toMatch(/^STRIPE_MODE=/m);
    expect(text).toContain('STRIPE_SECRET_KEY=sk_test_setup_local');
    expect(text).toContain('STRIPE_WEBHOOK_SECRET=whsec_setup_local');
  });

  it('rejects partial, live, or unclassified Stripe values before local or remote mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-invalid-stripe-')); const path = join(root, '.dev.vars');
    const writer = vi.fn(); const runner = { run: vi.fn() };
    for (const stripeSecrets of [
      { secretKey: 'sk_test_partial' },
      { secretKey: 'sk_live_forbidden', webhookSecret: 'whsec_test' },
      { secretKey: 'unknown', webhookSecret: 'whsec_test' },
      { secretKey: 'sk_test_valid', webhookSecret: 'unknown' },
    ]) {
      await expect(configureSecrets({ mode: 'local', adminEmail: 'a@b.test', path, writeAtomic: writer, stripeSecrets } as any)).rejects.toThrow(/Stripe test|complete pair/i);
      await expect(configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', stripeSecrets } as any)).rejects.toThrow(/Stripe test|complete pair/i);
    }
    expect(writer).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('uses current Wrangler JSON format and puts missing secret over stdin', async () => {
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => { calls.push(args); return { stdout: calls.length === 1 ? '[]' : '', stderr: '', exitCode: 0 }; } };
    const result = await configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' });
    expect(calls[0][1]).toEqual(['secret', 'list', '--format', 'json', '--config', 'wrangler.jsonc']);
    expect(calls[1][1]).toEqual(['secret', 'put', 'SESSION_SECRET', '--config', 'wrangler.jsonc']);
    expect(calls[1][2].input).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(JSON.stringify(result)).not.toContain(calls[1][2].input.trim());
  });

  it('puts only missing Stripe test secrets over Wrangler stdin and scrubs ambient runtime Stripe values', async () => {
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => {
      calls.push(args);
      return { stdout: calls.length === 1 ? '[{"name":"SESSION_SECRET","type":"secret_text"},{"name":"STRIPE_SECRET_KEY","type":"secret_text"}]' : '', stderr: '', exitCode: 0 };
    } };
    const oldKey = process.env.STRIPE_SECRET_KEY; const oldWebhook = process.env.STRIPE_WEBHOOK_SECRET; const oldMode = process.env.STRIPE_MODE;
    process.env.STRIPE_SECRET_KEY = 'sk_live_ambient_forbidden'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ambient_forbidden'; process.env.STRIPE_MODE = 'live';
    try {
      const result = await configureSecrets({
        mode: 'deploy', adminEmail: 'a@b.test', runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc',
        stripeSecrets: { secretKey: 'sk_test_setup_deploy', webhookSecret: 'whsec_setup_deploy' },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1][1]).toEqual(['secret', 'put', 'STRIPE_WEBHOOK_SECRET', '--config', 'wrangler.jsonc']);
      expect(calls[1][2].input).toBe('whsec_setup_deploy\n');
      for (const call of calls) {
        expect(call[2].env).not.toHaveProperty('STRIPE_SECRET_KEY');
        expect(call[2].env).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
        expect(call[2].env).not.toHaveProperty('STRIPE_MODE');
        expect(call[2].env).not.toHaveProperty('CHURCH_SETUP_STRIPE_SECRET_KEY');
        expect(call[2].env).not.toHaveProperty('CHURCH_SETUP_STRIPE_WEBHOOK_SECRET');
      }
      expect(JSON.stringify(result)).not.toContain('whsec_setup_deploy');
    } finally {
      if (oldKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldKey;
      if (oldWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = oldWebhook;
      if (oldMode === undefined) delete process.env.STRIPE_MODE; else process.env.STRIPE_MODE = oldMode;
    }
  });

  it('normalizes only the exact Wrangler 4.107 fresh-worker stderr presentation', async () => {
    const fresh = '\u001b[31m✘ [ERROR]\u001b[0m Worker "new-site" not found.\n\n  If this is a new Worker, run `wrangler deploy` first to create it.\n  Otherwise, check that the Worker name is correct and you\'re logged into the right account.\n\n\u001b[90m🪵  Logs were written to "/tmp/wrangler.log"\u001b[0m';
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => { calls.push(args); return calls.length === 1 ? { stdout: '', stderr: fresh, exitCode: 1 } : { stdout: '', stderr: '', exitCode: 0 }; } };
    await configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' });
    expect(calls[0][2]).toMatchObject({ allowNonzero: true });
    expect(calls[0][2].env).toEqual(expect.objectContaining({ WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' }));
    expect(calls[1][2].env).toEqual(expect.objectContaining({ WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' }));
    expect(calls).toHaveLength(2);
    const denied = { run: async () => ({ stdout: '', stderr: 'Authentication error [code: 10000]', exitCode: 1 }) };
    await expect(configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner: denied, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' })).rejects.toThrow(/secret list failed/i);
    for (const nearMiss of [
      fresh.replace('run `wrangler deploy` first', 'deploy it first'),
      `${fresh}\nAuthentication error [code: 10000]`,
      fresh.replace('🪵  Logs were written to', 'unexpected trailer'),
      fresh.replace('\u001b[31m', '\u001b]0;unsafe\u0007'),
    ]) {
      const bad = { run: async () => ({ stdout: '', stderr: nearMiss, exitCode: 1 }) };
      await expect(configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner: bad, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' })).rejects.toThrow(/secret list failed/i);
    }
  });

  it('passes the originally read .dev.vars bytes as expectedContent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-secret-cas-')); const path = join(root, '.dev.vars');
    await writeFile(path, '# owned\n');
    const writer = vi.fn(async (_path, _content, options) => { expect(options.expectedContent).toBe('# owned\n'); throw new Error('concurrent'); });
    await expect(configureSecrets({ mode: 'local', adminEmail: 'a@b.test', path, writeAtomic: writer })).rejects.toThrow('concurrent');
  });
});
