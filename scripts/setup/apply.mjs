import { fingerprintPlan } from './state.mjs';
import { bootstrapFirstAdmin, initializeModuleSettings } from '../../src/lib/setupDb.mjs';
import { ensureD1Database, ensureR2Bucket } from './providers/d1.mjs';
import { ensureHyperdrive } from './providers/postgres.mjs';
import { validateProviderResources } from './manifest.mjs';

export const SETUP_ACTION_ORDER = Object.freeze(['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor']);

function validateResolvedResources(resources, plan) {
  validateProviderResources(resources, plan.backend, { requireBindingIds: true });
  const expectedR2 = plan.resources?.r2BucketName ?? `${plan.site?.slug}-media`;
  const expectedD1 = plan.resources?.d1DatabaseName ?? `${plan.site?.slug}-db`;
  if (typeof plan.site?.slug !== 'string' || resources.r2BucketName !== expectedR2) throw new Error('Resolved R2 resource name does not match the setup plan');
  if (plan.backend === 'd1' && resources.d1DatabaseName !== expectedD1) throw new Error('Resolved D1 resource name does not match the setup plan');
  return resources;
}

function providerStep(apply, verify, name) {
  if (typeof verify !== 'function') throw new TypeError(`verify.${name} is required`);
  return Object.freeze({ apply, verify });
}

function commonDatabaseSteps(options) {
  if (!options.db || typeof options.db.prepare !== 'function') throw new TypeError('provider AppDb is required');
  if (!Array.isArray(options.moduleKeys)) throw new TypeError('moduleKeys are required');
  return {
    'initialize-modules': providerStep(async ({ plan } = {}) => {
      await initializeModuleSettings(options.db, options.moduleKeys, plan?.modules ?? []);
      const key = `site.name.${plan?.site?.locale}`;
      const current = await options.db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first('value');
      const canonical = plan?.site?.locale === 'zh' ? '四方基督教会' : 'Church4Christ';
      if (current == null || current === canonical) {
        await options.db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).bind(key, plan?.site?.name).run();
      }
      return { changed: true };
    }, options.verify?.['initialize-modules'], 'initialize-modules'),
    'bootstrap-admin': providerStep(async ({ plan } = {}) => {
      const outcome = await bootstrapFirstAdmin(options.db, {
        email: plan?.adminEmail,
        displayName: plan?.adminName,
        locale: plan?.site?.locale,
        promoteExisting: Boolean(options.promoteExistingAdmin),
      });
      return { changed: ['created', 'promoted'].includes(outcome.status) };
    }, options.verify?.['bootstrap-admin'], 'bootstrap-admin'),
  };
}

export function createD1Steps(options) {
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.wranglerBin !== 'string' || !options.wranglerBin) throw new TypeError('wranglerBin is required');
  if (typeof options.configPath !== 'string' || !options.configPath) throw new TypeError('configPath is required');
  if (!['local', 'deploy'].includes(options.mode)) throw new TypeError('D1 mode must be local or deploy');
  const location = options.mode === 'deploy' ? '--remote' : '--local';
  const localPersistence = options.mode === 'local' && options.persistTo ? ['--persist-to', options.persistTo] : [];
  const command = (args) => options.runner.run(options.wranglerBin, [...args, ...localPersistence], { cwd: options.root ?? process.cwd() });
  return Object.freeze({
    migrate: providerStep(async () => {
      await command(['d1', 'migrations', 'apply', 'DB', location, '--config', options.configPath]);
      return { changed: true };
    }, options.verify?.migrate, 'migrate'),
    seed: providerStep(async () => {
      await command(['d1', 'execute', 'DB', location, '--file', 'seed/dev-seed.sql', '--config', options.configPath, '--yes']);
      return { changed: true };
    }, options.verify?.seed, 'seed'),
    ...commonDatabaseSteps(options),
  });
}

export function createSupabaseSteps(options) {
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.root !== 'string' || !options.root) throw new TypeError('root is required');
  if (typeof options.dbUrl !== 'string' || !/^postgres(?:ql)?:\/\//.test(options.dbUrl)) throw new TypeError('Supabase database URL is required');
  const command = (script) => options.runner.run(process.execPath, [script], {
    cwd: options.root,
    env: { ...process.env, SUPABASE_DB_URL: options.dbUrl },
    secretEnvKeys: ['SUPABASE_DB_URL'],
  });
  return Object.freeze({
    migrate: providerStep(async () => { await command('scripts/db/migrate-supabase.mjs'); return { changed: true }; }, options.verify?.migrate, 'migrate'),
    seed: providerStep(async () => { await command('scripts/db/seed-supabase.mjs'); return { changed: true }; }, options.verify?.seed, 'seed'),
    ...commonDatabaseSteps(options),
  });
}

export function createResourceStep(options) {
  if (!options?.plan || !['d1', 'supabase'].includes(options.plan.backend)) throw new TypeError('resource plan backend is required');
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.verify !== 'function') throw new TypeError('resource verify is required');
  return providerStep(async (context = {}) => {
    const { plan } = options;
    const names = {
      d1DatabaseName: plan.resources?.d1DatabaseName ?? `${plan.site.slug}-db`,
      r2BucketName: plan.resources?.r2BucketName ?? `${plan.site.slug}-media`,
    };
    if (plan.resources) validateProviderResources(plan.resources, plan.backend);
    if (plan.mode === 'local') {
      const resolvedResources = Object.freeze({
        d1DatabaseName: plan.backend === 'd1' ? names.d1DatabaseName : null,
        d1DatabaseId: plan.backend === 'd1' ? 'local' : null,
        r2BucketName: names.r2BucketName,
        hyperdriveId: plan.backend === 'supabase' ? 'local' : null,
      });
      if (plan.resources && JSON.stringify(plan.resources) !== JSON.stringify(resolvedResources)) throw new Error('Local resource placeholders do not match the canonical setup resources');
      return { changed: false, resolvedResources };
    }
    const shared = { runner: options.runner, wranglerBin: options.wranglerBin, configPath: options.configPath };
    if (plan.backend === 'd1') {
      const database = await ensureD1Database({ ...shared, name: names.d1DatabaseName });
      const bucket = await ensureR2Bucket({ ...shared, name: names.r2BucketName });
      return { changed: bucket.created || database.created, resolvedResources: Object.freeze({ d1DatabaseName: database.name, d1DatabaseId: database.id, r2BucketName: bucket.name, hyperdriveId: null }) };
    }
    let parsed;
    try { parsed = new URL(options.dbUrl); } catch { throw new Error('Supabase database URL is invalid'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname === '/' || !parsed.username || !parsed.password) throw new Error('Supabase database URL is invalid');
    for (const component of [parsed.username, parsed.password, parsed.pathname]) {
      try { if (/[\0-\x1f\x7f]/.test(decodeURIComponent(component))) throw new Error(); }
      catch { throw new Error('Supabase database URL is invalid'); }
    }
    let hyperdrive;
    if (plan.resources?.hyperdriveId && !context.recovering) {
      try {
        hyperdrive = await ensureHyperdrive({ ...shared, name: `${plan.site.slug}-db` });
      } catch (error) {
        if (/connection string is required/i.test(String(error))) throw new Error('Imported Hyperdrive ID cannot be reconciled by name; refusing to create a replacement');
        throw error;
      }
    } else {
      try {
        hyperdrive = await ensureHyperdrive({ ...shared, name: `${plan.site.slug}-db`, connectionString: options.dbUrl, allowSecretInArgv: options.allowHyperdriveSecretInArgv });
      } catch (error) {
        if (context.recovering && /explicitly confirm|process-list argv/i.test(String(error))) {
          throw new Error('Deleted setup-owned Hyperdrive recovery requires --allow-hyperdrive-secret-in-argv; no resource mutation was performed');
        }
        throw error;
      }
    }
    if (plan.resources?.hyperdriveId && !context.recovering && hyperdrive.id !== plan.resources.hyperdriveId) {
      throw new Error('Imported Hyperdrive name is ambiguous: resolved ID mismatches the recorded Hyperdrive ID');
    }
    const bucket = await ensureR2Bucket({ ...shared, name: names.r2BucketName });
    return { changed: bucket.created || hyperdrive.created, resolvedResources: Object.freeze({ d1DatabaseName: null, d1DatabaseId: null, r2BucketName: bucket.name, hyperdriveId: hyperdrive.id }) };
  }, options.verify, 'ensure-resources');
}

function validate(plan, steps) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.actions)) throw new TypeError('setup plan actions are required');
  const seen = new Set(); let previous = -1;
  for (const name of plan.actions) {
    const index = SETUP_ACTION_ORDER.indexOf(name);
    if (index < 0) throw new Error(`Unknown setup action: ${String(name)}`);
    if (seen.has(name)) throw new Error(`Duplicate setup action: ${name}`);
    if (index <= previous) throw new Error('Setup actions are not in canonical order');
    seen.add(name); previous = index;
  }
  for (const name of plan.actions) {
    const step = steps?.[name];
    if (!step || typeof step.apply !== 'function' || typeof step.verify !== 'function') throw new Error(`Setup step ${name} must provide apply and verify`);
  }
  return [...plan.actions];
}

export async function applySetup(plan, { steps, stateStore, dryRun = false }) {
  if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
  const actions = validate(plan, steps);
  if (dryRun) return { status: 'dry-run', actions, results: [] };
  if (!stateStore || typeof stateStore.load !== 'function' || typeof stateStore.has !== 'function' || typeof stateStore.mark !== 'function') throw new TypeError('stateStore load/has/mark are required');
  if (actions.includes('ensure-resources') && typeof stateStore.getEvidence !== 'function') throw new TypeError('stateStore getEvidence is required for ensure-resources recovery');
  if (actions.includes('ensure-resources') && !['d1', 'supabase'].includes(plan.backend)) throw new TypeError('setup plan backend is required for resource recovery');
  await stateStore.load(fingerprintPlan(plan));
  const results = []; let resolvedResources = plan.resources;
  for (const name of actions) {
    const completed = await stateStore.has(name);
    if (completed && name === 'ensure-resources' && typeof stateStore.getEvidence === 'function') {
      const evidence = await stateStore.getEvidence(name);
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('Completed ensure-resources state has invalid evidence');
      validateResolvedResources(evidence, plan);
      resolvedResources = Object.freeze({ ...evidence });
    }
    const contextPlan = Object.freeze({ ...plan, ...(resolvedResources ? { resources: resolvedResources } : {}) });
    const context = Object.freeze({ plan: contextPlan, resources: resolvedResources, recovering: completed });
    if (await steps[name].verify(context) === true) {
      if (!completed) await stateStore.mark(name, name === 'ensure-resources' ? resolvedResources : null);
      results.push({ step: name, status: completed ? 'already-complete' : 'verified' });
      continue;
    }
    const raw = await steps[name].apply(context);
    const result = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (name === 'ensure-resources') {
      if (!result.resolvedResources || typeof result.resolvedResources !== 'object' || Array.isArray(result.resolvedResources)) throw new Error('Setup step ensure-resources did not return resolvedResources');
      validateResolvedResources(result.resolvedResources, plan);
      resolvedResources = Object.freeze({ ...result.resolvedResources });
    }
    const verified = await steps[name].verify(Object.freeze({ plan: Object.freeze({ ...plan, ...(resolvedResources ? { resources: resolvedResources } : {}) }), resources: resolvedResources }));
    if (verified !== true) throw new Error(`Setup step ${name} did not verify after apply`);
    await stateStore.mark(name, result.evidence ?? (name === 'ensure-resources' ? resolvedResources : null));
    results.push({ step: name, status: result.changed ? 'changed' : 'verified' });
  }
  return { status: 'applied', actions, results };
}
