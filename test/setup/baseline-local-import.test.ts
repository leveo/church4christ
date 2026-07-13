import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanWorkspace, execWorkspace, workspaceHash } from './fixtures';

const flags = [
  '--mode', 'local', '--preset', 'website', '--site-slug', 'church4christ',
  '--church-name', 'Church4Christ', '--locale', 'en',
  '--admin-email', 'admin@example.com', '--admin-name', 'Alex Admin',
  '--app-origin', 'http://localhost:4321', '--email-from', 'serve@church4christ.invalid',
];

describe('baseline local D1 import', () => {
  it('inspects a clone, preserves the binding identity, and keeps using the same database', async () => {
    const workspace = await createCleanWorkspace();
    const persistTo = join(workspace.root, '.legacy-state');
    const env = { WRANGLER_PERSIST_TO: '.legacy-state' };
    const wrangler = join(workspace.root, 'node_modules/.bin/wrangler');
    const config = join(workspace.root, 'wrangler.jsonc');
    await execWorkspace(workspace.root, wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', config]);
    await execWorkspace(workspace.root, wrangler, ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', config, '--file', join(workspace.root, 'seed/dev-seed.sql'), '--yes']);

    const beforeInspection = await workspaceHash(persistTo);
    const dryRun = JSON.parse((await workspace.execNode([...flags, '--dry-run', '--json'], env, 300_000)).stdout);
    expect(dryRun.plan.existingInstallation).toMatchObject({ backend: 'd1', mode: 'local', adminEmail: 'admin@example.com' });
    expect(await workspaceHash(persistTo)).toBe(beforeInspection);

    const first = JSON.parse((await workspace.execNode([...flags, '--yes', '--json'], env, 300_000)).stdout);
    expect(first.doctor.status).toBe('ready');
    const generated = await readFile(config, 'utf8');
    expect(generated).toContain('"database_id": "YOUR_D1_DATABASE_ID"');
    const query = await execWorkspace(workspace.root, wrangler, [
      'd1', 'execute', 'DB', '--local', '--json', '--persist-to', persistTo, '--config', config,
      '--command', "SELECT value AS site_name FROM settings WHERE key='site.name.en'; SELECT role FROM people WHERE email='admin@example.com';",
    ]);
    const rows = JSON.parse(query.stdout);
    expect(rows[0].results[0]).toEqual({ site_name: 'Church4Christ' });
    expect(rows[1].results[0]).toEqual({ role: 'admin' });

    const second = JSON.parse((await workspace.execNode([...flags, '--yes', '--json'], env, 300_000)).stdout);
    expect(second.doctor.status).toBe('ready');
    expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
  }, 600_000);

  it('ignores unrelated local D1 state without touching its bytes', async () => {
    const workspace = await createCleanWorkspace();
    const persistTo = join(workspace.root, '.legacy-state');
    const env = { WRANGLER_PERSIST_TO: '.legacy-state' };
    const wrangler = join(workspace.root, 'node_modules/.bin/wrangler');
    const baselinePath = join(workspace.root, 'wrangler.jsonc');
    const unrelatedPath = join(workspace.root, 'unrelated-wrangler.jsonc');
    await writeFile(unrelatedPath, (await readFile(baselinePath, 'utf8')).replace('YOUR_D1_DATABASE_ID', 'local'));
    await execWorkspace(workspace.root, wrangler, ['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', unrelatedPath, '--command', 'SELECT 1']);
    const before = await workspaceHash(persistTo);
    const dryRun = JSON.parse((await workspace.execNode([...flags, '--dry-run', '--json'], env, 300_000)).stdout);
    expect(dryRun.plan).not.toHaveProperty('existingInstallation');
    expect(await workspaceHash(persistTo)).toBe(before);
  }, 300_000);
});
