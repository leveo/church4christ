import type { DbEnv } from './dbProvider';
import { openDb } from './dbProvider';
import type { StripeEnv } from './stripe';
import {
  drainStripeCheckoutRecovery,
  type StripeCheckoutRecoveryDeps,
  type StripeCheckoutRecoveryResult,
} from './stripeCheckoutRecovery';
import {
  pruneStripeWebhookPayloads,
  sanitizeStripeDiagnostic,
  type StripePayloadPruneResult,
} from './stripeWebhookInbox';
import {
  drainStripeWebhookInbox,
  type ProcessAttemptResult,
  type StripeWebhookDrainDeps,
} from './stripeWebhookProcessor';

export type StripeRecoveryPhase<T> =
  | { state: 'completed'; result: T }
  | { state: 'failed'; error: string };

export interface StripeRecoveryResult {
  inbox: StripeRecoveryPhase<ProcessAttemptResult[]>;
  checkout: StripeRecoveryPhase<StripeCheckoutRecoveryResult[]>;
  retention: StripeRecoveryPhase<StripePayloadPruneResult>;
}

export interface StripeRecoveryDeps extends StripeWebhookDrainDeps {
  /** Independent bound for durable webhook inbox work. */
  inboxLimit?: number;
  /** Independent bound for registration Checkout recovery work. */
  checkoutLimit?: number;
  drain?: (deps: StripeWebhookDrainDeps) => Promise<ProcessAttemptResult[]>;
  checkout?: (deps: StripeCheckoutRecoveryDeps) => Promise<StripeCheckoutRecoveryResult[]>;
  retention?: (deps: StripeWebhookDrainDeps) => Promise<StripePayloadPruneResult>;
}

export async function pruneStripeWebhookRetention(
  deps: StripeWebhookDrainDeps,
): Promise<StripePayloadPruneResult> {
  const opened = (deps.openDb ?? openDb)(deps.env);
  try {
    if (opened.backend !== 'supabase') return { processedOrIgnored: 0, failed: 0 };
    return await pruneStripeWebhookPayloads(opened.db, (deps.now ?? (() => new Date()))());
  } finally {
    try {
      await opened.end();
    } catch {
      // Retention is retried by the next scheduled pass.
    }
  }
}

function recoverySecrets(env: StripeEnv & DbEnv): string[] {
  return [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.HYPERDRIVE?.connectionString]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Run bounded recovery phases independently so one failure never suppresses later work. */
export async function runStripeRecovery(deps: StripeRecoveryDeps): Promise<StripeRecoveryResult> {
  const secrets = recoverySecrets(deps.env);
  const drain = deps.drain ?? drainStripeWebhookInbox;
  const checkoutRecovery = deps.checkout ?? drainStripeCheckoutRecovery;
  const retention = deps.retention ?? pruneStripeWebhookRetention;
  let inbox: StripeRecoveryResult['inbox'];
  let checkout: StripeRecoveryResult['checkout'];
  let retained: StripeRecoveryResult['retention'];

  try {
    inbox = { state: 'completed', result: await drain({ ...deps, limit: deps.inboxLimit }) };
  } catch (error) {
    inbox = { state: 'failed', error: sanitizeStripeDiagnostic(error, secrets) };
  }

  try {
    checkout = {
      state: 'completed',
      result: await checkoutRecovery({ ...deps, limit: deps.checkoutLimit }),
    };
  } catch (error) {
    checkout = { state: 'failed', error: sanitizeStripeDiagnostic(error, secrets) };
  }

  try {
    retained = { state: 'completed', result: await retention(deps) };
  } catch (error) {
    retained = { state: 'failed', error: sanitizeStripeDiagnostic(error, secrets) };
  }

  return { inbox, checkout, retention: retained };
}
