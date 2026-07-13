import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applySetup, createD1Steps, createResourceStep, createSupabaseSteps } from '../../../scripts/setup/apply.mjs';
import { createStateStore, fingerprintPlan } from '../../../scripts/setup/state.mjs';
import { configureSecrets } from '../../../scripts/setup/secrets.mjs';

const ORDER = ['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor'];

function memoryStore() {
  const completed = new Set<string>();
  const evidence = new Map<string, unknown>();
  return { completed, async load() {}, async has(name: string) { return completed.has(name); }, async getEvidence(name: string) { return evidence.get(name) ?? null; }, async mark(name: string, value: unknown) { completed.add(name); evidence.set(name, value); } };
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
    }, stateStore: { async load() {}, async has() { return false; }, mark }, dryRun: false })).rejects.toThrow(/did not verify/i);
    expect(mark).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });

  it('requires exact true verification and resource evidence access', async () => {
    const state: any = { async load() {}, async has() { return true; }, async mark() {} };
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
    const failing = createStateStore(join(root, 'fail.json'), { writeJsonAtomic: async () => { throw new Error('disk'); } });
    await failing.load(fp); await expect(failing.mark('seed', null)).rejects.toThrow('disk'); expect(await failing.has('seed')).toBe(false);
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

  it('uses current Wrangler JSON format and puts missing secret over stdin', async () => {
    const calls: any[] = [];
    const runner = { run: async (...args: any[]) => { calls.push(args); return { stdout: calls.length === 1 ? '[]' : '', stderr: '', exitCode: 0 }; } };
    const result = await configureSecrets({ mode: 'deploy', adminEmail: 'a@b.test', runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' });
    expect(calls[0][1]).toEqual(['secret', 'list', '--format', 'json', '--config', 'wrangler.jsonc']);
    expect(calls[1][1]).toEqual(['secret', 'put', 'SESSION_SECRET', '--config', 'wrangler.jsonc']);
    expect(calls[1][2].input).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(JSON.stringify(result)).not.toContain(calls[1][2].input.trim());
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
