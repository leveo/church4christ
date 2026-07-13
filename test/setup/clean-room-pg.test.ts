import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { createCleanWorkspace, execWorkspace, spawnWorkspace, stopChild, waitForHttp } from './fixtures';

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const flags = [
  '--mode', 'local', '--preset', 'full-church', '--site-slug', 'full-clean-church',
  '--church-name', 'Full Clean Church', '--locale', 'en',
  '--admin-email', 'owner@full-clean.invalid', '--admin-name', 'Full Clean Owner',
  '--app-origin', 'http://127.0.0.1:4321', '--email-from', 'serve@full-clean.invalid',
  '--demo-data', '--yes', '--json',
];

suite('clean-room Supabase setup', () => {
  it('creates, verifies, serves, and safely reruns Full Church in an isolated schema', async () => {
    const base = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) {
      throw new Error('clean-room Postgres setup refuses to reset any non-loopback database');
    }
    const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const identity = (await admin<{ database: string; user: string }[]>`SELECT current_database() AS database, current_user AS user`)[0];
    const existingTables = await admin<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
    if (identity.database !== base.pathname.slice(1) || existingTables.length !== 0) {
      await admin.end({ timeout: 5 });
      throw new Error('clean-room Postgres setup requires the named loopback database to have an empty public schema');
    }
    await admin.unsafe('DROP SCHEMA public CASCADE');
    await admin.unsafe('CREATE SCHEMA public');
    const scopedUrl = databaseUrl!;
    const db = postgres(scopedUrl, { max: 1, onnotice: () => {} });
    const workspace = await createCleanWorkspace();
    const persistTo = join(workspace.root, '.wrangler-state');
    const env = {
      DATABASE_URL: scopedUrl,
      SUPABASE_DB_URL: scopedUrl,
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: scopedUrl,
      WRANGLER_PERSIST_TO: persistTo,
      ASTRO_DEV_BACKGROUND: '0',
    };

    try {
      const firstText = (await workspace.execNode(flags, env, 300_000)).stdout;
      const first = JSON.parse(firstText);
      expect(first).toMatchObject({ schemaVersion: 1, kind: 'setup-result', backend: 'supabase' });
      expect(first.enabledModules).toHaveLength(16);
      expect(first.moduleRows).toBe(16);
      expect(first.admin.status).toMatch(/created|already-admin/);
      expect(first.doctor.status).toBe('ready-with-limitations');
      expect(first.doctor.checks.filter(({ severity }: { severity: string }) => severity === 'warning').map(({ code }: { code: string }) => code)).toEqual(['services.stripe-absent']);

      const expectedMigrations = (await readdir(join(workspace.root, 'migrations-supabase'))).filter((name) => name.endsWith('.sql')).sort();
      const migrations = await db<{ name: string }[]>`SELECT name FROM _migrations ORDER BY name`;
      expect(migrations.map(({ name }) => name)).toEqual(expectedMigrations);
      const settings = await db<{ total: number; enabled: number }[]>`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE value='1')::int AS enabled FROM settings WHERE key LIKE 'module.%'`;
      expect(settings[0]).toEqual({ total: 16, enabled: 16 });
      const owners = await db<{ id: number; email: string; role: string; active: number; deleted_at: string | null; session_epoch: number }[]>`SELECT id, lower(email) AS email, role, active, deleted_at, session_epoch FROM people WHERE lower(email)='owner@full-clean.invalid'`;
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatchObject({ email: 'owner@full-clean.invalid', role: 'admin', active: 1, deleted_at: null });
      const media = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM media`;
      expect(media[0].count).toBeGreaterThan(0);
      const mediaTargets = await db<{ count: number }[]>`SELECT (SELECT COUNT(*) FROM settings WHERE value LIKE 'uploads/%')::int + (SELECT COUNT(*) FROM events WHERE image_key LIKE 'uploads/%')::int + (SELECT COUNT(*) FROM ministries WHERE cover_key LIKE 'uploads/%')::int AS count`;
      expect(mediaTargets[0].count).toBeGreaterThan(0);

      const manifestBefore = await readFile(join(workspace.root, 'church.config.json'));
      const configBefore = await readFile(join(workspace.root, 'wrangler.jsonc'));
      const secondText = (await workspace.execNode(flags, env, 300_000)).stdout;
      const second = JSON.parse(secondText);
      expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
      expect(await readFile(join(workspace.root, 'church.config.json'))).toEqual(manifestBefore);
      expect(await readFile(join(workspace.root, 'wrangler.jsonc'))).toEqual(configBefore);
      for (const generated of [firstText, secondText, manifestBefore.toString(), configBefore.toString()]) {
        expect(generated).not.toContain(scopedUrl);
        expect(generated).not.toContain(decodeURIComponent(base.password));
      }

      await execWorkspace(workspace.root, 'npm', ['run', 'build'], env, 300_000);
      const child = spawnWorkspace(workspace.root, 'npm', ['run', 'dev', '--', '--host', '127.0.0.1'], env);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      try {
        await waitForHttp('http://127.0.0.1:4321/healthz', child, () => output);
        const home = await fetch('http://127.0.0.1:4321/en/');
        expect(home.status, output).toBe(200);
        expect(await home.text()).toContain('Full Clean Church');
        const devVars = await readFile(join(workspace.root, '.dev.vars'), 'utf8');
        const secret = /^SESSION_SECRET=(.+)$/m.exec(devVars)?.[1];
        expect(secret).toBeTruthy();
        const jwt = await mintSession(secret!, { id: Number(owners[0].id), email: owners[0].email, sessionEpoch: Number(owners[0].session_epoch) });
        const portal = await fetch('http://127.0.0.1:4321/en/my', { headers: { cookie: `${SESSION_COOKIE}=${jwt}` }, redirect: 'manual' });
        expect(portal.status, output).toBe(200);
      } finally {
        await stopChild(child);
      }
    } finally {
      await db.end({ timeout: 5 }).catch(() => {});
      await admin.unsafe('DROP SCHEMA public CASCADE');
      await admin.unsafe('CREATE SCHEMA public');
      await admin.end({ timeout: 5 });
    }
  }, 600_000);
});
