import { result } from '../readiness.mjs';

const PRESENCE_KEYS = Object.freeze(['worker', 'r2', 'hyperdrive', 'email', 'emailDevLog', 'stripeSecretKey', 'stripeWebhookSecret', 'backup']);
const SUPPORTED_REQUIRED = new Set(['worker', 'r2', 'hyperdrive', 'email', 'stripe']);

export async function checkServices(options) {
  if (!options || !options.catalog || !options.manifest || !Array.isArray(options.manifest.modules)) {
    throw new TypeError('services check catalog and manifest are required');
  }
  if (!options.presence || typeof options.presence !== 'object' || Array.isArray(options.presence)) throw new TypeError('services presence is required');
  const actualPresence = Object.keys(options.presence).sort();
  if (actualPresence.join('|') !== [...PRESENCE_KEYS].sort().join('|')) throw new TypeError('services presence fields are invalid');
  for (const key of PRESENCE_KEYS) {
    if (typeof options.presence[key] !== 'boolean') throw new TypeError(`services presence.${key} must be a boolean`);
  }
  const selected = new Set(options.manifest.modules);
  if ([...selected].some((key) => !Object.hasOwn(options.catalog.capabilities, key))) throw new TypeError('services manifest contains an unknown capability');
  const required = new Set(options.catalog.providers[options.manifest.database]?.requiredServices ?? []);
  for (const key of selected) for (const service of options.catalog.capabilities[key].requiredServices) required.add(service);
  const optional = new Set();
  for (const key of selected) for (const service of options.catalog.capabilities[key].optionalServices) optional.add(service);
  const checks = [];

  if ([...required].some((service) => !SUPPORTED_REQUIRED.has(service))) {
    checks.push(result('services.required-unsupported', 'error', 'A required service has no readiness probe.', 'Update the doctor service checks before enabling this required service.'));
  }

  if (required.has('worker')) {
    checks.push(options.presence.worker
      ? result('services.worker-ok', 'info', 'The required Worker service is available.', 'No action is required.')
      : result('services.worker', 'error', 'The required Worker service is unavailable.', 'Deploy or configure the Worker before using the site.'));
  }

  if (required.has('r2')) {
    checks.push(options.presence.r2
      ? result('services.r2-ok', 'info', 'Required R2 media storage is accessible.', 'No action is required.')
      : result('services.r2', 'error', 'Required R2 media storage is unavailable.', 'Create or bind the configured MEDIA bucket and verify access.'));
  }

  if (required.has('hyperdrive')) {
    checks.push(options.presence.hyperdrive
      ? result('services.hyperdrive-ok', 'info', 'The required Hyperdrive connection is available.', 'No action is required.')
      : result('services.hyperdrive', 'error', 'The required Hyperdrive connection is unavailable.', 'Create and bind HYPERDRIVE for the Supabase provider.'));
  }

  if (options.manifest.mode === 'local' && options.presence.emailDevLog) {
    checks.push(result('services.email-dev', 'info', 'Local email delivery is using the development log.', 'Use a production email binding before deployment.'));
  } else if (options.presence.email) {
    checks.push(result('services.email-ok', 'info', 'Email delivery is configured.', 'No action is required.'));
  } else {
    checks.push(result('services.email', required.has('email') ? 'error' : 'warning', 'Production email delivery is not configured.', 'Configure the EMAIL binding before relying on notifications or sign-in email.'));
  }

  if (required.has('stripe') || optional.has('stripe')) {
    const count = Number(options.presence.stripeSecretKey) + Number(options.presence.stripeWebhookSecret);
    if (count === 0) {
      checks.push(result('services.stripe-absent', required.has('stripe') ? 'error' : 'warning', 'Stripe is not configured; free registration and offline giving remain available without online payments.', 'Configure both Stripe secrets to enable payments.'));
    } else if (count === 1) {
      checks.push(result('services.stripe-partial', 'error', 'Stripe configuration is partial and cannot safely process payments.', 'Configure both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or remove both.'));
    } else {
      checks.push(result('services.stripe-ok', 'info', 'Stripe payment and webhook secrets are both configured.', 'No action is required.'));
    }
  }

  checks.push(options.presence.backup
    ? result('services.backup-ok', 'info', 'Optional backup configuration is present.', 'No action is required.')
    : result('services.backup-absent', 'info', 'Optional application-managed backup configuration is absent.', 'Configure backup credentials if application-managed exports are desired.'));
  return checks;
}
