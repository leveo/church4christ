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
import type { LearningErrorCode, LearningProviderKind } from '../../../lib/learningModel';

export const prerender = false;

const SAFE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

type HealthResult =
  | { readonly ok: true; readonly errorCode: null }
  | { readonly ok: false; readonly errorCode: LearningErrorCode };

interface LearningConnectionActionDeps {
  readonly keySecret: string | undefined | (() => string | undefined);
  readonly nextConnectionId: () => number;
  readonly createConnection: (db: AppDb, input: CreateLearningConnectionInput) => Promise<unknown>;
  readonly updateConnection: (db: AppDb, input: UpdateLearningConnectionInput) => Promise<unknown>;
  readonly reconnectConnection: (db: AppDb, input: ReconnectLearningConnectionInput) => Promise<unknown>;
  readonly disconnectConnection: (db: AppDb, input: DisconnectLearningConnectionInput) => Promise<unknown>;
  readonly loadConnection: (
    db: AppDb,
    connectionId: number,
    options: { readonly includeDeleted?: boolean },
  ) => Promise<{ readonly provider: LearningProviderKind; readonly baseUrl: string | null } | null>;
  readonly checkHealth: (input: {
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
  loadConnection: getLearningConnection,
  // Provider network calls land in the adapter slices. Until then this safe seam
  // records an unavailable health result rather than making an ad-hoc request.
  checkHealth: async () => ({ ok: false, errorCode: 'provider_unavailable' }),
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

function csrfAllowed(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === url.origin;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
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
    if (!csrfAllowed(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });

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
        await deps.disconnectConnection(locals.db, {
          connectionId: data.connectionId,
          expectedRevision: data.revision,
          actorPersonId: user!.id,
        });
        return redirect('saved', 'connection_disconnected');
      }

      const connection = await deps.loadConnection(locals.db, data.connectionId, { includeDeleted: false });
      if (!connection) return redirect('error', 'connection_conflict');
      const health = await deps.checkHealth({
        connectionId: data.connectionId,
        provider: connection.provider,
        baseUrl: connection.baseUrl,
      });
      await deps.updateHealth(locals.db, {
        connectionId: data.connectionId,
        expectedRevision: data.revision,
        ok: health.ok,
        errorCode: health.errorCode,
        actorPersonId: user!.id,
      });
      return redirect('saved', 'health_checked');
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
