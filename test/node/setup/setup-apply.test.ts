import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applySetup, createD1Steps, createSupabaseSteps } from '../../../scripts/setup/apply.mjs';
import { createStateStore, fingerprintPlan } from '../../../scripts/setup/state.mjs';
import { configureSecrets } from '../../../scripts/setup/secrets.mjs';

const ORDER = ['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor'];

function memoryStore() {
  const completed = new Set<string>();
  return { completed, async load() {}, async has(name: string) { return completed.has(name); }, async mark(name: string) { completed.add(name); } };
}

describe('setup apply coordinator', () => {
  it('applies in canonical order and verifies persisted completions as no-ops', async () => {
    const calls: string[] = [];
    const steps = Object.fromEntries(ORDER.map((name) => [name, { apply: async (context: any) => { calls.push(name); return name === 'ensure-resources' ? { changed: true, resolvedResources: { d1DatabaseId: 'id' } } : { changed: true, saw: context.plan.resources }; }, verify: async () => true }]));
    const stateStore = memoryStore();
    const plan = Object.freeze({ actions: [...ORDER], planVersion: 1 });
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
});

describe('setup state', () => {
  it('is versioned, resets completion on fingerprint change, clones evidence, and fails corrupt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-state-')); const path = join(root, 'state.json');
    const store = createStateStore(path);
    const firstFingerprint = fingerprintPlan({ version: 'a' });
    const secondFingerprint = fingerprintPlan({ version: 'b' });
    await store.load(firstFingerprint);
    const evidence: any = { id: 'safe' }; await store.mark('migrate', evidence); evidence.id = 'changed';
    expect(JSON.parse(await readFile(path, 'utf8')).completed.migrate.evidence.id).toBe('safe');
    await store.load(secondFingerprint); expect(await store.has('migrate')).toBe(false);
    await writeFile(path, '{bad'); await expect(store.load(fingerprintPlan({ version: 'c' }))).rejects.toThrow(/state/i);
    expect(fingerprintPlan({ b: 2, a: 1 })).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.mark('seed', { token: 'oops' })).rejects.toThrow(/secret/i);
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
});
