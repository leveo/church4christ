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
  it('starts without demo records and preserves real content on a no-demo rerun', async () => {
    const workspace = await createCleanWorkspace();
    const port = await allocatePort();
    const cleanFlags = [...flags(port).filter((flag) => flag !== '--demo-data'), '--no-demo-data'];
    const env = { WRANGLER_PERSIST_TO: '.noncanonical/wrangler-state', ASTRO_DEV_BACKGROUND: '0' };
    const first = JSON.parse((await workspace.execNode(cleanFlags, env, 300_000)).stdout);
    expect(first.apply.actions).not.toContain('seed');
    expect(first.apply.actions).not.toContain('seed-media');
    expect(first).toMatchObject({ backend: 'd1', moduleRows: 21 });
    expect(first.doctor.status).toBe('ready-with-limitations');
    const manifest = JSON.parse(await readFile(join(workspace.root, 'church.config.json'), 'utf8'));
    expect(manifest.demoData).toBe(false);

    const query = async (command: string) => JSON.parse((await execWorkspace(workspace.root, join(workspace.root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--local', '--json', '--persist-to', join(workspace.root, env.WRANGLER_PERSIST_TO),
      '--config', join(workspace.root, 'wrangler.jsonc'), '--command', command,
    ])).stdout);
    const tables = ['sermons', 'events', 'ministries', 'groups', 'households', 'testimonies', 'bulletins', 'plans',
      'prayer_requests', 'checkins', 'learning_courses', 'learning_provider_connections', 'newcomer_submissions', 'media'];
    const results = await query([
      ...tables.map((table) => `SELECT COUNT(*) AS count FROM ${table}`),
      'SELECT email, role, super_admin FROM people',
      "SELECT key, value FROM settings WHERE key IN ('site.demo_content','site.name.en') ORDER BY key",
      "SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'module.%'",
      'SELECT COUNT(*) AS count FROM newcomer_statuses',
      'SELECT COUNT(*) AS count FROM email_templates',
    ].join(';'));
    tables.forEach((table, index) => expect(results[index].results[0].count, table).toBe(0));
    expect(results[tables.length].results).toEqual([{ email: 'owner@clean.invalid', role: 'admin', super_admin: 1 }]);
    expect(results[tables.length + 1].results).toEqual([
      { key: 'site.demo_content', value: 'false' }, { key: 'site.name.en', value: 'Clean Church' },
    ]);
    expect(results[tables.length + 2].results[0].count).toBe(21);
    expect(results[tables.length + 3].results[0].count).toBeGreaterThan(0);
    expect(results[tables.length + 4].results[0].count).toBeGreaterThan(0);

    await query("UPDATE settings SET value='Our Updated Church' WHERE key='site.name.en'; INSERT INTO events (id, active) VALUES (500, 1)");
    const second = JSON.parse((await workspace.execNode(cleanFlags, env, 300_000)).stdout);
    expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
    const retained = await query("SELECT id FROM events; SELECT value FROM settings WHERE key='site.name.en'; SELECT value FROM settings WHERE key='site.demo_content'; SELECT COUNT(*) AS count FROM people");
    expect(retained[0].results).toEqual([{ id: 500 }]);
    expect(retained[1].results[0].value).toBe('Our Updated Church');
    expect(retained[2].results[0].value).toBe('false');
    expect(retained[3].results[0].count).toBe(1);
  }, 600_000);

  it('creates, verifies, serves, and safely reruns the Website installation', async () => {
    const workspace = await createCleanWorkspace();
    const port = await allocatePort();
    const persistTo = join(workspace.root, '.noncanonical/wrangler-state');
    const env = {
      WRANGLER_PERSIST_TO: '.noncanonical/wrangler-state', ASTRO_DEV_BACKGROUND: '0',
      CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_test_d1_must_not_be_written',
      CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'whsec_d1_must_not_be_written',
    };
    const ambient = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN };
    process.env.STRIPE_SECRET_KEY = 'ambient-d1-stripe-must-not-leak';
    process.env.CLOUDFLARE_API_TOKEN = 'ambient-d1-cloudflare-must-not-leak';

    try {
    const firstRun = await workspace.execNode(flags(port), env, 300_000);
    const first = JSON.parse(firstRun.stdout);
    expect(first).toMatchObject({ schemaVersion: 1, kind: 'setup-result', backend: 'd1' });
    expect(first.enabledModules).toHaveLength(8);
    expect(first.moduleRows).toBe(21);
    expect(first.admin.status).toMatch(/created|already-admin/);
    expect(first.doctor.status).toBe('ready-with-limitations');
    expect(first.apply.actions).toEqual(expect.arrayContaining(['seed', 'seed-media']));
    const doctorRun = await workspace.execNode(['--doctor', '--json'], env, 300_000);
    expect(JSON.parse(doctorRun.stdout).status).toBe('ready-with-limitations');

    const query = await execWorkspace(workspace.root, join(workspace.root, 'node_modules/.bin/wrangler'), [
      'd1', 'execute', 'DB', '--local', '--json', '--persist-to', persistTo,
      '--config', join(workspace.root, 'wrangler.jsonc'), '--command',
      "SELECT COUNT(*) AS module_rows, SUM(CASE WHEN value='1' THEN 1 ELSE 0 END) AS enabled FROM settings WHERE key LIKE 'module.%'; SELECT lower(email) AS email, role, active, deleted_at FROM people WHERE lower(email)='owner@clean.invalid'; SELECT value AS site_name FROM settings WHERE key='site.name.en'; SELECT r2_key FROM media ORDER BY id LIMIT 1;",
    ]);
    const resultSets = JSON.parse(query.stdout);
    expect(resultSets[0].results[0]).toMatchObject({ module_rows: 21, enabled: 8 });
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
    expect(devVars).not.toContain('STRIPE_SECRET_KEY');
    expect(devVars).not.toContain('STRIPE_WEBHOOK_SECRET');
    const configText = configBefore.toString();
    expect(configText).not.toContain('*/5 * * * *');
    expect(configText).not.toContain('STRIPE_MODE');
    for (const text of [firstRun.stdout, firstRun.stderr, doctorRun.stdout, doctorRun.stderr, secondRun.stdout, secondRun.stderr, devVars]) {
      expect(text).not.toContain('ambient-d1-stripe-must-not-leak');
      expect(text).not.toContain('ambient-d1-cloudflare-must-not-leak');
      expect(text).not.toContain('sk_test_d1_must_not_be_written');
      expect(text).not.toContain('whsec_d1_must_not_be_written');
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
