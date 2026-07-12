import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import raw from '../../../config/capabilities.json';
import {
  manifestFromPlan,
  renderManifest,
  validateManifest,
} from '../../../scripts/setup/manifest.mjs';
import { renderWrangler } from '../../../scripts/setup/render-wrangler.mjs';
import {
  GENERATED_MARKER,
  _syncParentDirectory,
  classifyConfig,
  writeAtomic,
} from '../../../scripts/setup/files.mjs';
import { importExistingInstallation } from '../../../scripts/setup/import-existing.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const dirs: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'church-setup-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const plan = {
  planVersion: 1,
  mode: 'local',
  site: {
    slug: 'grace-church',
    name: 'Grace Church',
    locale: 'en',
    appOrigin: 'http://localhost:4321',
    emailFrom: 'serve@grace-church.invalid',
  },
  adminEmail: 'admin@example.com',
  adminName: 'Grace Admin',
  preset: null,
  modules: ['sermons'],
  backend: 'd1',
  demoData: true,
  resources: {
    d1DatabaseName: 'grace-church-db',
    d1DatabaseId: 'local',
    r2BucketName: 'grace-church-media',
    hyperdriveId: null,
  },
};

const manifest = () => manifestFromPlan(plan, raw);

describe('installation manifest', () => {
  it('renders deterministic, secret-free versioned JSON', () => {
    const one = renderManifest(plan, raw);

    expect(one).toBe(renderManifest(plan, raw));
    expect(one.endsWith('\n')).toBe(true);
    expect(validateManifest(JSON.parse(one), raw)).toMatchObject({
      schemaVersion: 1,
      database: 'd1',
    });
    expect(one).not.toMatch(/password|secret|connection/i);
  });

  it('copies plan data instead of retaining mutable module and resource references', () => {
    const mutable = structuredClone(plan);
    const result = manifestFromPlan(mutable, raw);
    mutable.modules.push('events');
    mutable.resources.d1DatabaseName = 'changed';

    expect(result.modules).toEqual(['sermons']);
    expect(result.resources.d1DatabaseName).toBe('grace-church-db');
  });

  it.each([
    ['unknown top-level field', { ...manifest(), token: 'credential' }],
    ['unknown site field', { ...manifest(), site: { ...manifest().site, password: 'x' } }],
    ['unknown resource field', { ...manifest(), resources: { ...manifest().resources, apiKey: 'x' } }],
    ['wrong schema', { ...manifest(), schemaVersion: 2 }],
    ['unknown module', { ...manifest(), modules: ['not-a-module'] }],
    ['module incompatible with D1', { ...manifest(), modules: ['giving'] }],
    ['duplicate module', { ...manifest(), modules: ['sermons', 'sermons'] }],
    ['preset/module mismatch', { ...manifest(), preset: 'website', modules: ['sermons'] }],
    ['unsafe slug', { ...manifest(), site: { ...manifest().site, slug: '../church' } }],
    ['URL with credentials', { ...manifest(), site: { ...manifest().site, appOrigin: 'https://user:pass@example.com' } }],
    ['URL with a path', { ...manifest(), site: { ...manifest().site, appOrigin: 'https://example.com/path' } }],
    ['non-local HTTP URL', { ...manifest(), site: { ...manifest().site, appOrigin: 'http://example.com' } }],
    ['unsafe resource name', { ...manifest(), resources: { ...manifest().resources, r2BucketName: '../media' } }],
    ['D1 manifest with Hyperdrive', { ...manifest(), resources: { ...manifest().resources, hyperdriveId: 'hd-id' } }],
    ['malformed sender', { ...manifest(), site: { ...manifest().site, emailFrom: 'serve..team@example.com' } }],
    ['noncanonical sender casing', { ...manifest(), site: { ...manifest().site, emailFrom: 'Serve@Example.com' } }],
    ['sender whitespace', { ...manifest(), site: { ...manifest().site, emailFrom: ' serve@example.com ' } }],
    ['noncanonical origin casing', { ...manifest(), site: { ...manifest().site, appOrigin: 'https://Example.com' } }],
    ['origin trailing slash', { ...manifest(), site: { ...manifest().site, appOrigin: 'https://example.com/' } }],
    ['origin whitespace', { ...manifest(), site: { ...manifest().site, appOrigin: ' https://example.com ' } }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateManifest(value, raw)).toThrow(/manifest|schema|unknown|duplicate|invalid|must/i);
  });

  it('accepts a strictly shaped Supabase manifest', () => {
    const value = {
      ...manifest(),
      mode: 'deploy',
      database: 'supabase',
      site: { ...manifest().site, appOrigin: 'https://grace.example' },
      resources: {
        d1DatabaseName: null,
        d1DatabaseId: null,
        r2BucketName: 'grace-church-media',
        hyperdriveId: '0123456789abcdef0123456789abcdef',
      },
    };

    expect(validateManifest(value, raw)).toEqual(value);
  });

  it('accepts preset modules only when membership exactly matches the preset', () => {
    const value = {
      ...manifest(),
      preset: 'website',
      modules: [...raw.presets.website.modules],
    };

    expect(validateManifest(value, raw)).toEqual(value);
  });
});

describe('Wrangler rendering', () => {
  it('renders D1 config with every controlled token consumed', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const output = renderWrangler(template, manifest());

    expect(output).toContain(GENERATED_MARKER);
    expect(output).toContain('"binding": "DB"');
    expect(output).toContain('"database_name": "grace-church-db"');
    expect(output).not.toContain('"hyperdrive"');
    expect(output).not.toMatch(/@@[A-Z_]+@@/);
  });

  it('renders only the Hyperdrive provider block for Supabase', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const supabase = {
      ...manifest(),
      mode: 'deploy',
      database: 'supabase',
      site: { ...manifest().site, appOrigin: 'https://grace.example' },
      resources: {
        d1DatabaseName: null,
        d1DatabaseId: null,
        r2BucketName: 'grace-church-media',
        hyperdriveId: '0123456789abcdef0123456789abcdef',
      },
    };
    const output = renderWrangler(template, supabase);

    expect(output).toContain('"binding": "HYPERDRIVE"');
    expect(output).not.toContain('"d1_databases"');
  });

  it('renders local Supabase with a non-secret placeholder id and no connection string', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const localPlan = { ...plan, backend: 'supabase', resources: undefined };
    const localManifest = manifestFromPlan(localPlan, raw);
    const output = renderWrangler(template, localManifest);

    expect(localManifest.resources.hyperdriveId).toBe('local');
    expect(output).toContain('"binding": "HYPERDRIVE"');
    expect(output).toContain('"id": "local"');
    expect(output).not.toContain('"null"');
    expect(output).not.toMatch(/connection/i);
  });

  it.each([
    ['D1 database id', { ...manifest(), mode: 'deploy', resources: { ...manifest().resources, d1DatabaseId: null } }],
    ['Hyperdrive id', {
      ...manifest(),
      mode: 'deploy',
      database: 'supabase',
      site: { ...manifest().site, appOrigin: 'https://grace.example' },
      resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-media', hyperdriveId: null },
    }],
  ])('requires a deploy %s', async (_label, value) => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    expect(() => renderWrangler(template, value)).toThrow(/requires/i);
  });

  it.each([
    ['unknown database', { ...manifest(), database: 'neon' }],
    ['missing D1 name', { ...manifest(), resources: { ...manifest().resources, d1DatabaseName: null } }],
    ['missing local D1 id', { ...manifest(), resources: { ...manifest().resources, d1DatabaseId: null } }],
    ['missing local Hyperdrive id', {
      ...manifest(),
      database: 'supabase',
      resources: { d1DatabaseName: null, d1DatabaseId: null, r2BucketName: 'grace-media', hyperdriveId: null },
    }],
    ['missing R2 bucket', { ...manifest(), resources: { ...manifest().resources, r2BucketName: null } }],
    ['unsafe R2 bucket', { ...manifest(), resources: { ...manifest().resources, r2BucketName: '../media' } }],
  ])('rejects direct rendering with %s', async (_label, value) => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    expect(() => renderWrangler(template, value)).toThrow(/database|requires|resource/i);
  });

  it('requires every controlled token exactly once', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');

    expect(() => renderWrangler(template.replace('@@WORKER_NAME@@', 'fixed'), manifest())).toThrow(/exactly once/i);
    expect(() => renderWrangler(`${template}@@WORKER_NAME@@`, manifest())).toThrow(/exactly once/i);
  });

  it('rejects unknown unresolved tokens', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    expect(() => renderWrangler(`${template}@@UNRECOGNIZED@@`, manifest())).toThrow(/unresolved/i);
  });

  it('JSON-escapes substitutions', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const unsafe = { ...manifest(), site: { ...manifest().site, name: 'A', appOrigin: 'https://example.com/"quoted"' } };
    const output = renderWrangler(template, unsafe);

    expect(output).toContain('https://example.com/\\"quoted\\"');
  });
});

describe('file ownership and atomic writes', () => {
  it('classifies generated, known baseline, and unrecognized config separately', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');

    expect(classifyConfig(baseline, baseline)).toBe('baseline');
    expect(classifyConfig(`${GENERATED_MARKER}\n{}` , baseline)).toBe('generated');
    expect(classifyConfig('{ "name": "hand-edited" }', baseline)).toBe('unrecognized');
  });

  it('creates nested paths atomically and is idempotent', async () => {
    const dir = await temp();
    const path = join(dir, 'nested', 'church.config.json');

    expect(await writeAtomic(path, 'generated', { allowReplace: false })).toEqual({ changed: true, backupPath: null });
    expect(await writeAtomic(path, 'generated', { allowReplace: false })).toEqual({ changed: false, backupPath: null });
    expect(await readFile(path, 'utf8')).toBe('generated');
  });

  it('preserves an existing file when replacement is refused', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'user config');

    await expect(writeAtomic(path, 'generated', { allowReplace: false })).rejects.toThrow(/refusing to overwrite/i);
    expect(await readFile(path, 'utf8')).toBe('user config');
  });

  it('optionally creates a timestamped backup before replacement', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'old config');

    const result = await writeAtomic(path, 'new config', { allowReplace: true, backup: true });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toMatch(/wrangler\.jsonc\.bak-\d{4}-\d{2}-\d{2}T/);
    expect(await readFile(result.backupPath!, 'utf8')).toBe('old config');
    expect(await readFile(path, 'utf8')).toBe('new config');
  });

  it('creates a new exclusive backup name when the timestamped name already exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:34:56.789Z'));
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    const collision = `${path}.bak-2026-07-12T12-34-56-789Z`;
    await writeFile(path, 'approved config');
    await writeFile(collision, 'other backup');

    const result = await writeAtomic(path, 'new config', { allowReplace: true, backup: true });

    expect(result.backupPath).toBe(`${collision}-1`);
    expect(await readFile(collision, 'utf8')).toBe('other backup');
    expect(await readFile(result.backupPath!, 'utf8')).toBe('approved config');
  });

  it('refuses replacement when the approved target changes before rename', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'approved config');

    await expect(writeAtomic(path, 'new config', {
      allowReplace: true,
      beforeReplace: () => writeFile(path, 'changed by another writer'),
    })).rejects.toThrow(/changed.*refusing/i);
    expect(await readFile(path, 'utf8')).toBe('changed by another writer');
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('serializes approval so concurrent writers cannot both replace the same snapshot', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'approved config');
    let releaseFirst!: () => void;
    let announceBarrier!: () => void;
    const atBarrier = new Promise<void>((resolve) => { announceBarrier = resolve; });
    const barrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = writeAtomic(path, 'first config', {
      allowReplace: true,
      beforeReplace: async () => {
        announceBarrier();
        await barrier;
      },
    });
    await atBarrier;

    await expect(writeAtomic(path, 'second config', { allowReplace: true })).rejects.toThrow(
      /configuration write already in progress/i,
    );
    releaseFirst();
    await expect(first).resolves.toMatchObject({ changed: true });
    expect(await readFile(path, 'utf8')).toBe('first config');
  });

  it('reclaims a demonstrably stale dead-owner ticket and preserves the target', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    const lockDir = `${path}.setup-lock`;
    await writeFile(path, 'approved config');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner'), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      createdAt: 0,
      token: 'dead',
    }));

    await expect(writeAtomic(path, 'new config', { allowReplace: true })).resolves.toMatchObject({ changed: true });
    expect(await readFile(path, 'utf8')).toBe('new config');
  });

  it('recovers when both the owner and stale-reclamation guard are demonstrably dead', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    const lockDir = `${path}.setup-lock`;
    const stale = JSON.stringify({ version: 1, pid: 2_147_483_647, createdAt: 0, token: 'dead' });
    await writeFile(path, 'approved config');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner'), stale);
    await writeFile(join(lockDir, 'reclaim'), stale);

    await expect(writeAtomic(path, 'new config', { allowReplace: true })).resolves.toMatchObject({ changed: true });
    expect(await readFile(path, 'utf8')).toBe('new config');
  });

  it.each([
    ['malformed', 'not json'],
    ['recent unknown', JSON.stringify({ version: 1, pid: 2_147_483_647, createdAt: Date.now(), token: 'recent' })],
  ])('refuses a %s lock instead of guessing ownership', async (_label, owner) => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    const lockDir = `${path}.setup-lock`;
    await writeFile(path, 'approved config');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner'), owner);

    await expect(writeAtomic(path, 'new config', { allowReplace: true })).rejects.toThrow(
      /cannot safely reclaim|already in progress/i,
    );
    expect(await readFile(path, 'utf8')).toBe('approved config');
  });

  it('refuses a symbolic-link lock directory', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    const redirected = join(dir, 'redirected');
    await writeFile(path, 'approved config');
    await mkdir(redirected);
    await symlink(redirected, `${path}.setup-lock`);

    await expect(writeAtomic(path, 'new config', { allowReplace: true })).rejects.toThrow(/lock.*symbolic|refus/i);
    expect(await readdir(redirected)).toEqual([]);
  });

  it('clearly refuses a non-directory lock path', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'approved config');
    await writeFile(`${path}.setup-lock`, 'unknown lock');

    await expect(writeAtomic(path, 'new config', { allowReplace: true })).rejects.toThrow(/refusing.*lock/i);
    expect(await readFile(path, 'utf8')).toBe('approved config');
  });

  it('ignores only documented unsupported directory-sync errors', async () => {
    const unsupported = {
      sync: () => Promise.reject(Object.assign(new Error('unsupported'), { code: 'EINVAL' })),
      close: () => Promise.resolve(),
    };
    await expect(_syncParentDirectory('/tmp/file', async () => unsupported)).resolves.toBeUndefined();
    await expect(_syncParentDirectory('/tmp/file', async () => {
      throw Object.assign(new Error('unsupported open'), { code: 'ENOTSUP' });
    })).resolves.toBeUndefined();

    const failed = {
      sync: () => Promise.reject(Object.assign(new Error('disk failure'), { code: 'EIO' })),
      close: () => Promise.resolve(),
    };
    await expect(_syncParentDirectory('/tmp/file', async () => failed)).rejects.toThrow(/disk failure/i);
  });

  it('cleans its exclusive temporary file when writing fails', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');

    await expect(writeAtomic(path, Symbol('invalid') as unknown as string, { allowReplace: true })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not delete another writer\'s colliding exclusive temporary file', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const collision = `${path}.tmp-${process.pid}-123-8`;
    await writeFile(collision, 'other writer');

    await expect(writeAtomic(path, 'generated', { allowReplace: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(collision, 'utf8')).toBe('other writer');
  });
});

describe('existing installation import', () => {
  it('returns a normalized, read-only legacy proposal', () => {
    const proposal = importExistingInstallation({
      catalog: raw,
      config: {
        backend: 'd1',
        siteSlug: ' Existing ',
        appOrigin: 'https://existing.example/',
        emailFrom: 'SERVE@EXISTING.EXAMPLE',
        resources: {
          d1DatabaseName: 'existing-db',
          d1DatabaseId: 'abc',
          r2BucketName: 'existing-media',
          hyperdriveId: null,
        },
      },
      settings: {
        'module.sermons': '0',
        'module.events': 'false',
        'site.name.en': 'Existing Church',
        'locale.default': 'en',
      },
      admins: [{ email: 'OWNER@EXAMPLE.COM', display_name: ' Owner ' }],
    });

    expect(proposal).toMatchObject({
      existingBackend: 'd1',
      mode: 'deploy',
      siteSlug: 'existing',
      churchName: 'Existing Church',
      locale: 'en',
      appOrigin: 'https://existing.example',
      emailFrom: 'serve@existing.example',
      adminEmail: 'owner@example.com',
      adminName: 'Owner',
      resources: {
        d1DatabaseName: 'existing-db',
        d1DatabaseId: 'abc',
        r2BucketName: 'existing-media',
        hyperdriveId: null,
      },
      mutations: [],
    });
    expect(proposal.modules).not.toContain('sermons');
    expect(proposal.modules).toContain('events');
    expect(proposal.modules).toContain('bulletins');
  });

  it('defaults a missing legacy backend to D1 and round-trips deployed resources through planning', () => {
    const settings = Object.fromEntries(raw.order.map((key) => [
      `module.${key}`,
      ['portal', 'giving', 'registration'].includes(key) ? '0' : '1',
    ]));
    const proposal = importExistingInstallation({
      catalog: raw,
      config: {
        siteSlug: 'existing',
        appOrigin: 'https://existing.example',
        emailFrom: 'serve@existing.example',
        resources: {
          d1DatabaseName: 'existing-db',
          d1DatabaseId: 'existing-id',
          r2BucketName: 'existing-media',
          hyperdriveId: null,
        },
      },
      settings: {
        ...settings,
        'site.name.en': 'Existing Church',
        'locale.default': 'en',
      },
      admins: [{ email: 'owner@example.com', display_name: 'Owner' }],
    });

    const importedPlan = buildSetupPlan(proposal, raw, proposal.currentState);
    const importedManifest = manifestFromPlan(importedPlan, raw);
    expect(proposal.existingBackend).toBe('d1');
    expect(proposal.currentState).toEqual({
      existingBackend: 'd1',
      resources: {
        d1DatabaseName: 'existing-db',
        d1DatabaseId: 'existing-id',
        r2BucketName: 'existing-media',
        hyperdriveId: null,
      },
    });
    expect(importedPlan.resources).toEqual(proposal.currentState.resources);
    expect(importedManifest.resources).toEqual(proposal.currentState.resources);
    expect(() => buildSetupPlan({ ...proposal, modules: ['portal'], backendOverride: undefined }, raw, proposal.currentState)).toThrow(
      /D1-to-Supabase content migration is not implemented/i,
    );
  });

  it.each([
    [{ backend: 'neon', resources: {} }, /backend/i],
    [{ backend: 'd1', resources: { d1DatabaseName: '../unsafe', d1DatabaseId: 'id', r2BucketName: 'media', hyperdriveId: null } }, /d1DatabaseName/i],
    [{ backend: 'd1', resources: { d1DatabaseName: 'db', d1DatabaseId: 'id', r2BucketName: 'media', hyperdriveId: null, password: 'unsafe' } }, /unknown fields/i],
  ])('rejects unsafe imported provider state', (config, error) => {
    expect(() => importExistingInstallation({ catalog: raw, config, settings: {}, admins: [] })).toThrow(error);
  });

  it.each([
    ['http://localhost:4321', 'local'],
    ['http://127.0.0.1:4321', 'local'],
    ['http://[::1]:4321', 'local'],
    ['https://localhost.evil', 'deploy'],
  ])('infers %s as %s mode using parsed hostnames', (appOrigin, mode) => {
    const proposal = importExistingInstallation({
      catalog: raw,
      config: {
        siteSlug: 'existing',
        appOrigin,
        resources: {
          d1DatabaseName: 'existing-db',
          d1DatabaseId: 'existing-id',
          r2BucketName: 'existing-media',
          hyperdriveId: null,
        },
      },
      settings: {},
      admins: [],
    });

    expect(proposal.mode).toBe(mode);
    expect(proposal.appOrigin).toBe(appOrigin);
  });

  it.each([
    { admins: [] },
    { admins: [{ email: 'one@example.com', display_name: 'One' }, { email: 'two@example.com', display_name: 'Two' }] },
  ])(
    'does not guess admin identity unless exactly one active admin exists',
    ({ admins }) => {
      const proposal = importExistingInstallation({
        catalog: raw,
        config: {
          backend: 'supabase',
          siteSlug: 'existing',
          resources: {
            d1DatabaseName: null,
            d1DatabaseId: null,
            r2BucketName: 'existing-media',
            hyperdriveId: 'existing-hyperdrive',
          },
        },
        settings: {},
        admins,
      });

      expect(proposal.adminEmail).toBeUndefined();
      expect(proposal.adminName).toBeUndefined();
      expect(proposal.resources).toEqual({
        d1DatabaseName: null,
        d1DatabaseId: null,
        r2BucketName: 'existing-media',
        hyperdriveId: 'existing-hyperdrive',
      });
      expect(proposal.mutations).toEqual([]);
    },
  );
});
