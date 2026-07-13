import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rawCatalog from '../../../config/capabilities.json';
import { inspectBaselineLocalD1Installation, inspectLegacyInstallation } from '../../../scripts/setup/import-existing.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const configuredD1 = `{
  "name": "legacy-church",
  "vars": { "APP_ORIGIN": "https://legacy.example", "EMAIL_FROM": "serve@legacy.example", "DB_BACKEND": "d1" },
  "d1_databases": [{ "binding": "DB", "database_name": "legacy-db", "database_id": "legacy-id" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "legacy-media" }]
}`;
const BASELINE_D1_FILE = '98c45dfa5a4e37d78dca9e60acc7ab3befe54db3c0cea3ddeb3b53ae3b6ecc30.sqlite';

function legacyDb() {
  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(async () => ({ results: sql.includes('settings') ? [
        { key: 'module.sermons', value: '0' },
        { key: 'site.name.en', value: 'Legacy Church' },
        { key: 'locale.default', value: 'en' },
      ] : [{ email: 'owner@example.test', display_name: 'Owner' }] })),
    })),
  };
}

describe('real legacy installation inspection', () => {
  it('treats the baseline as fresh only when no persisted local D1 exists and never opens D1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-local-d1-empty-'));
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const openD1 = vi.fn();
    try {
      await expect(inspectBaselineLocalD1Installation({
        catalog: rawCatalog,
        root,
        configContent: baseline,
        baselineContent: baseline,
        requestedMode: 'local',
        environment: {},
        openD1,
      })).resolves.toEqual({});
      expect(openD1).not.toHaveBeenCalled();
      await expect(readdir(join(root, '.wrangler'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('opens an existing baseline local D1 and imports names, settings, site identity, and admin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-local-d1-import-'));
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const stateDir = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const stateFile = join(stateDir, BASELINE_D1_FILE);
    await mkdir(stateDir, { recursive: true });
    await writeFile(stateFile, 'existing sqlite bytes');
    const openD1 = vi.fn(() => legacyDb());
    try {
      const proposal: any = await inspectBaselineLocalD1Installation({
        catalog: rawCatalog,
        root,
        configContent: baseline,
        baselineContent: baseline,
        requestedMode: 'local',
        environment: {},
        openD1,
      });
      expect(proposal).toMatchObject({
        existingBackend: 'd1',
        mode: 'local',
        siteSlug: 'church4christ',
        churchName: 'Legacy Church',
        locale: 'en',
        adminEmail: 'owner@example.test',
        adminName: 'Owner',
        resources: {
          d1DatabaseName: 'church4christ-db',
          d1DatabaseId: 'YOUR_D1_DATABASE_ID',
          r2BucketName: 'church4christ-media',
          hyperdriveId: null,
        },
      });
      expect(openD1).toHaveBeenCalledWith(expect.objectContaining({ mode: 'local', persistTo: join(await realpath(root), '.wrangler/state') }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails baseline local import when persisted D1 schema is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-local-d1-incomplete-'));
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const stateDir = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, BASELINE_D1_FILE), 'incomplete sqlite bytes');
    const openD1 = vi.fn(() => ({
      prepare: vi.fn(() => ({ all: vi.fn(async () => { throw new Error('D1_ERROR: no such table: settings'); }) })),
    }));
    try {
      await expect(inspectBaselineLocalD1Installation({
        catalog: rawCatalog,
        root,
        configContent: baseline,
        baselineContent: baseline,
        requestedMode: 'local',
        environment: {},
        openD1,
      })).rejects.toThrow(/settings/i);
      expect(openD1).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves every persisted D1 state file byte-for-byte unchanged during baseline inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-local-d1-readonly-'));
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const stateDir = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const files = {
      [BASELINE_D1_FILE]: 'database bytes',
      [`${BASELINE_D1_FILE}-wal`]: 'wal bytes',
      'metadata.sqlite': 'metadata bytes',
    };
    await mkdir(stateDir, { recursive: true });
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(stateDir, name), content)));
    const beforeNames = await readdir(stateDir);
    const beforeBytes = await Promise.all(beforeNames.map((name) => readFile(join(stateDir, name))));
    try {
      await inspectBaselineLocalD1Installation({
        catalog: rawCatalog,
        root,
        configContent: baseline,
        baselineContent: baseline,
        requestedMode: 'local',
        environment: {},
        openD1: vi.fn(() => legacyDb()),
      });
      expect(await readdir(stateDir)).toEqual(beforeNames);
      const afterBytes = await Promise.all(beforeNames.map((name) => readFile(join(stateDir, name))));
      expect(afterBytes).toEqual(beforeBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the exact baseline fresh and never opens a database', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    const openD1 = vi.fn();
    await expect(inspectLegacyInstallation({ catalog: rawCatalog, configContent: baseline, baselineContent: baseline, requestedMode: 'local', openD1 }))
      .resolves.toEqual({});
    expect(openD1).not.toHaveBeenCalled();
  });

  it('parses configured D1 JSONC and reads modules, localized identity, locale, and active admins read-only', async () => {
    const db = legacyDb();
    const proposal: any = await inspectLegacyInstallation({
      catalog: rawCatalog, configContent: configuredD1, baselineContent: '{}', requestedMode: 'deploy',
      openD1: vi.fn(() => db),
    });
    expect(proposal).toMatchObject({
      existingBackend: 'd1', mode: 'deploy', siteSlug: 'legacy-church', churchName: 'Legacy Church',
      locale: 'en', adminEmail: 'owner@example.test', adminName: 'Owner',
      resources: { d1DatabaseName: 'legacy-db', d1DatabaseId: 'legacy-id', r2BucketName: 'legacy-media', hyperdriveId: null },
    });
    expect(proposal.modules).not.toContain('sermons');
    expect(proposal.modules).toContain('events');
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it('fails closed for unknown backends, unresolved placeholders, and ambiguous bindings', async () => {
    for (const content of [
      configuredD1.replace('"d1"', '"neon"'),
      configuredD1.replace('legacy-id', 'YOUR_D1_DATABASE_ID'),
      configuredD1.replace('"r2_buckets": [', '"r2_buckets": [{ "binding": "OTHER", "bucket_name": "other" },'),
    ]) {
      await expect(inspectLegacyInstallation({ catalog: rawCatalog, configContent: content, baselineContent: '{}', requestedMode: 'deploy', openD1: vi.fn() }))
        .rejects.toThrow(/backend|placeholder|ambiguous|binding/i);
    }
  });

  it('requires a Supabase URL before database access and never leaks or collects it after confirmation', async () => {
    const config = configuredD1
      .replace('"d1"', '"supabase"')
      .replace('"d1_databases": [{ "binding": "DB", "database_name": "legacy-db", "database_id": "legacy-id" }]', '"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "hyper-id" }]');
    const openPostgres = vi.fn();
    await expect(inspectLegacyInstallation({ catalog: rawCatalog, configContent: config, baselineContent: '{}', requestedMode: 'deploy', environment: {}, openPostgres }))
      .rejects.toThrow(/SUPABASE_DB_URL.*legacy/i);
    expect(openPostgres).not.toHaveBeenCalled();
  });

  it('carries current installation state and a proposed diff into the plan and refuses provider migration', async () => {
    const proposal: any = await inspectLegacyInstallation({
      catalog: rawCatalog, configContent: configuredD1, baselineContent: '{}', requestedMode: 'deploy', openD1: vi.fn(() => legacyDb()),
    });
    const requested = {
      mode: 'deploy', preset: 'website', siteSlug: 'new-name', churchName: 'New Name', locale: 'en',
      adminName: 'New Admin', adminEmail: 'new@example.test', appOrigin: 'https://new.example',
      emailFrom: 'serve@new.example', demoData: false,
    };
    const plan = buildSetupPlan(requested, rawCatalog, proposal);
    expect(plan.existingInstallation).toMatchObject({ backend: 'd1', siteSlug: 'legacy-church', adminEmail: 'owner@example.test' });
    expect(plan.proposedChanges).toEqual(expect.arrayContaining([expect.stringMatching(/site/i), expect.stringMatching(/admin/i)]));
    expect(() => buildSetupPlan({ ...requested, preset: 'full-church' }, rawCatalog, proposal)).toThrow(/D1-to-Supabase content migration is not implemented/i);
  });
});
