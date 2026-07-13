import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanWorkspace, workspaceHash } from './fixtures';

const flags = [
  '--mode', 'local', '--preset', 'website', '--site-slug', 'clean-church',
  '--church-name', 'Clean Church', '--locale', 'en',
  '--admin-email', 'admin@clean.invalid', '--admin-name', 'Clean Admin',
  '--app-origin', 'http://127.0.0.1:4321', '--email-from', 'serve@clean.invalid',
];

describe('setup clean-room dry run', () => {
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
