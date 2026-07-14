import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { allocatePort, cleanupAll, createCleanWorkspace, execWorkspace, listRelativePaths, spawnWorkspace, stopChild, waitForHttp } from './fixtures';

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(!databaseUrl);
const setupFlags = (port: number) => [
  '--mode', 'local', '--preset', 'full-church', '--site-slug', 'full-clean-church',
  '--church-name', 'Full Clean Church', '--locale', 'en',
  '--admin-email', 'owner@full-clean.invalid', '--admin-name', 'Full Clean Owner',
  '--app-origin', `http://127.0.0.1:${port}`, '--email-from', 'serve@full-clean.invalid',
  '--demo-data', '--yes', '--json',
];

suite('clean-room Supabase setup', () => {
  it('creates, verifies, serves, and safely reruns Full Church in a disposable database', async () => {
    const base = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) throw new Error('clean-room Postgres setup requires a loopback administration URL');
    const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    const dbName = `church_setup_${randomUUID().replaceAll('-', '')}`;
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(dbName)) throw new Error('generated disposable database name is unsafe');
    let db: ReturnType<typeof postgres> | undefined;
    let child: ReturnType<typeof spawnWorkspace> | undefined;
    let databaseCreationAttempted = false;
    let primaryError: unknown;
    const oldStripe = process.env.STRIPE_SECRET_KEY;
    const oldSupabase = process.env.SUPABASE_DB_URL;
    process.env.STRIPE_SECRET_KEY = 'ambient-stripe-must-not-leak';
    process.env.SUPABASE_DB_URL = 'postgres://ambient:secret@invalid/ambient';

    try {
      const identity = (await admin<{ database: string; user: string }[]>`SELECT current_database() AS database, current_user AS user`)[0];
      if (identity.database !== decodeURIComponent(base.pathname.slice(1)) || identity.user !== decodeURIComponent(base.username)) {
        throw new Error('Postgres administration URL identity mismatch');
      }
      await admin.unsafe('CREATE TEMP TABLE base_clean_room_sentinel (value text)');
      await admin.unsafe("INSERT INTO base_clean_room_sentinel VALUES ('untouched')");
      databaseCreationAttempted = true;
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      const scoped = new URL(base); scoped.pathname = `/${dbName}`;
      const scopedUrl = scoped.toString();
      db = postgres(scopedUrl, { max: 1, onnotice: () => {} });
      await db.unsafe('CREATE TABLE public.disposable_reset_sentinel (id integer)');
      await db.unsafe('DROP SCHEMA public CASCADE');
      await db.unsafe('CREATE SCHEMA public');
      expect((await db<{ name: string | null }[]>`SELECT to_regclass('public.disposable_reset_sentinel')::text AS name`)[0].name).toBeNull();

      const workspace = await createCleanWorkspace();
      const port = await allocatePort();
      const persistTo = join(workspace.root, '.noncanonical/wrangler-state');
      const env = {
        DATABASE_URL: scopedUrl,
        SUPABASE_DB_URL: scopedUrl,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: scopedUrl,
        WRANGLER_PERSIST_TO: '.noncanonical/wrangler-state',
        ASTRO_DEV_BACKGROUND: '0',
        CHURCH_SETUP_STRIPE_SECRET_KEY: 'sk_test_clean_room_setup',
        CHURCH_SETUP_STRIPE_WEBHOOK_SECRET: 'whsec_clean_room_setup',
      };
      const flags = setupFlags(port);
      const plan = await workspace.execNode([...flags.filter((flag) => flag !== '--yes' && flag !== '--demo-data'), '--dry-run'], env);
      const firstRun = await workspace.execNode(flags, env, 300_000);
      const first = JSON.parse(firstRun.stdout);
      expect(first).toMatchObject({ schemaVersion: 1, kind: 'setup-result', backend: 'supabase' });
      expect(first.enabledModules).toHaveLength(17);
      expect(first.moduleRows).toBe(17);
      expect(first.admin.status).toMatch(/created|already-admin/);
      expect(first.doctor.status).toBe('ready');
      expect(first.doctor.checks).toContainEqual(expect.objectContaining({ code: 'services.stripe-ok', severity: 'info' }));

      const expectedMigrations = (await readdir(join(workspace.root, 'migrations-supabase'))).filter((name) => name.endsWith('.sql')).sort();
      const migrations = await db<{ name: string }[]>`SELECT name FROM _migrations ORDER BY name`;
      expect(migrations.map(({ name }) => name)).toEqual(expectedMigrations);
      expect((await db<{ total: number; enabled: number }[]>`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE value='1')::int AS enabled FROM settings WHERE key LIKE 'module.%'`)[0]).toEqual({ total: 17, enabled: 17 });
      const owners = await db<{ id: number; email: string; role: string; active: number; deleted_at: string | null; session_epoch: number }[]>`SELECT id, lower(email) AS email, role, active, deleted_at, session_epoch FROM people WHERE lower(email)='owner@full-clean.invalid'`;
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatchObject({ email: 'owner@full-clean.invalid', role: 'admin', active: 1, deleted_at: null });
      expect((await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM media`)[0].count).toBeGreaterThan(0);
      const mediaKey = (await db<{ r2_key: string }[]>`SELECT r2_key FROM media ORDER BY id LIMIT 1`)[0].r2_key;

      const manifestBefore = await readFile(join(workspace.root, 'church.config.json'));
      const configBefore = await readFile(join(workspace.root, 'wrangler.jsonc'));
      const stateBefore = await readFile(join(workspace.root, '.church/setup-state.json'));
      const devVars = await readFile(join(workspace.root, '.dev.vars'), 'utf8');
      expect(devVars).toContain('STRIPE_SECRET_KEY=sk_test_clean_room_setup');
      expect(devVars).toContain('STRIPE_WEBHOOK_SECRET=whsec_clean_room_setup');
      expect(configBefore.toString()).toContain('"crons": ["0 13 * * *", "0 14 * * 4", "0 * * * *", "*/5 * * * *"]');
      expect(configBefore.toString()).toContain('"STRIPE_MODE": "test"');
      const secondRun = await workspace.execNode(flags, env, 300_000);
      const second = JSON.parse(secondRun.stdout);
      expect(second.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
      expect(await readFile(join(workspace.root, 'church.config.json'))).toEqual(manifestBefore);
      expect(await readFile(join(workspace.root, 'wrangler.jsonc'))).toEqual(configBefore);
      const credentials = [scopedUrl, `${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}@`, JSON.stringify(decodeURIComponent(base.username)), JSON.stringify(decodeURIComponent(base.password)), 'ambient-stripe-must-not-leak', 'postgres://ambient:secret@invalid/ambient'];
      for (const generated of [plan.stdout, plan.stderr, firstRun.stdout, firstRun.stderr, secondRun.stdout, secondRun.stderr, manifestBefore.toString(), configBefore.toString(), stateBefore.toString()]) {
        for (const credential of credentials) expect(generated).not.toContain(credential);
        expect(generated).not.toContain('sk_test_clean_room_setup');
        expect(generated).not.toContain('whsec_clean_room_setup');
      }
      const localStatePaths = await listRelativePaths(persistTo);
      expect(localStatePaths.some((path) => /(?:^|\/)d1(?:\/|$)/i.test(path))).toBe(false);
      expect(localStatePaths.some((path) => /(?:^|\/)r2(?:\/|$)/i.test(path))).toBe(true);

      await execWorkspace(workspace.root, 'npm', ['run', 'build'], env, 300_000);
      child = spawnWorkspace(workspace.root, 'npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], env);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      await waitForHttp(`http://127.0.0.1:${port}/healthz`, child, () => output);
      const home = await fetch(`http://127.0.0.1:${port}/en/`);
      expect(home.status, output).toBe(200); expect(await home.text()).toContain('Full Clean Church');
      expect((await fetch(`http://127.0.0.1:${port}/media/${mediaKey}`)).status, output).toBe(200);
      const secret = /^SESSION_SECRET=(.+)$/m.exec(await readFile(join(workspace.root, '.dev.vars'), 'utf8'))?.[1];
      expect(secret).toBeTruthy();
      const jwt = await mintSession(secret!, { id: Number(owners[0].id), email: owners[0].email, sessionEpoch: Number(owners[0].session_epoch) });
      expect((await fetch(`http://127.0.0.1:${port}/en/my`, { headers: { cookie: `${SESSION_COOKIE}=${jwt}` }, redirect: 'manual' })).status, output).toBe(200);
      for (const credential of credentials) expect(output).not.toContain(credential);
      expect((await admin<{ value: string }[]>`SELECT value FROM base_clean_room_sentinel`)[0].value).toBe('untouched');
    } catch (error) {
      primaryError = error; throw error;
    } finally {
      if (oldStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldStripe;
      if (oldSupabase === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = oldSupabase;
      const failures = [
        ...await cleanupAll([async () => { if (child) await stopChild(child); }, async () => { if (db) await db.end({ timeout: 5 }); }], primaryError),
        ...await cleanupAll([async () => {
          if (!databaseCreationAttempted) return;
          await admin.unsafe('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [dbName]);
          await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
          expect((await admin<{ value: string }[]>`SELECT value FROM base_clean_room_sentinel`)[0].value).toBe('untouched');
        }], primaryError),
        ...await cleanupAll([async () => { await admin.end({ timeout: 5 }); }], primaryError),
      ];
      if (failures.length && primaryError === undefined) throw new AggregateError(failures, 'clean-room Postgres cleanup failed');
    }
  }, 600_000);
});
