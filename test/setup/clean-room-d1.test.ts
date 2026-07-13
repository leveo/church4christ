import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCleanWorkspace, execWorkspace, spawnWorkspace, stopChild, waitForHttp } from './fixtures';

const flags = [
  '--mode', 'local', '--preset', 'website', '--site-slug', 'clean-church',
  '--church-name', 'Clean Church', '--locale', 'en',
  '--admin-email', 'owner@clean.invalid', '--admin-name', 'Clean Owner',
  '--app-origin', 'http://127.0.0.1:4321', '--email-from', 'serve@clean.invalid',
  '--demo-data', '--yes', '--json',
];

describe('clean-room D1 setup', () => {
  it('creates, verifies, serves, and safely reruns the Website installation', async () => {
    const workspace = await createCleanWorkspace();
    // Astro's Cloudflare adapter reads the canonical Wrangler state directory.
    // Keeping that directory under this disposable root makes the state unique
    // while proving the generated handoff works without copying database files.
    const persistTo = join(workspace.root, '.wrangler/state');
    const env = { WRANGLER_PERSIST_TO: persistTo, ASTRO_DEV_BACKGROUND: '0' };

    const first = JSON.parse((await workspace.execNode(flags, env, 300_000)).stdout);
    expect(first).toMatchObject({ schemaVersion: 1, kind: 'setup-result', backend: 'd1' });
    expect(first.enabledModules).toHaveLength(8);
    expect(first.moduleRows).toBe(16);
    expect(first.admin.status).toMatch(/created|already-admin/);
    expect(first.doctor.status).toBe('ready');

    const query = await execWorkspace(workspace.root, join(workspace.root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--local', '--json', '--persist-to', persistTo,
      '--config', join(workspace.root, 'wrangler.jsonc'), '--command',
      "SELECT COUNT(*) AS module_rows, SUM(CASE WHEN value='1' THEN 1 ELSE 0 END) AS enabled FROM settings WHERE key LIKE 'module.%'; SELECT lower(email) AS email, role, active, deleted_at FROM people WHERE lower(email)='owner@clean.invalid';",
    ]);
    const resultSets = JSON.parse(query.stdout);
    expect(resultSets[0].results[0]).toMatchObject({ module_rows: 16, enabled: 8 });
    expect(resultSets[1].results[0]).toMatchObject({ email: 'owner@clean.invalid', role: 'admin', active: 1, deleted_at: null });

    const manifestBefore = await readFile(join(workspace.root, 'church.config.json'));
    const configBefore = await readFile(join(workspace.root, 'wrangler.jsonc'));
    const second = JSON.parse((await workspace.execNode(flags, env, 300_000)).stdout);
    expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
    expect(await readFile(join(workspace.root, 'church.config.json'))).toEqual(manifestBefore);
    expect(await readFile(join(workspace.root, 'wrangler.jsonc'))).toEqual(configBefore);

    await execWorkspace(workspace.root, 'npm', ['run', 'build'], env, 300_000);
    const child = spawnWorkspace(workspace.root, 'npm', ['run', 'dev', '--', '--host', '127.0.0.1'], env);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      await waitForHttp('http://127.0.0.1:4321/healthz', child, () => output);
      const home = await fetch('http://127.0.0.1:4321/en/');
      expect(home.status, output).toBe(200);
      expect(await home.text()).toContain('Clean Church');
    } finally {
      await stopChild(child);
    }
  }, 600_000);
});
