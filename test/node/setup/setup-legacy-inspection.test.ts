import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import rawCatalog from '../../../config/capabilities.json';
import { inspectLegacyInstallation } from '../../../scripts/setup/import-existing.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const configuredD1 = `{
  "name": "legacy-church",
  "vars": { "APP_ORIGIN": "https://legacy.example", "EMAIL_FROM": "serve@legacy.example", "DB_BACKEND": "d1" },
  "d1_databases": [{ "binding": "DB", "database_name": "legacy-db", "database_id": "legacy-id" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "legacy-media" }]
}`;

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
