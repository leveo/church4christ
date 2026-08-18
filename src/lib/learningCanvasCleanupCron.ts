import type { AppDb } from './appDb';
import { getBackend } from './dbProvider';
import {
  listCanvasDisconnectCleanupConnectionIds,
  recoverCanvasDisconnectCleanup,
  type CanvasCleanupSummary,
} from './learningCanvasCleanup';
import { readCanvasAllowedOrigins } from './learningCanvasOrigins';
import {
  importLearningCredentialKeyRing,
  type LearningCredentialKeyRing,
} from './learningCredentials';
import { getEnabledModules } from './modules';

const PASS_DEADLINE_MS = 25_000;
type CronFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CanvasDisconnectCleanupCronEnv {
  readonly DB_BACKEND?: string;
  readonly CANVAS_OAUTH_CLIENT_ID?: string;
  readonly CANVAS_OAUTH_CLIENT_SECRET?: string;
  readonly CANVAS_ALLOWED_ORIGINS?: string;
  readonly LEARNING_CREDENTIAL_KEYS?: string;
}

interface CanvasDisconnectCleanupCronDeps {
  readonly fetcher: CronFetcher;
  readonly now: () => number;
  readonly importKeyRing: (encoded: string) => Promise<LearningCredentialKeyRing>;
  readonly listCleanupConnectionIds: typeof listCanvasDisconnectCleanupConnectionIds;
  readonly recoverCleanup: typeof recoverCanvasDisconnectCleanup;
}

const DEFAULT_DEPS: CanvasDisconnectCleanupCronDeps = Object.freeze({
  fetcher: fetch,
  now: Date.now,
  importKeyRing: importLearningCredentialKeyRing,
  listCleanupConnectionIds: listCanvasDisconnectCleanupConnectionIds,
  recoverCleanup: recoverCanvasDisconnectCleanup,
});

export type CanvasDisconnectCleanupCronResult =
  | { readonly status: 'skipped'; readonly reason: 'module_disabled' | 'not_configured' }
  | { readonly status: 'completed'; readonly summary: CanvasCleanupSummary };

function configured(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

export async function runCanvasDisconnectCleanupPass(
  environment: CanvasDisconnectCleanupCronEnv,
  db: AppDb,
  dependencies: CanvasDisconnectCleanupCronDeps = DEFAULT_DEPS,
): Promise<CanvasDisconnectCleanupCronResult> {
  if (!(await getEnabledModules(db, getBackend(environment))).has('learning')) {
    return Object.freeze({ status: 'skipped', reason: 'module_disabled' });
  }
  const clientId = environment.CANVAS_OAUTH_CLIENT_ID;
  const clientSecret = environment.CANVAS_OAUTH_CLIENT_SECRET;
  const allowedOrigins = environment.CANVAS_ALLOWED_ORIGINS;
  const keySecret = environment.LEARNING_CREDENTIAL_KEYS;
  if (
    !configured(clientId, 512)
    || !configured(clientSecret, 8_192)
    || !configured(allowedOrigins, 16_384)
    || !configured(keySecret, 16_384)
  ) return Object.freeze({ status: 'skipped', reason: 'not_configured' });
  const origins = readCanvasAllowedOrigins(allowedOrigins);
  const keyRing = await dependencies.importKeyRing(keySecret);
  const connectionIds = await dependencies.listCleanupConnectionIds(db, 1);
  const connectionId = connectionIds[0];
  if (connectionId === undefined) {
    return Object.freeze({
      status: 'completed', summary: Object.freeze({ selected: 0, cleaned: 0, pending: 0 }),
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PASS_DEADLINE_MS);
  try {
    const summary = await dependencies.recoverCleanup(db, {
      connectionId, clientId, clientSecret, allowedOrigins: origins, keyRing,
      fetcher: dependencies.fetcher, signal: controller.signal, now: dependencies.now,
    });
    return Object.freeze({ status: 'completed', summary });
  } finally {
    clearTimeout(timer);
  }
}
