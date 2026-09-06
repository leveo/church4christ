import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { applySetup, createD1Steps, createSupabaseSteps } from '../../../scripts/setup/apply.mjs';
import { assertDemoSeedTarget } from '../../../scripts/setup/provider-verification.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';
import { createStateStore, fingerprintPlan } from '../../../scripts/setup/state.mjs';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const file of readdirSync('migrations').filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(resolve('migrations', file), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...bound: SQLInputValue[]) { values = bound; return this; },
        async first(column?: string) { const row = sqlite.prepare(sql).get(...values); return (column ? row?.[column] : row) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  return { sqlite, db };
}

function setupSteps(backend: 'd1' | 'supabase', db: ReturnType<typeof migratedDatabase>['db']) {
  const shared = { db, moduleKeys: catalog.order, runner: { run: vi.fn() }, verify: {
    migrate: async () => true, seed: async () => true,
    'initialize-modules': async () => true, 'bootstrap-admin': async () => true,
  } };
  return backend === 'd1'
    ? createD1Steps({ ...shared, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local' })
    : createSupabaseSteps({ ...shared, root: process.cwd(), dbUrl: 'postgres://local:local@localhost/test' });
}

function plan(demoData: boolean, preset = 'website-community') {
  return buildSetupPlan({ mode: 'local', preset, siteSlug: 'content-choice',
    churchName: 'Our Church', locale: 'en', adminEmail: 'owner@example.test', adminName: 'Owner', demoData }, catalog);
}

describe('content setup database boundary', () => {
  it.each([null, 'true', 'false'])('preserves managed content choice %s when a real plan change resets completion state', async (savedMarker) => {
    const { sqlite, db } = migratedDatabase();
    const directory = await mkdtemp(resolve(tmpdir(), 'c4c-content-history-'));
    const statePath = resolve(directory, 'setup-state.json');
    const resources = { d1DatabaseName: 'content-choice-db', d1DatabaseId: 'local', r2BucketName: 'content-choice-media', hyperdriveId: null };
    const initializeContexts: Array<{ recovering: boolean; managedInstallation: boolean }> = [];
    const provider = createD1Steps({
      db, moduleKeys: catalog.order, runner: { run: vi.fn() }, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local',
      verify: {
        migrate: async () => true, seed: async () => true,
        'initialize-modules': async ({ plan: activePlan }: any) => catalog.order.every((key) =>
          sqlite.prepare('SELECT value FROM settings WHERE key=?').get(`module.${key}`)?.value === activePlan.moduleSettings[`module.${key}`]),
        'bootstrap-admin': async () => Boolean(sqlite.prepare("SELECT id FROM people WHERE email='owner@example.test' AND super_admin=1").get()),
      },
    });
    const run = async (desired: ReturnType<typeof plan>) => {
      const steps = Object.fromEntries(desired.actions.map((action: string) => [action, { apply: vi.fn(), verify: async () => true }]));
      Object.assign(steps, provider, {
        'initialize-modules': {
          verify: provider['initialize-modules'].verify,
          apply: async (context: any) => { initializeContexts.push(context); return provider['initialize-modules'].apply(context); },
        },
      });
      return applySetup({ ...desired, resources }, { steps, stateStore: createStateStore(statePath) });
    };
    try {
      const website = plan(false, 'website');
      await run(website);
      // A null marker simulates the completed database of the previous release.
      if (savedMarker === null) sqlite.exec("DELETE FROM settings WHERE key='site.demo_content'");
      else sqlite.prepare("UPDATE settings SET value=? WHERE key='site.demo_content'").run(savedMarker);
      const community = plan(false, 'website-community');
      expect(fingerprintPlan(community)).not.toBe(fingerprintPlan(website));
      await run(community);
      expect(initializeContexts.at(-1)).toMatchObject({ recovering: false, managedInstallation: true });
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='module.learning'").get()?.value).toBe('1');
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe(savedMarker ?? undefined);
      // Repeat with another fingerprint to prove this does not depend on transient history.
      await run(website);
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe(savedMarker ?? undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('includes the affirmative content marker in fictional seed data before module initialization', async () => {
    const { sqlite, db } = migratedDatabase();
    sqlite.exec(readFileSync('seed/dev-seed.sql', 'utf8'));
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe('true');
    await setupSteps('d1', db)['initialize-modules'].apply({ plan: plan(true), managedInstallation: true });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe('true');
  });

  it('records the first choice before module initialization so an interrupted install can resume safely', async () => {
    const { sqlite, db } = migratedDatabase();
    const failingDb = { prepare(sql: string) {
      if (sql.includes('ON CONFLICT(key) DO UPDATE SET value = excluded.value')) throw new Error('interrupted module initialization');
      return db.prepare(sql);
    } };
    await expect(setupSteps('d1', failingDb)['initialize-modules'].apply({ plan: plan(false), managedInstallation: true }))
      .rejects.toThrow('interrupted module initialization');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe('false');
    await setupSteps('d1', db)['initialize-modules'].apply({ plan: plan(false), managedInstallation: true });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe('false');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'module.%'").get()?.count).toBe(21);
  });

  it.each(['d1', 'supabase'] as const)('persists both initial choices through the shared %s setup steps', async (backend) => {
    for (const demoData of [true, false]) {
      const { sqlite, db } = migratedDatabase();
      const steps = setupSteps(backend, db);
      const context = { plan: plan(demoData), managedInstallation: true };
      await steps['initialize-modules'].apply(context);
      await steps['bootstrap-admin'].apply(context);
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe(String(demoData));
      expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.en'").get()?.value).toBe('Our Church');
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'module.%'").get()?.count).toBe(21);
      expect(sqlite.prepare('SELECT email, role, super_admin FROM people').all()).toEqual([{ email: 'owner@example.test', role: 'admin', super_admin: 1 }]);
    }
  });

  it('keeps no-demo business tables empty while retaining operational defaults and admin campus access', async () => {
    const { sqlite, db } = migratedDatabase();
    const steps = setupSteps('d1', db);
    const context = { plan: plan(false), managedInstallation: true };
    await steps['initialize-modules'].apply(context);
    await steps['bootstrap-admin'].apply(context);
    for (const table of ['sermons', 'events', 'ministries', 'groups', 'households', 'testimonies', 'bulletins', 'plans',
      'prayer_requests', 'checkins', 'learning_courses', 'learning_provider_connections', 'newcomer_submissions', 'media']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
    for (const table of ['email_rules', 'email_templates', 'newcomer_statuses', 'newcomer_fields', 'activity_score_config', 'activity_score_dimensions']) {
      expect(Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count), table).toBeGreaterThan(0);
    }
    expect(sqlite.prepare('SELECT name, is_default FROM campuses').all()).toEqual([{ name: 'Main Campus', is_default: 1 }]);
    expect(sqlite.prepare('SELECT role, active FROM campus_memberships').all()).toEqual([{ role: 'admin', active: 1 }]);
  });

  it('preserves the chosen marker and edited records on rerun, and refuses adding demo data after admin creation', async () => {
    const { sqlite, db } = migratedDatabase();
    const steps = setupSteps('d1', db);
    const first = { plan: plan(false), managedInstallation: true };
    await steps['initialize-modules'].apply(first);
    await steps['bootstrap-admin'].apply(first);
    sqlite.exec("UPDATE settings SET value='Custom Church' WHERE key='site.name.en'; INSERT INTO events (id, active) VALUES (500, 1);");
    await steps['initialize-modules'].apply({ ...first, plan: plan(true), recovering: true });
    await steps['bootstrap-admin'].apply(first);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()?.value).toBe('false');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.en'").get()?.value).toBe('Custom Church');
    expect(sqlite.prepare('SELECT id FROM events').all()).toEqual([{ id: 500 }]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM people').get()?.count).toBe(1);
    await expect(assertDemoSeedTarget({ backend: 'd1', db, canonicalDemoReady: async () => false })).rejects.toThrow(/fresh database/);
  });

  it.each([false, true])('leaves the absent marker untouched for a legacy install (managed: %s)', async (managedInstallation) => {
    const { sqlite, db } = migratedDatabase();
    const steps = setupSteps('d1', db);
    await steps['initialize-modules'].apply({ plan: plan(false), managedInstallation, recovering: managedInstallation });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.demo_content'").get()).toBeUndefined();
  });
});
