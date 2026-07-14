export const READINESS_SCHEMA_VERSION = 1;
export const READINESS_SEVERITIES = Object.freeze(['error', 'warning', 'info']);

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
  if (keys.join('|') !== 'code|message|remediation|severity') throw new TypeError('readiness check fields are invalid');
  if (typeof value.code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/.test(value.code)) {
    throw new TypeError('readiness check code is invalid');
  }
  if (!READINESS_SEVERITIES.includes(value.severity)) throw new TypeError(`invalid readiness severity: ${String(value.severity)}`);
  if (typeof value.message !== 'string' || !value.message) throw new TypeError('readiness check message is invalid');
  if (typeof value.remediation !== 'string' || !value.remediation) throw new TypeError('readiness check remediation is invalid');
  return value;
}

export function result(code, severity, message, remediation) {
  return deepFreeze(validateResult({ code, severity, message, remediation }));
}

function copyChecks(checks) {
  if (!Array.isArray(checks)) throw new TypeError('readiness checks must be an array');
  const codes = new Set();
  return checks.map((entry) => {
    validateResult(entry);
    if (codes.has(entry.code)) throw new Error(`duplicate readiness check code: ${entry.code}`);
    codes.add(entry.code);
    return deepFreeze({ code: entry.code, severity: entry.severity, message: entry.message, remediation: entry.remediation });
  });
}

export function summarizeReadiness(checks) {
  const copied = copyChecks(checks);
  const status = copied.some((check) => check.severity === 'error')
    ? 'not-ready'
    : copied.some((check) => check.severity === 'warning') ? 'ready-with-limitations' : 'ready';
  return deepFreeze({ schemaVersion: READINESS_SCHEMA_VERSION, status, checks: copied });
}

export function doctorExitCode(checks, strict) {
  if (typeof strict !== 'boolean') throw new TypeError('doctor strict must be a boolean');
  const copied = copyChecks(checks);
  return copied.some((check) => check.severity === 'error' || (strict && check.severity === 'warning')) ? 1 : 0;
}

export { deepFreeze };
