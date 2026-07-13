import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import raw from '../../../config/capabilities.json';
import { buildHandoff, buildServicePresence, inspectExistingInstallation, readMaskedInput, resolveDoctorDatabaseUrl } from '../../../scripts/setup/index.mjs';
import { probeDeployResources, probeR2Object, parseWorkerDeployments } from '../../../scripts/setup/probes.mjs';
import { hasDeploySecret } from '../../../scripts/setup/secrets.mjs';
import { verifyCanonicalDemoSeed, verifyMigrationCompleteness } from '../../../scripts/setup/verification.mjs';
import { verifyMediaPlan } from '../../../scripts/setup/media.mjs';
import { checkServices } from '../../../scripts/setup/checks/services.mjs';
import { ALWAYS_REQUIRED_TABLES, TABLES_BY_CAPABILITY } from '../../../scripts/setup/checks/database.mjs';
import { verifyLocalSecretsContent } from '../../../scripts/setup/secrets.mjs';
import { SETUP_HELP } from '../../../scripts/setup/args.mjs';
import { redact } from '../../../scripts/setup/redact.mjs';
import { resolveLocalPersistence } from '../../../scripts/setup/persistence.mjs';

function statementDb(rows: Record<string, any>) {
  return { prepare(sql: string) { return { bind() { return this; }, async first() { return rows[sql] ?? null; }, async all() { return { success: true, meta: {}, results: rows[sql] ?? [] }; } }; } };
}

describe('runtime setup hardening', () => {
  it('resolves a validated workspace-local Wrangler persistence override', () => {
    expect(resolveLocalPersistence('/repo', {})).toBe('/repo/.wrangler/state');
    expect(resolveLocalPersistence('/repo', { WRANGLER_PERSIST_TO: '.test/state' })).toBe('/repo/.test/state');
    for (const value of ['', ' ', '../escape', '/tmp/escape', '--remote', 'bad\npath']) {
      expect(() => resolveLocalPersistence('/repo', { WRANGLER_PERSIST_TO: value })).toThrow(/WRANGLER_PERSIST_TO/i);
    }
  });
  it('strictly parses a nonempty Worker deployment list', () => {
    expect(parseWorkerDeployments(JSON.stringify([{ id: 'dep', created_on: '2026-01-01T00:00:00Z', versions: [{ version_id: 'v1', percentage: 100 }] }]))).toHaveLength(1);
    for (const invalid of ['{}', '[]', '[{"id":"dep"}]', 'not-json']) expect(() => parseWorkerDeployments(invalid)).toThrow();
  });

  it('probes deploy Worker, R2, D1 or Hyperdrive and fails closed on mismatches', async () => {
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'deployments') return { stdout: JSON.stringify({ id: 'dep', created_on: '2026-01-01T00:00:00Z', versions: [{ version_id: 'v', percentage: 100 }] }), stderr: '', exitCode: 0 };
      if (args[0] === 'r2') return { stdout: JSON.stringify({ name: 'church-media' }), stderr: '', exitCode: 0 };
      if (args[0] === 'd1') return { stdout: JSON.stringify([{ name: 'church-db', uuid: 'd1-id' }]), stderr: '', exitCode: 0 };
      throw new Error('unexpected');
    }) };
    await expect(probeDeployResources({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', manifest: { site: { slug: 'church' }, database: 'd1', resources: { d1DatabaseName: 'church-db', d1DatabaseId: 'd1-id', r2BucketName: 'church-media', hyperdriveId: null } } as any }))
      .resolves.toEqual({ worker: true, r2: true, d1: true, hyperdrive: false });
    runner.run.mockImplementationOnce(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    await expect(probeDeployResources({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', manifest: { site: { slug: 'church' }, database: 'd1', resources: { d1DatabaseName: 'church-db', d1DatabaseId: 'd1-id', r2BucketName: 'church-media', hyperdriveId: null } } as any })).rejects.toThrow(/deployment/i);
  });

  it('checks SESSION_SECRET remotely and R2 objects without logging object bytes', async () => {
    const secretRunner = { run: vi.fn(async () => ({ stdout: '[{"name":"SESSION_SECRET","type":"secret_text"}]', stderr: '', exitCode: 0 })) };
    await expect(hasDeploySecret({ runner: secretRunner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', name: 'SESSION_SECRET' })).resolves.toBe(true);
    const objectRunner = { run: vi.fn(async (_file: string, _args: string[]) => ({ stdout: 'binary bytes', stderr: '', exitCode: 0 })) };
    await expect(probeR2Object({ runner: objectRunner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', bucket: 'media', key: 'uploads/a.webp', mode: 'local' })).resolves.toBe(true);
    expect(objectRunner.run.mock.calls[0][1]).toContain('--pipe');
  });

  it('reports configured deploy email as unverified instead of live available', async () => {
    const findings = await checkServices({
      catalog: raw,
      manifest: { mode: 'deploy', database: 'd1', modules: ['events'] },
      presence: { worker: true, r2: true, hyperdrive: false, email: false, emailConfigured: true, emailDevLog: false, stripeSecretKey: false, stripeWebhookSecret: false, backup: false },
    } as any);
    expect(findings).toContainEqual(expect.objectContaining({ code: 'services.email-unverified', severity: 'warning' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ code: 'services.email-ok' }));
  });

  it('requires multiple canonical demo sentinels, not an unrelated admin email', async () => {
    const complete = statementDb({
      'SELECT COUNT(*) AS count FROM people': { count: 10 },
      'SELECT email, display_name, role FROM people WHERE id=?': { email: 'admin@example.com', display_name: 'Alex Admin', role: 'admin' },
      'SELECT slug FROM ministries WHERE id=?': { slug: 'av-tech' },
      'SELECT COUNT(*) AS count FROM sermons': { count: 5 },
    });
    await expect(verifyCanonicalDemoSeed(complete as any)).resolves.toBe(true);
    const unrelated = statementDb({
      'SELECT COUNT(*) AS count FROM people': { count: 1 },
      'SELECT email, display_name, role FROM people WHERE id=?': { email: 'admin@example.com', display_name: 'Someone', role: 'admin' },
      'SELECT slug FROM ministries WHERE id=?': null,
      'SELECT COUNT(*) AS count FROM sermons': { count: 0 },
    });
    await expect(verifyCanonicalDemoSeed(unrelated as any)).resolves.toBe(false);
  });

  it('detects a missing later migration table', async () => {
    const tables = ['people', 'settings', 'tokens', 'media'];
    const db = statementDb({ "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name": tables.map((name) => ({ name })) });
    await expect(verifyMigrationCompleteness({ db: db as any, backend: 'd1', catalog: raw, root: process.cwd() })).resolves.toBe(false);
  });

  it('requires exact D1 migration history even when all final tables exist', async () => {
    const tables = [...new Set([...ALWAYS_REQUIRED_TABLES, ...Object.values(TABLES_BY_CAPABILITY).flat()])].map((name) => ({ name }));
    const migrations = (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort();
    const sqlTables = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
    const sqlHistory = 'SELECT name FROM d1_migrations ORDER BY id';
    const complete = statementDb({ [sqlTables]: tables, [sqlHistory]: migrations.map((name) => ({ name })) });
    await expect(verifyMigrationCompleteness({ db: complete as any, backend: 'd1', catalog: raw, root: process.cwd() })).resolves.toBe(true);
    const partial = statementDb({ [sqlTables]: tables, [sqlHistory]: migrations.slice(0, -1).map((name) => ({ name })) });
    await expect(verifyMigrationCompleteness({ db: partial as any, backend: 'd1', catalog: raw, root: process.cwd() })).resolves.toBe(false);
  });

  it('verifies every media DB reference and object, detecting deletion', async () => {
    const plan: any = { assets: [{ key: 'uploads/a.webp', file: 'a.webp', contentType: 'image/webp', size: 1, target: { type: 'setting', key: 'site.hero' } }], uploadedBy: 'a@b.test' };
    const db = statementDb({
      'SELECT r2_key, filename, content_type, size, uploaded_by FROM media WHERE r2_key=?': { r2_key: 'uploads/a.webp', filename: 'a.webp', content_type: 'image/webp', size: 1, uploaded_by: 'a@b.test' },
      'SELECT value FROM settings WHERE key=?': { value: 'uploads/a.webp' },
    });
    await expect(verifyMediaPlan({ mediaPlan: plan, db: db as any, objectExists: async () => true })).resolves.toBe(true);
    await expect(verifyMediaPlan({ mediaPlan: plan, db: db as any, objectExists: async () => false })).resolves.toBe(false);
    await expect(verifyMediaPlan({ mediaPlan: plan, db: statementDb({}) as any, objectExists: async () => true })).resolves.toBe(false);
  });

  it('drops mode-specific resource placeholders across local/deploy transitions', () => {
    const cases = [
      { mode: 'local', database: 'd1', resources: { d1DatabaseName: 'x-db', d1DatabaseId: 'local', r2BucketName: 'x-media', hyperdriveId: null } },
      { mode: 'deploy', database: 'd1', resources: { d1DatabaseName: 'x-db', d1DatabaseId: 'remote-d1', r2BucketName: 'x-media', hyperdriveId: null } },
      { mode: 'local', database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'x-media', hyperdriveId: 'local' } },
      { mode: 'deploy', database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'x-media', hyperdriveId: 'remote-hd' } },
    ];
    for (const manifest of cases) {
      expect(inspectExistingInstallation(manifest as any, manifest.mode)).toHaveProperty('resources');
      expect(inspectExistingInstallation(manifest as any, manifest.mode === 'local' ? 'deploy' : 'local')).not.toHaveProperty('resources');
    }
  });

  it('keeps deploy Supabase argv consent required after a local-to-deploy mode transition', async () => {
    const localManifest = { mode: 'local', database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'x-media', hyperdriveId: 'local' } };
    const inspectExisting = vi.fn(async ({ requestedMode }: any) => inspectExistingInstallation(localManifest as any, requestedMode));
    const deps: any = {
      catalog: raw, interactive: false, output: vi.fn(), inspectExisting, formatPlan: vi.fn(), formatResult: vi.fn(),
      confirm: vi.fn(), collectSupabaseSecret: vi.fn(), apply: vi.fn(),
    };
    const argv = ['--mode', 'deploy', '--preset', 'full-church', '--site-slug', 'x', '--church-name', 'X', '--locale', 'en', '--admin-name', 'Admin', '--admin-email', 'admin@example.test', '--app-origin', 'https://x.example.test', '--email-from', 'serve@x.example.test', '--yes'];
    const { runSetup } = await import('../../../scripts/setup/index.mjs');
    await expect(runSetup(argv, deps)).rejects.toThrow(/allow-hyperdrive-secret-in-argv/);
    expect(deps.collectSupabaseSecret).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('masked input rejects on end and restores terminal state without echo', async () => {
    class Input extends EventEmitter { isTTY = true; isRaw = false; paused = true; setRawMode = vi.fn((raw: boolean) => { this.isRaw = raw; }); resume = vi.fn(() => { this.paused = false; }); pause = vi.fn(() => { this.paused = true; }); isPaused() { return this.paused; } }
    const input = new Input();
    const output = { isTTY: true, write: vi.fn() };
    const pending = readMaskedInput(input as any, output as any, 'Secret');
    input.emit('end');
    await expect(pending).rejects.toThrow(/ended/i);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(output.write).toHaveBeenCalledTimes(1);
  });

  it('strictly verifies local managed secrets and exact admin identity', () => {
    const strong = 'x'.repeat(32);
    expect(verifyLocalSecretsContent(`SESSION_SECRET=${strong}\nEMAIL_DEV_LOG=1\nAUTH_DEV_BYPASS_EMAIL=admin@example.test\n`, 'admin@example.test')).toBe(true);
    expect(verifyLocalSecretsContent(`SESSION_SECRET=weak\nEMAIL_DEV_LOG=1\nAUTH_DEV_BYPASS_EMAIL=admin@example.test\n`, 'admin@example.test')).toBe(false);
    expect(verifyLocalSecretsContent(`SESSION_SECRET=${strong}\nEMAIL_DEV_LOG=0\nAUTH_DEV_BYPASS_EMAIL=admin@example.test\n`, 'admin@example.test')).toBe(false);
    expect(verifyLocalSecretsContent(`SESSION_SECRET=${strong}\nEMAIL_DEV_LOG=1\nAUTH_DEV_BYPASS_EMAIL=other@example.test\n`, 'admin@example.test')).toBe(false);
    expect(verifyLocalSecretsContent(`SESSION_SECRET=${strong}\nEMAIL_DEV_LOG=1\nAUTH_DEV_BYPASS_EMAIL=other@example.test\n`)).toBe(true);
  });

  it('requires a real local Supabase connection source and returns a nonsecret handoff reference', async () => {
    const manifest: any = { mode: 'local', database: 'supabase', resources: { r2BucketName: 'x-media', hyperdriveId: 'local' } };
    expect((await buildServicePresence(manifest, { hostEnv: {}, localSecretsValid: true })).hyperdrive).toBe(false);
    expect((await buildServicePresence(manifest, { hostEnv: { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: 'postgres://secret' }, localSecretsValid: true })).hyperdrive).toBe(true);
    const handoff = buildHandoff({ mode: 'local', backend: 'supabase', site: { appOrigin: 'http://localhost:4321' }, adminEmail: 'admin@example.test', modules: ['portal'] } as any, { checks: [] } as any, { supabaseSecretSource: 'environment' });
    expect(handoff.startCommand).toBe('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$SUPABASE_DB_URL" npm run dev');
    expect(JSON.stringify(handoff)).not.toContain('postgres://secret');
    const masked = buildHandoff({ mode: 'local', backend: 'supabase', site: { appOrigin: 'http://localhost:4321' }, adminEmail: 'admin@example.test', modules: ['portal'] } as any, { checks: [] } as any, { supabaseSecretSource: 'masked' });
    expect(masked.startCommand).toContain('read -s SUPABASE_DB_URL');
    expect(masked.startCommand).toContain('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$SUPABASE_DB_URL"');
    expect(JSON.stringify(masked)).not.toContain('postgres://');
  });

  it('uses remote Stripe secret metadata for deploy and host env only for local', async () => {
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'secret') return { stdout: '[{"name":"STRIPE_SECRET_KEY","type":"secret_text"},{"name":"STRIPE_WEBHOOK_SECRET","type":"secret_text"}]', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'probe unavailable', exitCode: 1 };
    }) };
    const deploy: any = { mode: 'deploy', database: 'd1', site: { slug: 'x' }, resources: { r2BucketName: 'x-media', d1DatabaseName: 'x-db', d1DatabaseId: 'id' } };
    const remote = await buildServicePresence(deploy, { runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', hostEnv: {} });
    expect(remote.stripeSecretKey).toBe(true); expect(remote.stripeWebhookSecret).toBe(true);
    const local = await buildServicePresence({ ...deploy, mode: 'local' }, { hostEnv: { STRIPE_SECRET_KEY: 'local' }, localSecretsValid: false });
    expect(local.stripeSecretKey).toBe(true); expect(local.stripeWebhookSecret).toBe(false);
  });

  it('documents both banner-free JSON invocations', () => {
    expect(SETUP_HELP).toContain('node scripts/setup/index.mjs [options] --json');
    expect(SETUP_HELP).toContain('npm run --silent setup -- [options] --json');
  });

  it('resolves the canonical local Hyperdrive URL for doctor and keeps it redactable', () => {
    const canonical = 'postgres://doctor:secret@db.example.test/church';
    expect(resolveDoctorDatabaseUrl({ mode: 'local', database: 'supabase' } as any, { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: canonical })).toBe(canonical);
    expect(resolveDoctorDatabaseUrl({ mode: 'local', database: 'supabase' } as any, { SUPABASE_DB_URL: 'postgres://preferred:secret@db.example.test/church', CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: canonical })).toContain('preferred');
    expect(resolveDoctorDatabaseUrl({ mode: 'deploy', database: 'supabase' } as any, { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: canonical })).toBeUndefined();
    expect(JSON.stringify(redact({ message: `failed ${canonical}` }, [canonical]))).not.toContain(canonical);
  });
});
