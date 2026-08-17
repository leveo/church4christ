import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../lib/adminAreas';
import {
  LearningConnectionConflictError,
  LearningConnectionInvalidError,
  createLearningConnection,
  disconnectLearningConnection,
  getLearningConnection,
  reconnectLearningConnection,
  updateLearningConnection,
  updateLearningConnectionHealth,
  type CreateLearningConnectionInput,
  type DisconnectLearningConnectionInput,
  type ReconnectLearningConnectionInput,
  type UpdateLearningConnectionHealthInput,
  type UpdateLearningConnectionInput,
} from '../../../lib/learningConnectionDb';
import {
  parseLearningConnectionForm,
  readLearningConnectionForm,
} from '../../../lib/learningConnectionForms';
import {
  LearningCredentialConfigError,
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../../../lib/learningCredentials';
import type { AppDb } from '../../../lib/appDb';
import { hasSameOriginProvenance } from '../../../lib/csrf';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  type LearningConnectionStatus,
  type LearningErrorCode,
  type LearningProviderKind,
} from '../../../lib/learningModel';
import {
  checkGoogleClassroomConnectionHealth,
  disconnectGoogleClassroomConnection,
} from '../../../lib/learningGoogleAdmin';

export const prerender = false;

const SAFE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

type HealthResult =
  | { readonly ok: true; readonly errorCode: null; readonly connectionRevision?: number | null }
  | { readonly ok: false; readonly errorCode: LearningErrorCode; readonly connectionRevision?: number | null };

interface LearningConnectionActionDeps {
  readonly keySecret: string | undefined | (() => string | undefined);
  readonly nextConnectionId: () => number;
  readonly createConnection: (db: AppDb, input: CreateLearningConnectionInput) => Promise<unknown>;
  readonly updateConnection: (db: AppDb, input: UpdateLearningConnectionInput) => Promise<unknown>;
  readonly reconnectConnection: (db: AppDb, input: ReconnectLearningConnectionInput) => Promise<unknown>;
  readonly disconnectConnection: (db: AppDb, input: DisconnectLearningConnectionInput) => Promise<unknown>;
  readonly disconnectGoogleConnection: (
    db: AppDb,
    input: DisconnectLearningConnectionInput,
  ) => Promise<unknown>;
  readonly loadConnection: (
    db: AppDb,
    connectionId: number,
    options: { readonly includeDeleted?: boolean },
  ) => Promise<{
    readonly provider: LearningProviderKind;
    readonly baseUrl: string | null;
    readonly revision: number;
    readonly status: LearningConnectionStatus;
  } | null>;
  readonly checkHealth: (db: AppDb, input: {
    readonly connectionId: number;
    readonly provider: LearningProviderKind;
    readonly baseUrl: string | null;
  }) => Promise<HealthResult>;
  readonly updateHealth: (db: AppDb, input: UpdateLearningConnectionHealthInput) => Promise<unknown>;
}

function nextConnectionId(): number {
  let id = 0;
  while (id === 0) id = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fff_ffff;
  return id;
}

const defaultDeps: LearningConnectionActionDeps = {
  keySecret: () => (env as unknown as { LEARNING_CREDENTIAL_KEYS?: string }).LEARNING_CREDENTIAL_KEYS,
  nextConnectionId,
  createConnection: createLearningConnection,
  updateConnection: updateLearningConnection,
  reconnectConnection: reconnectLearningConnection,
  disconnectConnection: disconnectLearningConnection,
  disconnectGoogleConnection: async (db, input) => {
    const vars = env as unknown as {
      LEARNING_CREDENTIAL_KEYS?: string;
      GOOGLE_CLASSROOM_CLIENT_ID?: string;
      GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
    };
    if (
      typeof vars.LEARNING_CREDENTIAL_KEYS !== 'string'
      || typeof vars.GOOGLE_CLASSROOM_CLIENT_ID !== 'string'
      || typeof vars.GOOGLE_CLASSROOM_CLIENT_SECRET !== 'string'
    ) throw new LearningCredentialConfigError();
    const keyRing = await importLearningCredentialKeyRing(vars.LEARNING_CREDENTIAL_KEYS);
    return disconnectGoogleClassroomConnection(db, {
      ...input,
      clientId: vars.GOOGLE_CLASSROOM_CLIENT_ID,
      clientSecret: vars.GOOGLE_CLASSROOM_CLIENT_SECRET,
      keyRing,
      fetcher: fetch,
      nowEpochMs: Date.now(),
    }, { now: Date.now });
  },
  loadConnection: getLearningConnection,
  checkHealth: async (db, input) => {
    if (input.provider !== 'google_classroom') {
      return { ok: false, errorCode: 'provider_unavailable' };
    }
    const vars = env as unknown as {
      GOOGLE_CLASSROOM_CLIENT_ID?: string;
      GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
      LEARNING_CREDENTIAL_KEYS?: string;
    };
    if (
      typeof vars.GOOGLE_CLASSROOM_CLIENT_ID !== 'string'
      || typeof vars.GOOGLE_CLASSROOM_CLIENT_SECRET !== 'string'
      || typeof vars.LEARNING_CREDENTIAL_KEYS !== 'string'
    ) throw new LearningCredentialConfigError();
    const keyRing = await importLearningCredentialKeyRing(vars.LEARNING_CREDENTIAL_KEYS);
    return checkGoogleClassroomConnectionHealth(db, {
      connectionId: input.connectionId,
      clientId: vars.GOOGLE_CLASSROOM_CLIENT_ID,
      clientSecret: vars.GOOGLE_CLASSROOM_CLIENT_SECRET,
      keyRing,
      fetcher: fetch,
      nowEpochMs: Date.now(),
    });
  },
  updateHealth: updateLearningConnectionHealth,
};

function redirect(kind: 'saved' | 'error', code: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: `/admin/learning?${kind}=${encodeURIComponent(code)}` },
  });
}

function bodyError(status: 413 | 415): Response {
  return new Response('learning_connection_invalid', {
    status,
    headers: { ...SAFE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function secretFrom(deps: LearningConnectionActionDeps): string {
  const value = typeof deps.keySecret === 'function' ? deps.keySecret() : deps.keySecret;
  if (typeof value !== 'string') throw new LearningCredentialConfigError();
  return value;
}

async function canvasCredential(
  deps: LearningConnectionActionDeps,
  connectionId: number,
  accessToken: string,
) {
  const ring = await importLearningCredentialKeyRing(secretFrom(deps));
  return encryptLearningCredential(ring, {
    provider: 'canvas',
    connectionId,
    plaintext: new TextEncoder().encode(JSON.stringify({ accessToken })),
    expiresAt: null,
  });
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LearningConnectionConflictError) return 'connection_conflict';
  if (error instanceof LearningConnectionInvalidError) return 'connection_invalid';
  if (error instanceof LearningCredentialConfigError) return 'credentials_unavailable';
  return 'connection_failed';
}

function normalizedHealthResult(value: unknown): HealthResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LearningConnectionInvalidError();
  }
  const keys = Object.keys(value as object).sort();
  const expectedKeys = keys.length === 2
    ? 'errorCode|ok'
    : keys.length === 3
      ? 'connectionRevision|errorCode|ok'
      : '';
  if (keys.join('|') !== expectedKeys) {
    throw new LearningConnectionInvalidError();
  }
  const result = value as {
    readonly ok?: unknown;
    readonly errorCode?: unknown;
    readonly connectionRevision?: unknown;
  };
  const connectionRevision = Object.hasOwn(result, 'connectionRevision')
    ? result.connectionRevision
    : null;
  if (
    connectionRevision !== null
    && (!Number.isInteger(connectionRevision)
      || (connectionRevision as number) < 0
      || (connectionRevision as number) > LEARNING_LIMITS.databaseInteger)
  ) throw new LearningConnectionInvalidError();
  if (result.ok === true && result.errorCode === null) {
    return { ok: true, errorCode: null, connectionRevision: connectionRevision as number | null };
  }
  if (
    result.ok === false
    && typeof result.errorCode === 'string'
    && LEARNING_ERROR_CODES.includes(result.errorCode as LearningErrorCode)
  ) return {
    ok: false,
    errorCode: result.errorCode as LearningErrorCode,
    connectionRevision: connectionRevision as number | null,
  };
  throw new LearningConnectionInvalidError();
}

export function createLearningConnectionActionHandler(
  deps: LearningConnectionActionDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    const user = locals.user;
    if (!hasAreaAccess(user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    if (!hasSameOriginProvenance(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });

    const read = await readLearningConnectionForm(request);
    if (!read.ok) {
      if (read.reason === 'unsupported_media_type') return bodyError(415);
      if (read.reason === 'too_large') return bodyError(413);
      return redirect('error', 'connection_invalid');
    }
    const parsed = parseLearningConnectionForm(read.fields);
    if (!parsed.ok) return redirect('error', 'connection_invalid');

    try {
      const data = parsed.data;
      if (data.action === 'create') {
        const connectionId = deps.nextConnectionId();
        const credential = data.provider === 'canvas'
          ? await canvasCredential(deps, connectionId, data.accessToken)
          : null;
        await deps.createConnection(locals.db, {
          connectionId,
          provider: data.provider,
          displayName: data.displayName,
          baseUrl: data.baseUrl,
          actorPersonId: user!.id,
          credential,
        });
        return redirect('saved', 'connection_created');
      }
      if (data.action === 'update') {
        await deps.updateConnection(locals.db, {
          connectionId: data.connectionId,
          expectedRevision: data.revision,
          provider: data.provider,
          displayName: data.displayName,
          baseUrl: data.baseUrl,
          actorPersonId: user!.id,
        });
        return redirect('saved', 'connection_updated');
      }
      if (data.action === 'reconnect') {
        const credential = await canvasCredential(deps, data.connectionId, data.accessToken);
        await deps.reconnectConnection(locals.db, {
          connectionId: data.connectionId,
          expectedRevision: data.revision,
          provider: data.provider,
          baseUrl: data.baseUrl,
          actorPersonId: user!.id,
          credential,
        });
        return redirect('saved', 'connection_reconnected');
      }
      if (data.action === 'disconnect') {
        const disconnectInput = {
          connectionId: data.connectionId,
          expectedRevision: data.revision,
          actorPersonId: user!.id,
        };
        const connection = await deps.loadConnection(locals.db, data.connectionId, { includeDeleted: false });
        if (!connection || connection.revision !== data.revision) {
          return redirect('error', 'connection_conflict');
        }
        if (connection.provider === 'google_classroom' && connection.status !== 'pending') {
          await deps.disconnectGoogleConnection(locals.db, disconnectInput);
        } else {
          await deps.disconnectConnection(locals.db, disconnectInput);
        }
        return redirect('saved', 'connection_disconnected');
      }

      const connection = await deps.loadConnection(locals.db, data.connectionId, { includeDeleted: false });
      if (
        !connection
        || connection.revision !== data.revision
        || connection.provider !== data.provider
        || connection.status !== data.status
      ) return redirect('error', 'connection_conflict');
      const health = normalizedHealthResult(await deps.checkHealth(locals.db, {
        connectionId: data.connectionId,
        provider: connection.provider,
        baseUrl: connection.baseUrl,
      }));
      const healthRevision = health.connectionRevision ?? data.revision;
      if (healthRevision !== data.revision && healthRevision !== data.revision + 1) {
        throw new LearningConnectionInvalidError();
      }
      await deps.updateHealth(locals.db, {
        connectionId: data.connectionId,
        expectedRevision: healthRevision,
        expectedProvider: data.provider,
        expectedStatus: data.status,
        ok: health.ok,
        errorCode: health.errorCode,
        actorPersonId: user!.id,
      });
      return health.ok
        ? redirect('saved', 'health_checked')
        : redirect('error', health.errorCode);
    } catch (error) {
      return redirect('error', safeErrorCode(error));
    }
  };
}

export const POST: APIRoute = createLearningConnectionActionHandler();

export const ALL: APIRoute = async () => new Response(null, {
  status: 405,
  headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
