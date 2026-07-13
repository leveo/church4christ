import { result } from '../readiness.mjs';

const PRESENCE_KEYS = Object.freeze(['r2', 'email', 'emailDevLog', 'stripeSecretKey', 'stripeWebhookSecret', 'backup']);

export async function checkServices(options) {
  if (!options || !options.catalog || !options.manifest || !Array.isArray(options.manifest.modules)) {
    throw new TypeError('services check catalog and manifest are required');
  }
  if (!options.presence || typeof options.presence !== 'object' || Array.isArray(options.presence)) throw new TypeError('services presence is required');
  for (const key of PRESENCE_KEYS) {
    if (typeof options.presence[key] !== 'boolean') throw new TypeError(`services presence.${key} must be a boolean`);
  }
  const selected = new Set(options.manifest.modules);
  if ([...selected].some((key) => !Object.hasOwn(options.catalog.capabilities, key))) throw new TypeError('services manifest contains an unknown capability');
  const required = new Set(options.catalog.providers[options.manifest.database]?.requiredServices ?? []);
  for (const key of selected) for (const service of options.catalog.capabilities[key].requiredServices) required.add(service);
  const checks = [];

  if (required.has('r2')) {
    checks.push(options.presence.r2
      ? result('services.r2-ok', 'info', 'Required R2 media storage is accessible.', 'No action is required.')
      : result('services.r2', 'error', 'Required R2 media storage is unavailable.', 'Create or bind the configured MEDIA bucket and verify access.'));
  }

  if (options.manifest.mode === 'local' && options.presence.emailDevLog) {
    checks.push(result('services.email-dev', 'info', 'Local email delivery is using the development log.', 'Use a production email binding before deployment.'));
  } else if (options.presence.email) {
    checks.push(result('services.email-ok', 'info', 'Email delivery is configured.', 'No action is required.'));
  } else {
    checks.push(result('services.email', 'warning', 'Production email delivery is not configured.', 'Configure the EMAIL binding before relying on notifications or sign-in email.'));
  }

  if (selected.has('giving') || selected.has('registration')) {
    const count = Number(options.presence.stripeSecretKey) + Number(options.presence.stripeWebhookSecret);
    if (count === 0) {
      checks.push(result('services.stripe-absent', 'warning', 'Stripe is not configured; free registration and offline giving remain available without online payments.', 'Configure both Stripe secrets to enable payments.'));
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
