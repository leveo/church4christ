#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { applySetup, createD1Steps, createResourceStep, createSupabaseSteps } from './apply.mjs';
import { D1CliDb } from './providers/d1.mjs';
import { openPostgresSetupDb } from './providers/postgres.mjs';
import { createStateStore } from './state.mjs';
import { writeAtomic, GENERATED_MARKER } from './files.mjs';
import { renderManifest, validateManifest } from './manifest.mjs';
import { renderWrangler } from './render-wrangler.mjs';
import { configureSecrets } from './secrets.mjs';
import { applyMediaPlan, loadMediaPlan } from './media.mjs';

const MISSING_FLAGS = Object.freeze({
  mode: '--mode', featureChoice: '--preset or --modules', siteSlug: '--site-slug',
  churchName: '--church-name', locale: '--locale', adminEmail: '--admin-email',
  adminName: '--admin-name', appOrigin: '--app-origin', emailFrom: '--email-from',
});
const BASELINE_WRANGLER_SHA256 = '8fdf874f7956b5fb7c2e102d0041d9ac06ee694dca4c15201e3dc6d2b21424a8';

const requireDeps = (deps, names) => {
  for (const name of names) if (typeof deps[name] !== 'function') throw new TypeError(`setup dependency ${name} is required`);
};

export function formatPlan(plan) {
  const database = plan.backend === 'supabase' ? 'Supabase Postgres' : 'Cloudflare D1';
  const accounts = plan.backend === 'supabase' ? 'Cloudflare and Supabase' : 'Cloudflare';
  const dependencies = plan.addedDependencies.length
    ? plan.addedDependencies.map(({ capability, added }) => `${capability} adds ${added}`).join('; ')
    : 'none';
  const reasons = plan.providerReasons.length
    ? plan.providerReasons.map(({ capability, requiresBackend }) => `${capability} requires ${requiresBackend === 'supabase' ? 'Supabase' : 'Cloudflare D1'}`).join('; ')
    : 'selected capabilities are D1-compatible';
  return [
    `Setup plan: ${plan.site.name}`,
    `Capabilities (${plan.modules.length}): ${plan.modules.join(', ')}`,
    `Database: ${database}`,
    `Required accounts: ${accounts}`,
    `Required services: ${plan.services.join(', ')}`,
    `Dependency additions: ${dependencies}`,
    `Provider reasons: ${reasons}`,
    `Actions: ${plan.actions.join(' -> ')}`,
  ].join('\n');
}

export function formatDoctor(doctor) {
  return [`Readiness: ${doctor.status}`, ...doctor.checks.flatMap((check) => [
    `[${check.severity}] ${check.code}: ${check.message}`, `  ${check.remediation}`,
  ])].join('\n');
}

export function formatResult(result) {
  const doctor = result.doctor ? `Readiness: ${result.doctor.status}` : 'Readiness was not returned.';
  return [`Setup finished.`, doctor].join('\n');
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
  if (!dbUrl) {
    if (!interactive) throw new Error('SUPABASE_DB_URL is required in the environment for noninteractive setup');
    if (typeof maskedInput !== 'function') throw new Error('A masked input reader is required for interactive Supabase setup');
    dbUrl = await maskedInput('Supabase database URL (input hidden)');
  }
  if (typeof dbUrl !== 'string' || !/^postgres(?:ql)?:\/\//.test(dbUrl)) throw new Error('SUPABASE_DB_URL must be a Postgres URL');
  return Object.freeze({ dbUrl });
}

function servicePresence(manifest) {
  return {
    worker: Boolean(manifest),
    r2: Boolean(manifest?.resources?.r2BucketName),
    hyperdrive: manifest?.database !== 'supabase' || Boolean(manifest?.resources?.hyperdriveId),
    email: manifest?.mode === 'deploy' && Boolean(manifest?.site?.emailFrom),
    emailDevLog: manifest?.mode === 'local',
    stripeSecretKey: Boolean(process.env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    backup: Boolean(process.env.CF_ACCOUNT_ID && process.env.D1_DATABASE_ID && process.env.D1_EXPORT_TOKEN),
  };
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
  const dbUrl = options.secretContext?.dbUrl;
  let postgresConnection;
  const db = plan.backend === 'd1'
    ? new D1CliDb({ runner, wranglerBin, configPath, mode: plan.mode, ...(plan.mode === 'local' && process.env.WRANGLER_PERSIST_TO ? { persistTo: process.env.WRANGLER_PERSIST_TO } : {}) })
    : (postgresConnection = openPostgresSetupDb(dbUrl)).db;
  const template = await readFile(templatePath, 'utf8');
  let desiredManifest;
  let desiredConfig;
  let latestDoctor;

  const verify = {
    migrate: async () => {
      try { await db.prepare('SELECT 1 FROM settings LIMIT 1').first(); return true; } catch { return false; }
    },
    seed: async () => {
      try { return Boolean(await db.prepare('SELECT id FROM people WHERE lower(email)=?').bind('admin@example.com').first()); } catch { return false; }
    },
    'initialize-modules': async ({ plan: activePlan }) => {
      try {
        const rows = (await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'module.%'").all()).results;
        const found = new Map(rows.map((row) => [row.key, row.value]));
        const enabled = new Set(activePlan.modules);
        return catalog.order.every((key) => found.get(`module.${key}`) === (enabled.has(key) ? '1' : '0'));
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
    ? createD1Steps({ runner, wranglerBin, configPath, mode: plan.mode, db, moduleKeys: catalog.order, promoteExistingAdmin: options.promoteExistingAdmin, verify })
    : createSupabaseSteps({ runner, root, dbUrl, db, moduleKeys: catalog.order, promoteExistingAdmin: options.promoteExistingAdmin, verify });
  const providerSteps = { ...baseProviderSteps };
  const providerSeed = providerSteps.seed;
  providerSteps.seed = step(async (context) => await verify.seed(context) ? { changed: false } : providerSeed.apply(context), providerSeed.verify);

  if (plan.demoData) {
    try {
      const count = Number((await db.prepare('SELECT COUNT(*) AS count FROM people').first())?.count ?? 0);
      if (count > 0 && !await verify.seed()) {
        throw new Error('Fictional demo data can only be added to a fresh database; refusing to collide with existing people');
      }
    } catch (error) {
      if (/Fictional demo data/.test(String(error))) throw error;
      // A fresh database has no schema until the migration step.
    }
  }

  const runInstallationDoctor = async (activePlan) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const config = await readFile(configPath, 'utf8');
    const workerSource = await readFile(resolve(root, 'src/worker.ts'), 'utf8');
    return runDoctor({
      checkManifest: () => checkManifest({ catalog, manifest }),
      checkConfig: () => checkConfig({ manifest, template, config, workerSource, hostEnv: process.env }),
      checkDatabase: () => checkDatabase({ db, catalog, manifest, readDir: (path) => readdir(resolve(root, path)), ...(manifest.database === 'd1' ? { runner, wranglerBin, configPath } : {}), secrets: dbUrl ? [dbUrl] : [] }),
      checkServices: () => checkServices({ catalog, manifest, presence: servicePresence(manifest) }),
    }, { strict: false });
  };

  const steps = {
    'verify-provider': step(async () => ({ changed: false }), async () => true),
    'ensure-resources': createResourceStep({ plan, runner, wranglerBin, configPath, dbUrl, allowHyperdriveSecretInArgv: options.allowHyperdriveSecretInArgv, verify: async ({ resources }) => Boolean(resources?.r2BucketName && (plan.backend === 'd1' ? resources.d1DatabaseId : resources.hyperdriveId)) }),
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
      const current = await exists(configPath);
      if (current !== null) {
        const digest = createHash('sha256').update(current).digest('hex');
        const recognized = current.startsWith(GENERATED_MARKER) || digest === BASELINE_WRANGLER_SHA256;
        if (!recognized && !options.forceConfig) throw new Error('Refusing to overwrite an unrecognized wrangler.jsonc; review it and rerun with --force-config');
      }
      const result = await writeAtomic(configPath, desiredConfig, { allowReplace: current !== null, backup: current !== null, expectedContent: current });
      return { changed: result.changed };
    }, async ({ plan: activePlan }) => {
      desiredConfig ??= renderWrangler(template, JSON.parse(renderManifest(activePlan, catalog)));
      return await exists(configPath) === desiredConfig;
    }),
    'configure-secrets': step(async ({ plan: activePlan }) => configureSecrets({ mode: activePlan.mode, adminEmail: activePlan.adminEmail, path: resolve(root, '.dev.vars'), runner, wranglerBin, configPath }), async ({ plan: activePlan }) => {
      if (activePlan.mode === 'deploy') return true;
      const content = await exists(resolve(root, '.dev.vars')) ?? '';
      return ['SESSION_SECRET', 'EMAIL_DEV_LOG', 'AUTH_DEV_BYPASS_EMAIL'].every((key) => new RegExp(`^${key}=.+$`, 'm').test(content));
    }),
    ...providerSteps,
    'seed-media': step(async () => {
      const mediaPlan = loadMediaPlan({ root });
      return applyMediaPlan({ mediaPlan, db, uploadObject: ({ key, filePath, contentType }) => runner.run(wranglerBin, ['r2', 'object', 'put', `${plan.site.slug}-media/${key}`, '--file', filePath, '--content-type', contentType, ...(plan.mode === 'local' ? ['--local'] : []), '--config', configPath]) });
    }, async () => true),
    doctor: step(async ({ plan: activePlan }) => { latestDoctor = await runInstallationDoctor(activePlan); return { changed: false }; }, async ({ plan: activePlan }) => { latestDoctor ??= await runInstallationDoctor(activePlan); return latestDoctor.exitCode === 0; }),
  };

  try {
    const applied = await applySetup(plan, { steps, stateStore: createStateStore(statePath), dryRun: false });
    latestDoctor ??= await runInstallationDoctor(plan);
    const moduleRows = Number((await db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'module.%'").first())?.count ?? 0);
    const admin = await db.prepare('SELECT role, active FROM people WHERE lower(email)=lower(?)').bind(plan.adminEmail).first();
    return { backend: plan.backend, enabledModules: plan.modules, moduleRows, admin: { status: admin?.role === 'admin' && Number(admin.active) === 1 ? 'already-admin' : 'missing' }, apply: applied, doctor: latestDoctor };
  } finally {
    await postgresConnection?.close();
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
  const currentState = await deps.inspectExisting({ dryRun: parsed.dryRun });
  const plan = buildSetupPlan(answers, deps.catalog, currentState);
  if (parsed.dryRun) {
    deps.output(parsed.json
      ? JSON.stringify({ schemaVersion: 1, kind: 'setup-plan', plan })
      : deps.formatPlan(plan));
    return 0;
  }

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
  const result = await deps.apply(plan, {
    secretContext,
    forceConfig: parsed.forceConfig,
    promoteExistingAdmin: parsed.promoteExistingAdmin,
    allowHyperdriveSecretInArgv,
  });
  deps.output(parsed.json
    ? JSON.stringify({ schemaVersion: 1, kind: 'setup-result', ...result })
    : deps.formatResult(result));
  return result.doctor?.exitCode ?? 0;
}

async function readMaskedInput(input, output, message) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('SUPABASE_DB_URL is required in the environment for noninteractive setup');
  }
  output.write(`${message}: `);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  let value = '';
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === '\u0003') { cleanup(); reject(new Error('Setup cancelled')); return; }
          if (character === '\r' || character === '\n') { cleanup(); output.write('\n'); resolve(value); return; }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else value += character;
        }
      };
      const cleanup = () => input.off('data', onData);
      input.on('data', onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}

async function createDefaultDeps() {
  const catalog = JSON.parse(await readFile(new URL('../../config/capabilities.json', import.meta.url), 'utf8'));
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let readline;
  const getReadline = () => {
    if (!interactive) throw new Error('Interactive questions require a TTY');
    readline ??= createInterface({ input: process.stdin, output: process.stdout });
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
  const inspectExisting = async () => {
    try {
      const manifest = JSON.parse(await readFile('church.config.json', 'utf8'));
      return { existingBackend: manifest.database, resources: manifest.resources };
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
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
    const wranglerBin = resolve(root, 'node_modules/.bin/wrangler');
    const configPath = resolve(root, 'wrangler.jsonc');
    if (manifest?.database === 'd1') {
      runner = createCommandRunner();
      db = new D1CliDb({ runner, wranglerBin, configPath, mode: manifest.mode, ...(manifest.mode === 'local' && process.env.WRANGLER_PERSIST_TO ? { persistTo: process.env.WRANGLER_PERSIST_TO } : {}) });
    } else if (manifest?.database === 'supabase' && process.env.SUPABASE_DB_URL) {
      connection = openPostgresSetupDb(process.env.SUPABASE_DB_URL);
      db = connection.db;
    }
    try {
      return await runDoctor({
        checkManifest: () => checkManifest({ catalog, manifest }),
        checkConfig: () => checkConfig({ manifest, template, config, workerSource, hostEnv: process.env }),
        checkDatabase: () => {
          if (!db) throw new Error('database connection is unavailable');
          return checkDatabase({ db, catalog, manifest, readDir: (path) => readdir(resolve(root, path)), ...(runner ? { runner, wranglerBin, configPath } : {}), secrets: process.env.SUPABASE_DB_URL ? [process.env.SUPABASE_DB_URL] : [] });
        },
        checkServices: () => checkServices({ catalog, manifest, presence: servicePresence(manifest) }),
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
      maskedInput: (message) => readMaskedInput(process.stdin, process.stdout, message),
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
    deps.errorOutput(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    deps.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
