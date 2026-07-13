import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeAtomic } from './files.mjs';

const STATE_V1_KEYS = ['schemaVersion', 'planFingerprint', 'completed'];
const STATE_V2_KEYS = ['schemaVersion', 'installationOrigin', 'planFingerprint', 'completed'];
const RECORD_KEYS = ['at', 'evidence'];
const STEP = /^[a-z][a-z0-9-]*$/;
const KNOWN_STEPS = new Set(['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const RESOURCE_KEYS = ['d1DatabaseName', 'd1DatabaseId', 'r2BucketName', 'hyperdriveId'];
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]+$/;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprintPlan(plan) {
  let desired = plan;
  if (isRecord(plan) && isRecord(plan.site) && typeof plan.site.slug === 'string' && ['d1', 'supabase'].includes(plan.backend)) {
    const {
      existingInstallation: _provenance,
      proposedChanges: _previewOnly,
      resources,
      ...rest
    } = plan;
    const r2BucketName = isRecord(resources) && typeof resources.r2BucketName === 'string' ? resources.r2BucketName : `${plan.site.slug}-media`;
    const databaseName = plan.backend === 'd1' && isRecord(resources) && typeof resources.d1DatabaseName === 'string'
      ? resources.d1DatabaseName : `${plan.site.slug}-db`;
    desired = { ...rest, resources: { databaseName, r2BucketName } };
  }
  const json = stable(desired);
  if (json === undefined) throw new TypeError('plan cannot be fingerprinted');
  return createHash('sha256').update(json).digest('hex');
}

function jsonClone(value, path = 'value') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} is not JSON-safe`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => jsonClone(entry, `${path}[${index}]`));
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} is not plain JSON`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonClone(entry, `${path}.${key}`)]));
}

function resourceEvidence(value) {
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== [...RESOURCE_KEYS].sort().join('|')) throw new Error('ensure-resources evidence has invalid fields');
  const resource = jsonClone(value, 'ensure-resources evidence');
  if (!RESOURCE_NAME.test(resource.r2BucketName ?? '')) throw new Error('ensure-resources evidence has invalid bucket name');
  for (const key of ['d1DatabaseId', 'hyperdriveId']) {
    if (resource[key] !== null && (typeof resource[key] !== 'string' || !RESOURCE_ID.test(resource[key]))) throw new Error(`ensure-resources evidence has invalid ${key}`);
  }
  if (resource.d1DatabaseName !== null && (typeof resource.d1DatabaseName !== 'string' || !RESOURCE_NAME.test(resource.d1DatabaseName))) throw new Error('ensure-resources evidence has invalid database name');
  const d1 = resource.d1DatabaseName !== null && resource.d1DatabaseId !== null && resource.hyperdriveId === null;
  const postgres = resource.d1DatabaseName === null && resource.d1DatabaseId === null && resource.hyperdriveId !== null;
  if (!d1 && !postgres) throw new Error('ensure-resources evidence is inconsistent');
  return resource;
}

function stepEvidence(name, value) {
  if (name === 'ensure-resources') return resourceEvidence(value);
  if (value !== null) throw new Error(`Setup step ${name} evidence must be null`);
  return null;
}

function validateState(value) {
  if (!isRecord(value) || ![1, 2].includes(value.schemaVersion)) throw new Error('setup state version is unsupported');
  const expectedKeys = value.schemaVersion === 1 ? STATE_V1_KEYS : STATE_V2_KEYS;
  if (Object.keys(value).sort().join('|') !== [...expectedKeys].sort().join('|')) throw new Error('setup state schema is invalid');
  if (value.schemaVersion === 2 && !['managed', 'imported'].includes(value.installationOrigin)) throw new Error('setup state installation origin is invalid');
  if (value.planFingerprint !== null && (typeof value.planFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.planFingerprint))) throw new Error('setup state fingerprint is invalid');
  if (!isRecord(value.completed)) throw new Error('setup state completed map is invalid');
  const completed = {};
  for (const [name, record] of Object.entries(value.completed)) {
    if (!STEP.test(name) || !KNOWN_STEPS.has(name) || !isRecord(record) || Object.keys(record).sort().join('|') !== [...RECORD_KEYS].sort().join('|') ||
      typeof record.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at) || Number.isNaN(Date.parse(record.at))) throw new Error('setup state completion record is invalid');
    completed[name] = { at: record.at, evidence: stepEvidence(name, record.evidence) };
  }
  return {
    schemaVersion: value.schemaVersion,
    ...(value.schemaVersion === 2 ? { installationOrigin: value.installationOrigin } : {}),
    planFingerprint: value.planFingerprint,
    completed,
  };
}

/**
 * @param {string} path
 * @param {{ readJson?: (path: string) => Promise<unknown>, writeJsonAtomic?: (path: string, content: string, options: { expectedContent: string | null }) => Promise<unknown> }} [options]
 */
export function createStateStore(path, options = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('setup state path is required');
  const readJson = options.readJson ?? (async (target) => {
    const sourceContent = await readFile(target, 'utf8');
    return { value: JSON.parse(sourceContent), sourceContent };
  });
  const writeJsonAtomic = options.writeJsonAtomic ?? ((target, content, writeOptions) => writeAtomic(target, content, { allowReplace: true, expectedContent: writeOptions.expectedContent }));
  let state = { schemaVersion: 2, installationOrigin: 'managed', planFingerprint: null, completed: {} };
  let sourceContent = null;
  let loaded = false;
  return Object.freeze({
    async load(fingerprint, originHint = 'managed') {
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('setup plan fingerprint is invalid');
      if (!['managed', 'imported'].includes(originHint)) throw new Error('setup installation origin hint is invalid');
      loaded = false;
      let missing = false;
      try {
        const loadedValue = await readJson(path);
        if (isRecord(loadedValue) && Object.hasOwn(loadedValue, 'value') && Object.hasOwn(loadedValue, 'sourceContent')) {
          if (typeof loadedValue.sourceContent !== 'string') throw new Error('invalid state source');
          state = validateState(loadedValue.value);
          sourceContent = loadedValue.sourceContent;
        } else {
          state = validateState(loadedValue);
          sourceContent = `${JSON.stringify(loadedValue, null, 2)}\n`;
        }
      }
      catch (error) {
        if (error?.code !== 'ENOENT') throw new Error('Failed to read setup state: state file is corrupt or unsupported');
        state = { schemaVersion: 2, installationOrigin: originHint, planFingerprint: null, completed: {} };
        sourceContent = null;
        missing = true;
      }
      // Version 1 predates durable provenance. Its caller-provided discovery hint is
      // the only safe deterministic inference; the next mark atomically upgrades it.
      const legacy = state.schemaVersion === 1;
      if (legacy) state = { ...state, schemaVersion: 2, installationOrigin: originHint };
      const fingerprintChanged = state.planFingerprint !== fingerprint;
      if (state.planFingerprint !== fingerprint) state.completed = {};
      state.planFingerprint = fingerprint;
      if (missing || (!legacy && fingerprintChanged)) {
        const nextContent = `${JSON.stringify(state, null, 2)}\n`;
        await writeJsonAtomic(path, nextContent, { expectedContent: sourceContent });
        sourceContent = nextContent;
      }
      loaded = true;
      return state.installationOrigin;
    },
    async has(name) { if (!loaded) throw new Error('setup state must be loaded'); return Boolean(state.completed[name]); },
    async getEvidence(name) {
      if (!loaded) throw new Error('setup state must be loaded');
      return state.completed[name] ? jsonClone(state.completed[name].evidence) : null;
    },
    /** @param {string} name @param {unknown} evidence */
    async mark(name, evidence = null) {
      if (!loaded) throw new Error('setup state must be loaded');
      if (typeof name !== 'string' || !STEP.test(name) || !KNOWN_STEPS.has(name)) throw new Error('setup step name is invalid');
      const cloned = stepEvidence(name, evidence);
      const next = jsonClone({ ...state, completed: { ...state.completed, [name]: { at: new Date().toISOString(), evidence: cloned } } }, 'state');
      const nextContent = `${JSON.stringify(next, null, 2)}\n`;
      await writeJsonAtomic(path, nextContent, { expectedContent: sourceContent });
      state = next;
      sourceContent = nextContent;
    },
  });
}
