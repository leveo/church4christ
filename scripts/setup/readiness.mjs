import readinessCatalog from '../../config/readiness.json' with { type: 'json' };

export const READINESS_SCHEMA_VERSION = 2;
export const READINESS_SEVERITIES = Object.freeze(['error', 'warning', 'info']);
export const READINESS_STATUSES = Object.freeze(['pass', 'action_required', 'manual', 'not_applicable']);

const LEGACY_TO_ID = new Map(readinessCatalog.checks.flatMap((check) => check.legacyCodes.map((code) => [code, check.id])));

const PLAIN = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateResult(value) {
  if (!PLAIN(value)) throw new TypeError('readiness check must be a plain object');
  const keys = Object.keys(value).sort();
  if (keys.join('|') !== 'checkId|code|message|remediation|severity|status') throw new TypeError('readiness check fields are invalid');
  if (typeof value.checkId !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.checkId)) throw new TypeError('readiness check id is invalid');
  if (typeof value.code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/.test(value.code)) {
    throw new TypeError('readiness check code is invalid');
  }
  if (!READINESS_SEVERITIES.includes(value.severity)) throw new TypeError(`invalid readiness severity: ${String(value.severity)}`);
  if (!READINESS_STATUSES.includes(value.status)) throw new TypeError(`invalid readiness status: ${String(value.status)}`);
  if (typeof value.message !== 'string' || !value.message) throw new TypeError('readiness check message is invalid');
  if (typeof value.remediation !== 'string' || !value.remediation) throw new TypeError('readiness check remediation is invalid');
  return value;
}

export function result(...args) {
  let checkId, status, severity, code, message, remediation;
  if (args.length === 6) {
    [checkId, status, severity, code, message, remediation] = args;
  } else if (args.length === 4) {
    [code, severity, message, remediation] = args;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/.test(code)) throw new TypeError('readiness check code is invalid');
    // Synthetic fixture codes stay fixture-local; production literals are
    // exhaustively checked against config/readiness.json by the source test.
    checkId = LEGACY_TO_ID.get(code) ?? String(code).replaceAll('.', '-');
    status = severity === 'info' ? 'pass' : 'action_required';
    if (code === 'config.ok' || code === 'services.backup-ok' || code === 'services.backup-absent') status = 'manual';
    if (code === 'database.d1-migrations-unavailable') status = 'not_applicable';
  } else {
    throw new TypeError('readiness result arguments are invalid');
  }
  return deepFreeze(validateResult({ checkId, status, severity, code, message, remediation }));
}

function copyChecks(checks) {
  if (!Array.isArray(checks)) throw new TypeError('readiness checks must be an array');
  const codes = new Set();
  return checks.map((entry) => {
    validateResult(entry);
    if (codes.has(entry.code)) throw new Error(`duplicate readiness check code: ${entry.code}`);
    codes.add(entry.code);
    return deepFreeze({ checkId: entry.checkId, status: entry.status, severity: entry.severity, code: entry.code, message: entry.message, remediation: entry.remediation });
  });
}

export function summarizeReadiness(checks) {
  const copied = copyChecks(checks);
  const status = copied.some((check) => check.status === 'action_required' && check.severity === 'error')
    ? 'not-ready'
    : copied.some((check) => (check.status === 'action_required' && check.severity === 'warning') || check.status === 'manual') ? 'ready-with-limitations' : 'ready';
  return deepFreeze({ schemaVersion: READINESS_SCHEMA_VERSION, status, checks: copied });
}

export function doctorExitCode(checks, strict) {
  if (typeof strict !== 'boolean') throw new TypeError('doctor strict must be a boolean');
  const copied = copyChecks(checks);
  return copied.some((check) => check.status === 'action_required' && check.severity === 'error' ||
    strict && (check.status === 'manual' || check.status === 'action_required' && check.severity === 'warning')) ? 1 : 0;
}

export { deepFreeze };
