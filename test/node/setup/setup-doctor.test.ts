import { describe, expect, it } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { summarizeReadiness, doctorExitCode, result } from '../../../scripts/setup/readiness.mjs';
import { redact } from '../../../scripts/setup/redact.mjs';
import { checkManifest } from '../../../scripts/setup/checks/manifest.mjs';
import { checkConfig } from '../../../scripts/setup/checks/config.mjs';
import { ALWAYS_REQUIRED_TABLES, TABLES_BY_CAPABILITY, checkDatabase, missingRequiredTables } from '../../../scripts/setup/checks/database.mjs';
import { checkServices } from '../../../scripts/setup/checks/services.mjs';
import { runDoctor } from '../../../scripts/setup/doctor.mjs';
import { renderWrangler } from '../../../scripts/setup/render-wrangler.mjs';
import { readFile, readdir } from 'node:fs/promises';

const baseManifest = {
  schemaVersion: 1,
  mode: 'local',
  site: { slug: 'grace-church', name: 'Grace Church', locale: 'en', appOrigin: 'http://localhost:4321', emailFrom: 'serve@grace-church.invalid' },
  preset: 'website',
  modules: [...catalog.presets.website.modules],
  database: 'd1',
  demoData: false,
  resources: { d1DatabaseName: 'grace-church-db', d1DatabaseId: 'local', r2BucketName: 'grace-church-media', hyperdriveId: null },
} as const;

const rowResult = (rows: Record<string, unknown>[]) => ({ results: rows, meta: { changes: 0 }, success: true });

function fakeDb(manifest: any = baseManifest, overrides: Record<string, unknown> = {}) {
  const enabled = new Set(manifest.modules);
  const moduleRows = catalog.order.map((key) => ({ key: `module.${key}`, value: enabled.has(key) ? '1' : '0' }));
  const tables = [...new Set([
    ...ALWAYS_REQUIRED_TABLES,
    ...Object.values(TABLES_BY_CAPABILITY).flat(),
  ])];
  const migrations = ['0001_init.sql', '0002_giving.sql', '0003_registration.sql', '0004_custom_pages.sql', '0005_children_checkin.sql', '0006_page_builder.sql', '0007_member_portal.sql'];
  return {
    prepare(sql: string) {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        async first() {
          if (sql === 'SELECT 1 AS ok') return overrides.connectivity ?? { ok: 1 };
          if (sql.includes("role=?")) return overrides.admin ?? { count: 1 };
          throw new Error(`unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("key LIKE 'module.%'")) return rowResult((overrides.moduleRows as any) ?? moduleRows);
          if (sql.includes('sqlite_master')) return rowResult((overrides.tables as any) ?? tables.map((name) => ({ name })));
          if (sql.includes('information_schema.tables')) return rowResult((overrides.tables as any) ?? tables.map((table_name) => ({ table_name })));
          if (sql === 'SELECT name FROM _migrations ORDER BY name') return rowResult((overrides.migrations as any) ?? migrations.map((name) => ({ name })));
          throw new Error(`unexpected all query: ${sql}`);
        },
      };
      return statement;
    },
  };
}

describe('doctor readiness model', () => {
  it('derives the approved readiness states and strict exit codes for stable single-segment codes', () => {
    const check = (code: string, severity: 'info' | 'warning' | 'error') => result(code, severity, code, `fix ${code}`);
    expect(summarizeReadiness([check('ok', 'info')]).status).toBe('ready');
    expect(summarizeReadiness([check('stripe', 'warning')]).status).toBe('ready-with-limitations');
    expect(summarizeReadiness([check('db', 'error')]).status).toBe('not-ready');
    expect(doctorExitCode([check('stripe', 'warning')], false)).toBe(0);
    expect(doctorExitCode([check('stripe', 'warning')], true)).toBe(1);
    expect(doctorExitCode([check('db', 'error')], false)).toBe(1);
    expect(() => result('Bad.Code', 'info', 'bad', 'fix')).toThrow(/code/i);
    expect(() => result('bad..code', 'info', 'bad', 'fix')).toThrow(/code/i);
  });

  it('derives stable states, validates strict booleans, and deep-freezes copied results', () => {
    const input = [result('all.ok', 'info', 'ready', 'none')];
    const ready = summarizeReadiness(input);
    expect(ready).toEqual({ schemaVersion: 1, status: 'ready', checks: input });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.checks)).toBe(true);
    expect(ready.checks).not.toBe(input);
    expect(summarizeReadiness([result('stripe.absent', 'warning', 'limited', 'configure')]).status).toBe('ready-with-limitations');
    expect(summarizeReadiness([result('database.failed', 'error', 'failed', 'repair')]).status).toBe('not-ready');
    expect(doctorExitCode(input, false)).toBe(0);
    expect(doctorExitCode([result('stripe.absent', 'warning', 'limited', 'configure')], false)).toBe(0);
    expect(doctorExitCode([result('stripe.absent', 'warning', 'limited', 'configure')], true)).toBe(1);
    expect(() => doctorExitCode(input, 1 as any)).toThrow(/strict must be a boolean/i);
    expect(() => summarizeReadiness([result('same.code', 'info', 'one', 'none'), result('same.code', 'info', 'two', 'none')])).toThrow(/duplicate.*code/i);
    expect(() => result('bad.code', 'debug' as any, 'bad', 'fix')).toThrow(/severity/i);
  });

  it('redacts recursive values and keys using URL, encoded, and multiline variants', () => {
    const url = 'postgres://bob-user:p%40ssword@db.example/church?token=xYz12345';
    const value = {
      [url]: `failure for bob-user / p@ssword / ${encodeURIComponent('p@ssword')}`,
      nested: ['xYz12345', 'common', 'SESSION_SECRET=abcdefgh\nshort=xy'],
    };
    const safe = redact(value, [url, 'ordinary', 'SESSION_SECRET=abcdefgh\nshort=xy', 'tiny']);
    const json = JSON.stringify(safe);
    expect(json).not.toContain('bob-user');
    expect(json).not.toContain('p@ssword');
    expect(json).not.toContain('p%40ssword');
    expect(json).not.toContain('xYz12345');
    expect(json).not.toContain('abcdefgh');
    expect(json).not.toContain(url);
    expect(json).toContain('common');
    expect(Object.isFrozen(safe)).toBe(true);
    expect(Object.isFrozen(safe.nested)).toBe(true);
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(() => redact(cyclic, [])).toThrow(/cyclic/i);
    expect(() => redact({ bad: new Date() }, [])).toThrow(/plain JSON/i);
  });

  it('does not derive unsafe short replacements from explicit, multiline, or URL secrets', () => {
    const shortUrl = 'postgres://a:b@db.example/x?q=c';
    const encodedShortUrl = 'postgres://%61%62%63:%64%65%66@db.example/x';
    const safe = redact({ message: `a abc def database schema remediation ${shortUrl} ${encodedShortUrl} A=a`, database: 'stable' }, [
      'A=a', 'X=xy\nY=short', shortUrl, encodedShortUrl,
    ]);
    expect(safe).toEqual({ message: 'a abc def database schema remediation [REDACTED] [REDACTED] A=a', database: 'stable' });
  });
});

describe('doctor manifest check', () => {
  it('reports missing, invalid, and canonical manifests without exposing raw data', async () => {
    expect(await checkManifest({ catalog, readManifest: async () => { const error: any = new Error('gone'); error.code = 'ENOENT'; throw error; } }))
      .toEqual([expect.objectContaining({ code: 'manifest.missing', severity: 'error' })]);
    const invalid: any = { ...baseManifest, modules: ['gifts'], site: { ...baseManifest.site, name: 'PRIVATE-VALUE' } };
    const bad = await checkManifest({ catalog, manifest: invalid, secrets: ['PRIVATE-VALUE'] });
    expect(bad).toEqual([expect.objectContaining({ code: 'manifest.invalid', severity: 'error' })]);
    expect(JSON.stringify(bad)).not.toContain('PRIVATE-VALUE');
    expect(await checkManifest({ catalog, manifest: { ...baseManifest, resources: { ...baseManifest.resources, d1DatabaseId: null } } })).toEqual([
      expect.objectContaining({ code: 'manifest.invalid', severity: 'error' }),
    ]);
    expect(await checkManifest({ catalog, manifest: baseManifest })).toEqual([
      expect.objectContaining({ code: 'manifest.ok', severity: 'info' }),
    ]);
  });
});

describe('doctor generated configuration check', () => {
  it('checks exact generated bytes, provider binding, placeholders, crons, and deprecation', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const workerSource = await readFile('src/worker.ts', 'utf8');
    const config = renderWrangler(template, baseManifest);
    expect(await checkConfig({ manifest: baseManifest, template, config, workerSource, hostEnv: {} })).toEqual([
      expect.objectContaining({ code: 'config.ok', severity: 'info' }),
    ]);
    const drift = await checkConfig({ manifest: baseManifest, template, config: config.replace('"DB_BACKEND": "d1"', '"DB_BACKEND": "bogus"').replace('"binding": "DB"', '"binding": "WRONG"') + '\n// @@LEFT@@ YOUR_ID\n', workerSource, hostEnv: { WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: 'secret-value' } });
    expect(drift.map((entry) => entry.code)).toEqual([
      'config.placeholder', 'config.backend', 'config.binding', 'config.drift', 'config.hyperdrive-env-deprecated',
    ]);
    const badWorker = workerSource.replace("const DIGEST_CRON = '0 14 * * 4'", "const DIGEST_CRON = '0 15 * * 4'");
    expect((await checkConfig({ manifest: baseManifest, template, config, workerSource: badWorker, hostEnv: {} })).map((entry) => entry.code))
      .toEqual(['config.worker-crons']);
    const unrelated = `function unrelated(controller: { cron: string }) { switch (controller.cron) { case '1 2 3 4 5': break; } }\n${workerSource}`;
    expect(await checkConfig({ manifest: baseManifest, template, config, workerSource: unrelated, hostEnv: {} })).toEqual([
      expect.objectContaining({ code: 'config.ok' }),
    ]);
    const ambiguous = workerSource.replace('clearModuleCache();', "clearModuleCache(); switch (controller.cron) { case '0 13 * * *': break; }");
    expect((await checkConfig({ manifest: baseManifest, template, config, workerSource: ambiguous, hostEnv: {} })).map((entry) => entry.code))
      .toEqual(['config.worker-crons']);
  });

  it('accepts only the recorded baseline local D1 identifier as preserved legacy storage identity', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const workerSource = await readFile('src/worker.ts', 'utf8');
    const manifest = { ...baseManifest, resources: { ...baseManifest.resources, d1DatabaseId: 'YOUR_D1_DATABASE_ID' } };
    const config = renderWrangler(template, manifest);
    expect(await checkConfig({ manifest, template, config, workerSource, hostEnv: {} })).toEqual([
      expect.objectContaining({ code: 'config.ok', severity: 'info' }),
    ]);
    expect((await checkConfig({ manifest, template, config: `${config}\n// YOUR_OTHER_ID`, workerSource, hostEnv: {} })).map((entry) => entry.code))
      .toContain('config.placeholder');
  });

  it('finds the deprecated Hyperdrive variable in any injected additional file without exposing contents', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const workerSource = await readFile('src/worker.ts', 'utf8');
    const config = renderWrangler(template, baseManifest);
    const secret = 'PRIVATE-CONNECTION-CONTENT';
    const findings = await checkConfig({
      manifest: baseManifest,
      template,
      config,
      workerSource,
      hostEnv: {},
      files: { '.dev.vars': `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=${secret}`, '.env': 'SAFE=1' },
    });
    expect(findings.map((entry) => entry.code)).toEqual(['config.hyperdrive-env-deprecated']);
    expect(JSON.stringify(findings)).not.toContain(secret);
    await expect(checkConfig({ manifest: baseManifest, template, config, workerSource, hostEnv: {}, files: { '.dev.vars': 1 } as any }))
      .rejects.toThrow(/files/i);
    await expect(checkConfig({ manifest: baseManifest, template, config, workerSource, hostEnv: {}, files: [config, 1] as any }))
      .rejects.toThrow(/files/i);
  });
});

describe('doctor database check', () => {
  it('accepts complete D1 and Supabase installs and reports D1 CLI limitation', async () => {
    const runner = { run: async () => ({ stdout: 'OPTIONS\n  --local\n  --remote\n', stderr: '', exitCode: 0 }) };
    const d1 = await checkDatabase({ db: fakeDb(), catalog, manifest: baseManifest, readDir: async () => [], runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' });
    expect(d1.map((entry) => [entry.code, entry.severity])).toEqual([
      ['database.d1-migrations-unavailable', 'info'], ['database.ok', 'info'],
    ]);
    const supabase = { ...baseManifest, preset: 'full-church', modules: [...catalog.presets['full-church'].modules], database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-church-media', hyperdriveId: 'local' } } as const;
    const pg = await checkDatabase({ db: fakeDb(supabase), catalog, manifest: supabase, readDir: async () => ['0007_member_portal.sql', '0001_init.sql', 'ignore.example', '0002_giving.sql', '0003_registration.sql', '0004_custom_pages.sql', '0005_children_checkin.sql', '0006_page_builder.sql'] });
    expect(pg).toEqual([expect.objectContaining({ code: 'database.ok', severity: 'info' })]);
  });

  it('uses machine-readable D1 migration output when Wrangler advertises it and fails on pending files', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file: string, args: string[]) => {
      calls.push(args);
      return calls.length === 1
        ? { stdout: 'OPTIONS\n  --json  machine output\n', stderr: '', exitCode: 0 }
        : { stdout: '["0008_member_portal.sql"]', stderr: '', exitCode: 0 };
    } };
    const pending = await checkDatabase({ db: fakeDb(), catalog, manifest: baseManifest, readDir: async () => [], runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc' });
    expect(pending.map((entry) => entry.code)).toEqual(['database.migrations']);
    expect(calls[1]).toEqual(['d1', 'migrations', 'list', 'DB', '--local', '--json', '--config', 'wrangler.jsonc']);
  });

  it('fails closed on connectivity, malformed rows, module drift, missing admin/tables, and migration drift', async () => {
    const malformed = fakeDb(baseManifest, { moduleRows: [{ key: 'module.sermons', value: '2' }], admin: { count: 0 }, tables: [{ name: 'people' }] });
    const issues = await checkDatabase({ db: malformed, catalog, manifest: baseManifest, readDir: async () => [] });
    expect(issues.map((entry) => entry.code)).toEqual([
      'database.modules', 'database.admin', 'database.tables', 'database.d1-migrations-unavailable',
    ]);
    const broken = fakeDb(baseManifest, { connectivity: { nope: 1 } });
    expect(await checkDatabase({ db: broken, catalog, manifest: baseManifest, readDir: async () => [] })).toEqual([
      expect.objectContaining({ code: 'database.connectivity', severity: 'error' }),
    ]);
    const supabase = { ...baseManifest, preset: 'full-church', modules: [...catalog.presets['full-church'].modules], database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-church-media', hyperdriveId: 'local' } } as const;
    const pg = await checkDatabase({ db: fakeDb(supabase, { migrations: [{ name: 'wrong.sql' }] }), catalog, manifest: supabase, readDir: async () => ['0001_init.sql'] });
    expect(pg.map((entry) => entry.code)).toContain('database.migrations');
    const throwing = { prepare() { throw new Error('postgres://secret-value'); } };
    const safe = await checkDatabase({ db: throwing, catalog, manifest: baseManifest, readDir: async () => [], secrets: ['postgres://secret-value'] });
    expect(safe).toEqual([expect.objectContaining({ code: 'database.exception', severity: 'error' })]);
    expect(JSON.stringify(safe)).not.toContain('secret-value');
  });

  it('probes every operational table owned by every capability plus always-required core tables', async () => {
    expect(Object.keys(TABLES_BY_CAPABILITY).sort()).toEqual([...catalog.order].sort());
    expect(ALWAYS_REQUIRED_TABLES).toEqual(expect.arrayContaining(['people', 'settings', 'media', 'tokens']));
    expect(TABLES_BY_CAPABILITY.registration).toEqual(expect.arrayContaining([
      'reg_events', 'reg_event_i18n', 'reg_questions', 'reg_question_i18n', 'registrations', 'reg_answers',
    ]));
    expect(TABLES_BY_CAPABILITY.portal).toEqual(expect.arrayContaining([
      'group_members', 'group_applications', 'group_files', 'event_admins', 'prayer_items',
      'households', 'household_members', 'reg_events', 'reg_event_i18n', 'registrations',
    ]));
    expect(TABLES_BY_CAPABILITY.giving).toEqual(expect.arrayContaining(['funds', 'fund_i18n', 'gifts', 'recurring_gifts', 'households', 'household_members']));
    expect(TABLES_BY_CAPABILITY.children).toEqual(expect.arrayContaining(['checkin_events', 'checkins', 'households', 'household_members']));
    expect(TABLES_BY_CAPABILITY.people).toEqual(expect.arrayContaining(['households', 'household_members', 'person_notes']));
    const full = { ...baseManifest, preset: 'full-church', modules: [...catalog.order], database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-church-media', hyperdriveId: 'local' } } as const;
    const allTables = [...new Set([...ALWAYS_REQUIRED_TABLES, ...Object.values(TABLES_BY_CAPABILITY).flat()])];
    const migrationFiles = ['0001_init.sql', '0002_giving.sql', '0003_registration.sql', '0004_custom_pages.sql', '0005_children_checkin.sql', '0006_page_builder.sql', '0007_member_portal.sql'];
    expect(await checkDatabase({ db: fakeDb(full, { tables: allTables.map((table_name) => ({ table_name })) }), catalog, manifest: full, readDir: async () => migrationFiles }))
      .toEqual([expect.objectContaining({ code: 'database.ok' })]);
    for (const [capability, owned] of Object.entries(TABLES_BY_CAPABILITY)) {
      for (const missing of owned) {
        const tables = allTables.filter((name) => name !== missing).map((table_name) => ({ table_name }));
        const findings = await checkDatabase({ db: fakeDb(full, { tables }), catalog, manifest: full, readDir: async () => migrationFiles });
        expect(findings.map((entry) => entry.code), `${capability} must require ${missing}`).toContain('database.tables');
      }
    }
    for (const missing of ALWAYS_REQUIRED_TABLES) {
      const tables = allTables.filter((name) => name !== missing).map((table_name) => ({ table_name }));
      const findings = await checkDatabase({ db: fakeDb(full, { tables }), catalog, manifest: full, readDir: async () => migrationFiles });
      expect(findings.map((entry) => entry.code), `core must require ${missing}`).toContain('database.tables');
    }
  });

  it('checks migration-created tables independently for each compatible provider', async () => {
    const createdByProvider: Record<'d1' | 'supabase', Set<string>> = { d1: new Set(), supabase: new Set() };
    for (const [provider, directory] of [['d1', 'migrations'], ['supabase', 'migrations-supabase']] as const) {
      for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql'))) {
        const sql = await readFile(`${directory}/${file}`, 'utf8');
        for (const match of sql.matchAll(/\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z][a-z0-9_]*)"?/gi)) {
          createdByProvider[provider].add(match[1]);
        }
      }
    }
    expect(missingRequiredTables(catalog, 'd1', createdByProvider.d1)).toEqual([]);
    expect(missingRequiredTables(catalog, 'supabase', createdByProvider.supabase)).toEqual([]);

    const d1MissingSermons = new Set(createdByProvider.d1); d1MissingSermons.delete('sermons');
    const pgMissingSermons = new Set(createdByProvider.supabase); pgMissingSermons.delete('sermons');
    expect(createdByProvider.supabase.has('sermons')).toBe(true);
    expect(createdByProvider.d1.has('sermons')).toBe(true);
    expect(missingRequiredTables(catalog, 'd1', d1MissingSermons)).toContain('sermons');
    expect(missingRequiredTables(catalog, 'supabase', pgMissingSermons)).toContain('sermons');
  });
});

describe('doctor capability services check', () => {
  it('reports required R2, email by mode, exact Stripe states, and optional backup', async () => {
    const full = { ...baseManifest, mode: 'deploy', preset: 'full-church', modules: [...catalog.presets['full-church'].modules], database: 'supabase', resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-church-media', hyperdriveId: 'hd' } } as const;
    const absent = await checkServices({ catalog, manifest: full, presence: { worker: false, r2: false, hyperdrive: false, email: false, emailDevLog: false, stripeSecretKey: false, stripeWebhookSecret: false, backup: false } });
    expect(absent.map((entry) => entry.code)).toEqual(['services.worker', 'services.r2', 'services.hyperdrive', 'services.email', 'services.stripe-absent', 'services.backup-absent']);
    expect(absent.find((entry) => entry.code === 'services.stripe-absent')?.message).toMatch(/free registration.*offline giving/i);
    const partial = await checkServices({ catalog, manifest: full, presence: { worker: true, r2: true, hyperdrive: true, email: true, emailDevLog: false, stripeSecretKey: true, stripeWebhookSecret: false, backup: true } });
    expect(partial.map((entry) => [entry.code, entry.severity])).toEqual([
      ['services.worker-ok', 'info'], ['services.r2-ok', 'info'], ['services.hyperdrive-ok', 'info'], ['services.email-ok', 'info'], ['services.stripe-partial', 'error'], ['services.backup-ok', 'info'],
    ]);
    const complete = await checkServices({ catalog, manifest: full, presence: { worker: true, r2: true, hyperdrive: true, email: true, emailDevLog: false, stripeSecretKey: true, stripeWebhookSecret: true, backup: false } });
    expect(complete.find((entry) => entry.code === 'services.stripe-ok')?.severity).toBe('info');
    expect(complete.find((entry) => entry.code === 'services.backup-absent')?.severity).toBe('info');
    const local = await checkServices({ catalog, manifest: baseManifest, presence: { worker: true, r2: true, hyperdrive: false, email: false, emailDevLog: true, stripeSecretKey: false, stripeWebhookSecret: false, backup: false } });
    expect(local.map((entry) => entry.code)).toEqual(['services.worker-ok', 'services.r2-ok', 'services.email-dev', 'services.backup-absent']);
  });

  it('fails missing mandatory email/Stripe and unknown required services instead of silently ignoring them', async () => {
    const future: any = structuredClone(catalog);
    future.providers.d1.requiredServices = ['worker', 'r2', 'email', 'stripe', 'mystery'];
    const findings = await checkServices({ catalog: future, manifest: baseManifest, presence: { worker: true, r2: true, hyperdrive: false, email: false, emailDevLog: false, stripeSecretKey: false, stripeWebhookSecret: false, backup: false } });
    expect(findings.map((entry) => [entry.code, entry.severity])).toEqual([
      ['services.required-unsupported', 'error'], ['services.worker-ok', 'info'], ['services.r2-ok', 'info'],
      ['services.email', 'error'], ['services.stripe-absent', 'error'], ['services.backup-absent', 'info'],
    ]);
    const optional: any = structuredClone(catalog);
    optional.capabilities.bulletins.optionalServices = ['stripe'];
    const optionalFindings = await checkServices({ catalog: optional, manifest: baseManifest, presence: { worker: true, r2: true, hyperdrive: false, email: false, emailDevLog: true, stripeSecretKey: false, stripeWebhookSecret: false, backup: false } });
    expect(optionalFindings.map((entry) => [entry.code, entry.severity])).toContainEqual(['services.stripe-absent', 'warning']);
  });
});

describe('doctor composition', () => {
  it('keeps deterministic group order, converts check exceptions, redacts, and computes strict exit code', async () => {
    const doctor = await runDoctor({
      secrets: ['postgres://bob:secret-value@db.example/church'],
      checkManifest: async () => [result('manifest.ok', 'info', 'ok', 'none')],
      checkConfig: async () => { throw new Error('failed postgres://bob:secret-value@db.example/church'); },
      checkDatabase: async () => [result('database.warn', 'warning', 'limited', 'repair')],
      checkServices: async () => [result('services.ok', 'info', 'ok', 'none')],
    }, { strict: true });
    expect(doctor.checks.map((entry) => entry.code)).toEqual(['manifest.ok', 'config.exception', 'database.warn', 'services.ok']);
    expect(doctor.status).toBe('not-ready');
    expect(doctor.exitCode).toBe(1);
    expect(JSON.stringify(doctor)).not.toContain('secret-value');
    expect(Object.isFrozen(doctor)).toBe(true);
    await expect(runDoctor({} as any)).rejects.toThrow(/checkManifest/i);
    await expect(runDoctor({ checkManifest() {}, checkConfig() {}, checkDatabase() {}, checkServices() {} } as any, { strict: 'yes' as any })).rejects.toThrow(/strict must be a boolean/i);
    const duplicate = await runDoctor({
      checkManifest: () => [result('shared.code', 'info', 'ok', 'none')],
      checkConfig: () => [result('shared.code', 'info', 'ok', 'none')],
      checkDatabase: () => [],
      checkServices: () => [],
    });
    expect(duplicate.checks.map((entry) => entry.code)).toEqual(['shared.code', 'config.exception']);
  });

  it('reserves scoped exception codes and preserves structural output under adversarial secret names', async () => {
    const context = {
      secrets: ['A=a', 'database', 'remediation'],
      checkManifest: () => [result('config.exception', 'info', 'database remediation A=a', 'database remediation')],
      checkConfig: () => [result('config.exception', 'info', 'database remediation A=a', 'database remediation')],
      checkDatabase: () => { throw new Error('database remediation A=a'); },
      checkServices: () => [],
    };
    const doctor = await runDoctor(context);
    expect(doctor.schemaVersion).toBe(1);
    expect(doctor.status).toBe('not-ready');
    expect(doctor.checks.map((entry) => entry.code)).toEqual(['manifest.exception', 'config.exception', 'database.exception']);
    expect(Object.keys(doctor)).toEqual(['schemaVersion', 'status', 'checks', 'exitCode']);
    expect(doctor.checks.every((entry) => Object.keys(entry).sort().join('|') === 'code|message|remediation|severity')).toBe(true);
    expect(doctor.checks.some((entry) => entry.message.includes('database') || entry.remediation.includes('database'))).toBe(false);
  });
});
