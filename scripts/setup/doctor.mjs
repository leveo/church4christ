import { doctorExitCode, result, summarizeReadiness, deepFreeze } from './readiness.mjs';
import { redact } from './redact.mjs';

const GROUPS = Object.freeze([
  ['manifest', 'checkManifest'],
  ['config', 'checkConfig'],
  ['database', 'checkDatabase'],
  ['services', 'checkServices'],
]);

export async function runDoctor(context, { strict = false } = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('doctor context is required');
  if (typeof strict !== 'boolean') throw new TypeError('doctor strict must be a boolean');
  for (const [, name] of GROUPS) if (typeof context[name] !== 'function') throw new TypeError(`doctor ${name} is required`);
  if (context.secrets !== undefined && (!Array.isArray(context.secrets) || context.secrets.some((value) => typeof value !== 'string'))) {
    throw new TypeError('doctor secrets must be an array of strings');
  }

  const checks = [];
  const codes = new Set();
  for (const [scope, name] of GROUPS) {
    try {
      const group = await context[name]();
      const validated = summarizeReadiness(group).checks;
      if (validated.some((entry) => codes.has(entry.code))) throw new Error('duplicate cross-group readiness code');
      for (const entry of validated) codes.add(entry.code);
      checks.push(...validated);
    } catch {
      const exception = result(`${scope}.exception`, 'error', `The ${scope} readiness check failed unexpectedly.`, `Repair the ${scope} check inputs and rerun doctor.`);
      codes.add(exception.code);
      checks.push(exception);
    }
  }
  const safe = redact(checks, context.secrets ?? []);
  const summary = summarizeReadiness(safe);
  return deepFreeze({ ...summary, exitCode: doctorExitCode(summary.checks, strict) });
}
