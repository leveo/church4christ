import type { DbEnv } from './dbProvider';
import { openDb } from './dbProvider';
import type { StripeEnv } from './stripe';
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
  retention: StripeRecoveryPhase<StripePayloadPruneResult>;
}

export interface StripeRecoveryDeps extends StripeWebhookDrainDeps {
  drain?: (deps: StripeWebhookDrainDeps) => Promise<ProcessAttemptResult[]>;
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

/** Run bounded recovery phases independently so retention still follows inbox failure. */
export async function runStripeRecovery(deps: StripeRecoveryDeps): Promise<StripeRecoveryResult> {
  const secrets = recoverySecrets(deps.env);
  const drain = deps.drain ?? drainStripeWebhookInbox;
  const retention = deps.retention ?? pruneStripeWebhookRetention;
  let inbox: StripeRecoveryResult['inbox'];
  let retained: StripeRecoveryResult['retention'];

  try {
    inbox = { state: 'completed', result: await drain(deps) };
  } catch (error) {
    inbox = { state: 'failed', error: sanitizeStripeDiagnostic(error, secrets) };
  }

  try {
    retained = { state: 'completed', result: await retention(deps) };
  } catch (error) {
    retained = { state: 'failed', error: sanitizeStripeDiagnostic(error, secrets) };
  }

  return { inbox, retention: retained };
}
