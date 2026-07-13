import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { normalizeEmail } from './answers.mjs';
import { writeAtomic } from './files.mjs';

const MANAGED = new Set(['SESSION_SECRET', 'EMAIL_DEV_LOG', 'AUTH_DEV_BYPASS_EMAIL']);
const KEY = /^[A-Z][A-Z0-9_]*$/;
const LOCAL_HYPERDRIVE = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE';
const WRANGLER_ENV = Object.freeze({ ...process.env, WRANGLER_HIDE_BANNER: 'true', NO_COLOR: '1', FORCE_COLOR: '0' });
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

function appendManaged(content, additions) {
  let output = content;
  if (output && !output.endsWith('\n')) output += '\n';
  for (const [key, value] of additions) output += `${key}=${value}\n`;
  return output;
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
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: WRANGLER_ENV });
  if (listed.exitCode === 0) return parseSecretList(listed.stdout).has(options.name);
  if (listed.stdout === '' && isFreshWorkerError(listed.stderr)) return false;
  throw new Error('Wrangler secret list failed during verification');
}

export async function listDeploySecrets(options) {
  if (!options?.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: WRANGLER_ENV });
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
  if (options?.mode === 'local') {
    if (typeof options.path !== 'string' || !options.path) throw new TypeError('local .dev.vars path is required');
    let content = '';
    let sourceContent = null;
    try { content = await readFile(options.path, 'utf8'); sourceContent = content; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const existing = parseDevVars(content);
    const additions = [];
    if (!existing.has('SESSION_SECRET')) additions.push(['SESSION_SECRET', randomBytes(32).toString('base64url')]);
    if (!existing.has('EMAIL_DEV_LOG')) additions.push(['EMAIL_DEV_LOG', '1']);
    if (!existing.has('AUTH_DEV_BYPASS_EMAIL')) additions.push(['AUTH_DEV_BYPASS_EMAIL', adminEmail]);
    const writer = options.writeAtomic ?? writeAtomic;
    if (typeof writer !== 'function') throw new TypeError('writeAtomic must be a function');
    const result = await writer(options.path, appendManaged(content, additions), { allowReplace: true, expectedContent: sourceContent });
    const handle = await open(options.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { await handle.chmod(0o600); } finally { await handle.close(); }
    return Object.freeze({ changed: result.changed, configured: additions.map(([key]) => key) });
  }
  if (options?.mode !== 'deploy') throw new TypeError('secret mode must be local or deploy');
  if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner.run is required');
  if (typeof options.wranglerBin !== 'string' || !options.wranglerBin) throw new TypeError('wranglerBin is required');
  if (typeof options.configPath !== 'string' || !options.configPath) throw new TypeError('configPath is required');
  const listed = await options.runner.run(options.wranglerBin, ['secret', 'list', '--format', 'json', '--config', options.configPath], { allowNonzero: true, env: WRANGLER_ENV });
  let names;
  if (listed.exitCode === 0) {
    names = parseSecretList(listed.stdout);
  } else {
    if (listed.stdout !== '' || !isFreshWorkerError(listed.stderr)) throw new Error('Wrangler secret list failed; refusing to assume a fresh Worker');
    names = new Set();
  }
  if (names.has('SESSION_SECRET')) return Object.freeze({ changed: false, configured: [] });
  const sessionSecret = randomBytes(32).toString('base64url');
  await options.runner.run(options.wranglerBin, ['secret', 'put', 'SESSION_SECRET', '--config', options.configPath], { input: `${sessionSecret}\n`, env: WRANGLER_ENV });
  return Object.freeze({ changed: true, configured: ['SESSION_SECRET'] });
}
