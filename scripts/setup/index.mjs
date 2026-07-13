#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseSetupArgs, SETUP_HELP } from './args.mjs';
import { missingAnswers } from './answers.mjs';
import { buildSetupPlan } from './plan.mjs';
import { collectInteractiveAnswers } from './prompts.mjs';
import { runDoctor } from './doctor.mjs';
import { checkManifest } from './checks/manifest.mjs';
import { checkConfig } from './checks/config.mjs';
import { checkDatabase } from './checks/database.mjs';
import { checkServices } from './checks/services.mjs';
import { createCommandRunner } from './commands.mjs';
import { applySetup, createD1Steps, createResourceStep, createSupabaseSteps, SetupApplyError } from './apply.mjs';
import { buildSetupRerunCommand } from './failure.mjs';
import { D1CliDb } from './providers/d1.mjs';
import { openPostgresSetupDb } from './providers/postgres.mjs';
import { createStateStore } from './state.mjs';
import { acquireApprovedContentLease, classifyConfig, writeAtomic } from './files.mjs';
import { manifestFromPlan, renderManifest, validateManifest } from './manifest.mjs';
import { renderWrangler } from './render-wrangler.mjs';
import { configureSecrets, hasDeploySecret, listDeploySecrets, readLocalSecretNames, readLocalSecretsStatus } from './secrets.mjs';
import { applyMediaPlan, loadMediaPlan, verifyMediaPlan } from './media.mjs';
import { probeDeployResourcePresence, probeDeployResources, probeR2Object } from './probes.mjs';
import { verifyCanonicalDemoSeed, verifyMigrationCompleteness } from './verification.mjs';
import { resolveLocalPersistence } from './persistence.mjs';
import { inspectBaselineLocalD1Installation, inspectLegacyInstallation } from './import-existing.mjs';
import { applyAfterProviderPreflight, assertDemoSeedTarget } from './provider-verification.mjs';

const MISSING_FLAGS = Object.freeze({
  mode: '--mode', featureChoice: '--preset or --modules', siteSlug: '--site-slug',
  churchName: '--church-name', locale: '--locale', adminEmail: '--admin-email',
  adminName: '--admin-name', appOrigin: '--app-origin', emailFrom: '--email-from',
});
const BASELINE_WRANGLER_SHA256 = '8fdf874f7956b5fb7c2e102d0041d9ac06ee694dca4c15201e3dc6d2b21424a8';
const PROSPECTIVE_RESOURCE_IDS = Object.freeze({
  d1: 'PENDING_D1_DATABASE_ID_AFTER_APPROVAL',
  supabase: 'PENDING_HYPERDRIVE_ID_AFTER_APPROVAL',
});
const MAX_CONFIG_DIFF_LINES = 40;

const requireDeps = (deps, names) => {
  for (const name of names) if (typeof deps[name] !== 'function') throw new TypeError(`setup dependency ${name} is required`);
};

export function formatPlan(plan) {
  const database = plan.backend === 'supabase' ? 'Supabase Postgres' : 'Cloudflare D1';
  const accounts = plan.mode === 'local'
    ? plan.backend === 'supabase' ? 'Supabase' : 'none (local setup)'
    : plan.backend === 'supabase' ? 'Cloudflare and Supabase' : 'Cloudflare';
  const dependencies = plan.addedDependencies.length
    ? plan.addedDependencies.map(({ capability, added }) => `${capability} adds ${added}`).join('; ')
    : 'none';
  const capabilityReasons = plan.providerReasons.length
    ? plan.providerReasons.map(({ capability, requiresBackend }) => `${capability} requires ${requiresBackend === 'supabase' ? 'Supabase' : 'Cloudflare D1'}`).join('; ')
    : '';
  const providerSelectionReason = plan.providerSelectionReason ?? (plan.providerReasons.length ? 'capability-requirement' : 'default');
  const selectionReason = providerSelectionReason === 'explicit-override'
    ? `${plan.backend === 'supabase' ? 'Supabase' : 'Cloudflare D1'} selected by explicit --backend override`
    : providerSelectionReason === 'capability-requirement'
      ? 'database selected from capability requirements'
      : 'selected capabilities are D1-compatible, so Cloudflare D1 is the default';
  const reasons = capabilityReasons ? `${selectionReason}; ${capabilityReasons}` : selectionReason;
  const existing = plan.existingInstallation
    ? [
        `Current installation: ${plan.existingInstallation.backend} / ${plan.existingInstallation.mode}; ${plan.existingInstallation.modules.join(', ')}`,
        `Current site/admin: ${plan.existingInstallation.churchName ?? 'unknown'} / ${plan.existingInstallation.adminEmail ?? 'not uniquely identifiable'}`,
        `Current resources: ${Object.entries(plan.existingInstallation.resources).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `Proposed changes: ${plan.proposedChanges.length ? plan.proposedChanges.join('; ') : 'none'}`,
      ]
    : [];
  return [
    `Setup plan: ${plan.site.name}`,
    `Capabilities (${plan.modules.length}): ${plan.modules.join(', ')}`,
    `Database: ${database}`,
    `Required accounts: ${accounts}`,
    `Required services: ${plan.services.join(', ')}`,
    `Dependency additions: ${dependencies}`,
    `Provider reasons: ${reasons}`,
    `Actions: ${plan.actions.join(' -> ')}`,
    ...existing,
  ].join('\n');
}

const redactDiffLine = (line) => line
  .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
  .replace(/("(?:[^"\\]|\\.)*(?:secret|token|password|key|url|connection)(?:[^"\\]|\\.)*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[REDACTED]"');

function conciseLineDiff(current, desired) {
  const left = current.split(/\r?\n/);
  const right = desired.split(/\r?\n/);
  const changed = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length && changed.length < MAX_CONFIG_DIFF_LINES; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) changed.push(`- ${redactDiffLine(left[index])}`);
    if (right[index] !== undefined && changed.length < MAX_CONFIG_DIFF_LINES) changed.push(`+ ${redactDiffLine(right[index])}`);
  }
  if (changed.length === MAX_CONFIG_DIFF_LINES) changed.push('… additional differences omitted');
  return changed.join('\n');
}

function renderProspectiveWrangler(template, plan, catalog) {
  if (!plan || typeof plan !== 'object') throw new TypeError('Wrangler replacement preview requires the resolved setup plan');
  const manifest = manifestFromPlan(plan, catalog);
  const resources = { ...manifest.resources };
  const pendingIds = [];
  if (manifest.mode === 'deploy' && manifest.database === 'd1' && !resources.d1DatabaseId) {
    resources.d1DatabaseId = PROSPECTIVE_RESOURCE_IDS.d1;
    pendingIds.push(PROSPECTIVE_RESOURCE_IDS.d1);
  }
  if (manifest.mode === 'deploy' && manifest.database === 'supabase' && !resources.hyperdriveId) {
    resources.hyperdriveId = PROSPECTIVE_RESOURCE_IDS.supabase;
    pendingIds.push(PROSPECTIVE_RESOURCE_IDS.supabase);
  }
  return Object.freeze({
    content: renderWrangler(template, { ...manifest, resources }),
    pendingIds: Object.freeze(pendingIds),
  });
}

export async function preflightWranglerConfig(options) {
  if (!options || (options.current !== null && typeof options.current !== 'string') ||
      (options.baseline !== undefined && typeof options.baseline !== 'string') || typeof options.template !== 'string') {
    throw new TypeError('Wrangler preflight requires current and template configuration bytes');
  }
  if (options.current === null) return Object.freeze({ classification: 'absent', approvedContent: null });
  let canonical;
  if (options.existingManifest) {
    const manifest = validateManifest(structuredClone(options.existingManifest), options.catalog);
    canonical = renderWrangler(options.template, manifest);
  }
  let classification = classifyConfig(options.current, options.baseline ?? '', canonical);
  if (options.baselineSha256 && createHash('sha256').update(options.current).digest('hex') === options.baselineSha256) {
    classification = 'baseline';
  }
  if (classification === 'baseline' || classification === 'canonical-generated' ||
      (options.forceConfig === true && options.interactive !== true)) {
    return Object.freeze({ classification, approvedContent: options.current });
  }
  if (!options.interactive) {
    throw new Error(`Refusing to overwrite ${classification === 'modified-generated' ? 'a locally modified generated' : 'an unrecognized'} wrangler.jsonc; rerun with --force-config after reviewing it`);
  }
  if (typeof options.confirmConfigReplacement !== 'function' || typeof options.output !== 'function') {
    throw new TypeError('interactive Wrangler replacement requires output and confirmConfigReplacement');
  }
  const prospective = renderProspectiveWrangler(options.template, options.plan, options.catalog);
  const pendingNote = prospective.pendingIds.length
    ? '\nPending provider IDs are clearly labeled in this diff; only those IDs will be substituted after setup approval.'
    : '';
  options.output(`wrangler.jsonc replacement requires separate approval:${pendingNote}\n${conciseLineDiff(options.current, prospective.content)}`);
  if (await options.confirmConfigReplacement({ classification }) !== true) {
    throw new Error('wrangler.jsonc replacement was not approved; no setup changes were made');
  }
  return Object.freeze({ classification, approvedContent: options.current });
}

export function formatDoctor(doctor) {
  return [`Readiness: ${doctor.status}`, ...doctor.checks.flatMap((check) => [
    `[${check.severity}] ${check.code}: ${check.message}`, `  ${check.remediation}`,
  ])].join('\n');
}

export function formatResult(result) {
  if (!result?.doctor || !result.handoff) return 'Setup did not return readiness and handoff details; rerun doctor and inspect stderr.';
  const handoff = result.handoff;
  return [
    'Setup finished.',
    formatDoctor(result.doctor),
    `Next command: ${handoff.startCommand}`,
    `Site URL: ${handoff.url}`,
    `Sign-in email: ${handoff.adminEmail}`,
    `Enabled capabilities: ${handoff.capabilities.join(', ')}`,
    `Optional integration limitations: ${handoff.limitations.length ? handoff.limitations.join(', ') : 'none'}`,
  ].join('\n');
}

export function buildHandoff(plan, doctor, { supabaseSecretSource } = {}) {
  return Object.freeze({
    mode: plan.mode,
    url: plan.site.appOrigin,
    adminEmail: plan.adminEmail,
    capabilities: Object.freeze([...plan.modules]),
    startCommand: plan.mode === 'local'
      ? plan.backend === 'supabase'
        ? supabaseSecretSource === 'environment'
          ? 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$SUPABASE_DB_URL" npm run dev'
          : 'read -s SUPABASE_DB_URL && export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$SUPABASE_DB_URL" && npm run dev'
        : 'npm run dev'
      : 'npm run deploy',
    limitations: Object.freeze(doctor.checks.filter((check) => check.severity === 'warning').map((check) => check.code)),
  });
}

export function createPlanPreview({ output, errorOutput }) {
  if (typeof output !== 'function' || typeof errorOutput !== 'function') throw new TypeError('plan preview output functions are required');
  return (plan, { json = false } = {}) => (json ? errorOutput : output)(formatPlan(plan));
}

/** @param {{ environment?: Record<string, string | undefined>, interactive?: boolean, maskedInput?: (message: string) => Promise<string> }} [options] */
export async function collectSupabaseSecret(options = {}) {
  const { environment = process.env, interactive = false, maskedInput } = options;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('secret environment must be an object');
  let dbUrl = environment.SUPABASE_DB_URL;
  let source = 'environment';
  if (!dbUrl) {
    if (!interactive) throw new Error('SUPABASE_DB_URL is required in the environment for noninteractive setup');
    if (typeof maskedInput !== 'function') throw new Error('A masked input reader is required for interactive Supabase setup');
    dbUrl = await maskedInput('Supabase database URL (input hidden)');
    source = 'masked';
  }
  if (typeof dbUrl !== 'string' || !/^postgres(?:ql)?:\/\//.test(dbUrl)) throw new Error('SUPABASE_DB_URL must be a Postgres URL');
  return Object.freeze({ dbUrl, source });
}

export async function buildServicePresence(manifest, probeOptions = {}) {
  const hostEnv = probeOptions.hostEnv ?? process.env;
  const localNames = probeOptions.localSecretNames ?? [];
  if (!Array.isArray(localNames) || localNames.some((name) => typeof name !== 'string') || new Set(localNames).size !== localNames.length) {
    throw new TypeError('local secret names must be a unique string array');
  }
  const localSecrets = new Set(localNames);
  let live = { worker: false, r2: false, d1: false, hyperdrive: false };
  if (manifest?.mode === 'local') {
    live = {
      worker: true,
      r2: Boolean(manifest?.resources?.r2BucketName),
      d1: manifest?.database === 'd1',
      hyperdrive: manifest?.database !== 'supabase' || Boolean(hostEnv.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE || probeOptions.localSupabaseUrlAvailable),
    };
  } else if (manifest?.mode === 'deploy' && probeOptions.runner) {
    live = await probeDeployResourcePresence({ ...probeOptions, manifest });
  }
  let remoteSecrets = new Set();
  if (manifest?.mode === 'deploy' && probeOptions.runner) {
    try { remoteSecrets = await listDeploySecrets(probeOptions); } catch {}
  }
  return {
    worker: live.worker,
    r2: live.r2,
    d1: live.d1,
    hyperdrive: manifest?.database !== 'supabase' || live.hyperdrive,
    email: false,
    emailConfigured: manifest?.mode === 'deploy' && Boolean(manifest?.site?.emailFrom),
    emailDevLog: manifest?.mode === 'local' && probeOptions.localSecretsValid === true,
    stripeSecretKey: manifest?.mode === 'deploy' ? remoteSecrets.has('STRIPE_SECRET_KEY') : localSecrets.has('STRIPE_SECRET_KEY'),
    stripeWebhookSecret: manifest?.mode === 'deploy' ? remoteSecrets.has('STRIPE_WEBHOOK_SECRET') : localSecrets.has('STRIPE_WEBHOOK_SECRET'),
    backup: Boolean(hostEnv.CF_ACCOUNT_ID && hostEnv.D1_DATABASE_ID && hostEnv.D1_EXPORT_TOKEN),
  };
}

/** @param {any} manifest @param {Record<string, string | undefined>} [environment] */
export function resolveDoctorDatabaseUrl(manifest, environment = process.env) {
  if (manifest?.database !== 'supabase') return undefined;
  if (environment.SUPABASE_DB_URL) return environment.SUPABASE_DB_URL;
  if (manifest.mode === 'local') return environment.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
  return undefined;
}

const step = (apply, verify) => Object.freeze({ apply, verify });
const exists = async (path) => {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
};

async function applyDefaultSetup(plan, options, catalog) {
  const root = resolve(process.cwd());
  const configPath = resolve(root, 'wrangler.jsonc');
  const manifestPath = resolve(root, 'church.config.json');
  const templatePath = resolve(root, 'config/wrangler.template.jsonc');
  const statePath = resolve(root, '.church/setup-state.json');
  const runner = createCommandRunner();
  const wranglerBin = resolve(root, 'node_modules/.bin/wrangler');
  const persistTo = plan.mode === 'local' ? resolveLocalPersistence(root, process.env) : undefined;
  const dbUrl = options.secretContext?.dbUrl;
  let postgresConnection;
  const db = plan.backend === 'd1'
    ? new D1CliDb({ runner, wranglerBin, configPath, mode: plan.mode, ...(persistTo ? { persistTo } : {}) })
    : (postgresConnection = openPostgresSetupDb(dbUrl)).db;
  const template = await readFile(templatePath, 'utf8');
  let desiredManifest;
  let desiredConfig;
  let latestDoctor;
  let configLease = null;
  let providerProofComplete = false;
  let d1ProofRoot = null;

  const verify = {
    migrate: () => verifyMigrationCompleteness({ db, backend: plan.backend, catalog, root }),
    seed: () => verifyCanonicalDemoSeed(db),
    'initialize-modules': async ({ plan: activePlan, recovering = false, managedInstallation = false }) => {
      try {
        const rows = (await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'module.%'").all()).results;
        const found = new Map(rows.map((row) => [row.key, row.value]));
        const enabled = new Set(activePlan.modules);
        const identity = await db.prepare('SELECT value FROM settings WHERE key=?').bind(`site.name.${activePlan.site.locale}`).first('value');
        const validIdentity = typeof identity === 'string' && identity.trim() === identity && identity.length > 0 && identity.length <= 200 && !/[\0-\x1f\x7f]/.test(identity);
        const preserveImported = !managedInstallation;
        const identityReady = (recovering || preserveImported) ? validIdentity : identity === activePlan.site.name;
        return identityReady && catalog.order.every((key) => found.get(`module.${key}`) === (enabled.has(key) ? '1' : '0'));
      } catch { return false; }
    },
    'bootstrap-admin': async ({ plan: activePlan }) => {
      try {
        const row = await db.prepare('SELECT role, active, deleted_at FROM people WHERE lower(email)=lower(?)').bind(activePlan.adminEmail).first();
        return row?.role === 'admin' && Number(row.active) === 1 && row.deleted_at == null;
      } catch { return false; }
    },
  };
  const baseProviderSteps = plan.backend === 'd1'
    ? createD1Steps({ runner, wranglerBin, configPath, mode: plan.mode, ...(persistTo ? { persistTo } : {}), db, moduleKeys: catalog.order, promoteExistingAdmin: options.promoteExistingAdmin, preserveSiteIdentity: options.existingInstallation, verify })
    : createSupabaseSteps({ runner, root, dbUrl, db, moduleKeys: catalog.order, promoteExistingAdmin: options.promoteExistingAdmin, preserveSiteIdentity: options.existingInstallation, verify });
  const providerSteps = { ...baseProviderSteps };
  const providerSeed = providerSteps.seed;
  providerSteps.seed = step(async (context) => {
    if (await verify.seed(context)) return { changed: false };
    if (plan.demoData) await assertDemoSeedTarget({ backend: plan.backend, db, canonicalDemoReady: () => verify.seed(context) });
    return providerSeed.apply(context);
  }, providerSeed.verify);

  const runInstallationDoctor = async (activePlan) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const config = await readFile(configPath, 'utf8');
    const workerSource = await readFile(resolve(root, 'src/worker.ts'), 'utf8');
    return runDoctor({
      checkManifest: () => checkManifest({ catalog, manifest }),
      checkConfig: () => checkConfig({ manifest, template, config, workerSource, hostEnv: process.env }),
      checkDatabase: () => checkDatabase({ db, catalog, manifest, readDir: (path) => readdir(resolve(root, path)), ...(manifest.database === 'd1' ? { runner, wranglerBin, configPath } : {}), secrets: dbUrl ? [dbUrl] : [] }),
      checkServices: async () => checkServices({ catalog, manifest, presence: await buildServicePresence(manifest, { runner, wranglerBin, configPath, localSupabaseUrlAvailable: options.secretContext?.source === 'environment', localSecretsValid: await readLocalSecretsStatus(resolve(root, '.dev.vars'), activePlan.adminEmail), localSecretNames: await readLocalSecretNames(resolve(root, '.dev.vars')) }) }),
    }, { strict: false });
  };

  const steps = {
    'verify-provider': step(async () => ({ changed: false }), () => providerProofComplete),
    'ensure-resources': createResourceStep({ plan, runner, wranglerBin, configPath, dbUrl, allowHyperdriveSecretInArgv: options.allowHyperdriveSecretInArgv, verify: async ({ plan: activePlan, resources }) => {
      if (!resources?.r2BucketName || !(activePlan.backend === 'd1' ? resources.d1DatabaseId : resources.hyperdriveId)) return false;
      if (activePlan.mode === 'local') return true;
      try { await probeDeployResources({ runner, wranglerBin, configPath, manifest: JSON.parse(renderManifest({ ...activePlan, resources }, catalog)), probeWorker: false }); return true; } catch { return false; }
    } }),
    'write-manifest': step(async ({ plan: activePlan }) => {
      desiredManifest = renderManifest(activePlan, catalog);
      const current = await exists(manifestPath);
      if (current !== null && !options.forceConfig) {
        try { validateManifest(JSON.parse(current), catalog); }
        catch { throw new Error('Refusing to overwrite an invalid church.config.json; review it and rerun with --force-config'); }
      }
      const result = await writeAtomic(manifestPath, desiredManifest, { allowReplace: current !== null, backup: current !== null, expectedContent: current });
      return { changed: result.changed };
    }, async ({ plan: activePlan }) => {
      desiredManifest ??= renderManifest(activePlan, catalog);
      return await exists(manifestPath) === desiredManifest;
    }),
    'write-config': step(async ({ plan: activePlan }) => {
      desiredConfig = renderWrangler(template, JSON.parse(renderManifest(activePlan, catalog)));
      const approved = options.approvedConfigContent;
      if (!configLease) throw new Error('Wrangler configuration ownership lease is unavailable');
      const result = await configLease.writeAtomic(desiredConfig, {
        allowReplace: approved !== null,
        backup: approved !== null,
        expectedContent: approved,
      });
      return { changed: result.changed };
    }, async ({ plan: activePlan }) => {
      desiredConfig ??= renderWrangler(template, JSON.parse(renderManifest(activePlan, catalog)));
      const verified = await exists(configPath) === desiredConfig;
      if (verified && configLease) {
        await configLease.release();
        configLease = null;
      }
      return verified;
    }),
    'configure-secrets': step(async ({ plan: activePlan }) => configureSecrets({ mode: activePlan.mode, adminEmail: activePlan.adminEmail, path: resolve(root, '.dev.vars'), runner, wranglerBin, configPath }), async ({ plan: activePlan }) => {
      if (activePlan.mode === 'deploy') return hasDeploySecret({ runner, wranglerBin, configPath, name: 'SESSION_SECRET' });
      return readLocalSecretsStatus(resolve(root, '.dev.vars'), activePlan.adminEmail);
    }),
    ...providerSteps,
    'seed-media': step(async ({ plan: activePlan }) => {
      const mediaPlan = loadMediaPlan({ root });
      const bucket = activePlan.resources?.r2BucketName ?? `${activePlan.site.slug}-media`;
      return applyMediaPlan({ mediaPlan, db, uploadObject: ({ key, filePath, contentType }) => runner.run(wranglerBin, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', filePath, '--content-type', contentType, activePlan.mode === 'local' ? '--local' : '--remote', '--config', configPath, ...(activePlan.mode === 'local' && persistTo ? ['--persist-to', persistTo] : [])]) });
    }, async ({ plan: activePlan }) => {
      const mediaPlan = loadMediaPlan({ root });
      const bucket = activePlan.resources?.r2BucketName ?? `${activePlan.site.slug}-media`;
      return verifyMediaPlan({ mediaPlan, db, objectExists: (key) => probeR2Object({ runner, wranglerBin, configPath, bucket, key, mode: activePlan.mode, ...(persistTo ? { persistTo } : {}) }) });
    }),
    doctor: step(async ({ plan: activePlan }) => { latestDoctor = await runInstallationDoctor(activePlan); return { changed: false }; }, async ({ plan: activePlan }) => { latestDoctor ??= await runInstallationDoctor(activePlan); return true; }),
  };

  try {
    let proofConfigPath = configPath;
    let proofDb = db;
    if (plan.backend === 'd1') {
      d1ProofRoot = await mkdtemp(join(tmpdir(), 'church-setup-provider-proof-'));
      proofConfigPath = join(d1ProofRoot, 'wrangler.jsonc');
      await writeFile(proofConfigPath, renderProspectiveWrangler(template, plan, catalog).content, { encoding: 'utf8', mode: 0o600 });
      if (plan.mode === 'local') {
        proofDb = new D1CliDb({ runner, wranglerBin, configPath: proofConfigPath, mode: 'local', persistTo: join(d1ProofRoot, 'state') });
      }
    }
    return await applyAfterProviderPreflight({
      providerOptions: {
        backend: plan.backend,
        mode: plan.mode,
        db: proofDb,
        runner,
        wranglerBin,
        configPath: proofConfigPath,
        resources: plan.resources,
        ...(dbUrl ? { secrets: [dbUrl] } : {}),
      },
      apply: async () => {
        providerProofComplete = true;
        configLease = await acquireApprovedContentLease(configPath, options.approvedConfigContent);
        const applied = await applySetup({ ...plan, existingInstallation: options.existingInstallation === true }, {
          steps,
          stateStore: createStateStore(statePath),
          dryRun: false,
          rerunCommand: options.rerunCommand,
          secretValues: options.secretValues,
          beforeMutation: async () => { if (configLease) await configLease.assertUnchanged(); },
        });
        latestDoctor ??= await runInstallationDoctor(plan);
        const moduleRows = Number((await db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'module.%'").first())?.count ?? 0);
        const admin = await db.prepare('SELECT role, active FROM people WHERE lower(email)=lower(?)').bind(plan.adminEmail).first();
        return {
          backend: plan.backend,
          enabledModules: plan.modules,
          moduleRows,
          admin: { status: admin?.role === 'admin' && Number(admin.active) === 1 ? 'already-admin' : 'missing' },
          apply: applied,
          doctor: latestDoctor,
          handoff: buildHandoff(plan, latestDoctor, { supabaseSecretSource: options.secretContext?.source }),
        };
      },
    });
  } finally {
    await configLease?.release();
    await postgresConnection?.close();
    if (d1ProofRoot) await rm(d1ProofRoot, { recursive: true, force: true });
  }
}

export async function runSetup(argv, deps) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) throw new TypeError('setup argv must be a string array');
  if (!deps || typeof deps !== 'object' || !deps.catalog) throw new TypeError('setup dependencies and catalog are required');
  const parsed = parseSetupArgs(argv, deps.catalog);
  requireDeps(deps, ['output']);
  if (parsed.help) {
    deps.output(SETUP_HELP);
    return 0;
  }
  if (parsed.doctor) {
    requireDeps(deps, ['doctor', 'formatDoctor']);
    const doctor = await deps.doctor({ strict: parsed.strict });
    deps.output(parsed.json ? JSON.stringify(doctor) : deps.formatDoctor(doctor));
    return doctor.exitCode;
  }

  let answers;
  if (deps.interactive) {
    answers = await collectInteractiveAnswers(parsed, deps.catalog, deps.ask);
  } else {
    const missing = missingAnswers(parsed);
    if (missing.length) {
      throw new Error(`Noninteractive setup is missing required flags: ${missing.map((key) => MISSING_FLAGS[key]).join(', ')}`);
    }
    if (!parsed.dryRun && !parsed.yes) {
      throw new Error('Noninteractive setup requires --yes to apply changes; use --dry-run to preview without mutation');
    }
    answers = parsed;
  }

  requireDeps(deps, ['inspectExisting', 'formatPlan']);
  const currentState = await deps.inspectExisting({ dryRun: parsed.dryRun, requestedMode: answers.mode });
  const plan = buildSetupPlan(answers, deps.catalog, currentState);
  if (parsed.dryRun) {
    deps.output(parsed.json
      ? JSON.stringify({ schemaVersion: 1, kind: 'setup-plan', plan })
      : deps.formatPlan(plan));
    return 0;
  }

  requireDeps(deps, ['preflightConfig']);
  const configApproval = await deps.preflightConfig({
    plan,
    currentState,
    forceConfig: parsed.forceConfig,
  });

  requireDeps(deps, ['confirm', 'collectSupabaseSecret', 'apply', 'formatResult']);
  if (!parsed.yes) {
    requireDeps(deps, ['previewPlan']);
    deps.previewPlan(plan, { json: parsed.json });
    if (!await deps.confirm(plan)) return 0;
  }

  let allowHyperdriveSecretInArgv = parsed.allowHyperdriveSecretInArgv;
  if (plan.backend === 'supabase' && plan.mode === 'deploy' && !plan.resources?.hyperdriveId && !allowHyperdriveSecretInArgv) {
    if (deps.interactive && typeof deps.confirmHyperdriveSecretInArgv === 'function') {
      allowHyperdriveSecretInArgv = await deps.confirmHyperdriveSecretInArgv(plan) === true;
    }
    if (!allowHyperdriveSecretInArgv) {
      throw new Error('Creating deploy Hyperdrive exposes the Supabase URL to the Wrangler child-process argv; rerun with --allow-hyperdrive-secret-in-argv after reviewing this risk');
    }
  }

  const secretContext = plan.backend === 'supabase' ? await deps.collectSupabaseSecret() : {};
  const rerunNeedsForceConfig = parsed.forceConfig ||
    ['unrecognized', 'modified-generated'].includes(configApproval.classification);
  const rerunCommand = buildSetupRerunCommand(plan, {
    forceConfig: rerunNeedsForceConfig,
    promoteExistingAdmin: parsed.promoteExistingAdmin,
    allowHyperdriveSecretInArgv,
  });
  const secretValues = typeof secretContext.dbUrl === 'string' ? [secretContext.dbUrl] : [];
  let result;
  try {
    result = await deps.apply(plan, {
      secretContext,
      forceConfig: parsed.forceConfig,
      promoteExistingAdmin: parsed.promoteExistingAdmin,
      allowHyperdriveSecretInArgv,
      existingInstallation: Boolean(currentState.existingBackend),
      approvedConfigContent: configApproval.approvedContent,
      rerunCommand,
      secretValues,
    });
  } catch (error) {
    if (error instanceof SetupApplyError) {
      requireDeps(deps, ['errorOutput']);
      deps.errorOutput(error.message);
      Object.defineProperty(error, 'reported', { value: true });
    }
    throw error;
  }
  deps.output(parsed.json
    ? JSON.stringify({ schemaVersion: 1, kind: 'setup-result', ...result })
    : deps.formatResult(result));
  return result.doctor?.exitCode ?? 0;
}

export async function readMaskedInput(input, output, message) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('SUPABASE_DB_URL is required in the environment for noninteractive setup');
  }
  const wasRaw = Boolean(input.isRaw);
  const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : true;
  output.write(`${message}: `);
  let value = '';
  let rawChanged = false;
  try {
    input.setRawMode(true);
    rawChanged = true;
    input.resume();
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const character of String(chunk)) {
          if (character === '\u0003') { cleanup(); reject(new Error('Setup cancelled')); return; }
          if (character === '\r' || character === '\n') { cleanup(); output.write('\n'); resolve(value); return; }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else value += character;
        }
      };
      const onEnd = () => { cleanup(); reject(new Error('Masked input stream ended before a value was submitted')); };
      const onError = (error) => { cleanup(); reject(new Error(`Masked input stream failed: ${error instanceof Error ? error.message : String(error)}`)); };
      const cleanup = () => { input.off('data', onData); input.off('end', onEnd); input.off('error', onError); };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
    });
  } finally {
    if (rawChanged) input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
}

export function inspectExistingInstallation(manifest, requestedMode) {
  if (!manifest || typeof manifest !== 'object' || !['local', 'deploy'].includes(requestedMode)) return {};
  const state = {
    existingBackend: manifest.database,
    existingMode: manifest.mode,
    existingManifest: manifest,
    mode: manifest.mode,
    modules: Array.isArray(manifest.modules) ? [...manifest.modules] : [],
    siteSlug: manifest.site?.slug,
    churchName: manifest.site?.name,
    locale: manifest.site?.locale,
    appOrigin: manifest.site?.appOrigin,
    emailFrom: manifest.site?.emailFrom,
    currentResources: manifest.resources && typeof manifest.resources === 'object' ? { ...manifest.resources } : {},
  };
  if (manifest.mode === requestedMode && manifest.resources && typeof manifest.resources === 'object') {
    state.resources = { ...manifest.resources };
  }
  return state;
}

async function createDefaultDeps() {
  const catalog = JSON.parse(await readFile(new URL('../../config/capabilities.json', import.meta.url), 'utf8'));
  const jsonMode = process.argv.includes('--json');
  const uiOutput = jsonMode ? process.stderr : process.stdout;
  const interactive = Boolean(process.stdin.isTTY && uiOutput.isTTY);
  let readline;
  const getReadline = () => {
    if (!interactive) throw new Error('Interactive questions require a TTY');
    readline ??= createInterface({ input: process.stdin, output: uiOutput });
    return readline;
  };
  const ask = async (question) => {
    const choices = question.choices?.map((choice) => `${choice.value}=${choice.label}`).join(', ');
    const answer = await getReadline().question(`${question.message}${choices ? ` [${choices}]` : ''}: `);
    if (question.multiple) return answer.split(',').map((value) => value.trim()).filter(Boolean);
    if (answer === 'true' || answer === 'yes' || answer === 'y') return true;
    if (answer === 'false' || answer === 'no' || answer === 'n') return false;
    return answer.trim();
  };
  const inspectExisting = async ({ requestedMode }) => {
    try {
      const manifest = validateManifest(JSON.parse(await readFile('church.config.json', 'utf8')), catalog);
      return inspectExistingInstallation(manifest, requestedMode);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const root = resolve(process.cwd());
        const configPath = resolve(root, 'wrangler.jsonc');
        const configContent = await readFile(configPath, 'utf8');
        const runner = createCommandRunner();
        const wranglerBin = resolve(root, 'node_modules/.bin/wrangler');
        const openD1 = ({ mode, persistTo }) => new D1CliDb({
          runner,
          wranglerBin,
          configPath,
          mode,
          ...(mode === 'local' ? { persistTo: persistTo ?? resolveLocalPersistence(root, process.env) } : {}),
        });
        if (createHash('sha256').update(configContent).digest('hex') === BASELINE_WRANGLER_SHA256) {
          return inspectBaselineLocalD1Installation({
            catalog,
            root,
            configContent,
            baselineContent: configContent,
            requestedMode,
            environment: process.env,
            openD1,
          });
        }
        return inspectLegacyInstallation({
          catalog,
          configContent,
          baselineContent: '',
          requestedMode,
          environment: process.env,
          openD1,
          openPostgres: (url) => openPostgresSetupDb(url),
        });
      }
      throw new Error(`Existing church.config.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const standaloneDoctor = async ({ strict }) => {
    let manifest;
    try { manifest = JSON.parse(await readFile('church.config.json', 'utf8')); } catch {}
    const template = await readFile('config/wrangler.template.jsonc', 'utf8').catch(() => '');
    const config = await readFile('wrangler.jsonc', 'utf8').catch(() => '');
    const workerSource = await readFile('src/worker.ts', 'utf8').catch(() => '');
    let connection;
    let db;
    let runner;
    const root = resolve(process.cwd());
    const persistTo = manifest?.mode === 'local' ? resolveLocalPersistence(root, process.env) : undefined;
    const wranglerBin = resolve(root, 'node_modules/.bin/wrangler');
    const configPath = resolve(root, 'wrangler.jsonc');
    const doctorDbUrl = resolveDoctorDatabaseUrl(manifest, process.env);
    if (manifest?.database === 'd1') {
      runner = createCommandRunner();
      db = new D1CliDb({ runner, wranglerBin, configPath, mode: manifest.mode, ...(persistTo ? { persistTo } : {}) });
    } else if (manifest?.database === 'supabase' && doctorDbUrl) {
      connection = openPostgresSetupDb(doctorDbUrl);
      db = connection.db;
    }
    try {
      return await runDoctor({
        checkManifest: () => checkManifest({ catalog, manifest }),
        checkConfig: () => checkConfig({ manifest, template, config, workerSource, hostEnv: process.env }),
        checkDatabase: () => {
          if (!db) throw new Error('database connection is unavailable');
          return checkDatabase({ db, catalog, manifest, readDir: (path) => readdir(resolve(root, path)), ...(runner ? { runner, wranglerBin, configPath } : {}), secrets: doctorDbUrl ? [doctorDbUrl] : [] });
        },
        checkServices: async () => checkServices({ catalog, manifest, presence: await buildServicePresence(manifest, { runner: runner ?? createCommandRunner(), wranglerBin, configPath, hostEnv: process.env, localSecretsValid: manifest?.mode === 'local' ? await readLocalSecretsStatus(resolve(root, '.dev.vars')) : false, localSecretNames: manifest?.mode === 'local' ? await readLocalSecretNames(resolve(root, '.dev.vars')) : [] }) }),
      }, { strict });
    } finally {
      await connection?.close();
    }
  };
  const output = (value) => process.stdout.write(`${value}\n`);
  const errorOutput = (value) => process.stderr.write(`${value}\n`);
  return {
    catalog, interactive, ask,
    output,
    errorOutput,
    inspectExisting,
    preflightConfig: async ({ plan, currentState, forceConfig }) => {
      const current = await readFile('wrangler.jsonc', 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      const template = await readFile('config/wrangler.template.jsonc', 'utf8');
      return preflightWranglerConfig({
        current,
        template,
        plan,
        existingManifest: currentState.existingManifest ?? null,
        catalog,
        baselineSha256: BASELINE_WRANGLER_SHA256,
        interactive,
        forceConfig,
        output: (value) => uiOutput.write(`${value}\n`),
        confirmConfigReplacement: async () => (await ask({ key: 'configReplacement', message: 'Replace wrangler.jsonc after reviewing this diff?', choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })) === true,
      });
    },
    doctor: standaloneDoctor,
    formatPlan,
    formatDoctor,
    formatResult,
    previewPlan: createPlanPreview({ output, errorOutput }),
    confirm: async (plan) => (await ask({ key: 'confirmation', message: `Apply this ${plan.backend} plan?`, choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })) === true,
    confirmHyperdriveSecretInArgv: async () => (await ask({ key: 'hyperdriveArgv', message: 'Allow Wrangler to receive the Supabase URL in child-process argv?', choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] })) === true,
    collectSupabaseSecret: () => collectSupabaseSecret({
      environment: process.env,
      interactive,
      maskedInput: (message) => {
        readline?.close();
        readline = undefined;
        return readMaskedInput(process.stdin, uiOutput, message);
      },
    }),
    apply: (plan, options) => applyDefaultSetup(plan, options, catalog),
    close: () => readline?.close(),
  };
}

async function main() {
  const deps = await createDefaultDeps();
  try {
    process.exitCode = await runSetup(process.argv.slice(2), deps);
  } catch (error) {
    if (!error?.reported) deps.errorOutput(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    deps.close();
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url)).catch(() => '')) await main();
