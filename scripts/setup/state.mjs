import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './files.mjs';

const STATE_KEYS = ['schemaVersion', 'planFingerprint', 'completed'];
const RECORD_KEYS = ['at', 'evidence'];
const STEP = /^[a-z][a-z0-9-]*$/;
const KNOWN_STEPS = new Set(['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor']);
const SECRET_KEY = /(?:secret|token|password|credential|api.?key|database.?url|connection.?string)/i;
const SECRET_VALUE = /(?:postgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@|sk_(?:live|test)_|whsec_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprintPlan(plan) {
  const json = stable(plan);
  if (json === undefined) throw new TypeError('plan cannot be fingerprinted');
  return createHash('sha256').update(json).digest('hex');
}

function safeClone(value, path = 'evidence') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} is not JSON-safe`);
    if (typeof value === 'string' && SECRET_VALUE.test(value)) throw new Error(`${path} contains a secret-like value`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => safeClone(entry, `${path}[${index}]`));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} is not plain JSON`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (SECRET_KEY.test(key)) throw new Error(`${path} contains secret-like field ${key}`);
    return [key, safeClone(entry, `${path}.${key}`)];
  }));
}

function validateState(value) {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== [...STATE_KEYS].sort().join('|')) throw new Error('setup state schema is invalid');
  if (value.schemaVersion !== 1) throw new Error('setup state version is unsupported');
  if (value.planFingerprint !== null && (typeof value.planFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.planFingerprint))) throw new Error('setup state fingerprint is invalid');
  if (!isRecord(value.completed)) throw new Error('setup state completed map is invalid');
  const completed = {};
  for (const [name, record] of Object.entries(value.completed)) {
    if (!STEP.test(name) || !KNOWN_STEPS.has(name) || !isRecord(record) || Object.keys(record).sort().join('|') !== [...RECORD_KEYS].sort().join('|') ||
      typeof record.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at) || Number.isNaN(Date.parse(record.at))) throw new Error('setup state completion record is invalid');
    completed[name] = { at: record.at, evidence: safeClone(record.evidence) };
  }
  return { schemaVersion: 1, planFingerprint: value.planFingerprint, completed };
}

/**
 * @param {string} path
 * @param {{ readJson?: (path: string) => Promise<unknown>, writeJsonAtomic?: (path: string, value: unknown) => Promise<unknown> }} [options]
 */
export function createStateStore(path, options = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('setup state path is required');
  const readJson = options.readJson ?? (async (target) => JSON.parse(await readFile(target, 'utf8')));
  const writeJsonAtomic = options.writeJsonAtomic ?? ((target, value) => writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, { allowReplace: true }));
  let state = { schemaVersion: 1, planFingerprint: null, completed: {} };
  let loaded = false;
  return Object.freeze({
    async load(fingerprint) {
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('setup plan fingerprint is invalid');
      try { state = validateState(await readJson(path)); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw new Error('Failed to read setup state: state file is corrupt or unsupported');
        state = { schemaVersion: 1, planFingerprint: null, completed: {} };
      }
      if (state.planFingerprint !== fingerprint) state.completed = {};
      state.planFingerprint = fingerprint; loaded = true;
    },
    async has(name) { if (!loaded) throw new Error('setup state must be loaded'); return Boolean(state.completed[name]); },
    async getEvidence(name) {
      if (!loaded) throw new Error('setup state must be loaded');
      return state.completed[name] ? safeClone(state.completed[name].evidence) : null;
    },
    /** @param {string} name @param {unknown} evidence */
    async mark(name, evidence = null) {
      if (!loaded) throw new Error('setup state must be loaded');
      if (typeof name !== 'string' || !STEP.test(name) || !KNOWN_STEPS.has(name)) throw new Error('setup step name is invalid');
      const cloned = safeClone(evidence);
      state.completed[name] = { at: new Date().toISOString(), evidence: cloned };
      await writeJsonAtomic(path, safeClone(state, 'state'));
    },
  });
}
