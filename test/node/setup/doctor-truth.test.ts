import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { buildServicePresence, effectiveStripeTestMode } from '../../../scripts/setup/index.mjs';
import { checkServices } from '../../../scripts/setup/checks/services.mjs';
import { runDoctor } from '../../../scripts/setup/doctor.mjs';
import { probeDeployResourcePresence } from '../../../scripts/setup/probes.mjs';
import { readLocalSecretNames, readLocalStripeModeOverride } from '../../../scripts/setup/secrets.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const supabaseManifest = {
  mode: 'local', database: 'supabase', modules: [...catalog.presets['full-church'].modules],
  site: { slug: 'church', emailFrom: 'serve@church.invalid' },
  resources: { r2BucketName: 'church-media', hyperdriveId: 'local', d1DatabaseName: null, d1DatabaseId: null },
} as const;

const hyperdriveTable = [
  '📋 Listing Hyperdrive configs',
  '┌────┬──────┬──────┬──────┬──────┬────────┬──────────┬─────────┬──────┬─────────────────────────┐',
  '│ id │ name │ user │ host │ port │ scheme │ database │ caching │ mtls │ origin_connection_limit │',
  '├────┼──────┼──────┼──────┼──────┼────────┼──────────┼─────────┼──────┼─────────────────────────┤',
  '│ hd-id │ church-db │ u │ h │ 5432 │ Postgres │ db │ x │ {} │ 1 │',
  '└────┴──────┴──────┴──────┴──────┴────────┴──────────┴─────────┴──────┴─────────────────────────┘',
].join('\n');

describe('doctor service truth', () => {
  it('reads only local .dev.vars key names and never returns secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-vars-')); roots.push(root);
    const path = join(root, '.dev.vars');
    const secret = 'sk_test_private-value-that-must-not-escape';
    await writeFile(path, `# local only\nSESSION_SECRET=${'x'.repeat(32)}\nSTRIPE_SECRET_KEY=${secret}\nSTRIPE_WEBHOOK_SECRET=   \n`);
    const names = await readLocalSecretNames(path);
    expect(names).toEqual(['SESSION_SECRET', 'STRIPE_SECRET_KEY']);
    expect(JSON.stringify(names)).not.toContain(secret);

    await writeFile(path, `STRIPE_SECRET_KEY=${secret}\nSTRIPE_SECRET_KEY=duplicate\n`);
    await expect(readLocalSecretNames(path)).rejects.toThrow(/^Local secret names could not be read safely$/);
    try { await readLocalSecretNames(path); } catch (error) { expect(String(error)).not.toContain(secret); }
  });

  it('derives exact absent, partial, and complete local Stripe states from .dev.vars names, never host env', async () => {
    const states = [
      { names: [], classification: 'missing', code: 'services.stripe-absent', severity: 'warning' },
      { names: ['STRIPE_SECRET_KEY'], classification: 'unknown', code: 'services.stripe-partial', severity: 'error' },
      { names: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], classification: 'test', code: 'services.stripe-ok', severity: 'info' },
    ] as const;
    for (const state of states) {
      const names = new Set<string>(state.names);
      const presence = await buildServicePresence(supabaseManifest, {
        hostEnv: { STRIPE_SECRET_KEY: 'host-only', STRIPE_WEBHOOK_SECRET: 'host-only' },
        localSecretNames: state.names,
        localStripeClassification: { classification: state.classification, secretKey: names.has('STRIPE_SECRET_KEY'), webhookSecret: names.has('STRIPE_WEBHOOK_SECRET') },
        stripeModeTest: true,
        localSecretsValid: true,
        localSupabaseUrlAvailable: true,
      });
      const checks = await checkServices({ catalog, manifest: supabaseManifest, presence });
      expect(checks).toContainEqual(expect.objectContaining({ code: state.code, severity: state.severity }));
    }
  });

  it.each(['live', 'unexpected'])('does not report ready when local STRIPE_MODE=%s overrides generated test mode', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-stripe-mode-')); roots.push(root);
    const path = join(root, '.dev.vars');
    await writeFile(path, `STRIPE_SECRET_KEY=sk_test_local\nSTRIPE_WEBHOOK_SECRET=whsec_local\nSTRIPE_MODE=${mode}\n`);
    const override = await readLocalStripeModeOverride(path);
    const presence = await buildServicePresence(supabaseManifest, {
      hostEnv: {}, localSecretNames: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
      localStripeClassification: { classification: 'test', secretKey: true, webhookSecret: true },
      stripeModeTest: effectiveStripeTestMode('{ "vars": { "STRIPE_MODE": "test" } }', override),
      localSecretsValid: true, localSupabaseUrlAvailable: true,
    });
    const doctor = await runDoctor({
      checkManifest: () => [], checkConfig: () => [], checkDatabase: () => [],
      checkServices: () => checkServices({ catalog, manifest: supabaseManifest, presence }),
    });
    expect(doctor.status).toBe('not-ready');
    expect(doctor.exitCode).toBe(1);
    expect(doctor.checks).toContainEqual(expect.objectContaining({
      code: 'services.stripe-mode', severity: 'error',
      message: expect.stringMatching(/effective runtime mode.*not test/i),
      remediation: expect.stringMatching(/remove local STRIPE_MODE overrides/i),
    }));
    expect(doctor.checks).not.toContainEqual(expect.objectContaining({ code: 'services.stripe-ok' }));
    expect(JSON.stringify(doctor)).not.toContain(`STRIPE_MODE=${mode}`);
  });

  it('keeps deploy Worker, R2, and D1 probes independent when one fails', async () => {
    const calls: string[] = [];
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'deployments') return { stdout: '', stderr: 'worker unavailable', exitCode: 1 };
      if (args[0] === 'r2') return { stdout: JSON.stringify({ name: 'church-media' }), stderr: '', exitCode: 0 };
      if (args[0] === 'd1') return { stdout: JSON.stringify([{ name: 'church-db', uuid: 'd1-id' }]), stderr: '', exitCode: 0 };
      throw new Error('unexpected probe');
    }) };
    const manifest = {
      mode: 'deploy', database: 'd1', modules: ['events'], site: { slug: 'church' },
      resources: { r2BucketName: 'church-media', d1DatabaseName: 'church-db', d1DatabaseId: 'd1-id', hyperdriveId: null },
    } as const;
    await expect(probeDeployResourcePresence({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', manifest }))
      .resolves.toEqual({ worker: false, r2: true, d1: true, hyperdrive: false });
    expect(calls).toEqual(['deployments status', 'r2 bucket', 'd1 list']);
  });

  it('keeps deploy Hyperdrive probing independent from Worker and R2 failures', async () => {
    const calls: string[] = [];
    const runner = { run: vi.fn(async (_file: string, args: string[]) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'deployments') return { stdout: JSON.stringify({ id: 'dep', created_on: '2026-07-13T00:00:00Z', versions: [{ version_id: 'v', percentage: 100 }] }), stderr: '', exitCode: 0 };
      if (args[0] === 'r2') return { stdout: '', stderr: 'bucket unavailable', exitCode: 1 };
      if (args[0] === 'hyperdrive') return { stdout: hyperdriveTable, stderr: '', exitCode: 0 };
      throw new Error('unexpected probe');
    }) };
    const manifest = { ...supabaseManifest, mode: 'deploy', resources: { ...supabaseManifest.resources, hyperdriveId: 'hd-id' } } as const;
    await expect(probeDeployResourcePresence({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', manifest }))
      .resolves.toEqual({ worker: true, r2: false, d1: false, hyperdrive: true });
    expect(calls).toEqual(['deployments status', 'r2 bucket', 'hyperdrive list']);
  });
});
