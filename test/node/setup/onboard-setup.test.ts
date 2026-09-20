import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { parseSetupArgs } from '../../../scripts/setup/args.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';
import { runSetup } from '../../../scripts/setup/index.mjs';
import { buildSetupRerunCommand } from '../../../scripts/setup/failure.mjs';
import { assertOnboardingInstallation, brandingConfig, createOnboardingStep, loadSetupPreferences, mergePreferenceAnswers, withOnboardingPlan } from '../../../scripts/setup/onboarding.mjs';
import { normalizePreferences, savePreferences } from '../../../scripts/onboard/preferences.mjs';
import { fingerprintPlan, createStateStore } from '../../../scripts/setup/state.mjs';
import { applySetup } from '../../../scripts/setup/apply.mjs';
import { applyLocalBranding, contrastViolations, generateCss, readLocalBranding } from '../../../scripts/build-tokens.mjs';
import foundation from '../../../design/foundation.json';
import sanctuary from '../../../design/themes/sanctuary.json';
import harvest from '../../../design/themes/harvest.json';

const temporary: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'c4c-onboard-setup-'));
  temporary.push(root);
  return root;
}
function preferences() {
  return normalizePreferences({ schemaVersion: 1,
    organization: { type: 'nonprofit', name: 'Our Organization', tagline: 'A place for everyone', address: '123 Main Street', timezone: 'America/Chicago' },
    branding: { primaryColor: '#ABCDEF', secondaryColor: '#FFAA00', logo: null },
    setup: { siteSlug: 'our-organization', locale: 'zh', adminName: 'First Admin', adminEmail: 'admin@example.test', demoData: true, modules: ['events', 'sermons'] },
  }, catalog);
}
function plan(flags: string[] = [], prefs = preferences()) {
  const parsed = parseSetupArgs(['--preferences', '.church/preferences.json', ...flags], catalog);
  if (!('preferences' in parsed)) throw new Error('Expected setup answers');
  const answers = mergePreferenceAnswers(parsed, prefs, catalog);
  return withOnboardingPlan(buildSetupPlan(answers, catalog), prefs, parsed.preferences, answers.modules);
}
function database() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE media (r2_key TEXT PRIMARY KEY, filename TEXT, content_type TEXT, size INTEGER, uploaded_by TEXT)');
  const db = { prepare(sql: string) {
    let values: any[] = [];
    const statement = {
      bind(...args: any[]) { values = args; return statement; },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...values); return (column ? row?.[column] : row) ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { results: [], meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }, async batch(statements: any[]) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { db, sqlite };
}

describe('browser onboarding setup import', () => {
  it('accepts an explicit preferences file without doing I/O in the parser', () => {
    expect(parseSetupArgs(['--preferences', '.church/preferences.json', '--dry-run'], catalog))
      .toMatchObject({ preferences: '.church/preferences.json', dryRun: true });
  });

  it('uses saved choices and allows explicit flags to replace identity/content/feature selection', () => {
    const imported = plan();
    expect(imported).toMatchObject({ mode: 'local', backend: 'd1', demoData: true,
      site: { name: 'Our Organization', slug: 'our-organization', locale: 'zh' }, modules: ['sermons', 'events'] });
    expect(imported.onboarding).not.toHaveProperty('requestedModules');
    const replaced = plan(['--church-name', 'Override', '--locale', 'en', '--preset', 'website', '--no-demo-data']);
    expect(replaced).toMatchObject({ demoData: false, site: { name: 'Override', locale: 'en' }, preset: 'website' });
    expect(replaced.modules).toEqual(catalog.presets.website.modules);
    expect(replaced.onboarding.organization.name).toBe('Override');
    expect(plan(['--modules', 'bulletins']).modules).toEqual(['bulletins']);
    expect(plan(['--modules', 'portal']).backend).toBe('supabase');
  });

  it('retains deploy requirements and rejects mixed or invalid explicit flags', () => {
    expect(() => plan(['--mode', 'deploy'])).toThrow(/appOrigin/);
    expect(() => plan(['--preset', 'website', '--modules', 'events'])).toThrow(/cannot be combined/);
    expect(() => plan(['--locale', 'fr'])).toThrow(/locale/);
    expect(() => parseSetupArgs(['--doctor', '--preferences', 'x.json'], catalog)).toThrow(/cannot be combined/);
  });

  it('inherits local mode before validating an explicit HTTP loopback origin', () => {
    const desired = plan(['--app-origin', 'http://127.0.0.1:4322']);
    expect(desired).toMatchObject({ mode: 'local', site: { appOrigin: 'http://127.0.0.1:4322' } });
    expect(() => plan(['--mode', 'deploy', '--app-origin', 'http://127.0.0.1:4322']))
      .toThrow(/HTTPS origin/);
  });

  it('dry-run imports saved data, previews branding, and never applies or writes files', async () => {
    const root = await directory();
    await savePreferences(root, preferences(), catalog);
    const before = await readFile(join(root, '.church/preferences.json'), 'utf8');
    const output = vi.fn(); const apply = vi.fn(); const preflightConfig = vi.fn();
    const loadPreferences = (source: string) => loadSetupPreferences(root, source, catalog);
    const deps = { catalog, interactive: false, output, apply, preflightConfig, loadPreferences,
      formatPlan: JSON.stringify, inspectExisting: async () => ({}),
      assertOnboardingInstallation: (desired: any, state: any) => assertOnboardingInstallation(root, desired, state) };
    expect(await runSetup(['--preferences', '.church/preferences.json', '--modules', 'learning', '--dry-run', '--json'], deps)).toBe(0);
    const result = JSON.parse(output.mock.calls[0][0]);
    expect(result).toMatchObject({ kind: 'setup-plan', plan: { backend: 'd1', modules: ['people', 'learning'], onboarding: { requestedModules: ['learning'], branding: { primaryColor: '#ABCDEF' } } } });
    expect(result.plan.actions).toContain('initialize-branding');
    expect(apply).not.toHaveBeenCalled(); expect(preflightConfig).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['.church']);
    expect(await readdir(join(root, '.church'))).toEqual(['preferences.json']);
    expect(await readFile(join(root, '.church/preferences.json'), 'utf8')).toBe(before);
  });

  it('validates imported data and logo before provisioning, and rejects symlink files', async () => {
    const root = await directory();
    await mkdir(join(root, '.church'));
    const source = join(root, '.church/preferences.json');
    await writeFile(source, JSON.stringify({ ...preferences(), schemaVersion: 99 }));
    await expect(loadSetupPreferences(root, source, catalog)).rejects.toThrow(/schemaVersion/);
    const invalid = preferences(); invalid.branding.primaryColor = 'red; background:url(x)';
    await writeFile(source, JSON.stringify(invalid));
    await expect(loadSetupPreferences(root, source, catalog)).rejects.toThrow(/color/);
    await rm(source); await writeFile(join(root, 'valid.json'), JSON.stringify(preferences()));
    await symlink(join(root, 'valid.json'), source);
    await expect(loadSetupPreferences(root, source, catalog)).rejects.toThrow(/regular JSON file/);
  });

  it('blocks different preference plans on established installs while permitting an exact resume', async () => {
    const root = await directory(); const desired = plan();
    await expect(assertOnboardingInstallation(root, desired, {})).resolves.toBeUndefined();
    await expect(assertOnboardingInstallation(root, desired, { existingBackend: 'd1' })).rejects.toThrow(/existing installation/i);
    await mkdir(join(root, '.church'));
    await writeFile(join(root, '.church/setup-state.json'), JSON.stringify({ schemaVersion: 2, installationOrigin: 'managed', planFingerprint: fingerprintPlan(desired), completed: {} }));
    await expect(assertOnboardingInstallation(root, desired, { existingBackend: 'd1' })).resolves.toBeUndefined();
    await expect(assertOnboardingInstallation(root, plan(['--modules', 'bulletins']), { existingBackend: 'd1' })).rejects.toThrow(/original preferences/);
  });

  it.each([
    { flags: [] },
    { flags: ['--preset', 'website'] },
    { flags: ['--backend', 'supabase'] },
    { flags: ['--modules', 'learning'] },
    { flags: ['--modules', 'learning,newcomers'] },
  ])('recovery command preserves the preference plan fingerprint and can resume ($flags)', async ({ flags }) => {
    const desired = plan(flags);
    const command = buildSetupRerunCommand(desired);
    // Generated command uses shell-quoted arguments; this fixture has no single quotes.
    const args = [...command.slice(command.indexOf(' -- ') + 4).matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]);
    const parsed = parseSetupArgs(args, catalog);
    if (!('preferences' in parsed)) throw new Error('Expected setup answers');
    const answers = mergePreferenceAnswers(parsed, preferences(), catalog);
    const resumed = withOnboardingPlan(buildSetupPlan(answers, catalog), preferences(), parsed.preferences, answers.modules);
    expect(fingerprintPlan(resumed)).toBe(fingerprintPlan(desired));
    const root = await directory();
    await mkdir(join(root, '.church'));
    await writeFile(join(root, '.church/setup-state.json'), JSON.stringify({ schemaVersion: 2, installationOrigin: 'managed', planFingerprint: fingerprintPlan(desired), completed: {} }));
    await expect(assertOnboardingInstallation(root, resumed, { existingBackend: desired.backend })).resolves.toBeUndefined();
  });

  it('imports the CLI without running installation or reading preferences', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/setup/index.mjs')"], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  });
});

describe('one-time branding application', () => {
  it('initializes identity and local palette, then preserves later administrator customization', async () => {
    const root = await directory(); const { db, sqlite } = database(); const desired = plan();
    sqlite.exec("INSERT INTO settings VALUES ('site.name.en','Fictional church'),('site.name.zh','示例教会'),('locale.default','en')");
    const buildTokens = vi.fn(async () => {}); const uploadObject = vi.fn();
    const step = createOnboardingStep({ root, db, buildTokens, uploadObject });
    const context = { plan: desired, managedInstallation: true };
    expect(await step.verify(context)).toBe(false);
    await step.apply(context);
    expect(await step.verify(context)).toBe(true);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.en'").get()?.value).toBe('Our Organization');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.zh'").get()?.value).toBe('Our Organization');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.address'").get()?.value).toBe('123 Main Street');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='locale.default'").get()?.value).toBe('zh');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='theme.default_mode'").get()?.value).toBe('light');
    expect(JSON.parse(await readFile(join(root, '.church/branding.json'), 'utf8'))).toEqual(brandingConfig(desired));
    sqlite.exec("UPDATE settings SET value='Administrator change' WHERE key='site.name.en'");
    sqlite.exec("UPDATE settings SET value='en' WHERE key='locale.default'; UPDATE settings SET value='dark' WHERE key='theme.default_mode'");
    await writeFile(join(root, '.church/branding.json'), JSON.stringify({ ...brandingConfig(desired), primaryColor: '#112233' }));
    expect(await step.verify(context)).toBe(true);
    await step.apply(context);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.en'").get()?.value).toBe('Administrator change');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='locale.default'").get()?.value).toBe('en');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='theme.default_mode'").get()?.value).toBe('dark');
    expect(readLocalBranding(root).primaryColor).toBe('#112233');
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it('uploads an approved logo through the installer media contract and saves its setting', async () => {
    const root = await directory(); const { db, sqlite } = database();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
    const saved = await savePreferences(root, { ...preferences(), logoUpload: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } }, catalog);
    const desired = plan([], saved);
    const uploadObject = vi.fn(async ({ filePath }: any) => expect(await readFile(filePath)).toEqual(png));
    const step = createOnboardingStep({ root, db, uploadObject, buildTokens: async () => {} });
    await step.apply({ plan: desired, managedInstallation: true });
    expect(uploadObject).toHaveBeenCalledOnce();
    const media = sqlite.prepare('SELECT * FROM media').get();
    expect(media).toMatchObject({ filename: 'logo.png', content_type: 'image/png', uploaded_by: desired.adminEmail });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.logo_image_key'").get()?.value).toBe(media?.r2_key);
  });

  it('resumes after a checkpoint failure without replacing subsequent customization', async () => {
    const root = await directory(); const { db, sqlite } = database(); const desired = { ...plan(), actions: ['initialize-branding'] };
    const step = createOnboardingStep({ root, db, uploadObject: vi.fn(), buildTokens: async () => {} });
    const store = createStateStore(join(root, '.church/setup-state.json'));
    const steps = { 'initialize-branding': step };
    await expect(applySetup(desired, { steps, stateStore: { ...store, mark: async () => { throw new Error('checkpoint failed'); } } })).rejects.toMatchObject({ phase: 'mark' });
    sqlite.exec("UPDATE settings SET value='Changed after interruption' WHERE key='site.name.en'");
    await applySetup(desired, { steps, stateStore: createStateStore(join(root, '.church/setup-state.json')) });
    expect(sqlite.prepare("SELECT value FROM settings WHERE key='site.name.en'").get()?.value).toBe('Changed after interruption');
  });

  it('refuses imported databases and preexisting conflicting local palettes', async () => {
    const root = await directory(); const { db, sqlite } = database(); const desired = plan();
    const step = createOnboardingStep({ root, db, uploadObject: vi.fn(), buildTokens: async () => {} });
    await expect(step.apply({ plan: desired, managedInstallation: false })).rejects.toThrow(/imported/);
    await mkdir(join(root, '.church'));
    await writeFile(join(root, '.church/branding.json'), JSON.stringify({ ...brandingConfig(desired), primaryColor: '#111111' }));
    await expect(step.apply({ plan: desired, managedInstallation: true })).rejects.toThrow(/differs/);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM settings').get()?.n).toBe(0);
  });
});

describe('local branding design tokens', () => {
  it.each([['#FFFFFF', '#000000'], ['#000000', '#FFFFFF'], ['#FFFF00', '#FF00FF'], ['#777777', '#888888']])('keeps contrast pairs valid for %s / %s without altering shipped themes', (primaryColor, secondaryColor) => {
    const before = JSON.stringify(sanctuary);
    const customized = applyLocalBranding([sanctuary, harvest], { schemaVersion: 1, theme: 'sanctuary', primaryColor, secondaryColor });
    expect(contrastViolations(customized)).toEqual([]);
    expect(customized[1]).toBe(harvest);
    expect(JSON.stringify(sanctuary)).toBe(before);
    expect(generateCss(foundation, customized)).toContain(`--color-primary: ${primaryColor};`);
    expect(customized[0].modes.dark.accent).toBe(secondaryColor);
  });

  it('uses stock themes without local branding and rejects arbitrary CSS input', async () => {
    const root = await directory();
    expect(readLocalBranding(root)).toBeNull();
    expect(applyLocalBranding([sanctuary], null)).toEqual([sanctuary]);
    expect(() => applyLocalBranding([sanctuary], { schemaVersion: 1, theme: 'sanctuary', primaryColor: '#fff;}', secondaryColor: '#112233' })).toThrow(/Invalid/);
  });
});
