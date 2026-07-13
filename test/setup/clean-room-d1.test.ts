import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocatePort, createCleanWorkspace, execWorkspace, spawnWorkspace, stopChild, waitForHttp } from './fixtures';

const flags = (port: number) => [
  '--mode', 'local', '--preset', 'website', '--site-slug', 'clean-church',
  '--church-name', 'Clean Church', '--locale', 'en',
  '--admin-email', 'owner@clean.invalid', '--admin-name', 'Clean Owner',
  '--app-origin', `http://127.0.0.1:${port}`, '--email-from', 'serve@clean.invalid',
  '--demo-data', '--yes', '--json',
];

describe('clean-room D1 setup', () => {
  it('creates, verifies, serves, and safely reruns the Website installation', async () => {
    const workspace = await createCleanWorkspace();
    const port = await allocatePort();
    const persistTo = join(workspace.root, '.noncanonical/wrangler-state');
    const env = { WRANGLER_PERSIST_TO: '.noncanonical/wrangler-state', ASTRO_DEV_BACKGROUND: '0' };
    const ambient = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN };
    process.env.STRIPE_SECRET_KEY = 'ambient-d1-stripe-must-not-leak';
    process.env.CLOUDFLARE_API_TOKEN = 'ambient-d1-cloudflare-must-not-leak';

    try {
    const firstRun = await workspace.execNode(flags(port), env, 300_000);
    const first = JSON.parse(firstRun.stdout);
    expect(first).toMatchObject({ schemaVersion: 1, kind: 'setup-result', backend: 'd1' });
    expect(first.enabledModules).toHaveLength(8);
    expect(first.moduleRows).toBe(16);
    expect(first.admin.status).toMatch(/created|already-admin/);
    expect(first.doctor.status).toBe('ready');
    const doctorRun = await workspace.execNode(['--doctor', '--json'], env, 300_000);
    expect(JSON.parse(doctorRun.stdout).status).toBe('ready');

    const query = await execWorkspace(workspace.root, join(workspace.root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--local', '--json', '--persist-to', persistTo,
      '--config', join(workspace.root, 'wrangler.jsonc'), '--command',
      "SELECT COUNT(*) AS module_rows, SUM(CASE WHEN value='1' THEN 1 ELSE 0 END) AS enabled FROM settings WHERE key LIKE 'module.%'; SELECT lower(email) AS email, role, active, deleted_at FROM people WHERE lower(email)='owner@clean.invalid'; SELECT value AS site_name FROM settings WHERE key='site.name.en'; SELECT r2_key FROM media ORDER BY id LIMIT 1;",
    ]);
    const resultSets = JSON.parse(query.stdout);
    expect(resultSets[0].results[0]).toMatchObject({ module_rows: 16, enabled: 8 });
    expect(resultSets[1].results[0]).toMatchObject({ email: 'owner@clean.invalid', role: 'admin', active: 1, deleted_at: null });
    expect(resultSets[2].results[0]).toEqual({ site_name: 'Clean Church' });
    const mediaKey = resultSets[3].results[0].r2_key;

    await execWorkspace(workspace.root, join(workspace.root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', join(workspace.root, 'wrangler.jsonc'),
      '--command', "UPDATE settings SET value='Church4Christ' WHERE key='site.name.en'",
    ]);

    const manifestBefore = await readFile(join(workspace.root, 'church.config.json'));
    const configBefore = await readFile(join(workspace.root, 'wrangler.jsonc'));
    const secondRun = await workspace.execNode(flags(port), env, 300_000);
    const second = JSON.parse(secondRun.stdout);
    expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status)), JSON.stringify(second.apply.results)).toBe(true);
    expect(await readFile(join(workspace.root, 'church.config.json'))).toEqual(manifestBefore);
    expect(await readFile(join(workspace.root, 'wrangler.jsonc'))).toEqual(configBefore);
    const devVars = await readFile(join(workspace.root, '.dev.vars'), 'utf8');
    for (const text of [firstRun.stdout, firstRun.stderr, doctorRun.stdout, doctorRun.stderr, secondRun.stdout, secondRun.stderr, devVars]) {
      expect(text).not.toContain('ambient-d1-stripe-must-not-leak');
      expect(text).not.toContain('ambient-d1-cloudflare-must-not-leak');
    }

    await execWorkspace(workspace.root, 'npm', ['run', 'build'], env, 300_000);
    const child = spawnWorkspace(workspace.root, 'npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], env);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/healthz`, child, () => output);
      const home = await fetch(`http://127.0.0.1:${port}/en/`);
      expect(home.status, output).toBe(200);
      expect(await home.text()).toContain('Church4Christ');
      const media = await fetch(`http://127.0.0.1:${port}/media/${mediaKey}`);
      expect(media.status, output).toBe(200);
      expect(output).not.toContain('ambient-d1-stripe-must-not-leak');
      expect(output).not.toContain('ambient-d1-cloudflare-must-not-leak');
    } finally {
      await stopChild(child);
    }
    } finally {
      if (ambient.STRIPE_SECRET_KEY === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = ambient.STRIPE_SECRET_KEY;
      if (ambient.CLOUDFLARE_API_TOKEN === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = ambient.CLOUDFLARE_API_TOKEN;
    }
  }, 600_000);
});
