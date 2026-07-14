import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { normalizeEmail } from './answers.mjs';
import { writeAtomic } from './files.mjs';

const MANAGED = new Set(['SESSION_SECRET', 'EMAIL_DEV_LOG', 'AUTH_DEV_BYPASS_EMAIL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_MODE']);
const KEY = /^[A-Z][A-Z0-9_]*$/;
const LOCAL_HYPERDRIVE = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE';
const STRIPE_ENV_KEYS = Object.freeze([
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_MODE',
  'CHURCH_SETUP_STRIPE_SECRET_KEY',
  'CHURCH_SETUP_STRIPE_WEBHOOK_SECRET',
]);
const FRESH_WORKER = /^Worker "[A-Za-z0-9][A-Za-z0-9_-]*"(?: \(env: [A-Za-z0-9_-]+\))? not found\.\n\nIf this is a new Worker, run `wrangler deploy` first to create it\.\nOtherwise, check that the Worker name is correct and you're logged into the right account\.$/;

export function parseDevVars(content) {
  const found = new Map();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error(`Invalid .dev.vars line ${index + 1}`);
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    if (!KEY.test(key) || /[\r\n\0]/.test(value)) throw new Error(`Invalid .dev.vars line ${index + 1}`);
    if (key === LOCAL_HYPERDRIVE) throw new Error(`${LOCAL_HYPERDRIVE} is host-only and must not be stored in .dev.vars`);
    if (MANAGED.has(key)) {
      if (found.has(key)) throw new Error(`Duplicate managed .dev.vars key: ${key}`);
      if (!value) throw new Error(`Managed .dev.vars key ${key} has an empty value`);
      if (key === 'SESSION_SECRET' && (value.length < 32 || /\s/.test(value))) throw new Error('SESSION_SECRET must contain at least 32 non-space characters');
      if (key === 'EMAIL_DEV_LOG' && !['0', '1'].includes(value)) throw new Error('EMAIL_DEV_LOG must be 0 or 1');
      if (key === 'AUTH_DEV_BYPASS_EMAIL' && normalizeEmail(value, 'AUTH_DEV_BYPASS_EMAIL') !== value) throw new Error('AUTH_DEV_BYPASS_EMAIL must be normalized');
      found.set(key, value);
    }
  }
  return found;
}

function wranglerEnv(environment = process.env) {
  const env = { ...environment, WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of STRIPE_ENV_KEYS) delete env[key];
  return env;
}

function validateStripeTestSecrets(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== 'secretKey|webhookSecret') {
    throw new TypeError('Stripe test secrets must be a complete pair');
  }
  const secretKey = typeof value.secretKey === 'string' ? value.secretKey.trim() : '';
  const webhookSecret = typeof value.webhookSecret === 'string' ? value.webhookSecret.trim() : '';
  if (!secretKey.startsWith('sk_test_') || secretKey.length <= 'sk_test_'.length || /[\s\0]/.test(secretKey)) {
    throw new Error('Stripe test secret key must begin with sk_test_');
  }
  if (!webhookSecret.startsWith('whsec_') || webhookSecret.length <= 'whsec_'.length || /[\s\0]/.test(webhookSecret)) {
    throw new Error('Stripe test webhook secret must begin with whsec_');
  }
  return Object.freeze({ secretKey, webhookSecret });
}

export async function collectStripeTestSecrets(options = {}) {
  const environment = options.environment ?? process.env;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('secret environment must be an object');
  const secretKey = environment.CHURCH_SETUP_STRIPE_SECRET_KEY;
  const webhookSecret = environment.CHURCH_SETUP_STRIPE_WEBHOOK_SECRET;
  if (secretKey === undefined && webhookSecret === undefined) return null;
  if (!secretKey || !webhookSecret) throw new Error('Stripe test credentials must be supplied as a complete pair');
  return validateStripeTestSecrets({ secretKey, webhookSecret });
}

export function collectStripeSetupRedactionValues(options = {}) {
  const environment = options.environment ?? process.env;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('secret environment must be an object');
  const values = [];
  for (const key of ['CHURCH_SETUP_STRIPE_SECRET_KEY', 'CHURCH_SETUP_STRIPE_WEBHOOK_SECRET']) {
    const raw = environment[key];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    values.push(raw);
    const trimmed = raw.trim();
    if (trimmed && trimmed !== raw) values.push(trimmed);
  }
  return Object.freeze([...new Set(values)]);
}

export function verifyLocalSecretsContent(content, adminEmail) {
  try {
    const found = parseDevVars(content);
    const fileAdmin = found.get('AUTH_DEV_BYPASS_EMAIL');
    const normalizedFileAdmin = normalizeEmail(fileAdmin, 'AUTH_DEV_BYPASS_EMAIL');
    const expected = adminEmail === undefined ? undefined : normalizeEmail(adminEmail, 'admin email');
    return found.get('EMAIL_DEV_LOG') === '1' && fileAdmin === normalizedFileAdmin && (!expected || fileAdmin === expected) &&
      typeof found.get('SESSION_SECRET') === 'string' && found.get('SESSION_SECRET').length >= 32;
  } catch { return false; }
}

export async function readLocalSecretsStatus(path, adminEmail) {
  try { return verifyLocalSecretsContent(await readFile(path, 'utf8'), adminEmail); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function localSecretNames(content) {
  if (typeof content !== 'string') throw new TypeError('local secret content must be a string');
  const names = new Set();
  const seen = new Set();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error('local secret file is malformed');
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    if (!KEY.test(key) || /[\r\n\0]/.test(value) || seen.has(key) || key === LOCAL_HYPERDRIVE) {
      throw new Error('local secret file is malformed');
    }
    seen.add(key);
    if (value.trim().length > 0) names.add(key);
  }
  return Object.freeze([...names].sort());
}

export async function readLocalSecretNames(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('local secret path is required');
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw new Error('Local secret names could not be read safely');
  }
  try { return localSecretNames(content); }
  catch { throw new Error('Local secret names could not be read safely'); }
}

export async function readLocalStripeClassification(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('local secret path is required');
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ classification: 'missing', secretKey: false, webhookSecret: false });
    throw new Error('Local Stripe configuration could not be classified safely');
  }
  let found;
  try { found = parseDevVars(content); }
  catch { throw new Error('Local Stripe configuration could not be classified safely'); }
  const secretKey = found.get('STRIPE_SECRET_KEY');
  const webhookSecret = found.get('STRIPE_WEBHOOK_SECRET');
  const presence = { secretKey: Boolean(secretKey), webhookSecret: Boolean(webhookSecret) };
  let classification = 'unknown';
  const normalizedKey = secretKey?.trim() ?? '';
  const normalizedWebhook = webhookSecret?.trim() ?? '';
  const validWebhook = normalizedWebhook.startsWith('whsec_') && normalizedWebhook.length > 'whsec_'.length && !/[\s\0]/.test(normalizedWebhook);
  if (!secretKey && !webhookSecret) classification = 'missing';
  else if (normalizedKey.startsWith('sk_test_') && normalizedKey.length > 'sk_test_'.length && !/[\s\0]/.test(normalizedKey) && validWebhook) classification = 'test';
  else if (normalizedKey.startsWith('sk_live_') && normalizedKey.length > 'sk_live_'.length && !/[\s\0]/.test(normalizedKey) && validWebhook) classification = 'live';
  return Object.freeze({ classification, ...presence });
}

export async function readLocalStripeModeOverride(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('local secret path is required');
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ present: false, test: false });
    throw new Error('Local Stripe mode override could not be classified safely');
  }
  let found;
  try { found = parseDevVars(content); }
  catch { throw new Error('Local Stripe mode override could not be classified safely'); }
  const value = found.get('STRIPE_MODE');
  return Object.freeze({ present: value !== undefined, test: value?.trim() === 'test' });
}

function appendManaged(content, additions) {
  let output = content;
  if (output && !output.endsWith('\n')) output += '\n';
  for (const [key, value] of additions) output += `${key}=${value}\n`;
  return output;
}

function upsertManaged(content, entries) {
  const replacements = new Map(entries);
  const found = new Set();
  const lines = content.split(/\r?\n/).map((line) => {
    const equals = line.indexOf('=');
    if (equals < 1) return line;
    const key = line.slice(0, equals).trim();
    if (!replacements.has(key)) return line;
    found.add(key);
    return `${key}=${replacements.get(key)}`;
  });
  let output = lines.join('\n');
  const additions = entries.filter(([key]) => !found.has(key));
  return appendManaged(output, additions);
}

function removeManaged(content, name) {
  return content.split(/\r?\n/).filter((line) => {
    const equals = line.indexOf('=');
    return equals < 1 || line.slice(0, equals).trim() !== name;
  }).join('\n');
}

export function parseSecretList(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('Wrangler secret list returned malformed JSON'); }
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
    typeof entry.name !== 'string' || !KEY.test(entry.name) || typeof entry.type !== 'string' || !entry.type ||
    Object.keys(entry).sort().join('|') !== 'name|type')) {
    throw new Error('Wrangler secret list returned invalid JSON');
  }
  const names = new Set(value.map((entry) => entry.name));
  if (names.size !== value.length) throw new Error('Wrangler secret list returned duplicate names');
  return names;
}

export async function hasDeploySecret(options) {
  if (!options?.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.name !== 'string' || !KEY.test(options.name)) throw new TypeError('secret name is invalid');
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: wranglerEnv() });
  if (listed.exitCode === 0) return parseSecretList(listed.stdout).has(options.name);
  if (listed.stdout === '' && isFreshWorkerError(listed.stderr)) return false;
  throw new Error('Wrangler secret list failed during verification');
}

export async function listDeploySecrets(options) {
  if (!options?.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: wranglerEnv() });
  if (listed.exitCode === 0) return parseSecretList(listed.stdout);
  if (listed.stdout === '' && isFreshWorkerError(listed.stderr)) return new Set();
  throw new Error('Wrangler secret list failed during verification');
}

function isFreshWorkerError(stderr) {
  if (typeof stderr !== 'string') return false;
  const withoutSgr = stderr.replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n');
  if (/\u001b|[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(withoutSgr)) return false;
  const lines = withoutSgr.trim().split('\n');
  const logLine = /^🪵  Logs were written to "[^"\n]+"$/;
  if (logLine.test(lines.at(-1) ?? '')) {
    lines.pop();
    while ((lines.at(-1) ?? '').trim() === '') lines.pop();
  }
  if (!lines[0]?.startsWith('✘ [ERROR] ')) return false;
  lines[0] = lines[0].slice('✘ [ERROR] '.length);
  const normalized = lines.map((line, index) => index > 0 && line.startsWith('  ') ? line.slice(2) : line).join('\n');
  return FRESH_WORKER.test(normalized);
}

export async function configureSecrets(options) {
  const adminEmail = normalizeEmail(options?.adminEmail, 'admin email');
  const stripeSecrets = validateStripeTestSecrets(options?.stripeSecrets);
  if (options?.mode === 'local') {
    if (typeof options.path !== 'string' || !options.path) throw new TypeError('local .dev.vars path is required');
    let content = '';
    let sourceContent = null;
    try { content = await readFile(options.path, 'utf8'); sourceContent = content; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    content = removeManaged(content, 'STRIPE_MODE');
    const existing = parseDevVars(content);
    const additions = [];
    if (!existing.has('SESSION_SECRET')) additions.push(['SESSION_SECRET', randomBytes(32).toString('base64url')]);
    if (!existing.has('EMAIL_DEV_LOG')) additions.push(['EMAIL_DEV_LOG', '1']);
    additions.push(['AUTH_DEV_BYPASS_EMAIL', adminEmail]);
    if (stripeSecrets) {
      additions.push(['STRIPE_SECRET_KEY', stripeSecrets.secretKey]);
      additions.push(['STRIPE_WEBHOOK_SECRET', stripeSecrets.webhookSecret]);
    }
    const writer = options.writeAtomic ?? writeAtomic;
    if (typeof writer !== 'function') throw new TypeError('writeAtomic must be a function');
    const result = await writer(options.path, upsertManaged(content, additions), { allowReplace: true, expectedContent: sourceContent });
    const handle = await open(options.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { await handle.chmod(0o600); } finally { await handle.close(); }
    return Object.freeze({ changed: result.changed, configured: additions.map(([key]) => key) });
  }
  if (options?.mode !== 'deploy') throw new TypeError('secret mode must be local or deploy');
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.wranglerBin !== 'string' || !options.wranglerBin) throw new TypeError('wranglerBin is required');
  if (typeof options.configPath !== 'string' || !options.configPath) throw new TypeError('configPath is required');
  const environment = wranglerEnv();
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: environment });
  let names;
  if (listed.exitCode === 0) {
    names = parseSecretList(listed.stdout);
  } else {
    if (listed.stdout !== '' || !isFreshWorkerError(listed.stderr)) throw new Error('Wrangler secret list failed; refusing to assume a fresh Worker');
    names = new Set();
  }
  const required = [];
  if (!names.has('SESSION_SECRET')) required.push(['SESSION_SECRET', randomBytes(32).toString('base64url')]);
  if (stripeSecrets && !names.has('STRIPE_SECRET_KEY')) required.push(['STRIPE_SECRET_KEY', stripeSecrets.secretKey]);
  if (stripeSecrets && !names.has('STRIPE_WEBHOOK_SECRET')) required.push(['STRIPE_WEBHOOK_SECRET', stripeSecrets.webhookSecret]);
  for (const [name, value] of required) {
    await options.runner.run(options.wranglerBin, ['secret', 'put', name, '--config', options.configPath], { input: `${value}\n`, env: environment });
  }
  return Object.freeze({ changed: required.length > 0, configured: required.map(([name]) => name) });
}
