import type { DbEnv } from './dbProvider';
import { openDb } from './dbProvider';
import { handleStripeEvent } from './givingWebhook';
import { getEnabledModules } from './modules';
import type { StripeEnv } from './stripe';
import {
  STRIPE_ATTEMPT_MS,
  STRIPE_DRAIN_LIMIT,
  assertStripeLease,
  claimStripeEvent,
  finishStripeDispatch,
  listDueStripeEventIds,
  recordClaimErrorWhenOwned,
  type StripeDispatchResult,
  type StripeWebhookClaim,
} from './stripeWebhookInbox';

export type ProcessAttemptResult = StripeDispatchResult | { state: 'not_claimed' } | { state: 'failed' };

export interface StripeWebhookProcessorDeps {
  env: StripeEnv & DbEnv;
  openDb?: typeof openDb;
  fetcher?: typeof fetch;
  now?: () => Date;
  newLeaseToken?: () => string;
  dispatch?: typeof handleStripeEvent;
}

type OpenedDb = ReturnType<typeof openDb>;

function processorSecrets(env: StripeEnv & DbEnv): string[] {
  return [env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.HYPERDRIVE?.connectionString]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Process one durable receipt. Every successful open owns exactly one client close. */
export async function processStripeWebhookEvent(
  eventId: string,
  deps: StripeWebhookProcessorDeps,
): Promise<ProcessAttemptResult> {
  let opened: OpenedDb | undefined;
  let claim: StripeWebhookClaim | null = null;
  const now = deps.now ?? (() => new Date());

  try {
    opened = (deps.openDb ?? openDb)(deps.env);
    if (opened.backend !== 'supabase') return { state: 'not_claimed' };

    const leaseToken = deps.newLeaseToken ? deps.newLeaseToken() : crypto.randomUUID();
    claim = await claimStripeEvent(
      opened.db,
      eventId,
      now(),
      leaseToken,
    );
    if (!claim) return { state: 'not_claimed' };

    const deadline = now().getTime() + STRIPE_ATTEMPT_MS;
    const checkpoint = async () => {
      const checkedAt = now();
      if (
        checkedAt.getTime() >= deadline
        || !(await assertStripeLease(opened!.db, eventId, claim!.leaseToken, checkedAt))
      ) {
        throw Object.assign(new Error('stripe_attempt_lease_lost'), { code: 'stripe_attempt_lease_lost' });
      }
    };

    await checkpoint();
    const modules = await getEnabledModules(opened.db, 'supabase');
    const event = JSON.parse(claim.payloadJson) as Record<string, unknown>;
    await checkpoint();
    const result = await (deps.dispatch ?? handleStripeEvent)({
      db: opened.db,
      env: deps.env,
      modules,
      fetcher: deps.fetcher,
      checkpoint,
    }, event);
    await checkpoint();
    const finalized = await finishStripeDispatch(opened.db, claim, result, now());
    if (!finalized) {
      throw Object.assign(new Error('stripe_attempt_lease_lost'), { code: 'stripe_attempt_lease_lost' });
    }
    return result;
  } catch (error) {
    if (opened && claim) {
      try {
        const failedAt = now();
        if (await assertStripeLease(opened.db, claim.eventId, claim.leaseToken, failedAt)) {
          await recordClaimErrorWhenOwned(opened.db, claim, error, failedAt, processorSecrets(deps.env));
        }
      } catch {
        // The still-processing lease is the durable recovery path when the DB is
        // unavailable. A successor may reclaim it after the ten-minute lease.
      }
    }
    return { state: 'failed' };
  } finally {
    if (opened) {
      try {
        await opened.end();
      } catch {
        // Closing must never replace the durable processing result.
      }
    }
  }
}

export interface StripeWebhookDrainDeps extends StripeWebhookProcessorDeps {
  process?: typeof processStripeWebhookEvent;
}

/** List a bounded pass with one client, close it, then process sequentially. */
export async function drainStripeWebhookInbox(
  deps: StripeWebhookDrainDeps,
): Promise<ProcessAttemptResult[]> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const deadline = startedAt.getTime() + STRIPE_ATTEMPT_MS;
  let opened: OpenedDb | undefined;
  let eventIds: string[] = [];

  try {
    opened = (deps.openDb ?? openDb)(deps.env);
    if (opened.backend !== 'supabase') return [];
    eventIds = await listDueStripeEventIds(opened.db, startedAt, STRIPE_DRAIN_LIMIT);
  } finally {
    if (opened) {
      // A failed close means the listing client may still own resources. Abort
      // the pass rather than opening per-event clients alongside it.
      await opened.end();
    }
  }

  const process = deps.process ?? processStripeWebhookEvent;
  const results: ProcessAttemptResult[] = [];
  const { process: _process, ...processorDeps } = deps;
  for (const eventId of eventIds) {
    if (now().getTime() >= deadline) break;
    results.push(await process(eventId, processorDeps));
  }
  return results;
}
