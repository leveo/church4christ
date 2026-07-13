import { access, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupAll, createCleanWorkspace, execWorkspace, spawnWorkspace, stopChild, waitForHttp, workspaceHash } from './fixtures';

const flags = [
  '--mode', 'local', '--preset', 'website', '--site-slug', 'clean-church',
  '--church-name', 'Clean Church', '--locale', 'en',
  '--admin-email', 'admin@clean.invalid', '--admin-name', 'Clean Admin',
  '--app-origin', 'http://127.0.0.1:4321', '--email-from', 'serve@clean.invalid',
];

describe('setup clean-room dry run', () => {
  it('waits for disposable child termination and remains safe when stopped twice', async () => {
    const workspace = await createCleanWorkspace();
    const child = spawnWorkspace(workspace.root, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolveDone) => child.once('spawn', resolveDone));
    await stopChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(stopChild(child)).resolves.toBeUndefined();
  });

  it('surfaces spawn errors, scrubs ambient secrets, and runs every cleanup', async () => {
    const workspace = await createCleanWorkspace();
    const ambient = ['STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN', 'SESSION_SECRET'] as const;
    const old = Object.fromEntries(ambient.map((key) => [key, process.env[key]]));
    for (const key of ambient) process.env[key] = `ambient-${key}`;
    try {
      const result = await execWorkspace(workspace.root, process.execPath, ['-e', `process.stdout.write(JSON.stringify([${ambient.map((key) => `process.env.${key}`).join(',')}]))`]);
      expect(JSON.parse(result.stdout)).toEqual([null, null, null]);
    } finally { for (const key of ambient) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
    const missing = spawnWorkspace(workspace.root, join(workspace.root, 'missing-command'), []);
    await expect(waitForHttp('http://127.0.0.1:1', missing, () => '')).rejects.toThrow(/failed to spawn|ENOENT/i);
    await stopChild(missing);
    const calls: string[] = [];
    const failures = await cleanupAll([
      async () => { calls.push('first'); throw new Error('cleanup one'); },
      async () => { calls.push('second'); },
    ], new Error('primary'));
    expect(calls).toEqual(['first', 'second']); expect(failures).toHaveLength(1);
  });

  it('hashes symlink identity, target changes, and deletion without following targets', async () => {
    const workspace = await createCleanWorkspace();
    const initial = await workspaceHash(workspace.root);
    await rm(join(workspace.root, 'node_modules'));
    await symlink(join(workspace.root, 'scripts'), join(workspace.root, 'node_modules'), 'dir');
    const retargeted = await workspaceHash(workspace.root);
    expect(retargeted).not.toBe(initial);
    await rm(join(workspace.root, 'node_modules'));
    expect(await workspaceHash(workspace.root)).not.toBe(retargeted);
  });

  it('selects D1 without mutating one byte or path', async () => {
    const workspace = await createCleanWorkspace();
    const before = await workspaceHash(workspace.root);
    const wranglerBefore = await readFile(join(workspace.root, 'wrangler.jsonc'));

    const { stdout } = await workspace.execNode([...flags, '--yes', '--dry-run', '--json']);

    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      kind: 'setup-plan',
      plan: { backend: 'd1', modules: expect.any(Array) },
    });
    expect(await workspaceHash(workspace.root)).toBe(before);
    expect(await readFile(join(workspace.root, 'wrangler.jsonc'))).toEqual(wranglerBefore);
    for (const generated of ['.church', 'church.config.json', '.dev.vars']) {
      await expect(access(join(workspace.root, generated))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 180_000);

  it('does not collect or serialize one-shot Stripe values during a Supabase dry run', async () => {
    const workspace = await createCleanWorkspace();
    const before = await workspaceHash(workspace.root);
    const secretKey = 'sk_test_dry_run_must_not_serialize';
    const webhookSecret = 'whsec_dry_run_must_not_serialize';
    const { stdout, stderr } = await workspace.execNode([
      '--mode', 'local', '--preset', 'full-church', '--site-slug', 'dry-pg',
      '--church-name', 'Dry PG', '--locale', 'en', '--admin-email', 'admin@dry.invalid',
      '--admin-name', 'Dry Admin', '--dry-run', '--json',
    ], { CHURCH_SETUP_STRIPE_SECRET_KEY: secretKey, CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: webhookSecret });
    expect(JSON.parse(stdout)).toMatchObject({ kind: 'setup-plan', plan: { backend: 'supabase' } });
    expect(`${stdout}\n${stderr}`).not.toContain(secretKey);
    expect(`${stdout}\n${stderr}`).not.toContain(webhookSecret);
    expect(await workspaceHash(workspace.root)).toBe(before);
  }, 180_000);
});
