import { access, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanWorkspace, spawnWorkspace, stopChild, workspaceHash } from './fixtures';

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

  it('hashes symlink identity, target changes, and deletion without following targets', async () => {
    const workspace = await createCleanWorkspace();
    const initial = await workspaceHash(workspace.root);
    await mkdir(join(workspace.root, 'alternate-modules'));
    await rm(join(workspace.root, 'node_modules'));
    await symlink(join(workspace.root, 'alternate-modules'), join(workspace.root, 'node_modules'), 'dir');
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
});
