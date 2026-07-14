import { redact } from './redact.mjs';

const PHASES = new Set(['preverify', 'apply', 'postverify', 'mark']);

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function buildSetupRerunCommand(plan, controls = {}) {
  if (!plan || typeof plan !== 'object' || !['local', 'deploy'].includes(plan.mode) || !['d1', 'supabase'].includes(plan.backend)) {
    throw new TypeError('normalized setup plan is required for recovery');
  }
  const values = [plan.site?.slug, plan.site?.name, plan.site?.locale, plan.adminEmail, plan.adminName];
  if (values.some((value) => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))) {
    throw new TypeError('normalized setup plan contains an invalid recovery value');
  }
  const featureArgs = Array.isArray(plan.modules) && plan.modules.length && plan.modules.every((value) => typeof value === 'string' && value)
    ? ['--modules', plan.modules.join(',')]
    : null;
  if (!featureArgs) throw new TypeError('normalized setup plan features are required for recovery');
  const args = [
    '--mode', plan.mode, ...featureArgs,
    '--site-slug', plan.site.slug,
    '--church-name', plan.site.name,
    '--locale', plan.site.locale,
    '--admin-email', plan.adminEmail,
    '--admin-name', plan.adminName,
  ];
  if (plan.mode === 'deploy') {
    if (typeof plan.site.appOrigin !== 'string' || typeof plan.site.emailFrom !== 'string') throw new TypeError('deploy recovery values are required');
    args.push('--app-origin', plan.site.appOrigin, '--email-from', plan.site.emailFrom);
  }
  args.push('--backend', plan.backend);
  if (plan.demoData === true) args.push('--demo-data');
  if (controls.forceConfig === true) args.push('--force-config');
  if (controls.promoteExistingAdmin === true) args.push('--promote-existing-admin');
  if (controls.allowHyperdriveSecretInArgv === true) args.push('--allow-hyperdrive-secret-in-argv');
  args.push('--yes');
  return `npm run --silent setup -- ${args.map((arg) => arg.startsWith('--') ? arg : shellQuote(arg)).join(' ')}`;
}

function safeCauseMessage(error, secretValues) {
  let message = error instanceof Error ? error.message : String(error);
  message = redact(message, secretValues);
  return message
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED URL]')
    .replace(/\b(https?):\/\/([^\s/@:]+):([^\s/@]+)@[^\s"'<>]+/gi, '[REDACTED URL]');
}

export function formatSetupFailure(failure) {
  const completed = failure.completed.length
    ? failure.completed.map(({ step, status }) => `${step} (${status})`).join(', ')
    : 'none';
  const unchanged = failure.unchanged.length ? failure.unchanged.join(', ') : 'none';
  return [
    'Setup stopped safely.',
    `Failed step: ${failure.step} (${failure.phase})`,
    `Cause: ${failure.causeMessage}`,
    `Completed: ${completed}`,
    `Unchanged: ${unchanged}`,
    `Remediation: ${failure.remediation}`,
    `Rerun: ${failure.rerunCommand}`,
  ].join('\n');
}

export class SetupApplyError extends Error {
  constructor({ step, phase, completed, unchanged, cause, rerunCommand }) {
    if (typeof step !== 'string' || !step || !PHASES.has(phase)) throw new TypeError('setup failure step and phase are required');
    if (!Array.isArray(completed) || !Array.isArray(unchanged)) throw new TypeError('setup failure progress is required');
    if (typeof rerunCommand !== 'string' || !rerunCommand || /[\r\n\0]/.test(rerunCommand)) throw new TypeError('setup failure rerun command is invalid');
    const secretValues = Array.isArray(cause?.secretValues) ? cause.secretValues : [];
    const causeMessage = safeCauseMessage(cause?.error, secretValues);
    const remediation = 'Correct the reported cause, then rerun the same command; completed steps will be verified and no destructive rollback is needed.';
    const details = {
      code: 'SETUP_APPLY_FAILED', step, phase,
      completed: Object.freeze(completed.map((entry) => Object.freeze({ step: entry.step, status: entry.status }))),
      unchanged: Object.freeze([...unchanged]), causeMessage, remediation, rerunCommand,
    };
    super(formatSetupFailure(details), { cause: new Error(causeMessage) });
    this.name = 'SetupApplyError';
    Object.assign(this, details);
  }
}
