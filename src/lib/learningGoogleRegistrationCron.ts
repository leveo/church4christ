import type { AppDb } from './appDb';
import { getBackend } from './dbProvider';
import {
  listGoogleClassroomCleanupConnectionIds,
  recoverGoogleClassroomCleanup,
} from './learningGoogleCleanup';
import {
  googleClassroomPushReadiness,
  renewGoogleClassroomRegistrations,
  type GoogleRegistrationRenewalSummary,
} from './learningGoogleRegistrationLifecycle';
import {
  importLearningCredentialKeyRing,
  type LearningCredentialKeyRing,
} from './learningCredentials';
import { getEnabledModules } from './modules';

const PASS_DEADLINE_MS = 25_000;

type CronFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GoogleClassroomRegistrationCronEnv {
  readonly DB_BACKEND?: string;
  readonly GOOGLE_CLASSROOM_CLIENT_ID?: string;
  readonly GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
  readonly GOOGLE_CLASSROOM_PUBSUB_TOPIC?: string;
  readonly GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL?: string;
  readonly GOOGLE_PUBSUB_SUBSCRIPTION_NAME?: string;
  readonly LEARNING_CREDENTIAL_KEYS?: string;
}

interface GoogleClassroomRegistrationCronDeps {
  readonly fetcher: CronFetcher;
  readonly now: () => number;
  readonly importKeyRing: (encoded: string) => Promise<LearningCredentialKeyRing>;
  readonly renew: (
    db: AppDb,
    input: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly keyRing: LearningCredentialKeyRing;
      readonly fetcher: CronFetcher;
      readonly nowEpochMs: number;
      readonly topicName: string;
      readonly signal: AbortSignal;
    },
    clock?: { readonly now: () => number },
  ) => Promise<GoogleRegistrationRenewalSummary>;
  readonly listCleanupConnectionIds?: typeof listGoogleClassroomCleanupConnectionIds;
  readonly recoverCleanup?: typeof recoverGoogleClassroomCleanup;
}

const DEFAULT_DEPS: GoogleClassroomRegistrationCronDeps = Object.freeze({
  fetcher: fetch,
  now: Date.now,
  importKeyRing: importLearningCredentialKeyRing,
  renew: renewGoogleClassroomRegistrations,
  listCleanupConnectionIds: listGoogleClassroomCleanupConnectionIds,
  recoverCleanup: recoverGoogleClassroomCleanup,
});

export type GoogleClassroomRegistrationCronResult =
  | { readonly status: 'skipped'; readonly reason: 'module_disabled' | 'not_configured' }
  | { readonly status: 'completed'; readonly summary: GoogleRegistrationRenewalSummary };

function configured(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

export async function runGoogleClassroomRegistrationRenewalPass(
  environment: GoogleClassroomRegistrationCronEnv,
  db: AppDb,
  dependencies: GoogleClassroomRegistrationCronDeps = DEFAULT_DEPS,
): Promise<GoogleClassroomRegistrationCronResult> {
  if (!(await getEnabledModules(db, getBackend(environment))).has('learning')) {
    return Object.freeze({ status: 'skipped', reason: 'module_disabled' });
  }
  const clientId = environment.GOOGLE_CLASSROOM_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CLASSROOM_CLIENT_SECRET;
  const keySecret = environment.LEARNING_CREDENTIAL_KEYS;
  if (
    !configured(clientId, 512)
    || !configured(clientSecret, 2_048)
    || !configured(keySecret, 16_384)
  ) return Object.freeze({ status: 'skipped', reason: 'not_configured' });
  const pushReadiness = googleClassroomPushReadiness({
    topicName: environment.GOOGLE_CLASSROOM_PUBSUB_TOPIC,
    subscriptionName: environment.GOOGLE_PUBSUB_SUBSCRIPTION_NAME,
    serviceAccountEmail: environment.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
  });
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('learning_google_registration_cron_invalid');
  const keyRing = await dependencies.importKeyRing(keySecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PASS_DEADLINE_MS);
  try {
    if (dependencies.listCleanupConnectionIds && dependencies.recoverCleanup) {
      const cleanupConnections = await dependencies.listCleanupConnectionIds(db, 1);
      const cleanupConnectionId = cleanupConnections[0];
      if (cleanupConnectionId !== undefined) {
        try {
          await dependencies.recoverCleanup(db, {
            connectionId: cleanupConnectionId,
            clientId,
            clientSecret,
            keyRing,
            fetcher: dependencies.fetcher,
            nowEpochMs: now,
            signal: controller.signal,
            limit: 1,
          }, { now: dependencies.now });
        } catch { /* the durable task remains available to a later bounded pass */ }
      }
    }
    if (pushReadiness.mode !== 'ready') {
      return Object.freeze({ status: 'skipped', reason: 'not_configured' });
    }
    const summary = await dependencies.renew(db, {
      clientId,
      clientSecret,
      keyRing,
      fetcher: dependencies.fetcher,
      nowEpochMs: now,
      topicName: pushReadiness.topicName,
      signal: controller.signal,
    }, { now: dependencies.now });
    return Object.freeze({ status: 'completed', summary });
  } finally {
    clearTimeout(timer);
  }
}
