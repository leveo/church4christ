import type { AppDb } from './appDb';
import { getBackend } from './dbProvider';
import {
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
      readonly signal: AbortSignal;
    },
  ) => Promise<GoogleRegistrationRenewalSummary>;
}

const DEFAULT_DEPS: GoogleClassroomRegistrationCronDeps = Object.freeze({
  fetcher: fetch,
  now: Date.now,
  importKeyRing: importLearningCredentialKeyRing,
  renew: renewGoogleClassroomRegistrations,
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
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('learning_google_registration_cron_invalid');
  const keyRing = await dependencies.importKeyRing(keySecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PASS_DEADLINE_MS);
  try {
    const summary = await dependencies.renew(db, {
      clientId,
      clientSecret,
      keyRing,
      fetcher: dependencies.fetcher,
      nowEpochMs: now,
      signal: controller.signal,
    });
    return Object.freeze({ status: 'completed', summary });
  } finally {
    clearTimeout(timer);
  }
}
